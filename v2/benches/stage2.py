"""Benchmark isolated search processes and verify an immutable archive copy."""

import argparse
from collections import Counter
import hashlib
import json
import math
import re
from pathlib import Path
import statistics
import subprocess
import sys
import time
import unicodedata

import jieba
from opencc import OpenCC


SHORT = [
    "資產配置", "退休提領", "殖利率", "股息率", "那斯達克", "纳斯达克",
    "0050", "QQQ", "4%", "00864B", "技術分析", "再平衡", "定期定額", "緊急備用金",
    "通膨", "市盈率", "經濟衰退", "資本利得稅", "槓桿基金", "最大回撤", "勞退",
    "債券", "現金流", "資產質押", "台積電",
]

# Topic words are fixed before scoring. They exclude generic question words.
LONG = [
    ("退休之後遇到熊市應該怎麼安排現金流和提領比例", "退休 熊市 現金流 提領"),
    ("如果市場持續下跌要怎麼執行再平衡策略", "市場 下跌 再平衡 策略"),
    ("高通膨和升息對長期持有債券會產生哪些影響", "通膨 升息 債券 持有"),
    ("每個月定期定額買指數基金如何降低成本", "定期定額 指數 基金 成本"),
    ("想提早退休需要先準備多少年生活費", "提早退休 退休 生活費"),
    ("投資組合在股災中如何控制最大回撤", "投資 組合 股災 控制 最大回撤"),
    ("美股和台股在資產配置上怎麼分散風險", "美股 台股 資產配置 分散 風險"),
    ("如果退休金不夠應該何時開始領勞保年金", "退休金 勞保 年金"),
    ("如何用短期債券為未來的支出預留現金", "短期債券 債券 支出 現金"),
    ("遇到失業時緊急備用金應該放在哪裡", "失業 緊急備用金 備用金"),
    ("買入槓桿基金後在震盪市場會不會出現較大損失", "槓桿 基金 市場 損失 震盪"),
    ("為什麼有些人認為股息率高不等於總報酬高", "股息率 殖利率 股息 報酬"),
    ("為何房屋貸款利率上升會影響家庭現金流", "房屋貸款 房貸 利率 家庭 現金流"),
    ("比較台積電和大盤指數的集中度有什麼方法", "台積電 大盤 指數 集中度"),
    ("通貨膨脹期間有哪些方式可以保護退休收入", "通貨膨脹 通膨 退休 收入"),
    ("什麼時候適合動用信用額度而不賣掉股票", "信用額度 額度 股票"),
    ("年化報酬率怎麼計算以及如何比較不同基金", "年化報酬率 報酬率 計算 基金"),
    ("怎麼判斷投資組合的波動率是否可以承受", "投資 組合 波動率 波動 承受"),
    ("投資海外資產的時候匯率波動如何影響報酬", "海外 資產 匯率 波動 報酬"),
    ("景氣衰退時什麼情況會讓央行選擇降息", "景氣 衰退 央行 降息"),
    ("財務自由之後要不要繼續工作補充退休收入", "財務自由 工作 退休 收入"),
    ("長期投資成長型基金能不能減少遺產稅負擔", "投資 成長 基金 遺產稅"),
    ("在出售股票之前如何估算資本利得稅", "出售 股票 資本利得稅 資本 利得"),
    ("選擇貨幣市場基金需要注意哪些風險和費用", "貨幣市場基金 貨幣 基金 風險 費用"),
    ("股債搭配的比例應該隨著年齡變化而調整嗎", "股債 股 債 比例 年齡 調整"),
]


def execute(base, *args):
    process = subprocess.run([*base, *args], capture_output=True, timeout=10)
    assert process.returncode == 0, process.stderr.decode()
    assert not process.stderr
    assert b"\x1b" not in process.stdout
    return process.stdout


def fingerprint(index):
    return {
        str(file.relative_to(index)): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in index.rglob("*") if file.is_file()
    }


