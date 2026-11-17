"""CLI input adapter for Phase 3 retrieval evaluation on clec-native-v2."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any


VALID_MODES = frozenset({"single_query_product_baseline", "rrf_multiquery"})
VALID_QUERY_ANGLES = frozenset({"question", "blind_rewrite"})
FORBIDDEN_QUERY_FIELDS = frozenset({"evidence", "quote", "quotes", "workKeys", "notes", "spans"})
OUTCOME_SCHEMA_VERSION = 2


def _clean_env() -> dict[str, str]:
    return {
        k: v
        for k, v in os.environ.items()
        if not any(tok in k.upper() for tok in ("API_KEY", "TOKEN", "SECRET"))
    }


def load_blind_queries(path: Path) -> dict[str, list[str]]:
    raw = path.read_text(encoding="utf-8")
    mapping: dict[str, list[str]] = {}
    if path.suffix.lower() == ".jsonl":
        items = [json.loads(line) for line in raw.splitlines() if line.strip()]
    else:
        parsed = json.loads(raw)
        items = parsed.get("questions", parsed) if isinstance(parsed, dict) else parsed
    if isinstance(items, dict):
        for qid, queries in items.items():
            mapping[str(qid)] = [str(q) for q in queries]
        return mapping
    for row in items:
        if not isinstance(row, dict):
            continue
        if any(k in row for k in FORBIDDEN_QUERY_FIELDS):
            raise ValueError(
                f"Blind query file contains forbidden gold fields: {sorted(FORBIDDEN_QUERY_FIELDS & set(row))}"
            )
        qid = str(row["id"])
        queries = row.get("queries")
        if not isinstance(queries, list) or not queries:
            raise ValueError(f"Blind query entry {qid!r} must provide non-empty queries list")
        mapping[qid] = [str(q) for q in queries]
    return mapping


def build_runtime_queries(
    question: dict[str, Any],
    *,
    mode: str,
    query_angle: str,
    blind_map: dict[str, list[str]] | None,
) -> list[str]:
    if mode not in VALID_MODES:
        raise ValueError(f"Unsupported mode {mode!r}; expected one of {sorted(VALID_MODES)}")
    if query_angle not in VALID_QUERY_ANGLES:
        raise ValueError(f"Unsupported query_angle {query_angle!r}")

    if query_angle == "question":
        q_text = str(question["question"]).strip()
        if not q_text:
            raise ValueError(f"Empty question text for {question['id']}")
        return [q_text]

    if blind_map is None or question["id"] not in blind_map:
        raise ValueError(f"Missing blind rewrite queries for question {question['id']!r}")
    queries = [q.strip() for q in blind_map[question["id"]] if q.strip()]
    if not queries:
        raise ValueError(f"Empty blind rewrite queries for question {question['id']!r}")
    if mode == "single_query_product_baseline":
        return [queries[0]]
    return queries[:4]


def run_clec_command(
    clec_bin: Path,
    argv_tail: list[str],
    *,
    data_dir: Path,
    max_bytes: int,
    timeout_sec: float,
) -> dict[str, Any]:
    argv = [
        str(clec_bin),
        "--data-dir",
        str(data_dir),
        "--offline",
        "--json",
        "--max-bytes",
        str(max_bytes),
        *argv_tail,
    ]
    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            env=_clean_env(),
            timeout=timeout_sec,
        )
        elapsed = time.monotonic() - started
        return {
            "argv": argv,
            "exitCode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "elapsedSeconds": round(elapsed, 6),
            "timedOut": False,
        }
    except subprocess.TimeoutExpired as exc:
        elapsed = time.monotonic() - started
        stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return {
            "argv": argv,
            "exitCode": None,
            "stdout": stdout,
            "stderr": stderr,
            "elapsedSeconds": round(elapsed, 6),
            "timedOut": True,
        }


def verify_active_corpus(
    clec_bin: Path,
    data_dir: Path,
    expected_corpus_sha256: str,
    timeout_sec: float,
) -> tuple[bool, dict[str, Any]]:
    active_json = data_dir / "active.json"
    if active_json.is_file():
        try:
            active_obj = json.loads(active_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return False, {"error": f"Invalid active.json in {data_dir}: {exc}"}
        if active_obj.get("release") != expected_corpus_sha256:
            return False, {
                "error": f"active.json release {active_obj.get('release')!r} != expected {expected_corpus_sha256!r}"
            }

    rec = run_clec_command(
        clec_bin,
        ["status"],
        data_dir=data_dir,
        max_bytes=65536,
        timeout_sec=timeout_sec,
    )
    if rec["timedOut"] or rec["exitCode"] != 0:
        return False, {"record": rec, "error": "clec status failed or timed out"}
    try:
        payload = json.loads(rec["stdout"])
        data = payload["data"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        return False, {"record": rec, "error": f"Invalid status JSON: {exc}"}
    if not data.get("ready"):
        return False, {"record": rec, "error": "Target --data-dir has no active corpus"}
    if data.get("corpusFormat") != "clec-native-v2":
        return False, {"record": rec, "error": f"Expected clec-native-v2, got {data.get('corpusFormat')}"}
    if data.get("activeRelease") != expected_corpus_sha256:
        return False, {
            "record": rec,
            "error": f"Active release {data.get('activeRelease')} != expected {expected_corpus_sha256}",
        }
    return True, {"record": rec, "status": data}


def _step_record(step_name: str, rec: dict[str, Any]) -> dict[str, Any]:
    return {
        "step": step_name,
        "argv": rec["argv"],
        "exitCode": rec["exitCode"],
        "timedOut": rec["timedOut"],
        "elapsedSeconds": rec["elapsedSeconds"],
        "stdoutUtf8": rec["stdout"],
        "stderrUtf8": rec["stderr"],
    }


def execute_dataset_queries(
    *,
    clec_bin: Path,
    data_dir: Path,
    corpus_sha256: str,
    questions: list[dict[str, Any]],
    mode: str = "single_query_product_baseline",
    query_angle: str = "question",
    blind_queries_path: Path | None = None,
    limit: int = 5,
    per_work: int = 2,
    match_mode: str = "any",
    max_bytes: int = 65536,
    read_max_bytes: int = 65536,
    read_top_n: int = 0,
    timeout_sec: float = 30.0,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    blind_map = load_blind_queries(blind_queries_path) if blind_queries_path is not None else None
    outcomes: list[dict[str, Any]] = []
    raw_logs: list[dict[str, Any]] = []

    for q in questions:
        qid = q["id"]
        queries = build_runtime_queries(q, mode=mode, query_angle=query_angle, blind_map=blind_map)
        search_argv = [
            "search",
            *queries,
            "--match-mode",
            match_mode,
            "--limit",
            str(limit),
            "--per-work",
            str(per_work),
            "--release",
            corpus_sha256,
        ]
        search_rec = run_clec_command(
            clec_bin,
            search_argv,
            data_dir=data_dir,
            max_bytes=max_bytes,
            timeout_sec=timeout_sec,
        )
        raw_logs.append({"questionId": qid, "step": "search", **search_rec})
        steps = [_step_record("search", search_rec)]

        if search_rec["timedOut"]:
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": "timeout",
                    "stopReason": f"search_timeout_{timeout_sec}s",
                    "steps": steps,
                }
            )
            continue

        if search_rec["exitCode"] != 0:
            err_code = None
            try:
                err_code = json.loads(search_rec["stderr"]).get("error", {}).get("code")
            except (json.JSONDecodeError, AttributeError):
                pass
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": "error",
                    "stopReason": f"cli_error:{err_code or search_rec['exitCode']}",
                    "steps": steps,
                }
            )
            continue

        try:
            search_json = json.loads(search_rec["stdout"])
            hits = search_json["data"]["hits"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": "error",
                    "stopReason": f"invalid_search_json:{exc}",
                    "steps": steps,
                }
            )
            continue

        read_error: str | None = None
        if read_top_n > 0 and hits:
            read_ids = [h["passageId"] for h in hits[:read_top_n]]
            read_rec = run_clec_command(
                clec_bin,
                ["read", *read_ids, "--context", "1"],
                data_dir=data_dir,
                max_bytes=read_max_bytes,
                timeout_sec=timeout_sec,
            )
            raw_logs.append({"questionId": qid, "step": "read", **read_rec})
            steps.append(_step_record("read", read_rec))
            if read_rec["timedOut"]:
                read_error = f"read_timeout_{timeout_sec}s"
            elif read_rec["exitCode"] != 0:
                err_code = None
                try:
                    err_code = json.loads(read_rec["stderr"]).get("error", {}).get("code")
                except (json.JSONDecodeError, AttributeError):
                    pass
                read_error = f"read_cli_error:{err_code or read_rec['exitCode']}"
            else:
                try:
                    read_json = json.loads(read_rec["stdout"])
                    _ = read_json["data"]["items"]
                except (json.JSONDecodeError, KeyError, TypeError) as exc:
                    read_error = f"invalid_read_json:{exc}"

        if read_error is not None:
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": "error",
                    "stopReason": read_error,
                    "steps": steps,
                }
            )
            continue

        outcomes.append(
            {
                "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                "id": qid,
                "mode": mode,
                "queryAngle": query_angle,
                "queries": queries,
                "status": "completed",
                "stopReason": None,
                "steps": steps,
            }
        )

    return outcomes, raw_logs
