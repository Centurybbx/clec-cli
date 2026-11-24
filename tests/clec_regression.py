"""Twenty regression cases against the compiled CLEC corpus."""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import unittest


class CorpusRegression(unittest.TestCase):
    def cli(self, *args, code=0, stdin=None, use_env=False):
        command = [self.binary]
        if not use_env:
            command += ["--index", self.index]
        result = subprocess.run(
            [*command, *args], input=stdin, capture_output=True, text=True,
            env={**os.environ, "CLEC_INDEX_DIR": str(self.index)}, timeout=5,
        )
        self.assertEqual(result.returncode, code, result.stderr or result.stdout)
        self.assertNotIn("\x1b", result.stdout + result.stderr)
        if code:
            self.assertEqual(result.stdout, "")
            self.assertEqual(json.loads(result.stderr)["error"]["code"], code)
        else:
            self.assertEqual(result.stderr, "")
        return result.stdout

    def search(self, *args):
        data = json.loads(self.cli("search", *args))
        self.assertGreater(data["total"], 0)
        self.assertTrue(data["hits"])
        return data

    def contains(self, query, *spellings):
        hits = self.search(query)["hits"]
        for hit in hits:
            self.assertLessEqual(len(hit["snippet"].encode("utf-8")), 550)
            self.assertNotIn("<b>", hit["snippet"])
        snippets = "\n".join(hit["snippet"] for hit in hits).casefold()
        self.assertTrue(any(word.casefold() in snippets for word in spellings), query)

    def test_01_traditional(self):
        self.contains("資產配置", "資產配置", "资产配置")

    def test_02_simplified(self):
        self.contains("资产配置", "資產配置", "资产配置")

    def test_03_taiwan_yield(self):
        self.contains("殖利率", "殖利率", "股息率", "股息收益率")

    def test_04_mainland_yield(self):
        self.contains("股息率", "殖利率", "股息率", "股息收益率")

    def test_05_taiwan_nasdaq(self):
        self.contains("那斯達克", "那斯達克", "那斯达克", "納斯達克", "纳斯达克")

    def test_06_mainland_nasdaq(self):
        self.contains("纳斯达克", "那斯達克", "那斯达克", "納斯達克", "纳斯达克")

    def test_07_leading_zero_code(self):
        self.contains("0050", "0050")

    def test_08_qqq_with_equivalents(self):
        self.contains("QQQ", "QQQ", "00662", "納斯達克100", "那斯達克100", "纳指100")
        self.assertTrue(any("00662" in hit["highlights"] for hit in self.search("QQQ")["hits"]))

    def test_09_percentage(self):
        self.contains("4%", "4%", "４％")

    def test_10_alphanumeric_code(self):
        self.contains("00864B", "00864B")

    def test_11_unsegmented_question(self):
        self.contains("退休之後遇到熊市應該怎麼安排現金流和提領比例", "退休", "熊市", "現金流", "现金流", "提領")

    def test_12_four_routes_and_paging(self):
        queries = ("提前退休", "提前退休", "現金流", "資產配置")
        page = self.search(*queries, "--limit", "5", "--per-work", "1")
        next_page = self.search(*queries, "--limit", "5", "--per-work", "1", "--offset", "5")
        self.assertEqual(page["total"], next_page["total"])
        self.assertGreater(page["total"], 100)
        self.assertLessEqual(page["total"], 400)
        self.assertTrue(page["has_more"])
        self.assertEqual(next_page["offset"], 5)
        top = page["hits"] + next_page["hits"]
        self.assertEqual(len({hit["doc_id"] for hit in top}), 10)
        self.assertEqual(len({hit["work_id"] for hit in top}), 10)
        self.assertTrue(any(hit["score"] > 1.15 / 61 for hit in top))
        self.cli("search", *queries, "ETF", code=2)

    def test_13_kind_filter(self):
        hits = self.search("ETF", "--kind", "summary,qa")["hits"]
        self.assertTrue(all(hit["kind"] in {"summary", "qa"} for hit in hits))
        self.cli("search", "ETF", "--kind", "other", code=2)

    def test_14_date_bounds(self):
        hits = self.search("ETF", "--from", "2025-01-01", "--to", "2025-12-31")["hits"]
        self.assertTrue(all("2025-01-01" <= h["date"] <= "2025-12-31" for h in hits))
        self.cli("search", "ETF", "--from", "2025-02-29", code=2)
        self.cli("search", "ETF", "--from", "2025-03-01", "--to", "2025-02-01", code=2)

    def test_15_suspect_filter_and_warning(self):
        result = self.search("投資", "--exclude-suspect", "--limit", "50")
        self.assertTrue(all(h["quality"] < 4 for h in result["hits"]))
        data = json.loads(self.cli("read", self.suspect, "--context", "0"))
        passage = data["passages"][0]["passage"]
        self.assertEqual(passage["quality"], 4)
        self.assertIn("suspect", passage["quality_note"].casefold())
        hits = self.search(passage["title"], "--work", passage["work_id"], "--limit", "50")["hits"]
        self.assertIn(self.suspect, {hit["doc_id"] for hit in hits})
        page = json.loads(self.cli("search", passage["title"], "--work", passage["work_id"], "--limit", "50", "--exclude-suspect"))
        self.assertNotIn(self.suspect, {hit["doc_id"] for hit in page["hits"]})

    def test_16_outline_multi_source(self):
        outline = json.loads(self.cli("outline", "ep-00123"))
        self.assertEqual(outline["work_id"], "ep-00123")
        self.assertEqual({source["kind"] for source in outline["sources"]}, {"summary", "transcript"})
        keys = [(p["source_id"], p["ordinal"]) for p in outline["passages"]]
        self.assertEqual(keys, sorted(keys))
        only = json.loads(self.cli("outline", "ep-00123", "--kind", "transcript"))
        self.assertTrue(only["passages"])
        self.assertTrue(all(p["kind"] == "transcript" for p in only["passages"]))

    def test_17_time_range_and_neighbors(self):
        args = ("read", "--work", "ep-00123", "--range")
        result = json.loads(self.cli(*args, "00:10-00:30"))
        self.assertEqual(result, json.loads(self.cli(*args, "00:00:10-00:00:30")))
        self.assertTrue(result["passages"])
        for result in result["passages"]:
            hit = result["passage"]
            interval = hit["time_range"]
            self.assertLessEqual(interval["start_sec"], 30)
            self.assertGreaterEqual(interval["end_sec"], 10)
            self.assertTrue(hit["body"] and hit["origin_url"])
            self.assertTrue(result["after"])
            for neighbors, delta in [(result["before"], -1), (result["after"], 1)]:
                for neighbor in neighbors:
                    self.assertEqual(neighbor["source_id"], hit["source_id"])
                    self.assertEqual(neighbor["ordinal"], hit["ordinal"] + delta)

    def test_18_quarantined_work_and_stats(self):
        self.cli("outline", "ep-00176", code=4)
        self.cli("read", "--work", "ep-00176", "--range", "00:10-00:30", code=4)
        self.cli("search", "ETF", "--work", "ep-00176", code=4)
        stats = json.loads(self.cli("stats", use_env=True))
        self.assertEqual(stats["counts"]["passages"], 50_646)
        self.assertEqual(stats["counts"]["sources"], 5_359)
        self.assertEqual(stats["counts"]["works"], 2_817)
        self.assertTrue(any("ep-00176" in gap for gap in stats["known_gaps"]))
        self.assertTrue(stats["disclaimer"])

    def test_19_ids_pipe_and_missing_doc(self):
        command = [self.binary, "--index", self.index]
        with subprocess.Popen([*command, "search", "退休 提领", "--ids-only"],
                              stdout=subprocess.PIPE) as producer:
            result = subprocess.run([*command, "read", "--stdin", "--context", "1"],
                                    stdin=producer.stdout, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(producer.wait(timeout=5), 0)
        readings = json.loads(result.stdout)["passages"]
        expected = self.cli("search", "退休 提领", "--ids-only").splitlines()
        self.assertEqual([entry["passage"]["doc_id"] for entry in readings], expected)
        self.assertEqual(len(expected), 15)
        self.cli("read", "no-such-passage", code=4)

    def test_20_jsonl_and_empty_results(self):
        rows = self.cli("search", "退休", "--jsonl", "--limit", "3").splitlines()
        hits = self.search("退休", "--limit", "3")["hits"]
        self.assertEqual([json.loads(row) for row in rows], hits)
        data = json.loads(self.cli("search", "qzzzxvvv830119q"))
        self.assertEqual(data, {"total": 0, "offset": 0, "limit": 15, "has_more": False, "hits": []})
        self.assertEqual(self.cli("search", "qzzzxvvv830119q", "--jsonl"), "")
        self.cli("search", "?!", code=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path("target/release/clec"))
    parser.add_argument("--index", type=Path, default=Path.home() / ".local/share/clec/index")
    parser.add_argument("--corpus", type=Path, default=Path("../clec-corpus/dist/corpus.jsonl"))
    args = parser.parse_args()
    CorpusRegression.binary = args.binary.resolve()
    CorpusRegression.index = args.index.resolve()
    works = Counter()
    suspects = []
    with args.corpus.open(encoding="utf-8") as corpus:
        for line in corpus:
            row = json.loads(line)
            works[row["work_id"]] += 1
            if row["quality"] == 4:
                suspects.append((row["work_id"], row["doc_id"]))
    CorpusRegression.suspect = min(suspects, key=lambda row: works[row[0]], default=("", ""))[1]
    if not CorpusRegression.suspect:
        parser.error("expected a real suspect passage in --corpus")
    unittest.main(argv=[__file__], verbosity=2)
