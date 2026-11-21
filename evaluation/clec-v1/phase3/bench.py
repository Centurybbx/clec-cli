#!/usr/bin/env python3
"""Interleaved runtime benchmark separating whole-process CLI vs question-matched SQLite FTS probe."""

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
import score


def _summary_stats(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "median": None, "min": None, "max": None}
    return {
        "count": len(values),
        "median": round(statistics.median(values), 6),
        "min": round(min(values), 6),
        "max": round(max(values), 6),
    }


def _apply_work_diversity(
    candidates: list[tuple[str, str]],
    limit: int,
    per_work: int,
) -> list[tuple[str, str]]:
    selected: list[tuple[str, str]] = []
    used = [False] * len(candidates)
    work_counts: dict[str, int] = {}
    for idx, (pid, wid) in enumerate(candidates):
        if len(selected) == limit:
            break
        cnt = work_counts.get(wid, 0)
        if cnt < per_work:
            work_counts[wid] = cnt + 1
            used[idx] = True
            selected.append((pid, wid))
    if len(selected) < limit:
        for idx, pair in enumerate(candidates):
            if len(selected) == limit:
                break
            if not used[idx]:
                selected.append(pair)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Interleaved Phase 3 runtime bench (whole CLI vs question-matched SQLite FTS probe)"
    )
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
    try:
        binding = score.verify_active_corpus_binding(data_dir, args.corpus_sha256)
    except score.CorpusBindingError as exc:
        raise SystemExit(str(exc)) from exc

    ok_status, status_info = adapter.verify_active_corpus(
        clec_bin, data_dir, args.corpus_sha256, args.timeout_sec
    )
    if not ok_status:
        raise SystemExit(status_info["error"])

    db_path = binding.db_path
    actual_sha = score.stream_sha256(db_path)
    if actual_sha != args.corpus_sha256:
        raise SystemExit(f"Corpus SQLite SHA-256 mismatch: expected {args.corpus_sha256}, actual {actual_sha}")

    dataset = json.loads(args.dataset.read_bytes().decode("utf-8", errors="strict"))
    blind_map = adapter.load_blind_queries(args.blind_queries.resolve()) if args.blind_queries else None
    questions = adapter.extract_runtime_questions(dataset["questions"])
    del dataset

    effective_angle = args.query_angle if blind_map is not None else "question"
    plan_by_qid: dict[str, dict[str, list[str]]] = {}
    has_distinct_plans = True
    for q in questions:
        qid = q.id
        q_base = adapter.build_runtime_queries(
            q, mode="single_query_product_baseline", query_angle=effective_angle, blind_map=blind_map
        )
        q_rrf = adapter.build_runtime_queries(
            q, mode="rrf_multiquery", query_angle=effective_angle, blind_map=blind_map
        )
        plan_by_qid[qid] = {
            "single_query_product_baseline": q_base,
            "rrf_multiquery": q_rrf,
        }
        unique_raw_base = list(dict.fromkeys(q_base))
        unique_raw_rrf = list(dict.fromkeys(q_rrf))
        if len(unique_raw_rrf) < 2 or unique_raw_rrf == unique_raw_base:
            has_distinct_plans = False

    question_fts_queries: dict[str, str] = {}
    effective_plan_details: dict[str, dict[str, Any]] = {}
    warmup_error_count = 0
    for q in questions:
        qid = q.id
        modes_to_warm = (
            ("single_query_product_baseline", "rrf_multiquery")
            if has_distinct_plans
            else ("single_query_product_baseline",)
        )
        base_term_sets: set[frozenset[str]] | None = None
        rrf_term_sets: set[frozenset[str]] | None = None
        for mode in modes_to_warm:
            queries = plan_by_qid[qid][mode]
            warm_rec = adapter.run_clec_command(
                clec_bin,
                [
                    "search",
                    *queries,
                    "--limit",
                    str(args.limit),
                    "--per-work",
                    str(args.per_work),
                    "--release",
                    args.corpus_sha256,
                ],
                data_dir=data_dir,
                max_bytes=args.max_bytes,
                timeout_sec=args.timeout_sec,
            )
            warm_ok = (
                not warm_rec["timedOut"]
                and warm_rec["exitCode"] == 0
                and warm_rec["stdoutDecodeError"] is None
                and warm_rec["stderrDecodeError"] is None
                and warm_rec["stdout"] is not None
            )
            if not warm_ok:
                warmup_error_count += 1
                continue
            try:
                warm_data = json.loads(warm_rec["stdout"])["data"]
                q_entries = warm_data["queries"]
                term_sets = {frozenset(str(t) for t in item["terms"]) for item in q_entries}
            except (json.JSONDecodeError, KeyError, TypeError):
                warmup_error_count += 1
                continue
            if mode == "single_query_product_baseline":
                base_term_sets = term_sets
                terms = q_entries[0]["terms"]
                question_fts_queries[qid] = " OR ".join(
                    f'"t{t.encode("utf-8").hex()}"' for t in terms
                )
            else:
                rrf_term_sets = term_sets

        if rrf_term_sets is not None and (
            len(rrf_term_sets) < 2 or (base_term_sets is not None and rrf_term_sets == base_term_sets)
        ):
            has_distinct_plans = False
        effective_plan_details[qid] = {
            "baselineRawQueries": plan_by_qid[qid]["single_query_product_baseline"],
            "rrfRawQueries": plan_by_qid[qid]["rrf_multiquery"],
            "baselineEffectiveTermSetCount": len(base_term_sets) if base_term_sets is not None else None,
            "rrfEffectiveTermSetCount": len(rrf_term_sets) if rrf_term_sets is not None else None,
        }

    comparison_status = "DISTINCT_QUERY_PLANS" if has_distinct_plans else "IDENTICAL_QUERY_PLANS"

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        for fts_q in question_fts_queries.values():
            if fts_q:
                conn.execute(
                    "SELECT p.id, p.work_id, bm25(search, 4.0, 1.0) AS sc FROM search "
                    "JOIN passages p ON p.rowid = search.rowid "
                    "WHERE search MATCH ? ORDER BY sc ASC, p.id ASC LIMIT 100",
                    (fts_q,),
                ).fetchall()

    load_before = os.getloadavg() if hasattr(os, "getloadavg") else None
    cli_records: dict[str, list[dict[str, Any]]] = {
        "single_query_product_baseline": [],
        "rrf_multiquery": [],
    }
    sqlite_only_records: list[dict[str, Any]] = []

    for rep in range(args.repeats):
        if has_distinct_plans:
            order = (
                ["single_query_product_baseline", "rrf_multiquery"]
                if rep % 2 == 0
                else ["rrf_multiquery", "single_query_product_baseline"]
            )
        else:
            order = ["single_query_product_baseline"]

        for q in questions:
            qid = q.id
            for mode in order:
                queries = plan_by_qid[qid][mode]
                rec = adapter.run_clec_command(
                    clec_bin,
                    [
                        "search",
                        *queries,
                        "--limit",
                        str(args.limit),
                        "--per-work",
                        str(args.per_work),
                        "--release",
                        args.corpus_sha256,
                    ],
                    data_dir=data_dir,
                    max_bytes=args.max_bytes,
                    timeout_sec=args.timeout_sec,
                )
                ok = (
                    not rec["timedOut"]
                    and rec["exitCode"] == 0
                    and rec["stdoutDecodeError"] is None
                    and rec["stderrDecodeError"] is None
                    and rec["stdout"] is not None
                )
                work_keys: list[str] = []
                total_candidates = 0
                returned_hits = 0
                if ok:
                    try:
                        data = json.loads(rec["stdout"])["data"]
                        hits = data["hits"]
                        total_candidates = int(data.get("totalCandidates", 0))
                        returned_hits = len(hits)
                        work_keys = sorted({h["work"].get("workKey", h["work"].get("workId")) for h in hits})
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        ok = False
                cli_records[mode].append(
                    {
                        "repeat": rep,
                        "questionId": qid,
                        "queryCount": len(queries),
                        "elapsedSeconds": rec["elapsedSeconds"],
                        "ok": ok,
                        "totalCandidates": total_candidates,
                        "returnedHitCount": returned_hits,
                        "distinctWorkCount": len(work_keys),
                        "timedOut": rec["timedOut"],
                        "exitCode": rec["exitCode"],
                    }
                )

        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            for q in questions:
                qid = q.id
                fts_q = question_fts_queries.get(qid, "")
                t0 = time.monotonic()
                if fts_q:
                    rows = conn.execute(
                        "SELECT p.id, p.work_id, bm25(search, 4.0, 1.0) AS sc FROM search "
                        "JOIN passages p ON p.rowid = search.rowid "
                        "WHERE search MATCH ? ORDER BY sc ASC, p.id ASC LIMIT 100",
                        (fts_q,),
                    ).fetchall()
                    candidates = [(r[0], r[1]) for r in rows]
                    selected = _apply_work_diversity(candidates, args.limit, args.per_work)
                    candidate_count = len(candidates)
                    selected_count = len(selected)
                    distinct_works = len({w for _, w in selected})
                else:
                    candidate_count = 0
                    selected_count = 0
                    distinct_works = 0
                sqlite_only_records.append(
                    {
                        "repeat": rep,
                        "questionId": qid,
                        "elapsedSeconds": round(time.monotonic() - t0, 6),
                        "candidateRowCount": candidate_count,
                        "selectedCount": selected_count,
                        "distinctWorkCount": distinct_works,
                    }
                )

    load_after = os.getloadavg() if hasattr(os, "getloadavg") else None

    whole_process_cli = {}
    for mode, rows in cli_records.items():
        ok_rows = [r for r in rows if r["ok"]]
        whole_process_cli[mode] = {
            "runCount": len(rows),
            "errorCount": sum(1 for r in rows if not r["ok"]),
            "timeoutCount": sum(1 for r in rows if r["timedOut"]),
            "elapsedSeconds": _summary_stats([r["elapsedSeconds"] for r in ok_rows]),
            "medianCandidateCount": statistics.median([r["totalCandidates"] for r in ok_rows]) if ok_rows else None,
            "medianReturnedHits": statistics.median([r["returnedHitCount"] for r in ok_rows]) if ok_rows else None,
            "medianDistinctWorks": statistics.median([r["distinctWorkCount"] for r in ok_rows]) if ok_rows else None,
            "runs": rows,
        }

    total_cli_errors = sum(v["errorCount"] for v in whole_process_cli.values()) + warmup_error_count
    if total_cli_errors > 0:
        comparison_verdict = "inconclusive_errors_present"
    elif not has_distinct_plans:
        comparison_verdict = "no_comparison_identical_query_plans"
    elif args.repeats < 5:
        comparison_verdict = "inconclusive_under_5_repeats"
    else:
        comparison_verdict = "valid_interleaved_latency_comparison"

    report = {
        "schemaVersion": 2,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurementScope": "runtime_latency_only_no_quality_claim",
        "corpusSha256": args.corpus_sha256,
        "actualCorpusSha256": actual_sha,
        "comparisonStatus": comparison_status,
        "comparisonVerdict": comparison_verdict,
        "warmupErrorCount": warmup_error_count,
        "effectivePlanDetails": effective_plan_details,
        "repeats": args.repeats,
        "questionCount": len(questions),
        "hostLoadBefore": list(load_before) if load_before else None,
        "hostLoadAfter": list(load_after) if load_after else None,
        "wholeProcessCli": whole_process_cli,
        "sqliteOnlyQuestionMatchedProbe": {
            "note": (
                "Question-matched read-only SQLite FTS5 + per_work diversity diagnostic using pre-extracted CLI tokens; "
                "excludes CLI startup, OpenCC/jieba dictionary load, blob SHA-256 verification, and JSON serialization."
            ),
            "elapsedSeconds": _summary_stats([r["elapsedSeconds"] for r in sqlite_only_records]),
            "runs": sqlite_only_records,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "comparisonStatus": comparison_status,
                "comparisonVerdict": comparison_verdict,
                "repeats": args.repeats,
                "wholeProcessBaseline": report["wholeProcessCli"]["single_query_product_baseline"]["elapsedSeconds"],
                "wholeProcessRrfMultiquery": report["wholeProcessCli"]["rrf_multiquery"]["elapsedSeconds"],
                "sqliteOnlyQuestionMatchedProbe": report["sqliteOnlyQuestionMatchedProbe"]["elapsedSeconds"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
