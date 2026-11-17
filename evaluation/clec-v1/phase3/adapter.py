"""CLI input adapter for Phase 3 retrieval evaluation on clec-native-v2."""

from __future__ import annotations

import base64
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any, Literal

try:
    from . import score
except ImportError:
    import score


VALID_MODES = score.VALID_MODES
VALID_QUERY_ANGLES = score.VALID_QUERY_ANGLES
FORBIDDEN_QUERY_FIELDS = frozenset({"evidence", "quote", "quotes", "workKeys", "notes", "spans"})
OUTCOME_SCHEMA_VERSION = score.OUTCOME_SCHEMA_VERSION
_MAX_UNDECODABLE_BASE64_BYTES = 65536


@dataclass(frozen=True, slots=True)
class RuntimeQuestion:
    id: str
    question: str

    def __post_init__(self) -> None:
        if not isinstance(self.id, str):
            raise TypeError(f"RuntimeQuestion.id must be str, got {type(self.id).__name__}")
        if not self.id:
            raise ValueError("RuntimeQuestion.id must be a non-empty string")
        if not isinstance(self.question, str):
            raise TypeError(f"RuntimeQuestion.question must be str, got {type(self.question).__name__}")


def parse_runtime_question(record: Mapping[str, Any]) -> RuntimeQuestion:
    if not isinstance(record, Mapping):
        raise TypeError(f"Question record must be a mapping, got {type(record).__name__}")
    if "id" not in record or "question" not in record:
        raise ValueError("Question record must contain 'id' and 'question'")
    return RuntimeQuestion(id=record["id"], question=record["question"])


def extract_runtime_questions(records: Sequence[Mapping[str, Any]]) -> tuple[RuntimeQuestion, ...]:
    if isinstance(records, (str, bytes, Mapping)) or not isinstance(records, Sequence):
        raise TypeError(
            f"Question records must be a sequence of mappings, got {type(records).__name__}"
        )
    return tuple(parse_runtime_question(record) for record in records)


def _decode_stream_strict(raw: bytes, stream_name: str) -> dict[str, Any]:
    raw_len = len(raw)
    try:
        decoded = raw.decode("utf-8", errors="strict")
        return {
            "text": decoded,
            "rawByteLen": raw_len,
            "decodeError": None,
            "rawSha256": None,
            "rawBase64": None,
            "rawBase64Truncated": False,
        }
    except UnicodeDecodeError as exc:
        return {
            "text": None,
            "rawByteLen": raw_len,
            "decodeError": f"invalid_utf8_{stream_name}:{exc.reason}@byte_{exc.start}",
            "rawSha256": hashlib.sha256(raw).hexdigest(),
            "rawBase64": base64.b64encode(raw[:_MAX_UNDECODABLE_BASE64_BYTES]).decode("ascii"),
            "rawBase64Truncated": raw_len > _MAX_UNDECODABLE_BASE64_BYTES,
        }


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
    question: RuntimeQuestion,
    *,
    mode: str,
    query_angle: str,
    blind_map: dict[str, list[str]] | None,
) -> list[str]:
    if not isinstance(question, RuntimeQuestion):
        raise TypeError(f"question must be RuntimeQuestion, got {type(question).__name__}")
    if mode not in VALID_MODES:
        raise ValueError(f"Unsupported mode {mode!r}; expected one of {sorted(VALID_MODES)}")
    if query_angle not in VALID_QUERY_ANGLES:
        raise ValueError(f"Unsupported query_angle {query_angle!r}")

    if query_angle == "question":
        q_text = question.question.strip()
        if not q_text:
            raise ValueError(f"Empty question text for {question.id}")
        return [q_text]

    if blind_map is None or question.id not in blind_map:
        raise ValueError(f"Missing blind rewrite queries for question {question.id!r}")
    queries = [q.strip() for q in blind_map[question.id] if q.strip()]
    if not queries:
        raise ValueError(f"Empty blind rewrite queries for question {question.id!r}")
    if mode == "single_query_product_baseline":
        return [queries[0]]
    return queries[:4]


