#!/usr/bin/env python3
"""Synthetic correctness fixtures, bad controls, and CLI smoke tests for Phase 3 evaluation harness."""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
import contextlib
import copy
import dataclasses
import hashlib
import inspect
import io
import json
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from typing import Any, TypedDict, cast
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter
import bench
import eval as phase3_eval
import projection
import score


class _CliStepDict(TypedDict):
    step: str
    argv: list[str]
    exitCode: int | None
    timedOut: bool
    elapsedSeconds: float
    stdoutUtf8: str
    stderrUtf8: str


def _adapter_search_argv(
    clec_bin: Path | str,
    data_dir: Path | str,
    queries: list[str],
    release_sha: str,
    *,
    match_mode: str = "any",
    limit: int = 5,
    per_work: int = 2,
    max_bytes: int = 65536,
) -> list[str]:
    return [
        str(clec_bin),
        "--data-dir",
        str(data_dir),
        "--offline",
        "--json",
        "--max-bytes",
        str(max_bytes),
        "search",
        *queries,
        "--match-mode",
        match_mode,
        "--limit",
        str(limit),
        "--per-work",
        str(per_work),
        "--release",
        release_sha,
    ]


def _adapter_read_argv(
    clec_bin: Path | str,
    data_dir: Path | str,
    passage_ids: list[str],
    *,
    context: int = 1,
    max_bytes: int = 65536,
) -> list[str]:
    return [
        str(clec_bin),
        "--data-dir",
        str(data_dir),
        "--offline",
        "--json",
        "--max-bytes",
        str(max_bytes),
        "read",
        *passage_ids,
        "--context",
        str(context),
    ]


def _make_v2_outcome(
    qid: str,
    steps: list[_CliStepDict],
    *,
    queries: list[str],
    status: str = "completed",
    stop_reason: str | None = None,
    mode: str = "single_query_product_baseline",
    query_angle: str = "question",
) -> dict[str, object]:
    return {
        "outcomeSchemaVersion": 2,
        "id": qid,
        "mode": mode,
        "queryAngle": query_angle,
        "queries": queries,
        "status": status,
        "stopReason": stop_reason,
        "steps": steps,
    }


