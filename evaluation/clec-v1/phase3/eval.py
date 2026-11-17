#!/usr/bin/env python3
"""Rerunnable Phase 3 retrieval evaluation driver for clec-native-v2."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter
import score


def _db_path_for_release(data_dir: Path, corpus_sha256: str) -> Path:
    return data_dir / f"{corpus_sha256}.sqlite"


def cmd_validate_dataset(args: argparse.Namespace) -> int:
    dataset_bytes = args.dataset.read_bytes()
    dataset = json.loads(dataset_bytes.decode("utf-8"))
    db_path = _db_path_for_release(args.data_dir.resolve(), args.corpus_sha256)
    if not db_path.is_file():
        print(json.dumps({"valid": False, "error": f"Missing corpus SQLite: {db_path}"}, indent=2))
        return 1
    corpus = score.CorpusIndexView(db_path, args.corpus_sha256)
    errors = score.validate_dataset_against_db(dataset, corpus, args.corpus_sha256)
    out = {
        "schemaVersion": 1,
        "datasetSha256": hashlib.sha256(dataset_bytes).hexdigest(),
        "corpusSha256": args.corpus_sha256,
        "valid": len(errors) == 0,
        "errorCount": len(errors),
        "errors": errors,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


def cmd_run(args: argparse.Namespace) -> int:
    clec_bin = args.clec.resolve()
    data_dir = args.data_dir.resolve()
    dataset_bytes = args.dataset.read_bytes()
    dataset = json.loads(dataset_bytes.decode("utf-8"))
    dataset_sha = hashlib.sha256(dataset_bytes).hexdigest()

    ok_status, status_info = adapter.verify_active_corpus(
        clec_bin,
        data_dir,
        args.corpus_sha256,
        args.timeout_sec,
    )
    if not ok_status:
        report = {
            "schemaVersion": 1,
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
            "verdict": "inconclusive",
            "reason": status_info["error"],
            "corpusSha256": args.corpus_sha256,
            "datasetSha256": dataset_sha,
        }
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1

    db_path = _db_path_for_release(data_dir, args.corpus_sha256)
    corpus = score.CorpusIndexView(db_path, args.corpus_sha256)
    gt_errors = score.validate_dataset_against_db(dataset, corpus, args.corpus_sha256)
    if gt_errors:
        report = {
            "schemaVersion": 1,
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
            "verdict": "inconclusive",
            "reason": "Ground truth validation failed or dataset corpusSha256 mismatched.",
            "groundTruthValidation": {"valid": False, "errorCount": len(gt_errors), "errors": gt_errors},
            "corpusSha256": args.corpus_sha256,
            "datasetSha256": dataset_sha,
        }
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1

    outcomes, raw_logs = adapter.execute_dataset_queries(
        clec_bin=clec_bin,
        data_dir=data_dir,
        corpus_sha256=args.corpus_sha256,
        questions=dataset["questions"],
        mode=args.mode,
        query_angle=args.query_angle,
        blind_queries_path=args.blind_queries.resolve() if args.blind_queries else None,
        limit=args.limit,
        per_work=args.per_work,
        match_mode=args.match_mode,
        max_bytes=args.max_bytes,
        read_max_bytes=args.read_max_bytes,
        read_top_n=args.read_top_n,
        timeout_sec=args.timeout_sec,
    )

    scored = score.summarize_evaluation(
        dataset,
        outcomes,
        corpus,
        args.corpus_sha256,
        top_k=args.limit,
        stdout_byte_budget=args.max_bytes,
        read_byte_budget=args.read_max_bytes if args.read_top_n > 0 else None,
    )
    scored["timestamp"] = dt.datetime.now(dt.timezone.utc).isoformat()
    scored["datasetSha256"] = dataset_sha
    scored["config"] = {
        "clec": str(clec_bin),
        "dataDir": str(data_dir),
        "mode": args.mode,
        "queryAngle": args.query_angle,
        "blindQueriesPath": str(args.blind_queries) if args.blind_queries else None,
        "limit": args.limit,
        "perWork": args.per_work,
        "matchMode": args.match_mode,
        "maxBytes": args.max_bytes,
        "readMaxBytes": args.read_max_bytes,
        "readTopN": args.read_top_n,
        "timeoutSec": args.timeout_sec,
    }

    if args.raw_logs:
        args.raw_logs.parent.mkdir(parents=True, exist_ok=True)
        args.raw_logs.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in raw_logs),
            encoding="utf-8",
        )
        scored["rawLogsPath"] = str(args.raw_logs)

    if args.outcomes_out:
        args.outcomes_out.parent.mkdir(parents=True, exist_ok=True)
        args.outcomes_out.write_text(json.dumps(outcomes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        scored["outcomesPath"] = str(args.outcomes_out)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(scored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "verdict": scored["verdict"],
                "counts": scored.get("counts"),
                "gates": scored.get("gates"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if scored["verdict"] == "complete" and all(scored["gates"].values()) else 1


def cmd_score_outcomes(args: argparse.Namespace) -> int:
    dataset_bytes = args.dataset.read_bytes()
    dataset = json.loads(dataset_bytes.decode("utf-8"))
    outcomes = json.loads(args.outcomes.read_text(encoding="utf-8"))
    db_path = _db_path_for_release(args.data_dir.resolve(), args.corpus_sha256)
    if not db_path.is_file():
        print(json.dumps({"verdict": "inconclusive", "reason": f"Missing corpus SQLite: {db_path}"}, indent=2))
        return 1
    corpus = score.CorpusIndexView(db_path, args.corpus_sha256)
    scored = score.summarize_evaluation(
        dataset,
        outcomes,
        corpus,
        args.corpus_sha256,
        top_k=args.limit,
        stdout_byte_budget=args.max_bytes,
        read_byte_budget=args.read_max_bytes,
    )
    scored["datasetSha256"] = hashlib.sha256(dataset_bytes).hexdigest()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(scored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"verdict": scored["verdict"], "counts": scored.get("counts"), "gates": scored.get("gates")}, indent=2))
    return 0 if scored["verdict"] == "complete" and all(scored["gates"].values()) else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CLEC Phase 3 evaluation scaffold")
    sub = parser.add_subparsers(dest="command", required=True)

    p_val = sub.add_parser("validate-dataset", help="Validate annotation JSON against active clec-native-v2 DB")
    p_val.add_argument("--dataset", required=True, type=Path)
    p_val.add_argument("--data-dir", required=True, type=Path)
    p_val.add_argument("--corpus-sha256", required=True)
    p_val.set_defaults(func=cmd_validate_dataset)

    p_run = sub.add_parser("run", help="Run clec retrieval and score evidence coverage")
    p_run.add_argument("--clec", required=True, type=Path)
    p_run.add_argument("--data-dir", required=True, type=Path)
    p_run.add_argument("--corpus-sha256", required=True)
    p_run.add_argument("--dataset", required=True, type=Path)
    p_run.add_argument("--mode", choices=sorted(adapter.VALID_MODES), default="default_bm25")
    p_run.add_argument("--query-angle", choices=sorted(adapter.VALID_QUERY_ANGLES), default="question")
    p_run.add_argument("--blind-queries", type=Path)
    p_run.add_argument("--limit", type=int, default=5)
    p_run.add_argument("--per-work", type=int, default=2)
    p_run.add_argument("--match-mode", choices=["any", "all"], default="any")
    p_run.add_argument("--max-bytes", type=int, default=65536)
    p_run.add_argument("--read-max-bytes", type=int, default=65536)
    p_run.add_argument("--read-top-n", type=int, default=0)
    p_run.add_argument("--timeout-sec", type=float, default=30.0)
    p_run.add_argument("--raw-logs", type=Path)
    p_run.add_argument("--outcomes-out", type=Path)
    p_run.add_argument("--output", type=Path)
    p_run.set_defaults(func=cmd_run)

    p_score = sub.add_parser("score-outcomes", help="Score saved adapter outcomes JSON against dataset")
    p_score.add_argument("--dataset", required=True, type=Path)
    p_score.add_argument("--outcomes", required=True, type=Path)
    p_score.add_argument("--data-dir", required=True, type=Path)
    p_score.add_argument("--corpus-sha256", required=True)
    p_score.add_argument("--limit", type=int, default=5)
    p_score.add_argument("--max-bytes", type=int, default=65536)
    p_score.add_argument("--read-max-bytes", type=int)
    p_score.add_argument("--output", type=Path)
    p_score.set_defaults(func=cmd_score_outcomes)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
