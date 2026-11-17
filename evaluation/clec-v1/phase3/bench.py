#!/usr/bin/env python3
"""Interleaved runtime benchmark separating whole-process CLI vs SQLite-only FTS latency."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import statistics
import sys
import time
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter


def _summary_stats(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "median": None, "min": None, "max": None}
    return {
        "count": len(values),
        "median": round(statistics.median(values), 6),
        "min": round(min(values), 6),
        "max": round(max(values), 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Interleaved Phase 3 runtime bench (whole CLI vs SQLite-only)")
    parser.add_argument("--clec", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--corpus-sha256", required=True)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--blind-queries", type=Path)
    parser.add_argument("--query-angle", choices=sorted(adapter.VALID_QUERY_ANGLES), default="question")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--allow-smoke-repeats", action="store_true", help="Allow <5 repeats for unit/smoke tests only")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--per-work", type=int, default=2)
    parser.add_argument("--max-bytes", type=int, default=65536)
    parser.add_argument("--timeout-sec", type=float, default=30.0)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if args.repeats < 5 and not args.allow_smoke_repeats:
        raise SystemExit("--repeats must be >= 5 for protocol compliance (use --allow-smoke-repeats only for tests)")

    clec_bin = args.clec.resolve()
    data_dir = args.data_dir.resolve()
    ok_status, status_info = adapter.verify_active_corpus(
        clec_bin, data_dir, args.corpus_sha256, args.timeout_sec
    )
    if not ok_status:
        raise SystemExit(status_info["error"])

    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    blind_map = adapter.load_blind_queries(args.blind_queries.resolve()) if args.blind_queries else None
    questions = dataset["questions"]
    db_path = data_dir / f"{args.corpus_sha256}.sqlite"

    load_before = os.getloadavg() if hasattr(os, "getloadavg") else None
    cli_records: dict[str, list[dict[str, Any]]] = {"default_bm25": [], "rrf_multiquery": []}
    sqlite_only_records: list[dict[str, Any]] = []

    for rep in range(args.repeats):
        order = ["default_bm25", "rrf_multiquery"] if rep % 2 == 0 else ["rrf_multiquery", "default_bm25"]
        for q in questions:
            for mode in order:
                if mode == "rrf_multiquery" and blind_map is None:
                    queries = adapter.build_runtime_queries(q, mode="default_bm25", query_angle="question", blind_map=None)
                else:
                    queries = adapter.build_runtime_queries(
                        q,
                        mode=mode,
                        query_angle=args.query_angle if blind_map is not None else "question",
                        blind_map=blind_map,
                    )
                rec = adapter.run_clec_command(
                    clec_bin,
                    ["search", *queries, "--limit", str(args.limit), "--per-work", str(args.per_work), "--release", args.corpus_sha256],
                    data_dir=data_dir,
                    max_bytes=args.max_bytes,
                    timeout_sec=args.timeout_sec,
                )
                ok = not rec["timedOut"] and rec["exitCode"] == 0
                work_keys: list[str] = []
                if ok:
                    hits = json.loads(rec["stdout"])["data"]["hits"]
                    work_keys = sorted({h["work"]["workKey"] for h in hits})
                cli_records[mode].append(
                    {
                        "repeat": rep,
                        "questionId": q["id"],
                        "elapsedSeconds": rec["elapsedSeconds"],
                        "ok": ok,
                        "distinctWorkCount": len(work_keys),
                        "timedOut": rec["timedOut"],
                        "exitCode": rec["exitCode"],
                    }
                )

        # Measure SQLite-only FTS5 BM25 query separately from whole-process CLI startup + tokenization + read.
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            conn.execute("CREATE VIRTUAL TABLE temp.__v_bench USING fts5vocab(main, search, instance)")
            sample_term_row = conn.execute("SELECT term FROM temp.__v_bench LIMIT 1").fetchone()
            conn.execute("DROP TABLE temp.__v_bench")
            probe_term = sample_term_row[0] if sample_term_row else None
            for q in questions:
                t0 = time.monotonic()
                if probe_term is not None:
                    rows = conn.execute(
                        "SELECT p.id, bm25(search, 4.0, 1.0) AS sc FROM search "
                        "JOIN passages p ON p.rowid = search.rowid "
                        "WHERE search MATCH ? ORDER BY sc ASC LIMIT 100",
                        (f'"{probe_term}"',),
                    ).fetchall()
                    hit_len = len(rows)
                else:
                    hit_len = 0
                sqlite_only_records.append(
                    {
                        "repeat": rep,
                        "questionId": q["id"],
                        "elapsedSeconds": round(time.monotonic() - t0, 6),
                        "candidateRowCount": hit_len,
                    }
                )

    load_after = os.getloadavg() if hasattr(os, "getloadavg") else None
    report = {
        "schemaVersion": 1,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurementScope": "runtime_latency_only_no_quality_claim",
        "corpusSha256": args.corpus_sha256,
        "repeats": args.repeats,
        "questionCount": len(questions),
        "hostLoadBefore": list(load_before) if load_before else None,
        "hostLoadAfter": list(load_after) if load_after else None,
        "wholeProcessCli": {
            mode: {
                "elapsedSeconds": _summary_stats([r["elapsedSeconds"] for r in rows if r["ok"]]),
                "errorCount": sum(1 for r in rows if not r["ok"]),
                "medianDistinctWorks": (
                    statistics.median([r["distinctWorkCount"] for r in rows if r["ok"]])
                    if any(r["ok"] for r in rows)
                    else None
                ),
                "runs": rows,
            }
            for mode, rows in cli_records.items()
        },
        "sqliteOnlyProbe": {
            "note": "In-process read-only SQLite query excluding CLI startup, jieba/OpenCC tokenization, and stdout JSON serialization.",
            "elapsedSeconds": _summary_stats([r["elapsedSeconds"] for r in sqlite_only_records]),
            "runs": sqlite_only_records,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "repeats": args.repeats,
                "wholeProcessDefaultBm25": report["wholeProcessCli"]["default_bm25"]["elapsedSeconds"],
                "wholeProcessRrfMultiquery": report["wholeProcessCli"]["rrf_multiquery"]["elapsedSeconds"],
                "sqliteOnlyProbe": report["sqliteOnlyProbe"]["elapsedSeconds"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