def _make_cli_step(
    step_name: str,
    release_sha: str,
    payload_items: list[dict[str, object]],
    *,
    argv: list[str],
    extra_data: dict[str, object] | None = None,
    exit_code: int | None = 0,
    timed_out: bool = False,
    stderr_utf8: str = "",
) -> _CliStepDict:
    data: dict[str, object] = {"release": release_sha}
    if step_name == "search":
        data["hits"] = payload_items
    else:
        data["items"] = payload_items
    if extra_data:
        data.update(extra_data)
    stdout_utf8 = json.dumps(
        {"schemaVersion": 1, "ok": True, "command": step_name, "data": data},
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"
    return {
        "step": step_name,
        "argv": argv,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "elapsedSeconds": 0.001,
        "stdoutUtf8": stdout_utf8,
        "stderrUtf8": stderr_utf8,
    }


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

        filler = "無關背景說明內容。" * 250
        srt_text = (
            "1\n00:00:01,000 --> 00:00:03,000\n"
            "第一段重複關鍵句出現於開頭。\n\n"
            f"2\n00:00:04,000 --> 00:00:06,000\n{filler}\n\n"
            "3\n00:00:07,000 --> 00:00:09,000\n"
            "第二段核心條件：若無稅務問題才能匯回臺灣。\n\n"
            "4\n00:00:10,000 --> 00:00:12,000\n"
            "第三段重複關鍵句出現於結尾。\n"
        )
        txt_text = (
            "第一段重複關鍵句出現於開頭。\n"
            f"{filler}\n"
            "第二段核心條件：若無稅務問題才能匯回臺灣。\n"
            "第三段重複關鍵句出現於結尾。\n"
        )
        md_text = (
            "# 語音筆記：Episode 1\n\n"
            "## [00:00:01.000 – 00:00:03.000]\n"
            "第一段重複關鍵句出現於開頭。\n\n"
            f"## [00:00:04.000 – 00:00:06.000]\n{filler}\n\n"
            "## [00:00:07.000 – 00:00:09.000]\n"
            "第二段核心條件：若無稅務問題才能匯回臺灣。\n\n"
            "## [00:00:10.000 – 00:00:12.000]\n"
            "第三段重複關鍵句出現於結尾。\n"
        )
        (cls.ws / "ep1.srt").write_text(srt_text, encoding="utf-8")
        (cls.ws / "ep1.txt").write_text(txt_text, encoding="utf-8")
        (cls.ws / "ep1.md").write_text(md_text, encoding="utf-8")

        (cls.ws / "ep1_summary.txt").write_text(
            "反例說明：2022年討論融資時曾說不應留現金。\n",
            encoding="utf-8",
        )

        shared_body = "不同作品的同名檔案內容完全相同：資產配置0050與QQQ。\n"
        (cls.ws / "shared.txt").write_text(shared_body, encoding="utf-8")
        (cls.ws / "other").mkdir()
        (cls.ws / "other" / "shared.txt").write_text(shared_body, encoding="utf-8")

        dup_occ = "重複片語測試目標。\n\n中間隔開很多無關文字。" + ("填充內容" * 400) + "\n\n重複片語測試目標。\n"
        (cls.ws / "dup_occ.txt").write_text(dup_occ, encoding="utf-8")

        (cls.ws / "zh_canon.srt").write_text(
            "1\n00:00:01,000 --> 00:00:03,000\n" + ("甲" * 100 + "乙" * 2000) + "\n",
            encoding="utf-8",
        )
        (cls.ws / "zh_alias.txt").write_text("甲" * 100 + "乙" * 2000 + "\n", encoding="utf-8")

        (cls.ws / "en_canon.srt").write_text(
            "1\n00:00:01,000 --> 00:00:03,000\n" + ("abcdefghij" + "z" * 2000) + "\n",
            encoding="utf-8",
        )
        (cls.ws / "en_alias.txt").write_text("abcdefghij" + "z" * 2000 + "\n", encoding="utf-8")

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
                        {"key": "w:zh", "title": "Chinese Subrange Work"},
                        {"key": "w:en", "title": "English Subrange Work"},
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
                            "path": "ep1.md",
                            "title": "Ep1 MD",
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
                        {
                            "work": "w:zh",
                            "path": "zh_canon.srt",
                            "title": "ZH Canon",
                            "role": "transcript",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:zh",
                            "path": "zh_alias.txt",
                            "title": "ZH Alias",
                            "role": "transcript",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:en",
                            "path": "en_canon.srt",
                            "title": "EN Canon",
                            "role": "transcript",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        },
                        {
                            "work": "w:en",
                            "path": "en_alias.txt",
                            "title": "EN Alias",
                            "role": "transcript",
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
        for p_res_q in ("核心條件", "重複關鍵句", "2022年討論", "0050", "重複片語測試目標", "abcdefghij"):
            p = subprocess.run(
                [str(cls.clec_bin), "--data-dir", str(cls.data_dir), "--json", "search", p_res_q],
                capture_output=True,
                text=True,
                check=True,
            )
            for hit in json.loads(p.stdout)["data"]["hits"]:
                path = hit["source"]["path"]
                existing_ids = {h["passageId"] for h in cls.p_by_path.setdefault(path, [])}
                if hit["passageId"] not in existing_ids:
                    cls.p_by_path[path].append(hit)

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "corpus"):
            cls.corpus.close()
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

    def test_projection_rejects_partial_disjoint_and_accepts_subrange_and_whitespace_equiv(self) -> None:
        zh_raw = ("甲" * 100 + "乙" * 900).encode("utf-8")
        zh_proj = projection.project_source(zh_raw, "plain_text")
        self.assertFalse(
            projection.intervals_cover(zh_proj.project_byte_spans([(0, 300)]), zh_proj.project_byte_spans([(0, 3000)])[0])
        )
        self.assertTrue(
            projection.intervals_cover(zh_proj.project_byte_spans([(0, 600)]), zh_proj.project_byte_spans([(150, 450)])[0])
        )

        en_raw = b"abcdefghij"
        en_proj = projection.project_source(en_raw, "plain_text")
        self.assertFalse(
            projection.intervals_cover(en_proj.project_byte_spans([(0, 1)]), en_proj.project_byte_spans([(0, 10)])[0])
        )
        self.assertFalse(
            projection.intervals_cover(en_proj.project_byte_spans([(0, 1)]), en_proj.project_byte_spans([(5, 10)])[0])
        )
        self.assertTrue(
            projection.intervals_cover(en_proj.project_byte_spans([(0, 5)]), en_proj.project_byte_spans([(1, 4)])[0])
        )

        ws_a = projection.project_source(b"alpha   \n\t  beta  gamma", "plain_text")
        ws_b = projection.project_source(b"alpha beta\ngamma", "plain_text")
        self.assertEqual(ws_a.equivalence_hash, ws_b.equivalence_hash)
        self.assertEqual(ws_a.project_byte_spans([(0, len(b"alpha   \n\t  beta"))]), ws_b.project_byte_spans([(0, len(b"alpha beta"))]))

        with self.assertRaises(ValueError):
            zh_proj.project_byte_spans([(0, 1)])

    def test_partial_subrange_and_disjoint_subrange_controls_via_canonical_alias(self) -> None:
        sid_zh_alias, sp_zh_full = self._span_for("zh_alias.txt", "甲" * 100 + "乙" * 2000)
        _, sp_zh_head = self._span_for("zh_alias.txt", "甲" * 100)
        _, sp_zh_tail = self._span_for("zh_alias.txt", "乙" * 100)
        sid_en_alias, sp_en_full = self._span_for("en_alias.txt", "abcdefghij" + "z" * 2000)
        _, sp_en_head = self._span_for("en_alias.txt", "a")
        sp_en_tail_word = {"startByte": 2000, "endByte": 2010}
        _, sp_en_mid = self._span_for("en_alias.txt", "bcd")

        sid_zh_canon = self.sid_by_path["zh_canon.srt"]
        sid_en_canon = self.sid_by_path["en_canon.srt"]

        zh_pids = json.loads(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", sid_zh_canon],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )["data"]["items"][0]["passageIds"]
        self.assertEqual(len(zh_pids), 2)
        zh_p1_read = json.loads(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", zh_pids[1], "--context", "0"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )["data"]["items"][0]
        zh_p0_read = json.loads(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", zh_pids[0], "--context", "0"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )["data"]["items"][0]

        zh_partial_fail_ds = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "evaluation",
            "questions": [
                {
                    "id": "q-zh-partial-fail",
                    "question": "中文完整區間",
                    "answerable": True,
                    "workKeys": ["w:zh"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_zh_alias,
                            "path": "zh_alias.txt",
                            "spans": [sp_zh_full],
                            "quote": "甲" * 100 + "乙" * 2000,
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-zh-disjoint-fail",
                    "question": "中文不相交區間",
                    "answerable": True,
                    "workKeys": ["w:zh"],
                    "evidence": [
                        {
                            "claimId": "c2",
                            "sourceId": sid_zh_alias,
                            "path": "zh_alias.txt",
                            "spans": [sp_zh_head],
                            "quote": "甲" * 100,
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-zh-sub-pass",
                    "question": "中文部分子區間",
                    "answerable": True,
                    "workKeys": ["w:zh"],
                    "evidence": [
                        {
                            "claimId": "c3",
                            "sourceId": sid_zh_alias,
                            "path": "zh_alias.txt",
                            "spans": [sp_zh_tail],
                            "quote": "乙" * 100,
                            "kind": "condition",
                        }
                    ],
                },
            ],
        }
        zh_p0_hit = {k: v for k, v in zh_p0_read.items() if k not in ("kind", "context")}
        zh_p1_hit = {k: v for k, v in zh_p1_read.items() if k not in ("kind", "context")}
        zh_summary = score.summarize_evaluation(
            zh_partial_fail_ds,
            [
                _make_v2_outcome(
                    "q-zh-partial-fail",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [zh_p1_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["中文完整區間"], self.corpus_sha),
                        )
                    ],
                    queries=["中文完整區間"],
                ),
                _make_v2_outcome(
                    "q-zh-disjoint-fail",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [zh_p1_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["中文不相交區間"], self.corpus_sha),
                        )
                    ],
                    queries=["中文不相交區間"],
                ),
                _make_v2_outcome(
                    "q-zh-sub-pass",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [zh_p0_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["中文部分子區間"], self.corpus_sha),
                        )
                    ],
                    queries=["中文部分子區間"],
                ),
            ],
            self.corpus,
            self.corpus_sha,
        )
        self.assertEqual(zh_summary["perQuestion"][0]["evidenceCoverage"], 0.0)
        self.assertFalse(zh_summary["perQuestion"][0]["completeChain"])
        self.assertEqual(zh_summary["perQuestion"][1]["evidenceCoverage"], 0.0)
        self.assertFalse(zh_summary["perQuestion"][1]["completeChain"])
        self.assertTrue(zh_summary["perQuestion"][2]["completeChain"])

        en_pids = json.loads(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", sid_en_canon],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )["data"]["items"][0]["passageIds"]
        self.assertEqual(len(en_pids), 2)
        en_p0_read = json.loads(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", en_pids[0], "--context", "0"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )["data"]["items"][0]
        en_p1_read = json.loads(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", en_pids[1], "--context", "0"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )["data"]["items"][0]

        en_ds = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "evaluation",
            "questions": [
                {
                    "id": "q-en-partial-fail",
                    "question": "english full token",
                    "answerable": True,
                    "workKeys": ["w:en"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_en_alias,
                            "path": "en_alias.txt",
                            "spans": [sp_en_full],
                            "quote": "abcdefghij" + "z" * 2000,
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-en-disjoint-fail",
                    "question": "english disjoint within same word",
                    "answerable": True,
                    "workKeys": ["w:en"],
                    "evidence": [
                        {
                            "claimId": "c2",
                            "sourceId": sid_en_alias,
                            "path": "en_alias.txt",
                            "spans": [sp_en_head],
                            "quote": "a",
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-en-mid",
                    "question": "english subrange",
                    "answerable": True,
                    "workKeys": ["w:en"],
                    "evidence": [
                        {
                            "claimId": "c3",
                            "sourceId": sid_en_alias,
                            "path": "en_alias.txt",
                            "spans": [sp_en_mid],
                            "quote": "bcd",
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-en-tail",
                    "question": "english tail subrange",
                    "answerable": True,
                    "workKeys": ["w:en"],
                    "evidence": [
                        {
                            "claimId": "c4",
                            "sourceId": sid_en_alias,
                            "path": "en_alias.txt",
                            "spans": [sp_en_tail_word],
                            "quote": "z" * 10,
                            "kind": "condition",
                        }
                    ],
                },
            ],
        }
        en_p0_hit = {k: v for k, v in en_p0_read.items() if k not in ("kind", "context")}
        en_p1_hit = {k: v for k, v in en_p1_read.items() if k not in ("kind", "context")}
        en_summary = score.summarize_evaluation(
            en_ds,
            [
                _make_v2_outcome(
                    "q-en-partial-fail",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [en_p1_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["english full token"], self.corpus_sha),
                        )
                    ],
                    queries=["english full token"],
                ),
                _make_v2_outcome(
                    "q-en-disjoint-fail",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [en_p1_hit],
                            argv=_adapter_search_argv(
                                self.clec_bin, self.data_dir, ["english disjoint within same word"], self.corpus_sha
                            ),
                        )
                    ],
                    queries=["english disjoint within same word"],
                ),
                _make_v2_outcome(
                    "q-en-mid",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [en_p0_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["english subrange"], self.corpus_sha),
                        )
                    ],
                    queries=["english subrange"],
                ),
                _make_v2_outcome(
                    "q-en-tail",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [en_p1_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["english tail subrange"], self.corpus_sha),
                        )
                    ],
                    queries=["english tail subrange"],
                ),
            ],
            self.corpus,
            self.corpus_sha,
        )
        self.assertEqual(en_summary["perQuestion"][0]["evidenceCoverage"], 0.0)
        self.assertFalse(en_summary["perQuestion"][0]["completeChain"])
        self.assertEqual(en_summary["perQuestion"][1]["evidenceCoverage"], 0.0)
        self.assertFalse(en_summary["perQuestion"][1]["completeChain"])
        self.assertTrue(en_summary["perQuestion"][2]["completeChain"])
        self.assertTrue(en_summary["perQuestion"][3]["completeChain"])

    def test_missing_hop_and_and_necessity_within_claim(self) -> None:
        sid_srt, sp1 = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        sid_sum, sp2 = self._span_for("ep1_summary.txt", "曾說不應留現金")
        ep1_cond_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])
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
        only_hop1 = [
            _make_v2_outcome(
                "q-two-hop",
                [
                    _make_cli_step(
                        "search",
                        self.corpus_sha,
                        [ep1_cond_hit],
                        argv=_adapter_search_argv(
                            self.clec_bin, self.data_dir, ["匯回臺灣的條件與2022年反例為何？"], self.corpus_sha
                        ),
                    )
                ],
                queries=["匯回臺灣的條件與2022年反例為何？"],
            )
        ]
        summary = score.summarize_evaluation(dataset, only_hop1, self.corpus, self.corpus_sha)
        row = summary["perQuestion"][0]
        self.assertEqual(row["evidenceCoverage"], 0.5)
        self.assertFalse(row["completeChain"])
        self.assertEqual(row["counterexampleLoss"], 1)
        self.assertFalse(summary["gates"]["zeroCriticalConditionLoss"])

    def test_wrong_occurrence_in_same_source_and_across_canonical_alias_fails(self) -> None:
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
            [
                _make_v2_outcome(
                    "q-wrong-occ",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [first_passage_hit],
                            argv=_adapter_search_argv(
                                self.clec_bin, self.data_dir, ["重複片語第二次出現的位置？"], self.corpus_sha
                            ),
                        )
                    ],
                    queries=["重複片語第二次出現的位置？"],
                )
            ],
            self.corpus,
            self.corpus_sha,
        )
        row = summary["perQuestion"][0]
        self.assertEqual(row["evidenceCoverage"], 0.0)
        self.assertFalse(row["completeChain"])

        sid_ep1_txt, sp_txt_end = self._span_for("ep1.txt", "重複關鍵句出現於結尾")
        sid_ep1_md, sp_md_cond = self._span_for("ep1.md", "若無稅務問題才能匯回臺灣")
        ep1_first_passage = sorted(self.p_by_path["ep1.srt"], key=lambda h: h["ordinal"])[0]
        self.assertIn("第一段重複關鍵句出現於開頭", ep1_first_passage["text"])
        self.assertNotIn("第三段重複關鍵句出現於結尾", ep1_first_passage["text"])

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
            [
                _make_v2_outcome(
                    "q-alias-wrong-occ",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [ep1_first_passage],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["結尾重複句？"], self.corpus_sha),
                        )
                    ],
                    queries=["結尾重複句？"],
                )
            ],
            self.corpus,
            self.corpus_sha,
        )
        self.assertFalse(alias_occ_summary["perQuestion"][0]["completeChain"])
        self.assertEqual(alias_occ_summary["perQuestion"][0]["evidenceCoverage"], 0.0)

        ep1_cond_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])
        md_alias_ds = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-md-alias",
                    "category": "alias_md",
                    "question": "md 條件",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_ep1_md,
                            "path": "ep1.md",
                            "spans": [sp_md_cond],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "condition",
                        }
                    ],
                }
            ],
        }
        md_res = score.summarize_evaluation(
            md_alias_ds,
            [
                _make_v2_outcome(
                    "q-md-alias",
                    [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [ep1_cond_hit],
                            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["md 條件"], self.corpus_sha),
                        )
                    ],
                    queries=["md 條件"],
                )
            ],
            self.corpus,
            self.corpus_sha,
        )
        self.assertTrue(md_res["perQuestion"][0]["completeChain"])

    def test_canonical_alias_proof_matches_same_work_not_other_work_same_filename(self) -> None:
        sid_txt, sp_txt = self._span_for("ep1.txt", "若無稅務問題才能匯回臺灣")
        sid_beta, sp_beta = self._span_for("other/shared.txt", "資產配置0050與QQQ")
        alpha_hit = self.p_by_path["shared.txt"][0]
        ep1_cond_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])

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
            _make_v2_outcome(
                "q-canon-alias",
                [
                    _make_cli_step(
                        "search",
                        self.corpus_sha,
                        [ep1_cond_hit],
                        argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["ep1 匯回條件？"], self.corpus_sha),
                    )
                ],
                queries=["ep1 匯回條件？"],
            ),
            _make_v2_outcome(
                "q-same-name-diff-work",
                [
                    _make_cli_step(
                        "search",
                        self.corpus_sha,
                        [alpha_hit],
                        argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["Beta 資產配置？"], self.corpus_sha),
                    )
                ],
                queries=["Beta 資產配置？"],
            ),
        ]
        summary = score.summarize_evaluation(dataset, outcomes, self.corpus, self.corpus_sha)
        self.assertTrue(summary["perQuestion"][0]["completeChain"])
        self.assertFalse(summary["perQuestion"][1]["completeChain"])
        self.assertEqual(summary["perQuestion"][1]["evidenceCoverage"], 0.0)

    def test_provenance_spoofing_and_invalid_citation_give_zero_coverage_and_fail_gates(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        valid_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])
        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-prov",
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
                            "kind": "condition",
                        }
                    ],
                }
            ],
        }

        prov_search_argv = _adapter_search_argv(self.clec_bin, self.data_dir, ["稅務條件？"], self.corpus_sha)
        fabricated = copy.deepcopy(valid_hit)
        fabricated["text"] = "這是一段改寫摘要而不是原文"
        fab_summary = score.summarize_evaluation(
            dataset,
            [_make_v2_outcome("q-prov", [_make_cli_step("search", self.corpus_sha, [fabricated], argv=prov_search_argv)], queries=["稅務條件？"])],
            self.corpus,
            self.corpus_sha,
        )
        fab_row = fab_summary["perQuestion"][0]
        self.assertFalse(fab_row["citationRawSpanValid"])
        self.assertFalse(fab_row["completeChain"])
        self.assertEqual(fab_row["evidenceCoverage"], 0.0)
        self.assertEqual(fab_row["conditionLoss"], 1)
        self.assertFalse(fab_summary["gates"]["zeroRawQuoteFabricationOrWrongRange"])
        self.assertFalse(fab_summary["gates"]["zeroCriticalConditionLoss"])

        spoof = copy.deepcopy(valid_hit)
        spoof["source"]["path"] = "wrong.txt"
        spoof["source"]["role"] = "summary"
        spoof["source"]["workId"] = "w_" + "0" * 24
        spoof["source"]["contentHash"] = "f" * 64
        spoof["passageId"] = "p_" + "9" * 24
        spoof["work"] = {"workId": "w_" + "0" * 24, "workKey": "fake"}
        spoof_summary = score.summarize_evaluation(
            dataset,
            [_make_v2_outcome("q-prov", [_make_cli_step("search", self.corpus_sha, [spoof], argv=prov_search_argv)], queries=["稅務條件？"])],
            self.corpus,
            self.corpus_sha,
        )
        spoof_row = spoof_summary["perQuestion"][0]
        self.assertFalse(spoof_row["citationRawSpanValid"])
        self.assertFalse(spoof_row["completeChain"])
        self.assertEqual(spoof_row["evidenceCoverage"], 0.0)
        self.assertEqual(spoof_row["conditionLoss"], 1)

        bad_tail = copy.deepcopy(valid_hit)
        bad_tail["text"] = "outside-topk-fabrication"
        mixed_summary = score.summarize_evaluation(
            dataset,
            [_make_v2_outcome("q-prov", [_make_cli_step("search", self.corpus_sha, [valid_hit, bad_tail], argv=prov_search_argv)], queries=["稅務條件？"])],
            self.corpus,
            self.corpus_sha,
            top_k=1,
        )
        self.assertFalse(mixed_summary["perQuestion"][0]["citationRawSpanValid"])
        self.assertFalse(mixed_summary["perQuestion"][0]["completeChain"])
        self.assertFalse(mixed_summary["gates"]["zeroRawQuoteFabricationOrWrongRange"])

        overview_proc = subprocess.run(
            [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", sid_srt],
            capture_output=True,
            text=True,
            check=True,
        )
        overview_item = json.loads(overview_proc.stdout)["data"]["items"][0]
        overview_val, overview_errs = score.validate_returned_item(overview_item, self.corpus, item_index=0)
        self.assertIsNone(overview_val)
        self.assertEqual(overview_errs, [])

        orig_proc = subprocess.run(
            [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", self.sid_by_path["ep1.txt"], "--original"],
            capture_output=True,
            text=True,
            check=True,
        )
        orig_item = json.loads(orig_proc.stdout)["data"]["items"][0]
        orig_val, orig_errs = score.validate_returned_item(orig_item, self.corpus, item_index=0)
        self.assertIsNotNone(orig_val)
        self.assertEqual(orig_errs, [])

        spoof_orig_item = copy.deepcopy(orig_item)
        spoof_orig_item["originalText"] = "spoofed original text"
        spoof_orig_val, spoof_orig_errs = score.validate_returned_item(spoof_orig_item, self.corpus, item_index=0)
        self.assertIsNone(spoof_orig_val)
        self.assertGreater(len(spoof_orig_errs), 0)

        ep1_first = sorted(self.p_by_path["ep1.srt"], key=lambda h: h["ordinal"])[0]
        ctx_proc = subprocess.run(
            [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", ep1_first["passageId"], "--context", "1"],
            capture_output=True,
            text=True,
            check=True,
        )
        ctx_payload = json.loads(ctx_proc.stdout)
        self.assertGreaterEqual(len(ctx_payload["data"]["items"][0]["context"]), 1)
        ctx_payload["data"]["items"][0]["context"][0]["text"] = "spoofed context text"
        ctx_payload["data"].pop("budget", None)
        ctx_search_step = _make_cli_step("search", self.corpus_sha, [ep1_first], argv=prov_search_argv)
        ctx_spoof_step: _CliStepDict = {
            "step": "read",
            "argv": _adapter_read_argv(self.clec_bin, self.data_dir, [ep1_first["passageId"]]),
            "exitCode": 0,
            "timedOut": False,
            "elapsedSeconds": 0.001,
            "stdoutUtf8": json.dumps(ctx_payload, ensure_ascii=False, separators=(",", ":")) + "\n",
            "stderrUtf8": "",
        }
        ctx_spoof_res = score.summarize_evaluation(
            dataset,
            [_make_v2_outcome("q-prov", [ctx_search_step, ctx_spoof_step], queries=["稅務條件？"])],
            self.corpus,
            self.corpus_sha,
        )
        self.assertFalse(ctx_spoof_res["perQuestion"][0]["citationRawSpanValid"])
        self.assertEqual(ctx_spoof_res["perQuestion"][0]["evidenceCoverage"], 0.0)
        self.assertFalse(ctx_spoof_res["perQuestion"][0]["completeChain"])

    def test_raw_stdout_budget_cumulative_cap_and_legacy_outcome_rejection(self) -> None:
        sid_sum, sp_sum = self._span_for("ep1_summary.txt", "曾說不應留現金")
        sum_hit = self.p_by_path["ep1_summary.txt"][0]
        compact_item_bytes = len(json.dumps(sum_hit, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

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
                            "kind": "condition",
                        }
                    ],
                }
            ],
        }

        budget_search_argv = _adapter_search_argv(self.clec_bin, self.data_dir, ["2022反例？"], self.corpus_sha)
        envelope_step = _make_cli_step(
            "search",
            self.corpus_sha,
            [sum_hit],
            argv=budget_search_argv,
            extra_data={"metadata": "x" * 600},
            stderr_utf8="warning on stderr not counted toward stdout\n",
        )
        raw_stdout_len = len(envelope_step["stdoutUtf8"].encode("utf-8"))
        self.assertGreater(raw_stdout_len, compact_item_bytes + 500)

        over_budget_res = score.summarize_evaluation(
            dataset,
            [_make_v2_outcome("q-budget", [envelope_step], queries=["2022反例？"])],
            self.corpus,
            self.corpus_sha,
            stdout_byte_budget=compact_item_bytes,
        )
        row = over_budget_res["perQuestion"][0]
        self.assertTrue(row["stdoutBudgetExceeded"])
        self.assertEqual(row["searchStdoutUtf8Bytes"], raw_stdout_len)
        self.assertEqual(row["evidenceCoverage"], 0.0)
        self.assertFalse(row["completeChain"])
        self.assertFalse(over_budget_res["gates"]["zeroBudgetViolations"])

        ep1_cond_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])
        big_first_step = _make_cli_step(
            "search",
            self.corpus_sha,
            [ep1_cond_hit, sum_hit],
            argv=budget_search_argv,
            extra_data={"metadata": "y" * 1200},
        )
        small_read_step = _make_cli_step(
            "read",
            self.corpus_sha,
            [{**ep1_cond_hit, "kind": "passage", "context": []}],
            argv=_adapter_read_argv(self.clec_bin, self.data_dir, [ep1_cond_hit["passageId"]]),
        )
        big_len = len(big_first_step["stdoutUtf8"].encode("utf-8"))
        small_len = len(small_read_step["stdoutUtf8"].encode("utf-8"))
        cum_cap = max(small_len + 50, big_len - 1)
        self.assertLess(cum_cap, big_len)

        no_skip_res = score.summarize_evaluation(
            dataset,
            [_make_v2_outcome("q-budget", [big_first_step, small_read_step], queries=["2022反例？"])],
            self.corpus,
            self.corpus_sha,
            stdout_byte_budget=big_len + 100,
            read_byte_budget=small_len + 100,
            cumulative_stdout_byte_budget=cum_cap,
        )
        self.assertTrue(no_skip_res["perQuestion"][0]["stdoutBudgetExceeded"])
        self.assertEqual(no_skip_res["perQuestion"][0]["evidenceCoverage"], 0.0)
        self.assertFalse(no_skip_res["perQuestion"][0]["completeChain"])

        legacy_outcome = {"id": "q-budget", "status": "completed", "hits": [sum_hit], "reads": []}
        legacy_summary = score.summarize_evaluation(dataset, [legacy_outcome], self.corpus, self.corpus_sha)
        self.assertEqual(legacy_summary["verdict"], "inconclusive")
        self.assertIn("outcomeSchemaVersion", legacy_summary["reason"])

        legacy_direct = score.score_question(dataset["questions"][0], legacy_outcome, self.corpus)
        self.assertFalse(legacy_direct["outcomeVersionValid"])
        self.assertIsNone(legacy_direct["completeChain"])
        self.assertIn("unsupported_outcome_version", legacy_direct["stopReason"])

        tampered_used_bytes_step = _make_cli_step(
            "search",
            self.corpus_sha,
            [sum_hit],
            argv=budget_search_argv,
            extra_data={"budget": {"maxBytes": 65536, "usedBytes": 10, "omittedCount": 0, "omittedIds": []}},
        )
        tampered_used_res = score.score_question(
            dataset["questions"][0],
            _make_v2_outcome("q-budget", [tampered_used_bytes_step], queries=["2022反例？"]),
            self.corpus,
        )
        self.assertEqual(tampered_used_res["status"], "error")
        self.assertIn("budget_usedBytes_mismatch", tampered_used_res["stopReason"])
        self.assertIsNone(tampered_used_res["completeChain"])

    def test_corpus_sha_verification_errors_timeouts_and_lazy_blob_cache(self) -> None:
        with self.assertRaises(ValueError):
            score.CorpusIndexView(self.db_path, "0" * 64)

        with score.CorpusIndexView(self.db_path, self.corpus_sha, max_cached_blobs=2) as bounded_view:
            for p in ("ep1.srt", "ep1_summary.txt", "shared.txt", "dup_occ.txt"):
                raw = bounded_view.raw_bytes_for_source(self.sid_by_path[p])
                self.assertGreater(len(raw), 0)
            self.assertLessEqual(len(bounded_view._blob_cache), 2)

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
        empty_search_step = _make_cli_step(
            "search",
            self.corpus_sha,
            [],
            argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["星際橙子基金何時發行？"], self.corpus_sha),
        )
        timeout_step: _CliStepDict = {
            "step": "search",
            "argv": _adapter_search_argv(self.clec_bin, self.data_dir, ["稅務條件？"], self.corpus_sha),
            "exitCode": None,
            "timedOut": True,
            "elapsedSeconds": 0.05,
            "stdoutUtf8": "",
            "stderrUtf8": "",
        }
        outcomes = [
            _make_v2_outcome(
                "q-timeout",
                [timeout_step],
                queries=["稅務條件？"],
                status="timeout",
                stop_reason="search_timeout_0.05s",
            ),
            _make_v2_outcome("q-unans", [empty_search_step], queries=["星際橙子基金何時發行？"]),
        ]
        summary = score.summarize_evaluation(dataset, outcomes, self.corpus, self.corpus_sha)
        self.assertEqual(summary["verdict"], "inconclusive_errors_present")
        self.assertEqual(summary["counts"]["scheduledQuestions"], 2)
        self.assertEqual(summary["counts"]["errorsOrTimeouts"], 1)
        self.assertIsNone(summary["perQuestion"][0]["evidenceCoverage"])
        self.assertEqual(summary["perQuestion"][0]["stopReason"], "search_timeout_0.05s")
        self.assertIsNone(summary["perQuestion"][1]["completeChain"])
        self.assertEqual(summary["counts"]["completeChainRateAllScheduledAnswerable"], 0.0)

        eval_py = Path(__file__).resolve().parent / "eval.py"
        fake_ds = self.tmp / "fake-sha-ds.json"
        fake_ds.write_text(json.dumps(dict(dataset, corpusSha256="0" * 64), ensure_ascii=False), encoding="utf-8")
        val_proc = subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "validate-dataset",
                "--dataset",
                str(fake_ds),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                "0" * 64,
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(val_proc.returncode, 0)
        self.assertFalse(json.loads(val_proc.stdout)["valid"])

        stale_data = self.tmp / "stale-data"
        shutil.copytree(self.data_dir, stale_data)
        active_file = stale_data / "active.json"
        active_obj = json.loads(active_file.read_text(encoding="utf-8"))
        active_obj["release"] = "0" * 64
        active_file.write_text(json.dumps(active_obj), encoding="utf-8")
        ok_stale, stale_info = adapter.verify_active_corpus(self.clec_bin, stale_data, self.corpus_sha, 5.0)
        self.assertFalse(ok_stale)
        self.assertIn("active.json", stale_info["error"])

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

    def test_cli_smoke_eval_score_outcomes_and_bench_end_to_end(self) -> None:
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

        val_proc = subprocess.run(
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
        val_json = json.loads(val_proc.stdout)
        self.assertEqual(val_json["actualCorpusSha256"], self.corpus_sha)
        self.assertEqual(val_json["corpusFormat"], "clec-native-v2")

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
        self.assertEqual(rep["actualCorpusSha256"], self.corpus_sha)
        self.assertEqual(rep["counts"]["completeChains"], 1)
        self.assertTrue(all(rep["gates"].values()))

        outcomes_payload = json.loads(outcomes_out.read_text(encoding="utf-8"))
        self.assertEqual(outcomes_payload[0]["outcomeSchemaVersion"], 2)
        self.assertEqual(len(outcomes_payload[0]["steps"]), 2)

        rescored_out = self.tmp / "smoke-rescored.json"
        subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "score-outcomes",
                "--dataset",
                str(dataset_path),
                "--outcomes",
                str(outcomes_out),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
                "--output",
                str(rescored_out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        rescored = json.loads(rescored_out.read_text(encoding="utf-8"))
        self.assertEqual(rescored["verdict"], "complete")
        self.assertEqual(rescored["actualCorpusSha256"], self.corpus_sha)

        legacy_outcomes_path = self.tmp / "legacy-outcomes.json"
        legacy_outcomes_path.write_text(
            json.dumps([{"id": "smoke-1", "status": "completed", "hits": [], "reads": []}]),
            encoding="utf-8",
        )
        legacy_proc = subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "score-outcomes",
                "--dataset",
                str(dataset_path),
                "--outcomes",
                str(legacy_outcomes_path),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(legacy_proc.returncode, 0)
        self.assertEqual(json.loads(legacy_proc.stdout)["verdict"], "inconclusive")

        bench_identical = self.tmp / "bench-identical.json"
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
                "--repeats",
                "2",
                "--allow-smoke-repeats",
                "--output",
                str(bench_identical),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        bench_id_rep = json.loads(bench_identical.read_text(encoding="utf-8"))
        self.assertEqual(bench_id_rep["comparisonStatus"], "IDENTICAL_QUERY_PLANS")
        self.assertEqual(bench_id_rep["comparisonVerdict"], "no_comparison_identical_query_plans")

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
                "5",
                "--output",
                str(bench_out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        bench_rep = json.loads(bench_out.read_text(encoding="utf-8"))
        self.assertEqual(bench_rep["comparisonStatus"], "DISTINCT_QUERY_PLANS")
        self.assertEqual(bench_rep["comparisonVerdict"], "valid_interleaved_latency_comparison")
        self.assertEqual(bench_rep["wholeProcessCli"]["single_query_product_baseline"]["errorCount"], 0)
        self.assertEqual(bench_rep["wholeProcessCli"]["rrf_multiquery"]["errorCount"], 0)
        self.assertGreater(bench_rep["sqliteOnlyQuestionMatchedProbe"]["elapsedSeconds"]["median"], 0.0)
        self.assertGreater(bench_rep["sqliteOnlyQuestionMatchedProbe"]["runs"][0]["candidateRowCount"], 0)

        err_cli = self.tmp / "err-clec.sh"
        err_cli.write_text(
            "#!/bin/sh\n"
            "for arg in \"$@\"; do\n"
            "  if [ \"$arg\" = \"status\" ]; then\n"
            f"    exec \"{self.clec_bin}\" \"$@\"\n"
            "  fi\n"
            "done\n"
            "exit 2\n",
            encoding="utf-8",
        )
        err_cli.chmod(err_cli.stat().st_mode | stat.S_IXUSR)
        bench_err_out = self.tmp / "bench-err.json"
        subprocess.run(
            [
                sys.executable,
                str(bench_py),
                "--clec",
                str(err_cli),
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
                "5",
                "--output",
                str(bench_err_out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        bench_err_rep = json.loads(bench_err_out.read_text(encoding="utf-8"))
        self.assertEqual(bench_err_rep["comparisonVerdict"], "inconclusive_errors_present")
        self.assertEqual(bench_err_rep["wholeProcessCli"]["single_query_product_baseline"]["errorCount"], 5)
        self.assertEqual(bench_err_rep["wholeProcessCli"]["rrf_multiquery"]["errorCount"], 5)

    def test_execution_boundary_rejects_failed_timedout_and_incoherent_steps(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        valid_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])
        boundary_search_argv = _adapter_search_argv(self.clec_bin, self.data_dir, ["稅務條件"], self.corpus_sha)
        boundary_read_argv = _adapter_read_argv(self.clec_bin, self.data_dir, [valid_hit["passageId"]])
        valid_search = _make_cli_step("search", self.corpus_sha, [valid_hit], argv=boundary_search_argv)
        failed_read = _make_cli_step("read", self.corpus_sha, [], argv=boundary_read_argv, exit_code=2, stderr_utf8="read error")
        timed_out_read = _make_cli_step("read", self.corpus_sha, [], argv=boundary_read_argv, exit_code=None, timed_out=True)
        incoherent_to_zero = _make_cli_step("read", self.corpus_sha, [valid_hit], argv=boundary_read_argv, exit_code=0, timed_out=True)

        questions = [
            {
                "id": f"q-{idx}",
                "category": "condition",
                "question": "稅務條件",
                "answerable": True,
                "workKeys": ["w:ep1"],
                "evidence": [
                    {
                        "claimId": f"c-{idx}",
                        "sourceId": sid_srt,
                        "path": "ep1.srt",
                        "spans": [sp_srt],
                        "quote": "若無稅務問題才能匯回臺灣",
                        "kind": "condition",
                    }
                ],
            }
            for idx in range(7)
        ]
        dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": questions,
        }
        outcomes = [
            _make_v2_outcome("q-0", [valid_search, failed_read], queries=["稅務條件"], status="error", stop_reason="read_cli_error:2"),
            _make_v2_outcome("q-1", [valid_search, failed_read], queries=["稅務條件"], status="completed"),
            _make_v2_outcome("q-2", [valid_search, timed_out_read], queries=["稅務條件"], status="completed"),
            _make_v2_outcome("q-3", [valid_search, incoherent_to_zero], queries=["稅務條件"], status="completed"),
            _make_v2_outcome("q-4", [], queries=["稅務條件"], status="completed"),
            _make_v2_outcome("q-5", [valid_search], queries=["稅務條件"], status="timeout", stop_reason="forged_timeout"),
            _make_v2_outcome("q-6", [valid_search], queries=["稅務條件"], status="partial"),
        ]
        summary = score.summarize_evaluation(dataset, outcomes, self.corpus, self.corpus_sha)
        self.assertEqual(summary["verdict"], "inconclusive_errors_present")
        self.assertEqual(summary["counts"]["scheduledQuestions"], 7)
        self.assertEqual(summary["counts"]["completedAnswerable"], 0)
        self.assertEqual(summary["counts"]["errorsOrTimeouts"], 7)
        self.assertFalse(summary["gates"]["zeroErrorsInDenominator"])
        self.assertFalse(summary["gates"]["zeroCriticalConditionLoss"])
        for row in summary["perQuestion"]:
            self.assertNotEqual(row["status"], "completed")
            self.assertIsNone(row["evidenceCoverage"])
            self.assertIsNone(row["completeChain"])
            self.assertIsNone(row["conditionLoss"])

        eval_py = Path(__file__).resolve().parent / "eval.py"
        fail_read_cli = self.tmp / "fail-read-clec.sh"
        fail_read_cli.write_text(
            "#!/bin/sh\n"
            "for arg in \"$@\"; do\n"
            "  if [ \"$arg\" = \"read\" ]; then\n"
            "    echo '{\"schemaVersion\":1,\"ok\":false,\"error\":{\"code\":\"READ_FAIL\"}}' >&2\n"
            "    exit 2\n"
            "  fi\n"
            "done\n"
            f"exec \"{self.clec_bin}\" \"$@\"\n",
            encoding="utf-8",
        )
        fail_read_cli.chmod(fail_read_cli.stat().st_mode | stat.S_IXUSR)
        ds_file = self.tmp / "exec-boundary-ds.json"
        ds_file.write_text(
            json.dumps({**dataset, "questions": [questions[0]]}, ensure_ascii=False),
            encoding="utf-8",
        )
        run_out = self.tmp / "exec-boundary-run.json"
        proc = subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "run",
                "--clec",
                str(fail_read_cli),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
                "--dataset",
                str(ds_file),
                "--read-top-n",
                "1",
                "--output",
                str(run_out),
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        rep = json.loads(run_out.read_text(encoding="utf-8"))
        self.assertEqual(rep["verdict"], "inconclusive_errors_present")
        self.assertIsNone(rep["perQuestion"][0]["completeChain"])
        self.assertIsNone(rep["perQuestion"][0]["evidenceCoverage"])

    def test_active_corpus_coherence_across_validate_run_and_score_outcomes(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        valid_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])
        dataset_path = self.tmp / "coherence-ds.json"
        dataset_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "corpusSha256": self.corpus_sha,
                    "split": "development",
                    "questions": [
                        {
                            "id": "q-coh",
                            "category": "condition",
                            "question": "匯回臺灣 稅務問題",
                            "answerable": True,
                            "workKeys": ["w:ep1"],
                            "evidence": [
                                {
                                    "claimId": "c1",
                                    "sourceId": sid_srt,
                                    "path": "ep1.srt",
                                    "spans": [sp_srt],
                                    "quote": "若無稅務問題才能匯回臺灣",
                                    "kind": "condition",
                                }
                            ],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        outcomes_path = self.tmp / "coherence-outcomes.json"
        outcomes_path.write_text(
            json.dumps(
                [
                    _make_v2_outcome(
                        "q-coh",
                        [
                            _make_cli_step(
                                "search",
                                self.corpus_sha,
                                [valid_hit],
                                argv=_adapter_search_argv(self.clec_bin, self.data_dir, ["匯回臺灣 稅務問題"], self.corpus_sha),
                            )
                        ],
                        queries=["匯回臺灣 稅務問題"],
                    )
                ]
            ),
            encoding="utf-8",
        )
        eval_py = Path(__file__).resolve().parent / "eval.py"

        for case_name in ("all_zero_release", "missing_active_json", "malformed_active_json", "dir_active_json"):
            bad_dir = self.tmp / f"coh-{case_name}"
            shutil.copytree(self.data_dir, bad_dir)
            active_file = bad_dir / "active.json"
            if case_name == "all_zero_release":
                active_file.write_text(
                    json.dumps({"release": "0" * 64, "manifestPath": str(self.rel_dir / "manifest.json")}),
                    encoding="utf-8",
                )
            elif case_name == "missing_active_json":
                active_file.unlink()
            elif case_name == "malformed_active_json":
                active_file.write_text("{not-json", encoding="utf-8")
            elif case_name == "dir_active_json":
                active_file.unlink()
                active_file.mkdir()

            val_p = subprocess.run(
                [
                    sys.executable,
                    str(eval_py),
                    "validate-dataset",
                    "--dataset",
                    str(dataset_path),
                    "--data-dir",
                    str(bad_dir),
                    "--corpus-sha256",
                    self.corpus_sha,
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(val_p.returncode, 0, case_name)
            self.assertFalse(json.loads(val_p.stdout)["valid"], case_name)

            score_p = subprocess.run(
                [
                    sys.executable,
                    str(eval_py),
                    "score-outcomes",
                    "--dataset",
                    str(dataset_path),
                    "--outcomes",
                    str(outcomes_path),
                    "--data-dir",
                    str(bad_dir),
                    "--corpus-sha256",
                    self.corpus_sha,
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(score_p.returncode, 0, case_name)
            self.assertEqual(json.loads(score_p.stdout)["verdict"], "inconclusive", case_name)

            run_p = subprocess.run(
                [
                    sys.executable,
                    str(eval_py),
                    "run",
                    "--clec",
                    str(self.clec_bin),
                    "--data-dir",
                    str(bad_dir),
                    "--corpus-sha256",
                    self.corpus_sha,
                    "--dataset",
                    str(dataset_path),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(run_p.returncode, 0, case_name)
            self.assertEqual(json.loads(run_p.stdout)["verdict"], "inconclusive", case_name)

        relocated_dir = self.tmp / "coh-relocated-missing-manifest"
        shutil.copytree(self.data_dir, relocated_dir)
        active_reloc = relocated_dir / "active.json"
        reloc_obj = json.loads(active_reloc.read_text(encoding="utf-8"))
        reloc_obj["manifestPath"] = str(self.tmp / "deleted-release" / "manifest.json")
        active_reloc.write_text(json.dumps(reloc_obj), encoding="utf-8")
        reloc_val = subprocess.run(
            [
                sys.executable,
                str(eval_py),
                "validate-dataset",
                "--dataset",
                str(dataset_path),
                "--data-dir",
                str(relocated_dir),
                "--corpus-sha256",
                self.corpus_sha,
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(reloc_val.returncode, 0)
        self.assertTrue(json.loads(reloc_val.stdout)["valid"])

    def test_unicode_whitespace_and_projection_parity_with_native_corpus(self) -> None:
        ws = self.tmp / "parity-ws"
        ws.mkdir()
        (ws / "sep_plain.txt").write_bytes(
            b"\xef\xbb\xbfalpha\x1cbeta\x1dgamma\x1edelta\x1fepsilon\xc2\x85zeta\xc2\xa0eta\xe3\x80\x80theta\r\nsecondline\n"
        )
        (ws / "sep_alias.srt").write_bytes(
            b"1\r\n00:00:01,000 --> 00:00:03,000\r\nalpha\x1cbeta\x1dgamma\x1edelta\x1fepsilon\xc2\x85zeta\xc2\xa0eta\xe3\x80\x80theta\r\nsecondline\r\n"
        )
        (ws / "voice_note.md").write_bytes(
            (
                "\ufeff# 語音筆記：Parity\r\n\r\n"
                "## [01:02.000 – 01:05.000]\r\n"
                "alpha\u001cbeta\rcarriage\r\n"
                "## [00:01:06,000 - 00:01:08,500]\r\n"
                "gamma\u00a0delta\u2028omega\r\n"
            ).encode("utf-8")
        )
        (ws / "voice_note.txt").write_bytes("alpha\u001cbeta\rcarriage\ngamma\u00a0delta\u2028omega\n".encode("utf-8"))
        (ws / "cue_vtt.vtt").write_bytes(
            "WEBVTT\r\n\r\n00:01.000 --> 00:03.000\r\nfirst\u001cpart\u3000second\u00a0part\r\n".encode("utf-8")
        )
        intake = self.tmp / "parity-intake.json"
        intake.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "works": [
                        {"key": "w:sep", "title": "Sep"},
                        {"key": "w:md", "title": "MD"},
                        {"key": "w:vtt", "title": "VTT"},
                    ],
                    "sources": [
                        {"work": "w:sep", "path": "sep_plain.txt", "title": "P", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        {"work": "w:sep", "path": "sep_alias.srt", "title": "S", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        {"work": "w:md", "path": "voice_note.md", "title": "MD", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        {"work": "w:md", "path": "voice_note.txt", "title": "TXT", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        {"work": "w:vtt", "path": "cue_vtt.vtt", "title": "VTT", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        rel = self.tmp / "parity-rel"
        pub = subprocess.run(
            [str(self.pub_bin), "--workspace", str(ws), "--intake", str(intake), "--output", str(rel)],
            capture_output=True,
            text=True,
            check=True,
        )
        sha = json.loads(pub.stdout)["sha256"]
        data_dir = self.tmp / "parity-data"
        subprocess.run(
            [str(self.clec_bin), "--data-dir", str(data_dir), "sync", "--manifest", str(rel / "manifest.json")],
            capture_output=True,
            text=True,
            check=True,
        )
        with score.CorpusIndexView(data_dir / f"{sha}.sqlite", sha) as parity_corpus:
            for sid, meta in parity_corpus.sources.items():
                proj = parity_corpus.projected_for_source(sid)
                self.assertEqual(proj.equivalence_hash, meta["equivalenceHash"], meta["path"])

            sids = {v["path"]: sid for sid, v in parity_corpus.sources.items()}
            self.assertTrue(parity_corpus.are_canonical_aliases(sids["sep_plain.txt"], sids["sep_alias.srt"]))
            self.assertTrue(parity_corpus.are_canonical_aliases(sids["voice_note.md"], sids["voice_note.txt"]))

            raw_plain = parity_corpus.raw_bytes_for_source(sids["sep_plain.txt"])
            needle = b"alpha\x1cbeta"
            pos = raw_plain.index(needle)
            ds = {
                "schemaVersion": 1,
                "corpusSha256": sha,
                "split": "development",
                "questions": [
                    {
                        "id": "q-empty-no-crash",
                        "category": "alias",
                        "question": "sep",
                        "answerable": True,
                        "workKeys": ["w:sep"],
                        "evidence": [
                            {
                                "claimId": "c1",
                                "sourceId": sids["sep_plain.txt"],
                                "path": "sep_plain.txt",
                                "spans": [{"startByte": pos, "endByte": pos + len(needle)}],
                                "quote": "alpha\u001cbeta",
                                "kind": "required",
                            }
                        ],
                    }
                ],
            }
            res = score.summarize_evaluation(
                ds,
                [
                    _make_v2_outcome(
                        "q-empty-no-crash",
                        [
                            _make_cli_step(
                                "search",
                                sha,
                                [],
                                argv=_adapter_search_argv(self.clec_bin, data_dir, ["sep"], sha),
                            )
                        ],
                        queries=["sep"],
                    )
                ],
                parity_corpus,
                sha,
            )
            self.assertEqual(res["perQuestion"][0]["evidenceCoverage"], 0.0)
            self.assertFalse(res["perQuestion"][0]["completeChain"])

            parity_corpus._proj_cache.clear()
            parity_corpus.sources[sids["sep_plain.txt"]]["equivalenceHash"] = "f" * 64
            raw_vtt = parity_corpus.raw_bytes_for_source(sids["cue_vtt.vtt"])
            vtt_needle = b"first\x1cpart"
            vtt_pos = raw_vtt.index(vtt_needle)
            ds_mixed = {
                "schemaVersion": 1,
                "corpusSha256": sha,
                "split": "development",
                "questions": [
                    ds["questions"][0],
                    {
                        "id": "q-valid-sibling",
                        "category": "plain",
                        "question": "vtt",
                        "answerable": True,
                        "workKeys": ["w:vtt"],
                        "evidence": [
                            {
                                "claimId": "c2",
                                "sourceId": sids["cue_vtt.vtt"],
                                "path": "cue_vtt.vtt",
                                "spans": [{"startByte": vtt_pos, "endByte": vtt_pos + len(vtt_needle)}],
                                "quote": "first\u001cpart",
                                "kind": "required",
                            }
                        ],
                    },
                ],
            }
            inc = score.summarize_evaluation(
                ds_mixed,
                [
                    _make_v2_outcome(
                        "q-empty-no-crash",
                        [
                            _make_cli_step(
                                "search",
                                sha,
                                [],
                                argv=_adapter_search_argv(self.clec_bin, data_dir, ["sep"], sha),
                            )
                        ],
                        queries=["sep"],
                    ),
                    _make_v2_outcome(
                        "q-valid-sibling",
                        [
                            _make_cli_step(
                                "search",
                                sha,
                                [],
                                argv=_adapter_search_argv(self.clec_bin, data_dir, ["vtt"], sha),
                            )
                        ],
                        queries=["vtt"],
                    ),
                ],
                parity_corpus,
                sha,
            )
            self.assertEqual(inc["verdict"], "inconclusive_errors_present")
            self.assertEqual(inc["perQuestion"][0]["status"], "inconclusive")
            self.assertIn("projection_error", inc["perQuestion"][0]["stopReason"])
            self.assertIsNone(inc["perQuestion"][0]["completeChain"])
            self.assertIsNone(inc["perQuestion"][0]["evidenceCoverage"])
            self.assertEqual(inc["perQuestion"][1]["status"], "completed")
            self.assertEqual(inc["perQuestion"][1]["evidenceCoverage"], 0.0)

    def test_subprocess_byte_capture_crlf_multibyte_invalid_utf8_and_timeout_partial_bytes(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        valid_hit = next(h for h in self.p_by_path["ep1.srt"] if "若無稅務問題才能匯回臺灣" in h["text"])

        payload_obj = {
            "schemaVersion": 1,
            "ok": True,
            "command": "search",
            "data": {"release": self.corpus_sha, "hits": [valid_hit], "note": "漢字\r\n換行"},
        }
        raw_crlf = json.dumps(payload_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\r\n"
        crlf_cli = self.tmp / "crlf-clec.py"
        crlf_cli.write_text(
            f"#!/usr/bin/env python3\nimport sys\nsys.stdout.buffer.write({raw_crlf!r})\n",
            encoding="utf-8",
        )
        crlf_cli.chmod(crlf_cli.stat().st_mode | stat.S_IXUSR)

        rec_crlf = adapter.run_clec_command(
            crlf_cli, ["search", "x"], data_dir=self.data_dir, max_bytes=65536, timeout_sec=5.0
        )
        self.assertEqual(len(rec_crlf["stdout"].encode("utf-8")), len(raw_crlf))
        self.assertIn("\r\n", rec_crlf["stdout"])
        self.assertIsNone(rec_crlf["stdoutDecodeError"])

        ds = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-bytes",
                    "category": "budget",
                    "question": "稅務",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_srt,
                            "path": "ep1.srt",
                            "spans": [sp_srt],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "condition",
                        }
                    ],
                }
            ],
        }
        outcomes, _ = adapter.execute_dataset_queries(
            clec_bin=crlf_cli,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions(ds["questions"]),
            max_bytes=len(raw_crlf),
            timeout_sec=5.0,
        )
        under_cap = score.summarize_evaluation(
            ds, outcomes, self.corpus, self.corpus_sha, stdout_byte_budget=len(raw_crlf)
        )
        self.assertFalse(under_cap["perQuestion"][0]["stdoutBudgetExceeded"])
        self.assertEqual(under_cap["perQuestion"][0]["searchStdoutUtf8Bytes"], len(raw_crlf))

        over_cap = score.summarize_evaluation(
            ds, outcomes, self.corpus, self.corpus_sha, stdout_byte_budget=len(raw_crlf) - 1
        )
        self.assertTrue(over_cap["perQuestion"][0]["stdoutBudgetExceeded"])
        self.assertFalse(over_cap["perQuestion"][0]["completeChain"])

        cum_crlf_cli = self.tmp / "cum-crlf-clec.py"
        search_crlf = json.dumps(
            {
                "schemaVersion": 1,
                "ok": True,
                "command": "search",
                "data": {"release": self.corpus_sha, "hits": [valid_hit]},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8") + b"\r\n"
        bad_read_hit = copy.deepcopy(valid_hit)
        bad_read_hit["text"] = "fabricated-inside-over-budget-read"
        read_crlf = json.dumps(
            {
                "schemaVersion": 1,
                "ok": True,
                "command": "read",
                "data": {"release": self.corpus_sha, "items": [{**bad_read_hit, "kind": "passage", "context": []}]},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8") + b"\r\n"
        cum_crlf_cli.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "if 'read' in sys.argv:\n"
            f"    sys.stdout.buffer.write({read_crlf!r})\n"
            "else:\n"
            f"    sys.stdout.buffer.write({search_crlf!r})\n",
            encoding="utf-8",
        )
        cum_crlf_cli.chmod(cum_crlf_cli.stat().st_mode | stat.S_IXUSR)
        cum_outcomes, _ = adapter.execute_dataset_queries(
            clec_bin=cum_crlf_cli,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions(ds["questions"]),
            read_top_n=1,
            timeout_sec=5.0,
        )
        cum_scored = score.summarize_evaluation(
            ds,
            cum_outcomes,
            self.corpus,
            self.corpus_sha,
            stdout_byte_budget=len(search_crlf) + 100,
            read_byte_budget=len(read_crlf) + 100,
            cumulative_stdout_byte_budget=len(search_crlf) + len(read_crlf) - 1,
        )
        self.assertTrue(cum_scored["perQuestion"][0]["stdoutBudgetExceeded"])
        self.assertFalse(cum_scored["perQuestion"][0]["citationRawSpanValid"])
        self.assertFalse(cum_scored["perQuestion"][0]["completeChain"])
        self.assertEqual(
            cum_scored["perQuestion"][0]["cumulativeStdoutUtf8Bytes"],
            len(search_crlf) + len(read_crlf),
        )

        bad_utf8_cli = self.tmp / "bad-utf8-clec.py"
        bad_utf8_cli.write_text(
            "#!/usr/bin/env python3\nimport sys\nsys.stdout.buffer.write(b'{\"ok\":true}\\xff\\xfe')\n",
            encoding="utf-8",
        )
        bad_utf8_cli.chmod(bad_utf8_cli.stat().st_mode | stat.S_IXUSR)
        rec_bad = adapter.run_clec_command(
            bad_utf8_cli, ["search", "x"], data_dir=self.data_dir, max_bytes=65536, timeout_sec=5.0
        )
        self.assertIsNone(rec_bad["stdout"])
        self.assertIsNotNone(rec_bad["stdoutDecodeError"])
        self.assertEqual(rec_bad["stdoutRawByteLen"], 13)

        bad_outcomes, _ = adapter.execute_dataset_queries(
            clec_bin=bad_utf8_cli,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions(ds["questions"]),
            timeout_sec=5.0,
        )
        self.assertEqual(bad_outcomes[0]["status"], "error")
        self.assertIsNone(bad_outcomes[0]["steps"][0]["stdoutUtf8"])
        bad_scored = score.summarize_evaluation(ds, bad_outcomes, self.corpus, self.corpus_sha)
        self.assertEqual(bad_scored["verdict"], "inconclusive_errors_present")
        self.assertFalse(bad_scored["perQuestion"][0]["citationRawSpanValid"])
        self.assertIsNone(bad_scored["perQuestion"][0]["completeChain"])

        partial_to_cli = self.tmp / "partial-to-clec.sh"
        partial_to_cli.write_text(
            "#!/bin/sh\nprintf '{\"a\":\\344\\270'\nexec sleep 3\n",
            encoding="utf-8",
        )
        partial_to_cli.chmod(partial_to_cli.stat().st_mode | stat.S_IXUSR)
        rec_to = adapter.run_clec_command(
            partial_to_cli, ["search", "x"], data_dir=self.data_dir, max_bytes=65536, timeout_sec=1.0
        )
        self.assertTrue(rec_to["timedOut"])
        self.assertIsNone(rec_to["stdout"])
        self.assertIsNotNone(rec_to["stdoutDecodeError"])
        self.assertEqual(rec_to["stdoutRawByteLen"], 7)

    def test_bench_rejects_duplicate_and_semantically_identical_rewrite_plans(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        dataset_path = self.tmp / "bench-dup-ds.json"
        dataset_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "corpusSha256": self.corpus_sha,
                    "split": "development",
                    "questions": [
                        {
                            "id": "q-b1",
                            "category": "condition",
                            "question": "稅務問題",
                            "answerable": True,
                            "workKeys": ["w:ep1"],
                            "evidence": [
                                {
                                    "claimId": "c1",
                                    "sourceId": sid_srt,
                                    "path": "ep1.srt",
                                    "spans": [sp_srt],
                                    "quote": "若無稅務問題才能匯回臺灣",
                                    "kind": "condition",
                                }
                            ],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        bench_py = Path(__file__).resolve().parent / "bench.py"

        for case_name, queries in (
            ("exact_duplicate", ["稅務", "稅務"]),
            ("tw2s_semantic_duplicate", ["稅務問題", "税务问题"]),
        ):
            blind_p = self.tmp / f"blind-{case_name}.json"
            blind_p.write_text(json.dumps([{"id": "q-b1", "queries": queries}], ensure_ascii=False), encoding="utf-8")
            out_p = self.tmp / f"bench-{case_name}.json"
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
                    str(blind_p),
                    "--query-angle",
                    "blind_rewrite",
                    "--repeats",
                    "5",
                    "--output",
                    str(out_p),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            rep = json.loads(out_p.read_text(encoding="utf-8"))
            self.assertEqual(rep["comparisonStatus"], "IDENTICAL_QUERY_PLANS", case_name)
            self.assertEqual(rep["comparisonVerdict"], "no_comparison_identical_query_plans", case_name)

    def test_execution_grammar_score_outcomes_positives_and_negatives(self) -> None:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        sid_sum, sp_sum = self._span_for("ep1_summary.txt", "曾說不應留現金")
        eval_py = Path(__file__).resolve().parent / "eval.py"

        def _run_score_outcomes(ds_obj: dict[str, object], outcomes_obj: list[dict[str, object]], tag: str) -> tuple[int, dict[str, object]]:
            ds_p = self.tmp / f"grammar-ds-{tag}.json"
            out_p = self.tmp / f"grammar-out-{tag}.json"
            rep_p = self.tmp / f"grammar-rep-{tag}.json"
            ds_p.write_text(json.dumps(ds_obj, ensure_ascii=False), encoding="utf-8")
            out_p.write_text(json.dumps(outcomes_obj, ensure_ascii=False), encoding="utf-8")
            proc = subprocess.run(
                [
                    sys.executable,
                    str(eval_py),
                    "score-outcomes",
                    "--dataset",
                    str(ds_p),
                    "--outcomes",
                    str(out_p),
                    "--data-dir",
                    str(self.data_dir),
                    "--corpus-sha256",
                    self.corpus_sha,
                    "--output",
                    str(rep_p),
                ],
                capture_output=True,
                text=True,
            )
            return proc.returncode, json.loads(rep_p.read_text(encoding="utf-8"))

        q_base = {
            "id": "q-grammar",
            "category": "condition",
            "question": "核心條件 匯回臺灣 稅務問題",
            "answerable": True,
            "workKeys": ["w:ep1"],
            "evidence": [
                {
                    "claimId": "c1",
                    "sourceId": sid_srt,
                    "path": "ep1.srt",
                    "spans": [sp_srt],
                    "quote": "若無稅務問題才能匯回臺灣",
                    "kind": "condition",
                }
            ],
        }
        ds_single = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [q_base],
        }

        search_only_out, _ = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions([q_base]),
            read_top_n=0,
        )
        rc_so, rep_so = _run_score_outcomes(ds_single, search_only_out, "pos-search-only")
        self.assertEqual(rc_so, 0)
        self.assertEqual(rep_so["verdict"], "complete")
        self.assertTrue(all(rep_so["gates"].values()))
        self.assertEqual(rep_so["perQuestion"][0]["evidenceCoverage"], 1.0)
        self.assertTrue(rep_so["perQuestion"][0]["completeChain"])

        search_read_out, _ = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions([q_base]),
            read_top_n=1,
        )
        rc_sr, rep_sr = _run_score_outcomes(ds_single, search_read_out, "pos-search-read")
        self.assertEqual(rc_sr, 0)
        self.assertEqual(rep_sr["verdict"], "complete")
        self.assertTrue(all(rep_sr["gates"].values()))
        self.assertEqual(rep_sr["perQuestion"][0]["evidenceCoverage"], 1.0)
        self.assertTrue(rep_sr["perQuestion"][0]["completeChain"])

        q_kw = copy.deepcopy(q_base)
        q_kw["id"] = "q-kw"
        q_kw["question"] = "read --context 1 --release 匯回臺灣 稅務問題"
        ds_kw = {**ds_single, "questions": [q_kw]}
        kw_out, _ = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions([q_kw]),
            read_top_n=1,
        )
        rc_kw, rep_kw = _run_score_outcomes(ds_kw, kw_out, "pos-keywords-in-query")
        self.assertEqual(rc_kw, 0)
        self.assertEqual(rep_kw["verdict"], "complete")
        self.assertTrue(rep_kw["perQuestion"][0]["completeChain"])

        q_trim = {
            "id": "q-trim",
            "category": "condition",
            "question": "稅務問題 融資",
            "answerable": True,
            "workKeys": ["w:ep1"],
            "evidence": [
                {
                    "claimId": "c1",
                    "sourceId": sid_sum,
                    "path": "ep1_summary.txt",
                    "spans": [sp_sum],
                    "quote": "曾說不應留現金",
                    "kind": "condition",
                }
            ],
        }
        ds_trim = {**ds_single, "questions": [q_trim]}
        search_two_hits = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions([q_trim]),
            limit=2,
            per_work=2,
            read_top_n=2,
        )[0][0]
        self.assertEqual(len(search_two_hits["steps"]), 2)
        search_step_2 = search_two_hits["steps"][0]
        read_ids_2 = [h["passageId"] for h in json.loads(search_step_2["stdoutUtf8"])["data"]["hits"]]
        self.assertEqual(len(read_ids_2), 2)
        first_read_len = len(
            subprocess.run(
                [str(self.clec_bin), "--data-dir", str(self.data_dir), "--offline", "--json", "read", read_ids_2[0], "--context", "1"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.encode("utf-8")
        )
        trimmed_out = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions([q_trim]),
            limit=2,
            per_work=2,
            read_max_bytes=first_read_len + 40,
            read_top_n=2,
        )[0]
        trimmed_read_payload = json.loads(trimmed_out[0]["steps"][1]["stdoutUtf8"])["data"]
        self.assertEqual(trimmed_read_payload["budget"]["omittedCount"], 1)
        rc_trim, rep_trim = _run_score_outcomes(ds_trim, trimmed_out, "pos-trimmed-read")
        self.assertEqual(rc_trim, 0)
        self.assertEqual(rep_trim["verdict"], "complete")
        self.assertEqual(rep_trim["perQuestion"][0]["status"], "completed")
        self.assertIn(rep_trim["perQuestion"][0]["evidenceCoverage"], (0.0, 1.0))

        blind_q_path = self.tmp / "grammar-blind.json"
        blind_q_path.write_text(
            json.dumps([{"id": "q-grammar", "queries": ["匯回臺灣", "稅務問題"]}], ensure_ascii=False),
            encoding="utf-8",
        )
        rrf_out, _ = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=adapter.extract_runtime_questions([q_base]),
            mode="rrf_multiquery",
            query_angle="blind_rewrite",
            blind_queries_path=blind_q_path,
            read_top_n=1,
        )
        rc_rrf, rep_rrf = _run_score_outcomes(ds_single, rrf_out, "pos-rrf-blind")
        self.assertEqual(rc_rrf, 0)
        self.assertEqual(rep_rrf["verdict"], "complete")
        self.assertTrue(rep_rrf["perQuestion"][0]["completeChain"])

        orig_proc = subprocess.run(
            [str(self.clec_bin), "--data-dir", str(self.data_dir), "--json", "read", self.sid_by_path["ep1.txt"], "--original"],
            capture_output=True,
            text=True,
            check=True,
        )
        orig_read_only_step: _CliStepDict = {
            "step": "read",
            "argv": [
                str(self.clec_bin),
                "--data-dir",
                str(self.data_dir),
                "--offline",
                "--json",
                "--max-bytes",
                "65536",
                "read",
                self.sid_by_path["ep1.txt"],
                "--original",
            ],
            "exitCode": 0,
            "timedOut": False,
            "elapsedSeconds": 0.001,
            "stdoutUtf8": orig_proc.stdout,
            "stderrUtf8": orig_proc.stderr,
        }

        base_o = copy.deepcopy(search_read_out[0])
        search_s = copy.deepcopy(base_o["steps"][0])
        read_s = copy.deepcopy(base_o["steps"][1])
        other_pid = next(h["passageId"] for h in self.p_by_path["ep1_summary.txt"])

        negatives: list[tuple[str, dict[str, object]]] = [
            ("read_only", {**copy.deepcopy(base_o), "steps": [copy.deepcopy(read_s)]}),
            ("read_original_only", {**copy.deepcopy(base_o), "steps": [orig_read_only_step]}),
            ("read_before_search", {**copy.deepcopy(base_o), "steps": [copy.deepcopy(read_s), copy.deepcopy(search_s)]}),
            ("duplicate_search", {**copy.deepcopy(base_o), "steps": [copy.deepcopy(search_s), copy.deepcopy(search_s)]}),
            ("duplicate_read", {**copy.deepcopy(base_o), "steps": [copy.deepcopy(search_s), copy.deepcopy(read_s), copy.deepcopy(read_s)]}),
            (
                "read_after_empty_search",
                {
                    **copy.deepcopy(base_o),
                    "steps": [
                        _make_cli_step(
                            "search",
                            self.corpus_sha,
                            [],
                            argv=copy.deepcopy(search_s["argv"]),
                        ),
                        copy.deepcopy(read_s),
                    ],
                },
            ),
            ("contradictory_stop_reason", {**copy.deepcopy(base_o), "stopReason": "read_cli_error:2"}),
            ("argv_command_mismatch", {**copy.deepcopy(base_o), "steps": [{**copy.deepcopy(search_s), "argv": ["clec", "read", "invented"]}, copy.deepcopy(read_s)]}),
            ("read_argv_command_mismatch", {**copy.deepcopy(base_o), "steps": [copy.deepcopy(search_s), {**copy.deepcopy(read_s), "argv": ["clec", "search", "x"]}]}),
            ("argv_missing", {**copy.deepcopy(base_o), "steps": [{k: v for k, v in search_s.items() if k != "argv"}, copy.deepcopy(read_s)]}),
            ("argv_malformed_type", {**copy.deepcopy(base_o), "steps": [{**copy.deepcopy(search_s), "argv": "clec search"}, copy.deepcopy(read_s)]}),
            ("argv_missing_adapter_flags", {**copy.deepcopy(base_o), "steps": [{**copy.deepcopy(search_s), "argv": ["clec", "search", q_base["question"]]}, copy.deepcopy(read_s)]}),
            (
                "argv_release_mismatch",
                {
                    **copy.deepcopy(base_o),
                    "steps": [
                        {
                            **copy.deepcopy(search_s),
                            "argv": _adapter_search_argv(self.clec_bin, self.data_dir, [q_base["question"]], "0" * 64),
                        },
                        copy.deepcopy(read_s),
                    ],
                },
            ),
            ("declared_queries_mismatch", {**copy.deepcopy(base_o), "queries": ["unrelated query"]}),
            ("invalid_mode", {**copy.deepcopy(base_o), "mode": "unsupported_mode"}),
            (
                "blind_rewrite_over_4_queries",
                {
                    **copy.deepcopy(base_o),
                    "mode": "rrf_multiquery",
                    "queryAngle": "blind_rewrite",
                    "queries": ["q1", "q2", "q3", "q4", "q5"],
                    "steps": [
                        {
                            **copy.deepcopy(search_s),
                            "argv": _adapter_search_argv(self.clec_bin, self.data_dir, ["q1", "q2", "q3", "q4", "q5"], self.corpus_sha),
                        }
                    ],
                },
            ),
            (
                "single_query_mode_multi_queries",
                {
                    **copy.deepcopy(base_o),
                    "queries": [q_base["question"], "extra"],
                    "steps": [
                        {
                            **copy.deepcopy(search_s),
                            "argv": _adapter_search_argv(self.clec_bin, self.data_dir, [q_base["question"], "extra"], self.corpus_sha),
                        },
                    ],
                },
            ),
            (
                "read_wrong_context_flag",
                {
                    **copy.deepcopy(base_o),
                    "steps": [
                        copy.deepcopy(search_s),
                        {
                            **copy.deepcopy(read_s),
                            "argv": _adapter_read_argv(
                                self.clec_bin,
                                self.data_dir,
                                [json.loads(search_s["stdoutUtf8"])["data"]["hits"][0]["passageId"]],
                                context=0,
                            ),
                        },
                    ],
                },
            ),
            (
                "read_id_unbound_to_search",
                {
                    **copy.deepcopy(base_o),
                    "steps": [
                        copy.deepcopy(search_s),
                        {
                            **copy.deepcopy(read_s),
                            "argv": _adapter_read_argv(self.clec_bin, self.data_dir, [other_pid]),
                        },
                    ],
                },
            ),
        ]

        tampered_read_payload = json.loads(read_s["stdoutUtf8"])
        tampered_read_payload["data"]["items"][0]["passageId"] = other_pid
        negatives.append(
            (
                "read_stdout_id_mismatch",
                {
                    **copy.deepcopy(base_o),
                    "steps": [
                        copy.deepcopy(search_s),
                        {
                            **copy.deepcopy(read_s),
                            "stdoutUtf8": json.dumps(tampered_read_payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                        },
                    ],
                },
            )
        )

        tampered_search_payload = json.loads(search_s["stdoutUtf8"])
        tampered_search_payload["data"]["queries"] = [{"query": "spoofed query", "terms": ["spoof"]}]
        tampered_search_payload["data"].pop("budget", None)
        negatives.append(
            (
                "search_stdout_queries_mismatch",
                {
                    **copy.deepcopy(base_o),
                    "steps": [
                        {
                            **copy.deepcopy(search_s),
                            "stdoutUtf8": json.dumps(tampered_search_payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                        }
                    ],
                },
            )
        )

        for neg_name, neg_outcome in negatives:
            rc, rep = _run_score_outcomes(ds_single, [neg_outcome], f"neg-{neg_name}")
            self.assertNotEqual(rc, 0, neg_name)
            self.assertEqual(rep["verdict"], "inconclusive_errors_present", neg_name)
            self.assertEqual(rep["counts"]["scheduledQuestions"], 1, neg_name)
            self.assertEqual(rep["counts"]["errorsOrTimeouts"], 1, neg_name)
            self.assertFalse(rep["gates"]["zeroErrorsInDenominator"], neg_name)
            self.assertFalse(rep["gates"]["zeroCriticalConditionLoss"], neg_name)
            row = rep["perQuestion"][0]
            self.assertNotEqual(row["status"], "completed", neg_name)
            self.assertIsNone(row["evidenceCoverage"], neg_name)
            self.assertIsNone(row["completeChain"], neg_name)
            self.assertIsNone(row["conditionLoss"], neg_name)
            self.assertIsNone(row["counterexampleLoss"], neg_name)

        batch_questions = []
        batch_outcomes = []
        pos_o = copy.deepcopy(search_only_out[0])
        pos_o["id"] = "batch-pos"
        q_pos = copy.deepcopy(q_base)
        q_pos["id"] = "batch-pos"
        batch_questions.append(q_pos)
        batch_outcomes.append(pos_o)
        for idx, (neg_name, neg_outcome) in enumerate(negatives):
            qid = f"batch-neg-{idx}-{neg_name}"
            q_i = copy.deepcopy(q_base)
            q_i["id"] = qid
            o_i = copy.deepcopy(neg_outcome)
            o_i["id"] = qid
            batch_questions.append(q_i)
            batch_outcomes.append(o_i)

        rc_batch, rep_batch = _run_score_outcomes(
            {"schemaVersion": 1, "corpusSha256": self.corpus_sha, "split": "development", "questions": batch_questions},
            batch_outcomes,
            "mixed-batch",
        )
        self.assertNotEqual(rc_batch, 0)
        self.assertEqual(rep_batch["verdict"], "inconclusive_errors_present")
        self.assertEqual(rep_batch["counts"]["scheduledQuestions"], 1 + len(negatives))
        self.assertEqual(rep_batch["counts"]["errorsOrTimeouts"], len(negatives))
        self.assertEqual(rep_batch["counts"]["completedAnswerable"], 1)
        self.assertEqual(rep_batch["perQuestion"][0]["status"], "completed")
        self.assertTrue(rep_batch["perQuestion"][0]["completeChain"])
        for row in rep_batch["perQuestion"][1:]:
            self.assertNotEqual(row["status"], "completed")
            self.assertIsNone(row["evidenceCoverage"])
            self.assertIsNone(row["completeChain"])
            self.assertIsNone(row["conditionLoss"])

    def _make_poison_gold_dataset_files(self, tag: str) -> tuple[dict[str, Any], Path, Path]:
        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        gold_q = {
            "id": f"q-boundary-{tag}",
            "category": "condition",
            "question": "  匯回臺灣 稅務問題  ",
            "answerable": True,
            "workKeys": ["w:ep1"],
            "notes": "POISON_GOLD_NOTES_DO_NOT_LEAK",
            "evidence": [
                {
                    "claimId": "c1",
                    "sourceId": sid_srt,
                    "path": "ep1.srt",
                    "spans": [sp_srt],
                    "quote": "若無稅務問題才能匯回臺灣",
                    "kind": "condition",
                }
            ],
        }
        ds_path = self.tmp / f"boundary-{tag}-ds.json"
        ds_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "corpusSha256": self.corpus_sha,
                    "split": "development",
                    "questions": [gold_q],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        blind_path = self.tmp / f"boundary-{tag}-blind.json"
        blind_path.write_text(
            json.dumps([{"id": gold_q["id"], "queries": ["匯回臺灣 稅務問題", "稅務 問題"]}], ensure_ascii=False),
            encoding="utf-8",
        )
        return gold_q, ds_path, blind_path

    def _assert_narrow_runtime_input(self, item: object, caller: str) -> None:
        forbidden_fields = (
            "evidence",
            "spans",
            "quote",
            "quotes",
            "path",
            "paths",
            "workKeys",
            "notes",
            "answerable",
            "category",
        )
        self.assertNotIsInstance(item, Mapping, f"{caller} received Mapping instead of narrow type")
        self.assertFalse(hasattr(item, "__dict__"), f"{caller} received object with __dict__")
        for field in forbidden_fields:
            self.assertFalse(hasattr(item, field), f"{caller} leaked forbidden attribute {field}")

    def test_eval_run_passes_only_narrow_runtime_questions_without_gold_fields(self) -> None:
        _, ds_path, _ = self._make_poison_gold_dataset_files("eval-spy")
        observed_exec_items: list[object] = []
        observed_builder_items: list[object] = []
        orig_exec = adapter.execute_dataset_queries
        orig_build = adapter.build_runtime_queries

        def spy_exec(*args: Any, **kwargs: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
            passed_qs = cast(Iterable[object], kwargs["questions"])
            for item in passed_qs:
                observed_exec_items.append(item)
            return orig_exec(*args, **kwargs)

        def spy_build(question: Any, *args: Any, **kwargs: Any) -> list[str]:
            observed_builder_items.append(question)
            return orig_build(question, *args, **kwargs)

        eval_out = self.tmp / "boundary-eval-spy-out.json"
        eval_args = phase3_eval.build_parser().parse_args(
            [
                "run",
                "--clec",
                str(self.clec_bin),
                "--data-dir",
                str(self.data_dir),
                "--corpus-sha256",
                self.corpus_sha,
                "--dataset",
                str(ds_path),
                "--output",
                str(eval_out),
            ]
        )
        with (
            mock.patch.object(adapter, "execute_dataset_queries", side_effect=spy_exec),
            mock.patch.object(adapter, "build_runtime_queries", side_effect=spy_build),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            rc = phase3_eval.cmd_run(eval_args)
        self.assertEqual(rc, 0)
        self.assertEqual(len(observed_exec_items), 1)
        self.assertEqual(len(observed_builder_items), 1)
        for item in observed_exec_items:
            self._assert_narrow_runtime_input(item, "eval.execute_dataset_queries")
            self.assertIsInstance(item, adapter.RuntimeQuestion)
        for item in observed_builder_items:
            self._assert_narrow_runtime_input(item, "eval.build_runtime_queries")
            self.assertIsInstance(item, adapter.RuntimeQuestion)
        eval_report = json.loads(eval_out.read_text(encoding="utf-8"))
        self.assertEqual(eval_report["verdict"], "complete")
        self.assertTrue(all(eval_report["gates"].values()))
        self.assertEqual(eval_report["counts"]["completeChains"], 1)

    def test_bench_warmup_passes_only_narrow_runtime_questions_without_gold_fields(self) -> None:
        _, ds_path, blind_path = self._make_poison_gold_dataset_files("bench-spy")
        bench_observed_items: list[object] = []
        orig_build = adapter.build_runtime_queries

        def spy_bench_build(question: Any, *args: Any, **kwargs: Any) -> list[str]:
            bench_observed_items.append(question)
            return orig_build(question, *args, **kwargs)

        bench_out = self.tmp / "boundary-bench-spy-out.json"
        with (
            mock.patch.object(adapter, "build_runtime_queries", side_effect=spy_bench_build),
            mock.patch.object(
                sys,
                "argv",
                [
                    "bench.py",
                    "--clec",
                    str(self.clec_bin),
                    "--data-dir",
                    str(self.data_dir),
                    "--corpus-sha256",
                    self.corpus_sha,
                    "--dataset",
                    str(ds_path),
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
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            bench_rc = bench.main()
        self.assertEqual(bench_rc, 0)
        self.assertEqual(len(bench_observed_items), 2)
        for item in bench_observed_items:
            self._assert_narrow_runtime_input(item, "bench.build_runtime_queries")
            self.assertIsInstance(item, adapter.RuntimeQuestion)
        bench_text = bench_out.read_text(encoding="utf-8")
        self.assertNotIn("POISON_GOLD_NOTES_DO_NOT_LEAK", bench_text)
        bench_rep = json.loads(bench_text)
        self.assertEqual(bench_rep["comparisonStatus"], "DISTINCT_QUERY_PLANS")
        self.assertEqual(bench_rep["warmupErrorCount"], 0)

    def test_direct_gold_record_to_query_api_rejected_before_cli_spawn(self) -> None:
        gold_q, _, _ = self._make_poison_gold_dataset_files("direct-reject")
        sentinel_marker = self.tmp / "sentinel-cli-invoked.marker"
        sentinel_cli = self.tmp / "sentinel-clec.sh"
        sentinel_cli.write_text(
            f"#!/bin/sh\ntouch {str(sentinel_marker)!r}\nexit 1\n",
            encoding="utf-8",
        )
        sentinel_cli.chmod(sentinel_cli.stat().st_mode | stat.S_IXUSR)

        with self.assertRaises(TypeError):
            adapter.execute_dataset_queries(
                clec_bin=sentinel_cli,
                data_dir=self.data_dir,
                corpus_sha256=self.corpus_sha,
                questions=cast(Any, [gold_q]),
            )
        self.assertFalse(sentinel_marker.exists())

        mixed = [adapter.RuntimeQuestion(id="q-ok", question="稅務問題"), gold_q]
        with self.assertRaises(TypeError):
            adapter.execute_dataset_queries(
                clec_bin=sentinel_cli,
                data_dir=self.data_dir,
                corpus_sha256=self.corpus_sha,
                questions=cast(Any, mixed),
            )
        self.assertFalse(sentinel_marker.exists())

        with self.assertRaises(TypeError):
            adapter.execute_dataset_queries(
                clec_bin=sentinel_cli,
                data_dir=self.data_dir,
                corpus_sha256=self.corpus_sha,
                questions=cast(Any, gold_q),
            )
        self.assertFalse(sentinel_marker.exists())

        duck_obj = SimpleNamespace(id="q-duck", question="稅務問題", evidence=["leak"])
        with self.assertRaises(TypeError):
            adapter.execute_dataset_queries(
                clec_bin=sentinel_cli,
                data_dir=self.data_dir,
                corpus_sha256=self.corpus_sha,
                questions=cast(Any, [duck_obj]),
            )
        self.assertFalse(sentinel_marker.exists())

        with self.assertRaises(TypeError):
            adapter.build_runtime_queries(
                cast(Any, gold_q),
                mode="single_query_product_baseline",
                query_angle="question",
                blind_map=None,
            )

        with self.assertRaises(TypeError):
            adapter.build_runtime_queries(
                cast(Any, duck_obj),
                mode="single_query_product_baseline",
                query_angle="question",
                blind_map=None,
            )

    def test_runtime_question_structural_restrictions_poison_isolation_and_narrow_positive_controls(self) -> None:
        rq_type = adapter.RuntimeQuestion
        self.assertTrue(dataclasses.is_dataclass(rq_type))
        self.assertTrue(getattr(rq_type, "__dataclass_params__").frozen)
        self.assertEqual(getattr(rq_type, "__slots__"), ("id", "question"))
        self.assertEqual(tuple(f.name for f in dataclasses.fields(rq_type)), ("id", "question"))

        rq = rq_type(id="q-struct", question="  匯回臺灣 稅務問題  ")
        self.assertFalse(hasattr(rq, "__dict__"))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            setattr(rq, "id", "other")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            setattr(rq, "question", "other")
        with self.assertRaises((AttributeError, TypeError)):
            setattr(rq, "evidence", [])
        with self.assertRaises(AttributeError):
            object.__setattr__(rq, "evidence", [])

        build_sig = inspect.signature(adapter.build_runtime_queries)
        exec_sig = inspect.signature(adapter.execute_dataset_queries)
        self.assertIn("RuntimeQuestion", str(build_sig.parameters["question"].annotation))
        self.assertIn("RuntimeQuestion", str(exec_sig.parameters["questions"].annotation))
        self.assertNotIn("dict", str(build_sig.parameters["question"].annotation))
        self.assertNotIn("Mapping", str(build_sig.parameters["question"].annotation))
        self.assertNotIn("dict", str(exec_sig.parameters["questions"].annotation))
        self.assertNotIn("Mapping", str(exec_sig.parameters["questions"].annotation))

        with self.assertRaises(ValueError):
            rq_type(id="", question="ok")
        with self.assertRaises(TypeError):
            rq_type(id=cast(Any, 123), question="ok")
        with self.assertRaises(TypeError):
            rq_type(id="q-1", question=cast(Any, None))
        with self.assertRaises(ValueError):
            adapter.extract_runtime_questions([{"id": "q-1"}])
        with self.assertRaises(TypeError):
            adapter.extract_runtime_questions(cast(Any, {"id": "q-1", "question": "ok"}))

        gold_q, _, _ = self._make_poison_gold_dataset_files("poison-read")

        class _ReadTrackingGoldMapping(Mapping[str, Any]):
            def __init__(self, inner: dict[str, Any]) -> None:
                self._inner = inner
                self.read_keys: list[str] = []

            def __getitem__(self, key: str) -> Any:
                self.read_keys.append(key)
                if key not in ("id", "question"):
                    raise AssertionError(f"Forbidden gold key read outside validation/scoring: {key!r}")
                return self._inner[key]

            def __iter__(self) -> Iterator[str]:
                raise AssertionError("Boundary extractor must not iterate over gold mapping keys")

            def __len__(self) -> int:
                return len(self._inner)

            def __contains__(self, key: object) -> bool:
                if key not in ("id", "question"):
                    raise AssertionError(f"Forbidden gold key membership check: {key!r}")
                return key in self._inner

        tracked = _ReadTrackingGoldMapping(gold_q)
        extracted = adapter.extract_runtime_questions([tracked])
        self.assertEqual(extracted, (adapter.RuntimeQuestion(id=gold_q["id"], question=gold_q["question"]),))
        self.assertEqual(set(tracked.read_keys), {"id", "question"})

        blind_map = {
            "q-pos": ["  匯回臺灣  ", "  稅務問題 ", "條件", "臺灣", "extra-fifth"],
        }
        q_ws = adapter.RuntimeQuestion(id="q-pos", question="  匯回臺灣 稅務問題  ")
        self.assertEqual(
            adapter.build_runtime_queries(
                q_ws,
                mode="single_query_product_baseline",
                query_angle="question",
                blind_map=blind_map,
            ),
            ["匯回臺灣 稅務問題"],
        )
        self.assertEqual(
            adapter.build_runtime_queries(
                q_ws,
                mode="single_query_product_baseline",
                query_angle="blind_rewrite",
                blind_map=blind_map,
            ),
            ["匯回臺灣"],
        )
        self.assertEqual(
            adapter.build_runtime_queries(
                q_ws,
                mode="rrf_multiquery",
                query_angle="blind_rewrite",
                blind_map=blind_map,
            ),
            ["匯回臺灣", "稅務問題", "條件", "臺灣"],
        )
        q_kw = adapter.RuntimeQuestion(
            id="q-kw-pos",
            question="  read --context 1 --release 匯回臺灣 稅務問題  ",
        )
        self.assertEqual(
            adapter.build_runtime_queries(
                q_kw,
                mode="single_query_product_baseline",
                query_angle="question",
                blind_map=None,
            ),
            ["read --context 1 --release 匯回臺灣 稅務問題"],
        )

        sid_srt, sp_srt = self._span_for("ep1.srt", "若無稅務問題才能匯回臺灣")
        full_dataset = {
            "schemaVersion": 1,
            "corpusSha256": self.corpus_sha,
            "split": "development",
            "questions": [
                {
                    "id": "q-pos",
                    "category": "condition",
                    "question": "  匯回臺灣 稅務問題  ",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c1",
                            "sourceId": sid_srt,
                            "path": "ep1.srt",
                            "spans": [sp_srt],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "condition",
                        }
                    ],
                },
                {
                    "id": "q-kw-pos",
                    "category": "condition",
                    "question": "  read --context 1 --release 匯回臺灣 稅務問題  ",
                    "answerable": True,
                    "workKeys": ["w:ep1"],
                    "evidence": [
                        {
                            "claimId": "c2",
                            "sourceId": sid_srt,
                            "path": "ep1.srt",
                            "spans": [sp_srt],
                            "quote": "若無稅務問題才能匯回臺灣",
                            "kind": "condition",
                        }
                    ],
                },
            ],
        }
        narrow_outcomes, _ = adapter.execute_dataset_queries(
            clec_bin=self.clec_bin,
            data_dir=self.data_dir,
            corpus_sha256=self.corpus_sha,
            questions=(q_ws, q_kw),
            read_top_n=1,
        )
        summary = score.summarize_evaluation(full_dataset, narrow_outcomes, self.corpus, self.corpus_sha)
        self.assertEqual(summary["verdict"], "complete")
        self.assertEqual(summary["counts"]["completeChains"], 2)
        self.assertTrue(all(summary["gates"].values()))

        pos_ds_path = self.tmp / "narrow-pos-eval-ds.json"
        pos_ds_path.write_text(json.dumps(full_dataset, ensure_ascii=False), encoding="utf-8")
        pos_blind_path = self.tmp / "narrow-pos-blind.json"
        pos_blind_path.write_text(
            json.dumps(
                [
                    {"id": "q-pos", "queries": ["匯回臺灣 稅務問題", "稅務 問題"]},
                    {"id": "q-kw-pos", "queries": ["匯回臺灣", "稅務問題"]},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        pos_eval_out = self.tmp / "narrow-pos-eval-out.json"
        eval_py = Path(__file__).resolve().parent / "eval.py"
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
                str(pos_ds_path),
                "--mode",
                "rrf_multiquery",
                "--query-angle",
                "blind_rewrite",
                "--blind-queries",
                str(pos_blind_path),
                "--read-top-n",
                "1",
                "--output",
                str(pos_eval_out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        pos_eval_rep = json.loads(pos_eval_out.read_text(encoding="utf-8"))
        self.assertEqual(pos_eval_rep["verdict"], "complete")
        self.assertEqual(pos_eval_rep["counts"]["completeChains"], 2)
        self.assertTrue(all(pos_eval_rep["gates"].values()))

        pos_bench_out = self.tmp / "narrow-pos-bench-out.json"
        bench_py = Path(__file__).resolve().parent / "bench.py"
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
                str(pos_ds_path),
                "--blind-queries",
                str(pos_blind_path),
                "--query-angle",
                "blind_rewrite",
                "--repeats",
                "5",
                "--output",
                str(pos_bench_out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        pos_bench_rep = json.loads(pos_bench_out.read_text(encoding="utf-8"))
        self.assertEqual(pos_bench_rep["comparisonStatus"], "DISTINCT_QUERY_PLANS")
        self.assertEqual(pos_bench_rep["comparisonVerdict"], "valid_interleaved_latency_comparison")
        self.assertEqual(pos_bench_rep["warmupErrorCount"], 0)


if __name__ == "__main__":
    unittest.main()