def run_clec_command(
    clec_bin: Path,
    argv_tail: list[str] | score.CommandPlan,
    *,
    data_dir: Path,
    max_bytes: int,
    timeout_sec: float,
) -> dict[str, Any]:
    argv = score.build_adapter_argv(clec_bin, data_dir, max_bytes, argv_tail)
    started = time.monotonic()
    timed_out = False
    exit_code: int | None = None
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=False,
            env=_clean_env(),
            timeout=timeout_sec,
        )
        elapsed = time.monotonic() - started
        exit_code = proc.returncode
        raw_stdout = proc.stdout or b""
        raw_stderr = proc.stderr or b""
    except subprocess.TimeoutExpired as exc:
        elapsed = time.monotonic() - started
        timed_out = True
        raw_stdout = (
            exc.stdout
            if isinstance(exc.stdout, bytes)
            else (exc.stdout.encode("utf-8") if isinstance(exc.stdout, str) else b"")
        )
        raw_stderr = (
            exc.stderr
            if isinstance(exc.stderr, bytes)
            else (exc.stderr.encode("utf-8") if isinstance(exc.stderr, str) else b"")
        )

    out_dec = _decode_stream_strict(raw_stdout, "stdout")
    err_dec = _decode_stream_strict(raw_stderr, "stderr")
    return {
        "argv": argv,
        "exitCode": exit_code,
        "stdout": out_dec["text"],
        "stderr": err_dec["text"],
        "stdoutRawByteLen": out_dec["rawByteLen"],
        "stderrRawByteLen": err_dec["rawByteLen"],
        "stdoutDecodeError": out_dec["decodeError"],
        "stderrDecodeError": err_dec["decodeError"],
        "stdoutRawSha256": out_dec["rawSha256"],
        "stderrRawSha256": err_dec["rawSha256"],
        "stdoutRawBase64": out_dec["rawBase64"],
        "stderrRawBase64": err_dec["rawBase64"],
        "stdoutRawBase64Truncated": out_dec["rawBase64Truncated"],
        "stderrRawBase64Truncated": err_dec["rawBase64Truncated"],
        "elapsedSeconds": round(elapsed, 6),
        "timedOut": timed_out,
    }


