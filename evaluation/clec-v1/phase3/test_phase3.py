#!/usr/bin/env python3
"""Synthetic correctness fixtures and CLI smoke tests for Phase 3 evaluation harness."""

from __future__ import annotations

import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter
import score


class Phase3HarnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = Path(__file__).resolve().parents[3]
        cls.clec_bin = cls.repo_root / "native" / "target" / "release" / "clec"
        cls.pub_bin = cls.repo_root / "native" / "target" / "release" / "clec-publish"
        if not cls.clec_bin.is_file() or not cls.pub_bin.is_file():
            raise unittest.SkipTest("Release binaries clec / clec-publish are not built")

        cls.tmp_ctx = tempfile.TemporaryDirectory(prefix="clec-phase3-test-")
        cls.tmp = Path(cls.tmp_ctx.name)
        cls.ws = cls.tmp / "ws"
        cls.ws.mkdir()

        # Work 1: canonical .srt + collapsed .txt with repeated phrase for wrong-occurrence testing
        srt_text = (
            "1\n00:00:01,000 --> 00:00:03,000\n"
            "第一段重複關鍵句出現於開頭。\n\n"
            "2\n00:00:04,000 --> 00:00:06,000\n"
            "第二段核心條件：若無稅務問題才能匯回臺灣。\n\n"
            "3\n00:00:07,000 --> 00:00:09,000\n"
            "第三段重複關鍵句出現於結尾。\n"
        )
        txt_text = (
            "第一段重複關鍵句出現於開頭。\n"
            "第二段核心條件：若無稅務問題才能匯回臺灣。\n"
            "第三段重複關鍵句出現於結尾。\n"
        )
        (cls.ws / "ep1.srt").write_text(srt_text, encoding="utf-8")
        (cls.ws / "ep1.txt").write_text(txt_text, encoding="utf-8")

        # Work 1 summary (different role, has counterexample + repeated sentence)
        (cls.ws / "ep1_summary.txt").write_text(
            "反例說明：2022年討論融資時曾說不應留現金。\n",
            encoding="utf-8",
        )

        # Work 2 & Work 3: identical filename and identical body across distinct works (must never alias)
        shared_body = "不同作品的同名檔案內容完全相同：資產配置0050與QQQ。\n"
        (cls.ws / "shared.txt").write_text(shared_body, encoding="utf-8")
        (cls.ws / "other").mkdir()
        (cls.ws / "other" / "shared.txt").write_text(shared_body, encoding="utf-8")

        # Work 4: two occurrences of the exact same phrase in one plain-text source
        dup_occ = "重複片語測試目標。\n\n中間隔開很多無關文字。" + ("填充內容" * 400) + "\n\n重複片語測試目標。\n"
        (cls.ws / "dup_occ.txt").write_text(dup_occ, encoding="utf-8")

        intake = cls.tmp / "intake.json"
        intake.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "works": [
                        {"key": "w:ep1", "title": "Episode 1"},
                        {"key": "w:alpha", "title": "Work Alpha"},
                        {"key": "w:beta", "title": "Work Beta"},
                        {"key": "w:dup", "title": "Duplicate Occurrence Work"},
                    ],
                    "sources": [
                        {
                            "work": "w:ep1",
                            "path": "ep1.srt",
                            "title": "Ep1 SRT",
                            "role": "transcript",
                            "attribution": "machine_unverified",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:ep1",
                            "path": "ep1.txt",
                            "title": "Ep1 TXT",
                            "role": "transcript",
                            "attribution": "machine_unverified",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:ep1",
                            "path": "ep1_summary.txt",
                            "title": "Ep1 Summary",
                            "role": "summary",
                            "attribution": "original_unknown",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:alpha",
                            "path": "shared.txt",
                            "title": "Shared",
                            "role": "document",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:beta",
                            "path": "other/shared.txt",
                            "title": "Shared",
                            "role": "document",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:dup",
                            "path": "dup_occ.txt",
                            "title": "Dup Occ",
                            "role": "document",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        },
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        cls.rel_dir = cls.tmp / "release"
        pub = subprocess.run(
            [str(cls.pub_bin), "--workspace", str(cls.ws), "--intake", str(intake), "--output", str(cls.rel_dir)],
            capture_output=True,
            text=True,
            check=True,
        )
        cls.manifest = json.loads(pub.stdout)
        cls.corpus_sha = cls.manifest["sha256"]
        cls.data_dir = cls.tmp / "data"
        subprocess.run(
            [str(cls.clec_bin), "--data-dir", str(cls.data_dir), "sync", "--manifest", str(cls.rel_dir / "manifest.json")],
            capture_output=True,
            text=True,
            check=True,
        )
        cls.db_path = cls.data_dir / f"{cls.corpus_sha}.sqlite"
        cls.corpus = score.CorpusIndexView(cls.db_path, cls.corpus_sha)

        cls.sid_by_path = {v["path"]: sid for sid, v in cls.corpus.sources.items()}
        cls.p_by_path: dict[str, list[dict[str, object]]] = {}
        for p_res_q in ("核心條件", "2022年討論", "0050", "重複片語測試目標"):
            p = subprocess.run(
                [str(cls.clec_bin), "--data-dir", str(cls.data_dir), "--json", "search", p_res_q],
                capture_output=True,
                text=True,
                check=True,
            )
            for hit in json.loads(p.stdout)["data"]["hits"]:
                cls.p_by_path.setdefault(hit["source"]["path"], []).append(hit)

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "tmp_ctx"):
            cls.tmp_ctx.cleanup()

    def _span_for(self, path: str, needle: str, occurrence: int = 0) -> tuple[str, dict[str, int]]:
        sid = self.sid_by_path[path]
        raw = self.corpus.raw_bytes_for_source(sid)
        n_bytes = needle.encode("utf-8")
        pos = -1
        start = 0
        for _ in range(occurrence + 1):
            pos = raw.index(n_bytes, start)
            start = pos + len(n_bytes)
        return sid, {"startByte": pos, "endByte": pos + len(n_bytes)}

    def test_missing_hop_and_and_necessity_within_claim(self) -> None:
        sid_srt, sp1 = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        sid_sum, sp2 = self._span_for("ep1_summary.txt", "曾說不應留現金")
        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-two-hop",
                    "category": "multi_hop",
                    "question": "匯回臺灣的條件與2022年反例為何？",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_srt,
                            "path": "ep1.srt",
                            "spans": [sp1],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "condition",
                        },
                        {
                            "claimId": "c1",
                            "sourceId": sid_sum,
                            "path": "ep1_summary.txt",
                            "spans": [sp2],
                            "quote": "曾說不應留現金",
                            "kind": "counterexample",
                        },
                    ],
                }
            ],
        }
        only_hop1 = [{"id": "q-two-hop", "status": "completed", "hits": [self.p_by_path["ep1.srt"][0]], "reads": []}]
        summary = score.summarize_evaluation(dataset, only_hop1, self.corpus, self.corpus_sha)
        row = summary["perQuestion"][0]
        self.assertEqual(row["evidenceCoverage"], 0.5)
        self.assertFalse(row["completeChain"])
        self.assertEqual(row["counterexampleLoss"], 1)
        self.assertFalse(summary["gates"]["zeroCriticalConditionLoss"])

    def test_wrong_occurrence_in_same_source_fails_despite_matching_quote_string(self) -> None:
        sid_dup, sp_second = self._span_for("dup_occ.txt", "重複片語測試目標", occurrence=1)
        dup_hits = sorted(self.p_by_path["dup_occ.txt"], key=lambda h: h["ordinal"])
        first_passage_hit = dup_hits[0]
        self.assertEqual(first_passage_hit["ordinal"], 0)

        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-wrong-occ",
                    "category": "exact_occurrence",
                    "question": "重複片語第二次出現的位置？",
                    "answerable": True,
                    "workKeys": ["w:dup"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_dup,
                            "path": "dup_occ.txt",
                            "spans": [sp_second],
                            "quote": "重複片語測試目標",
                            "kind": "required",
                        }
                    ],
                }
            ],
        }
        summary = score.summarize_evaluation(
            dataset,
            [{"id": "q-wrong-occ", "status": "completed", "hits": [first_passage_hit], "reads": []}],
            self.corpus,
            self.corpus_sha,
        )
        row = summary["perQuestion"][0]
        self.assertEqual(row["evidenceCoverage"], 0.0)
        self.assertFalse(row["completeChain"])

        # Also verify wrong-occurrence across canonical alias (.txt -> .srt):
        # "重複關鍵句" appears in cue 1 and cue 3 of ep1.srt; hitting only cue 1 must NOT cover cue 3 in ep1.txt.
        sid_ep1_txt, sp_txt_end = self._span_for("ep1.txt", "重複關鍵句出現於結尾")
        sid_ep1_srt, sp_srt_cue1 = self._span_for("ep1.srt", "第一段重複關鍵句出現於開頭")
        cue1_only_hit = {
            "source": {"sourceId": sid_ep1_srt},
            "spans": [sp_srt_cue1],
            "text": "第一段重複關鍵句出現於開頭",
        }
        alias_occ_ds = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-alias-wrong-occ",
                    "category": "alias_occurrence",
                    "question": "結尾重複句？",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_ep1_txt,
                            "path": "ep1.txt",
                            "spans": [sp_txt_end],
                            "quote": "重複關鍵句出現於結尾",
                            "kind": "required",
                        }
                    ],
                }
            ],
        }
        alias_occ_summary = score.summarize_evaluation(
            alias_occ_ds,
            [{"id": "q-alias-wrong-occ", "status": "completed", "hits": [cue1_only_hit], "reads": []}],
            self.corpus,
            self.corpus_sha,
        )
        self.assertFalse(alias_occ_summary["perQuestion"][0]["completeChain"])
        self.assertEqual(alias_occ_summary["perQuestion"][0]["evidenceCoverage"], 0.0)

    def test_canonical_alias_proof_matches_same_work_not_other_work_same_filename(self) -> None:
        sid_txt, sp_txt = self._span_for("ep1.txt", "若無稅務問題才能匯回臺灣")
        sid_beta, sp_beta = self._span_for("other/shared.txt", "資產配置0050與QQQ")
        alpha_hit = self.p_by_path["shared.txt"][0]
        ep1_srt_hit = self.p_by_path["ep1.srt"][0]

        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-canon-alias",
                    "category": "alias",
                    "question": "ep1 匯回條件？",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_txt,
                            "path": "ep1.txt",
                            "spans": [sp_txt],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-same-name-diff-work",
                    "category": "false_friend",
                    "question": "Beta 資產配置？",
                    "answerable": True,
                    "workKeys": ["w:beta"],
                    "evidence": [
                        {
                            "claimId": "c2",
                            "sourceId": sid_beta,
                            "path": "other/shared.txt",
                            "spans": [sp_beta],
                            "quote": "資產配置0050與QQQ",
                            "kind": "required",
                        }
                    ],
                },
            ],
        }
        outcomes = [
            {"id": "q-canon-alias", "status": "completed", "hits": [ep1_srt_hit], "reads": []},
            {"id": "q-same-name-diff-work", "status": "completed", "hits": [alpha_hit], "reads": []},
        ]
        summary = score.summarize_evaluation(dataset, outcomes, self.corpus, self.corpus_sha)
        self.assertTrue(summary["perQuestion"][0]["completeChain"])
        self.assertFalse(summary["perQuestion"][1]["completeChain"])
        self.assertEqual(summary["perQuestion"][1]["evidenceCoverage"], 0.0)

    def test_summary_as_quote_and_wrong_range_fail_citation_gate(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        bad_hit = dict(self.p_by_path["ep1.srt"][0])
        bad_hit["text"] = "這是一段改寫摘要而不是原文"
        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-fab",
                    "category": "provenance",
                    "question": "稅務條件？",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_srt,
                            "path": "ep1.srt",
                            "spans": [sp_srt],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "required",
                        }
                    ],
                }
            ],
        }
        summary = score.summarize_evaluation(
            dataset,
            [{"id": "q-fab", "status": "completed", "hits": [bad_hit], "reads": []}],
            self.corpus,
            self.corpus_sha,
        )
        self.assertFalse(summary["perQuestion"][0]["citationRawSpanValid"])
        self.assertFalse(summary["perQuestion"][0]["completeChain"])
        self.assertFalse(summary["gates"]["zeroRawQuoteFabricationOrWrongRange"])

    def test_overbudget_cannot_skip_oversized_first_hit_and_distinguishes_bytes_from_tokens(self) -> None:
        sid_sum, sp_sum = self._span_for("ep1_summary.txt", "曾說不應留現金")
        large_hit = self.p_by_path["ep1.srt"][0]
        small_hit = self.p_by_path["ep1_summary.txt"][0]
        large_len = len(json.dumps(large_hit, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        small_len = len(json.dumps(small_hit, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        budget = max(small_len + 10, large_len - 1)
        self.assertLess(budget, large_len)

        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-budget",
                    "category": "budget",
                    "question": "2022反例？",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_sum,
                            "path": "ep1_summary.txt",
                            "spans": [sp_sum],
                            "quote": "曾說不應留現金",
                            "kind": "required",
                        }
                    ],
                }
            ],
        }
        summary = score.summarize_evaluation(
            dataset,
            [{"id": "q-budget", "status": "completed", "hits": [large_hit, small_hit], "reads": []}],
            self.corpus,
            self.corpus_sha,
            stdout_byte_budget=budget,
        )
        row = summary["perQuestion"][0]
        self.assertEqual(row["serializedHitsUtf8Bytes"], 0)
        self.assertIsNone(row["tokenBudget"])
        self.assertIn("not tokens", row["tokenMetricNote"])
        self.assertFalse(row["completeChain"])

    def test_errors_timeouts_and_unanswerable_and_ground_truth_mismatch(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-timeout",
                    "category": "error",
                    "question": "稅務條件？",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_srt,
                            "path": "ep1.srt",
                            "spans": [sp_srt],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "required",
                        }
                    ],
                },
                {
                    "id": "q-unans",
                    "category": "unanswerable",
                    "question": "星際橙子基金何時發行？",
                    "answerable": False,
                    "workKeys": [],
                    "evidence": [],
                },
            ],
        }
        outcomes = [
            {"id": "q-timeout", "status": "timeout", "stopReason": "search_timeout_0.05s", "hits": [], "reads": []},
            {"id": "q-unans", "status": "completed", "hits": [self.p_by_path["ep1.srt"][0]], "reads": []},
        ]
        summary = score.summarize_evaluation(dataset, outcomes, self.corpus, self.corpus_sha)
        self.assertEqual(summary["verdict"], "inconclusive_errors_present")
        self.assertEqual(summary["counts"]["scheduledQuestions"], 2)
        self.assertEqual(summary["counts"]["errorsOrTimeouts"], 1)
        self.assertIsNone(summary["perQuestion"][0]["evidenceCoverage"])
        self.assertEqual(summary["perQuestion"][0]["stopReason"], "search_timeout_0.05s")
        self.assertIsNone(summary["perQuestion"][1]["completeChain"])
        self.assertEqual(summary["counts"]["completeChainRateAllScheduledAnswerable"], 0.0)

        bad_sha_ds = dict(dataset, corpusSha256="0" * 64)
        self.assertEqual(
            score.summarize_evaluation(bad_sha_ds, outcomes, self.corpus, self.corpus_sha)["verdict"],
            "inconclusive",
        )
        bad_quote_ds = json.loads(json.dumps(dataset))
        bad_quote_ds["questions"][0]["evidence"][0]["quote"] = "竄改過的標準引文"
        self.assertEqual(
            score.summarize_evaluation(bad_quote_ds, outcomes, self.corpus, self.corpus_sha)["verdict"],
            "inconclusive",
        )

    def test_adapter_timeout_and_blind_query_gold_leak_rejection(self) -> None:
        slow_bin = self.tmp / "slow-clec.sh"
        slow_bin.write_text("#!/bin/sh\nsleep 1\n", encoding="utf-8")
        slow_bin.chmod(slow_bin.stat().st_mode | stat.S_IXUSR)
        rec = adapter.run_clec_command(
            slow_bin,
            ["search", "test"],
            data_dir=self.data_dir,
            max_bytes=65536,
            timeout_sec=0.05,
        )
        self.assertTrue(rec["timedOut"])

        leaky_blind = self.tmp / "leaky.json"
        leaky_blind.write_text(json.dumps([{"id": "q1", "queries": ["test"], "quote": "leak"}]), encoding="utf-8")
        with self.assertRaises(ValueError):
            adapter.load_blind_queries(leaky_blind)

    def test_cli_smoke_eval_and_bench_end_to_end(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        sid_txt, sp_txt = self._span_for("ep1.txt", "若無稅務問題才能匯回臺灣")
        dataset_path = self.tmp / "smoke-dataset.json"
        dataset_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "corpusSha256": self.corpus_sha,
                    "split": "development",
                    "questions": [
                        {
                            "id": "smoke-1",
                            "category": "condition",
                            "question": "匯回臺灣 稅務問題",
                            "answerable": True,
                            "workKeys": ["w:ep1"],
                            "evidence": [
                                {
                                    "claimId": "c1",
                                    "alternativeGroup": "g1",
                                    "sourceId": sid_srt,
                                    "path": "ep1.srt",
                                    "spans": [sp_srt],
                                    "quote": "若無稅務問題才能匯回臺灣",
                                    "kind": "condition",
                                },
                                {
                                    "claimId": "c1",
                                    "alternativeGroup": "g1",
                                    "sourceId": sid_txt,
                                    "path": "ep1.txt",
                                    "spans": [sp_txt],
                                    "quote": "若無稅務問題才能匯回臺灣",
                                    "kind": "condition",
                                },
                            ],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        blind_path = self.tmp / "smoke-blind.json"
        blind_path.write_text(
            json.dumps([{"id": "smoke-1", "queries": ["匯回臺灣 稅務問題", "稅務 問題"]}], ensure_ascii=False),
            encoding="utf-8",
        )
        eval_py = Path(__file__).resolve().parent / "eval.py"
        bench_py = Path(__file__).resolve().parent / "bench.py"
        out_report = self.tmp / "smoke-eval-report.json"
        raw_logs = self.tmp / "smoke-raw-logs.jsonl"
        outcomes_out = self.tmp / "smoke-outcomes.json"

        subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "validate-dataset",
                "--dataset",
                str(dataset_path),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "run",
                "--clec",
                str(self.clec_bin),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
                "--dataset",
                str(dataset_path),
                "--mode",
                "rrf_multiquery",
                "--query-angle",
                "blind_rewrite",
                "--blind-queries",
                str(blind_path),
                "--read-top-n",
                "1",
                "--raw-logs",
                str(raw_logs),
                "--outcomes-out",
                str(outcomes_out),
                "--output",
                str(out_report),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        rep = json.loads(out_report.read_text(encoding="utf-8"))
        self.assertEqual(rep["verdict"], "complete")
        self.assertEqual(rep["counts"]["completeChains"], 1)
        self.assertTrue(all(rep["gates"].values()))

        bench_out = self.tmp / "smoke-bench.json"
        subprocess.run(
            [
                sys.executable,
                str(bench_py),
                "--clec",
                str(self.clec_bin),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
                "--dataset",
                str(dataset_path),
                "--blind-queries",
                str(blind_path),
                "--query-angle",
                "blind_rewrite",
                "--repeats",
                "2",
                "--allow-smoke-repeats",
                "--output",
                str(bench_out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        bench_rep = json.loads(bench_out.read_text(encoding="utf-8"))
        self.assertEqual(bench_rep["wholeProcessCli"]["default_bm25"]["errorCount"], 0)
        self.assertEqual(bench_rep["wholeProcessCli"]["rrf_multiquery"]["errorCount"], 0)
        self.assertGreater(bench_rep["sqliteOnlyProbe"]["elapsedSeconds"]["median"], 0.0)


if __name__ == "__main__":
    unittest.main()