def concurrent_reads(binary, index):
    before = fingerprint(index)
    processes = [
        subprocess.Popen([binary, "--index", index, "search", query],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for query in SHORT[:8]
    ]
    for child in processes:
        stdout, stderr = child.communicate(timeout=10)
        assert child.returncode == 0 and not stderr and b"\x1b" not in stdout, stderr
        assert len(json.loads(stdout)["hits"]) == 15
    assert fingerprint(index) == before
    return len(processes)


def timings(values):
    ordered = sorted(values)
    return {
        "min": round(ordered[0], 3),
        "p50": round(statistics.median(ordered), 3),
        "p95": round(ordered[math.ceil(.95 * len(ordered)) - 1], 3),
        "max": round(ordered[-1], 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path("v2/target/release/clec"))
    parser.add_argument("--root", type=Path, default=Path("/tmp/clec-v2-real"))
    parser.add_argument("--corpus-repo", type=Path, default=Path("../clec-corpus"))
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(args.corpus_repo.resolve()))
    from etl.audit_corpus import TEMPLATE_PATTERNS

    index = args.root / "index"
    base = [args.binary, "--index", index]
    converter = OpenCC("t2s")
    jieba.setLogLevel(30)
    jieba.dt.tmp_dir = str(args.root)
    jieba.initialize()
    word_runs = re.compile(r"[㐀-鿿]+|[a-z0-9]+(?:\.[0-9]+)?%?")

    def normalize(text):
        return converter.convert(unicodedata.normalize("NFKC", text).casefold())

    def tokenize(text):
        terms = set()
        for run in word_runs.findall(normalize(text)):
            terms.update(jieba.cut(run) if "\u3400" <= run[0] <= "\u9fff" else [run])
        return terms

    stopwords = set((Path(__file__).resolve().parents[1] / "src/stopwords.txt").read_text().split())
    groups = [
        {normalize(word) for word in group}
        for group in json.loads((index / "synonyms.json").read_text())
    ]
    groups.append({"那斯达克", "纳斯达克"})
    queries = [(query, [query]) for query in SHORT]
    queries.extend((query, terms.split()) for query, terms in LONG)
    assert len(SHORT) == len(LONG) == 25 and all(not any(c.isspace() for c in q) for q, _ in LONG)
    for warmup, _ in queries[::5]:
        execute(base, "search", warmup)

    samples = []
    patterns = Counter()
    sources = Counter()
    for i, (query, terms) in enumerate(queries):
        accepted = {normalize(term) for term in terms}
        expansion = accepted.union(*(group for group in groups if group & accepted))
        query_tokens = tokenize(query)
        query_tokens = query_tokens - stopwords or query_tokens
        query_tokens.update(*(tokenize(term) for term in expansion - accepted))
        start = time.perf_counter_ns()
        data = execute(base, "search", query)
        ms = (time.perf_counter_ns() - start) / 1e6
        hits = json.loads(data)["hits"]
        assert len(hits) == 15, query
        lexical = topical = highlighted = polluted = 0
        miss_ids = []
        for hit in hits:
            excerpt = hit["snippet"]
            assert "<b>" not in excerpt and len(excerpt.encode("utf-8")) <= 550
            assert all(word in excerpt for word in hit["highlights"])
            sources[hit["snippet_field"]] += 1
            if tokenize(excerpt) & query_tokens:
                lexical += 1
            else:
                miss_ids.append(hit["doc_id"])
            topical += any(term in normalize(excerpt) for term in expansion)
            highlighted += bool(hit["highlights"])
            observed = [name for name, pattern in TEMPLATE_PATTERNS.items() if pattern.search(excerpt)]
            polluted += bool(observed)
            patterns.update(observed)
        samples.append({
            "query": query, "type": "short" if i < len(SHORT) else "long",
            "ms": round(ms, 3), "hits": len(hits), "lexical": lexical,
            "topical": topical, "highlighted": highlighted, "polluted": polluted, "lexical_miss_ids": miss_ids,
        })

    immutable = args.root / "readonly" / "index"
    assert immutable.stat().st_mode & 0o777 == 0o555
    assert (immutable / "index").stat().st_mode & 0o777 == 0o555
    successes = concurrent_reads(args.binary, immutable)
    assert json.loads(execute([args.binary, "--index", immutable], "stats")) == json.loads(execute(base, "stats"))

    hits = sum(row["hits"] for row in samples)
    lexical = sum(row["lexical"] for row in samples)
    highlighted = sum(row["highlighted"] for row in samples)
    polluted = sum(row["polluted"] for row in samples)
    summary = {
        "queries": len(samples),
        "time_ms": timings([row["ms"] for row in samples]),
        "short_ms": timings([row["ms"] for row in samples if row["type"] == "short"]),
        "long_ms": timings([row["ms"] for row in samples if row["type"] == "long"]),
        "hits": hits, "lexical": lexical, "topical": sum(row["topical"] for row in samples),
        "highlighted": highlighted,
        "polluted": polluted, "template_patterns": patterns, "snippet_fields": sources,
        "readonly_successes": successes,
    }
    print(json.dumps({"summary": summary, "samples": samples}, ensure_ascii=False, indent=2))
    assert summary["time_ms"]["p50"] <= 30 and summary["time_ms"]["p95"] <= 60, summary
    assert lexical / hits >= .9 and polluted / hits < .005, summary


if __name__ == "__main__":
    main()