def verify_active_corpus(
    clec_bin: Path,
    data_dir: Path,
    expected_corpus_sha256: str,
    timeout_sec: float,
) -> tuple[bool, dict[str, Any]]:
    try:
        binding = score.verify_active_corpus_binding(data_dir, expected_corpus_sha256)
    except score.CorpusBindingError as exc:
        return False, {"error": str(exc)}

    rec = run_clec_command(
        clec_bin,
        ["status"],
        data_dir=data_dir,
        max_bytes=65536,
        timeout_sec=timeout_sec,
    )
    if rec["timedOut"] or rec["exitCode"] != 0:
        return False, {"record": rec, "error": "clec status failed or timed out"}
    if rec["stdoutDecodeError"] or rec["stderrDecodeError"] or rec["stdout"] is None:
        return False, {
            "record": rec,
            "error": f"clec status produced undecodable UTF-8: {rec['stdoutDecodeError'] or rec['stderrDecodeError']}",
        }
    try:
        payload = json.loads(rec["stdout"])
        data = payload["data"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        return False, {"record": rec, "error": f"Invalid status JSON: {exc}"}
    if not data.get("ready"):
        return False, {"record": rec, "error": "Target --data-dir has no active corpus"}
    if data.get("corpusFormat") != "clec-native-v2":
        return False, {"record": rec, "error": f"Expected clec-native-v2, got {data.get('corpusFormat')}"}
    if data.get("activeRelease") != binding.release:
        return False, {
            "record": rec,
            "error": f"Active release {data.get('activeRelease')} != expected {binding.release}",
        }
    if data.get("manifestPath") != binding.manifest_path:
        return False, {
            "record": rec,
            "error": f"Status manifestPath {data.get('manifestPath')!r} != active.json {binding.manifest_path!r}",
        }
    return True, {"record": rec, "status": data}


def _step_record(step_name: str, rec: dict[str, Any]) -> dict[str, Any]:
    step: dict[str, Any] = {
        "step": step_name,
        "argv": rec["argv"],
        "exitCode": rec["exitCode"],
        "timedOut": rec["timedOut"],
        "elapsedSeconds": rec["elapsedSeconds"],
        "stdoutUtf8": rec["stdout"],
        "stderrUtf8": rec["stderr"],
        "stdoutRawByteLen": rec["stdoutRawByteLen"],
        "stderrRawByteLen": rec["stderrRawByteLen"],
    }
    if rec["stdoutDecodeError"] is not None:
        step["stdoutDecodeError"] = rec["stdoutDecodeError"]
        step["stdoutRawSha256"] = rec["stdoutRawSha256"]
        step["stdoutRawBase64"] = rec["stdoutRawBase64"]
        if rec["stdoutRawBase64Truncated"]:
            step["stdoutRawBase64Truncated"] = True
    if rec["stderrDecodeError"] is not None:
        step["stderrDecodeError"] = rec["stderrDecodeError"]
        step["stderrRawSha256"] = rec["stderrRawSha256"]
        step["stderrRawBase64"] = rec["stderrRawBase64"]
        if rec["stderrRawBase64Truncated"]:
            step["stderrRawBase64Truncated"] = True
    return step


def execute_dataset_queries(
    *,
    clec_bin: Path,
    data_dir: Path,
    corpus_sha256: str,
    questions: Sequence[RuntimeQuestion],
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
    if isinstance(questions, (str, bytes, Mapping)) or not isinstance(questions, Sequence):
        raise TypeError(
            f"questions must be a sequence of RuntimeQuestion, got {type(questions).__name__}"
        )
    validated_questions: list[RuntimeQuestion] = []
    for idx, q in enumerate(questions):
        if not isinstance(q, RuntimeQuestion):
            raise TypeError(f"questions[{idx}] must be RuntimeQuestion, got {type(q).__name__}")
        validated_questions.append(q)

    if match_mode not in score.VALID_MATCH_MODES:
        raise ValueError(f"Unsupported match_mode {match_mode!r}; expected one of {sorted(score.VALID_MATCH_MODES)}")
    typed_match_mode: Literal["any", "all"] = "any" if match_mode == "any" else "all"
    blind_map = load_blind_queries(blind_queries_path) if blind_queries_path is not None else None
    outcomes: list[dict[str, Any]] = []
    raw_logs: list[dict[str, Any]] = []

    for q in validated_questions:
        qid = q.id
        queries = build_runtime_queries(q, mode=mode, query_angle=query_angle, blind_map=blind_map)
        search_plan = score.SearchCommandPlan(
            queries=tuple(queries),
            match_mode=typed_match_mode,
            limit=limit,
            per_work=per_work,
            release=corpus_sha256,
        )
        search_rec = run_clec_command(
            clec_bin,
            search_plan,
            data_dir=data_dir,
            max_bytes=max_bytes,
            timeout_sec=timeout_sec,
        )
        raw_logs.append({"questionId": qid, "step": "search", **search_rec})
        steps = [_step_record("search", search_rec)]

        if search_rec["timedOut"]:
            dec_err = search_rec["stdoutDecodeError"] or search_rec["stderrDecodeError"]
            stop_reason = (
                f"search_timeout_{timeout_sec}s:{dec_err}"
                if dec_err
                else f"search_timeout_{timeout_sec}s"
            )
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": "timeout",
                    "stopReason": stop_reason,
                    "steps": steps,
                }
            )
            continue

        if search_rec["stdoutDecodeError"] or search_rec["stderrDecodeError"] or search_rec["stdout"] is None:
            dec_err = search_rec["stdoutDecodeError"] or search_rec["stderrDecodeError"] or "undecodable_search"
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": "error",
                    "stopReason": f"undecodable_search_output:{dec_err}",
                    "steps": steps,
                }
            )
            continue

        if search_rec["exitCode"] != 0:
            err_code = None
            try:
                if search_rec["stderr"] is not None:
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

        read_status = "completed"
        read_error: str | None = None
        if read_top_n > 0 and hits:
            read_plan = score.ReadCommandPlan(
                passage_ids=tuple(h["passageId"] for h in hits[:read_top_n]),
                context=1,
            )
            read_rec = run_clec_command(
                clec_bin,
                read_plan,
                data_dir=data_dir,
                max_bytes=read_max_bytes,
                timeout_sec=timeout_sec,
            )
            raw_logs.append({"questionId": qid, "step": "read", **read_rec})
            steps.append(_step_record("read", read_rec))
            if read_rec["timedOut"]:
                dec_err = read_rec["stdoutDecodeError"] or read_rec["stderrDecodeError"]
                read_status = "timeout"
                read_error = (
                    f"read_timeout_{timeout_sec}s:{dec_err}"
                    if dec_err
                    else f"read_timeout_{timeout_sec}s"
                )
            elif read_rec["stdoutDecodeError"] or read_rec["stderrDecodeError"] or read_rec["stdout"] is None:
                dec_err = read_rec["stdoutDecodeError"] or read_rec["stderrDecodeError"] or "undecodable_read"
                read_status = "error"
                read_error = f"undecodable_read_output:{dec_err}"
            elif read_rec["exitCode"] != 0:
                err_code = None
                try:
                    if read_rec["stderr"] is not None:
                        err_code = json.loads(read_rec["stderr"]).get("error", {}).get("code")
                except (json.JSONDecodeError, AttributeError):
                    pass
                read_status = "error"
                read_error = f"read_cli_error:{err_code or read_rec['exitCode']}"
            else:
                try:
                    read_json = json.loads(read_rec["stdout"])
                    _ = read_json["data"]["items"]
                except (json.JSONDecodeError, KeyError, TypeError) as exc:
                    read_status = "error"
                    read_error = f"invalid_read_json:{exc}"

        if read_error is not None:
            outcomes.append(
                {
                    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                    "id": qid,
                    "mode": mode,
                    "queryAngle": query_angle,
                    "queries": queries,
                    "status": read_status,
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
