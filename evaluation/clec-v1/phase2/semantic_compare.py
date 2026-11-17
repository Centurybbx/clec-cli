#!/usr/bin/env python3
"""Streaming content digest and native structural validity comparison for clec-native-v2 SQLite corpora."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
from typing import Any
import zlib


BUCKET_COUNT = 64
REQUIRED_RECEIPT_KEYS = (
    "schemaVersion",
    "validatorKind",
    "packageVersion",
    "corpusFormat",
    "segmentationRevision",
    "tokenizationRevision",
    "normalizationRevision",
    "dictionaryRevision",
    "equivalenceRevision",
    "binarySha256",
    "dbBytes",
    "dbSha256",
    "valid",
)
IDENTITY_MATCH_KEYS = (
    "schemaVersion",
    "validatorKind",
    "packageVersion",
    "corpusFormat",
    "segmentationRevision",
    "tokenizationRevision",
    "normalizationRevision",
    "dictionaryRevision",
    "equivalenceRevision",
)


def file_size_and_sha256(path: Path) -> tuple[int, str]:
    h = hashlib.sha256()
    total = 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
            total += len(chunk)
    return total, h.hexdigest()


def _git_code_state(repo_root: Path) -> dict[str, Any] | None:
    try:
        git_head = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        status_out = subprocess.run(
            ["git", "-C", str(repo_root), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    dirty = bool(status_out.strip())
    if not dirty:
        return {"gitHead": git_head, "gitDirty": False, "gitDirtyDigest": None}
    diff_unstaged = subprocess.run(
        ["git", "-C", str(repo_root), "diff"],
        capture_output=True,
        check=True,
    ).stdout
    diff_staged = subprocess.run(
        ["git", "-C", str(repo_root), "diff", "--cached"],
        capture_output=True,
        check=True,
    ).stdout
    h = hashlib.sha256()
    h.update(status_out.encode("utf-8"))
    h.update(b"\x00")
    h.update(diff_unstaged)
    h.update(b"\x00")
    h.update(diff_staged)
    return {"gitHead": git_head, "gitDirty": True, "gitDirtyDigest": h.hexdigest()}


def _load_validator_identity(validator_bin: Path) -> dict[str, Any]:
    resolved = validator_bin.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Validator binary not found: {resolved}")
    _, actual_bin_sha = file_size_and_sha256(resolved)
    proc = subprocess.run(
        [str(resolved), "--identity"],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    identity = json.loads(proc.stdout)
    if identity.get("binarySha256") != actual_bin_sha:
        raise RuntimeError(
            f"Validator binary SHA-256 mismatch: reported {identity.get('binarySha256')} != actual {actual_bin_sha}"
        )
    return identity


def _hash_row_fields(h: Any, row: tuple[Any, ...]) -> None:
    encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    h.update(struct.pack("<I", len(encoded)))
    h.update(encoded)


def _query_digest(conn: sqlite3.Connection, sql: str) -> dict[str, Any]:
    h = hashlib.sha256()
    count = 0
    for row in conn.execute(sql):
        _hash_row_fields(h, tuple(row))
        count += 1
    return {"count": count, "sha256": h.hexdigest()}


def _blobs_digest(conn: sqlite3.Connection) -> dict[str, Any]:
    h = hashlib.sha256()
    count = 0
    for chash, byte_len, raw_bytes in conn.execute(
        "SELECT content_hash, byte_len, raw_bytes FROM blobs ORDER BY content_hash"
    ):
        raw_sha = hashlib.sha256(bytes(raw_bytes)).hexdigest()
        _hash_row_fields(h, (chash, int(byte_len), raw_sha))
        count += 1
    return {"count": count, "sha256": h.hexdigest()}


def _fts_postings_digest(conn: sqlite3.Connection, db_path: Path) -> dict[str, Any]:
    rowid_to_pid = {
        int(rowid): pid
        for rowid, pid in conn.execute("SELECT rowid, id FROM passages")
    }
    with tempfile.TemporaryDirectory(prefix="clec-sem-fts-") as tmp_str:
        tmp = Path(tmp_str)
        bucket_files = [open(tmp / f"b{i}.bin", "wb") for i in range(BUCKET_COUNT)]
        total_postings = 0
        try:
            conn.execute("CREATE VIRTUAL TABLE temp.__v_sem USING fts5vocab(main, search, instance)")
            for doc, col, offset, term in conn.execute("SELECT doc, col, offset, term FROM temp.__v_sem"):
                pid = rowid_to_pid[int(doc)].encode("utf-8")
                term_b = term.encode("utf-8")
                col_b = b"\x00" if col == "title_tokens" else b"\x01"
                b_idx = zlib.crc32(pid) % BUCKET_COUNT
                rec = (
                    struct.pack("<H", len(pid))
                    + pid
                    + col_b
                    + struct.pack("<IH", int(offset), len(term_b))
                    + term_b
                )
                bucket_files[b_idx].write(rec)
                total_postings += 1
            conn.execute("DROP TABLE temp.__v_sem")
        finally:
            for f in bucket_files:
                f.close()

        combined = hashlib.sha256()
        bucket_hashes: list[str] = []
        for i in range(BUCKET_COUNT):
            data = (tmp / f"b{i}.bin").read_bytes()
            entries: list[tuple[bytes, int, int, bytes]] = []
            pos = 0
            n = len(data)
            while pos < n:
                pid_len = struct.unpack_from("<H", data, pos)[0]
                pos += 2
                pid_b = data[pos : pos + pid_len]
                pos += pid_len
                col_id = data[pos]
                pos += 1
                offset, term_len = struct.unpack_from("<IH", data, pos)
                pos += 6
                term_b = data[pos : pos + term_len]
                pos += term_len
                entries.append((pid_b, col_id, offset, term_b))
            entries.sort()
            bh = hashlib.sha256()
            for pid_b, col_id, offset, term_b in entries:
                rec_hdr = struct.pack("<HBII", len(pid_b), col_id, offset, len(term_b))
                bh.update(rec_hdr)
                bh.update(pid_b)
                bh.update(term_b)
            b_hex = bh.hexdigest()
            bucket_hashes.append(b_hex)
            combined.update(b_hex.encode("ascii"))

    return {
        "count": total_postings,
        "bucketCount": BUCKET_COUNT,
        "sha256": combined.hexdigest(),
        "bucketSha256s": bucket_hashes,
        "dbFileName": db_path.name,
    }


def compute_semantic_digest(db_path: Path) -> dict[str, Any]:
    db_bytes, db_sha256 = file_size_and_sha256(db_path)
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        tables = {
            "metadata": _query_digest(conn, "SELECT key, value FROM metadata ORDER BY key"),
            "works": _query_digest(conn, "SELECT id, work_key, title FROM works ORDER BY id"),
            "blobs": _blobs_digest(conn),
            "sources": _query_digest(
                conn,
                "SELECT id, work_id, path, title, role, attribution, quality, date, date_basis, origin, content_hash "
                "FROM sources ORDER BY id",
            ),
            "source_canonical_map": _query_digest(
                conn,
                "SELECT source_id, canonical_source_id, equivalence_hash, projection_kind, equivalence_basis "
                "FROM source_canonical_map ORDER BY source_id",
            ),
            "source_diagnostics": _query_digest(
                conn,
                "SELECT source_id, ordinal, message FROM source_diagnostics ORDER BY source_id, ordinal",
            ),
            "cues": _query_digest(
                conn,
                "SELECT source_id, ordinal, original_identifier, raw_start_byte, raw_end_byte, "
                "text_start_byte, text_end_byte, start_ms, end_ms FROM cues ORDER BY source_id, ordinal",
            ),
            "inventory": _query_digest(
                conn,
                "SELECT work_key, path, status, reason, content_hash FROM inventory ORDER BY work_key, path",
            ),
            "passages": _query_digest(
                conn,
                "SELECT id, source_id, work_id, ordinal, boundary, is_continuation, continued_from, continued_to, text "
                "FROM passages ORDER BY id",
            ),
            "passage_spans": _query_digest(
                conn,
                "SELECT passage_id, span_ordinal, start_byte, end_byte, cue_ordinal "
                "FROM passage_spans ORDER BY passage_id, span_ordinal",
            ),
        }
        postings = _fts_postings_digest(conn, db_path)
    return {
        "dbPath": str(db_path),
        "dbBytes": db_bytes,
        "dbSha256": db_sha256,
        "tables": tables,
        "ftsPostings": postings,
    }


def verify_validation_receipt(
    *,
    db_bytes: int,
    db_sha256: str,
    receipt: Any,
    expected_identity: dict[str, Any] | None,
    code_state: dict[str, Any] | None,
    source_kind: str,
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "dbBytes": db_bytes,
        "dbSha256": db_sha256,
        "source": source_kind,
        "receipt": receipt if isinstance(receipt, dict) else None,
    }
    if not isinstance(receipt, dict) or any(k not in receipt for k in REQUIRED_RECEIPT_KEYS):
        return {
            **base,
            "status": "stale_receipt",
            "valid": False,
            "reason": "Validation receipt is malformed or missing required binding fields.",
        }
    if expected_identity is None:
        return {
            **base,
            "status": "inconclusive",
            "valid": False,
            "reason": "Cannot verify receipt binary/code identity without an active validator binary.",
        }
    if receipt.get("dbBytes") != db_bytes or receipt.get("dbSha256") != db_sha256:
        return {
            **base,
            "status": "stale_receipt",
            "valid": False,
            "reason": (
                f"Receipt file hash mismatch: expected ({db_bytes}, {db_sha256}), "
                f"got ({receipt.get('dbBytes')}, {receipt.get('dbSha256')})."
            ),
        }
    if receipt.get("binarySha256") != expected_identity.get("binarySha256"):
        return {
            **base,
            "status": "stale_receipt",
            "valid": False,
            "reason": "Receipt validator binarySha256 does not match active validator binary.",
        }
    for key in IDENTITY_MATCH_KEYS:
        if receipt.get(key) != expected_identity.get(key):
            return {
                **base,
                "status": "stale_receipt",
                "valid": False,
                "reason": f"Receipt {key} ({receipt.get(key)!r}) does not match active validator ({expected_identity.get(key)!r}).",
            }
    if code_state is not None and any(k in receipt for k in ("gitHead", "gitDirty", "gitDirtyDigest")):
        for key in ("gitHead", "gitDirty", "gitDirtyDigest"):
            if receipt.get(key) != code_state.get(key):
                return {
                    **base,
                    "status": "stale_receipt",
                    "valid": False,
                    "reason": f"Receipt code identity {key} does not match current git state.",
                }
    if receipt.get("valid") is not True or receipt.get("errorCode") is not None:
        return {
            **base,
            "status": "invalid",
            "valid": False,
            "errorCode": receipt.get("errorCode"),
            "reason": receipt.get("errorMessage") or "Native structural validation reported invalid.",
        }
    return {
        **base,
        "status": "valid",
        "valid": True,
        "errorCode": None,
        "reason": "Native structural validation passed and receipt matches actual DB and validator identity.",
    }


def _evaluate_side_validity(
    *,
    db_path: Path,
    db_bytes: int,
    db_sha256: str,
    validator_bin: Path | None,
    expected_identity: dict[str, Any] | None,
    code_state: dict[str, Any] | None,
    supplied_receipt_path: Path | None,
    write_receipt_path: Path | None,
) -> dict[str, Any]:
    if supplied_receipt_path is not None:
        try:
            receipt = json.loads(supplied_receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return {
                "dbBytes": db_bytes,
                "dbSha256": db_sha256,
                "source": "supplied_receipt",
                "receipt": None,
                "status": "stale_receipt",
                "valid": False,
                "reason": f"Cannot parse supplied receipt {supplied_receipt_path}: {exc}",
            }
        return verify_validation_receipt(
            db_bytes=db_bytes,
            db_sha256=db_sha256,
            receipt=receipt,
            expected_identity=expected_identity,
            code_state=code_state,
            source_kind="supplied_receipt",
        )

    if validator_bin is None or expected_identity is None:
        return {
            "dbBytes": db_bytes,
            "dbSha256": db_sha256,
            "source": "none",
            "receipt": None,
            "status": "inconclusive",
            "valid": False,
            "reason": "Native structural validator not configured; validity is inconclusive.",
        }

    proc = subprocess.run(
        [str(validator_bin.resolve()), "--db", str(db_path)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if not proc.stdout.strip():
        return {
            "dbBytes": db_bytes,
            "dbSha256": db_sha256,
            "source": "live_validator",
            "receipt": None,
            "status": "invalid",
            "valid": False,
            "reason": proc.stderr.strip() or f"Validator exited {proc.returncode} without receipt output.",
        }
    try:
        receipt = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "dbBytes": db_bytes,
            "dbSha256": db_sha256,
            "source": "live_validator",
            "receipt": None,
            "status": "invalid",
            "valid": False,
            "reason": f"Validator returned invalid JSON: {exc}",
        }
    if code_state is not None:
        receipt.update(code_state)
    if write_receipt_path is not None:
        write_receipt_path.parent.mkdir(parents=True, exist_ok=True)
        write_receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return verify_validation_receipt(
        db_bytes=db_bytes,
        db_sha256=db_sha256,
        receipt=receipt,
        expected_identity=expected_identity,
        code_state=code_state,
        source_kind="live_validator",
    )


def compare_databases(
    left_db: Path,
    right_db: Path,
    *,
    validator_bin: Path | None = None,
    left_receipt_path: Path | None = None,
    right_receipt_path: Path | None = None,
    write_left_receipt_path: Path | None = None,
    write_right_receipt_path: Path | None = None,
) -> dict[str, Any]:
    pre_left = file_size_and_sha256(left_db)
    pre_right = file_size_and_sha256(right_db)

    repo_root = Path(__file__).resolve().parents[3]
    code_state = _git_code_state(repo_root)
    expected_identity = _load_validator_identity(validator_bin) if validator_bin is not None else None

    left = compute_semantic_digest(left_db)
    right = compute_semantic_digest(right_db)

    content_mismatches: list[dict[str, Any]] = []
    for table_name in sorted(left["tables"]):
        if left["tables"][table_name] != right["tables"][table_name]:
            content_mismatches.append(
                {
                    "section": table_name,
                    "left": left["tables"][table_name],
                    "right": right["tables"][table_name],
                }
            )
    if (
        left["ftsPostings"]["count"] != right["ftsPostings"]["count"]
        or left["ftsPostings"]["sha256"] != right["ftsPostings"]["sha256"]
    ):
        content_mismatches.append(
            {
                "section": "ftsPostings",
                "left": {"count": left["ftsPostings"]["count"], "sha256": left["ftsPostings"]["sha256"]},
                "right": {"count": right["ftsPostings"]["count"], "sha256": right["ftsPostings"]["sha256"]},
            }
        )

    left_validity = _evaluate_side_validity(
        db_path=left_db,
        db_bytes=pre_left[0],
        db_sha256=pre_left[1],
        validator_bin=validator_bin,
        expected_identity=expected_identity,
        code_state=code_state,
        supplied_receipt_path=left_receipt_path,
        write_receipt_path=write_left_receipt_path,
    )
    right_validity = _evaluate_side_validity(
        db_path=right_db,
        db_bytes=pre_right[0],
        db_sha256=pre_right[1],
        validator_bin=validator_bin,
        expected_identity=expected_identity,
        code_state=code_state,
        supplied_receipt_path=right_receipt_path,
        write_receipt_path=write_right_receipt_path,
    )

    post_left = file_size_and_sha256(left_db)
    post_right = file_size_and_sha256(right_db)
    left_validity["dbUnchanged"] = pre_left == post_left
    right_validity["dbUnchanged"] = pre_right == post_right
    if not left_validity["dbUnchanged"]:
        left_validity["valid"] = False
        left_validity["status"] = "invalid"
        left_validity["reason"] = "Left source DB bytes changed during comparison/validation."
    if not right_validity["dbUnchanged"]:
        right_validity["valid"] = False
        right_validity["status"] = "invalid"
        right_validity["reason"] = "Right source DB bytes changed during comparison/validation."

    content_equal = len(content_mismatches) == 0
    both_valid = bool(left_validity["valid"] and right_validity["valid"])
    usable_equivalence = bool(content_equal and both_valid)

    if usable_equivalence:
        verdict = "usable_semantic_equivalence"
    elif not content_equal:
        verdict = "content_mismatch"
    elif left_validity["status"] in ("invalid", "stale_receipt") or right_validity["status"] in (
        "invalid",
        "stale_receipt",
    ):
        verdict = "structural_validation_failed"
    else:
        verdict = "content_only_validity_inconclusive"

    return {
        "schemaVersion": 2,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "codeState": code_state,
        "verdict": verdict,
        "usableSemanticEquivalence": usable_equivalence,
        "semanticallyEqual": usable_equivalence,
        "contentEqual": content_equal,
        "contentMismatches": content_mismatches,
        "structuralValidity": {
            "bothValid": both_valid,
            "validatorIdentity": expected_identity,
            "left": left_validity,
            "right": right_validity,
        },
        "left": left,
        "right": right,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare logical content digests and native structural validity of two clec-native-v2 SQLite DBs"
    )
    parser.add_argument("--left", required=True, type=Path)
    parser.add_argument("--right", required=True, type=Path)
    parser.add_argument("--validator", type=Path, help="Path to clec-validate binary")
    parser.add_argument("--left-receipt", type=Path, help="Pre-computed bound validation receipt for --left")
    parser.add_argument("--right-receipt", type=Path, help="Pre-computed bound validation receipt for --right")
    parser.add_argument("--write-left-receipt", type=Path, help="Write live bound validation receipt for --left")
    parser.add_argument("--write-right-receipt", type=Path, help="Write live bound validation receipt for --right")
    parser.add_argument(
        "--content-only",
        action="store_true",
        help="Compare logical content only without native structural validation (never asserts usable equivalence)",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    validator_bin: Path | None = None
    if not args.content_only:
        if args.validator is not None:
            validator_bin = args.validator.resolve()
            if not validator_bin.is_file():
                raise SystemExit(f"missing validator binary: {validator_bin}")
        else:
            default_val = Path(__file__).resolve().parents[3] / "native" / "target" / "release" / "clec-validate"
            if default_val.is_file():
                validator_bin = default_val

    result = compare_databases(
        args.left.resolve(),
        args.right.resolve(),
        validator_bin=validator_bin,
        left_receipt_path=args.left_receipt.resolve() if args.left_receipt and not args.content_only else None,
        right_receipt_path=args.right_receipt.resolve() if args.right_receipt and not args.content_only else None,
        write_left_receipt_path=args.write_left_receipt.resolve() if args.write_left_receipt else None,
        write_right_receipt_path=args.write_right_receipt.resolve() if args.write_right_receipt else None,
    )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "schemaVersion": result["schemaVersion"],
        "verdict": result["verdict"],
        "usableSemanticEquivalence": result["usableSemanticEquivalence"],
        "semanticallyEqual": result["semanticallyEqual"],
        "contentEqual": result["contentEqual"],
        "contentMismatches": result["contentMismatches"],
        "structuralValidity": {
            "bothValid": result["structuralValidity"]["bothValid"],
            "left": {
                k: v
                for k, v in result["structuralValidity"]["left"].items()
                if k != "receipt"
            },
            "right": {
                k: v
                for k, v in result["structuralValidity"]["right"].items()
                if k != "receipt"
            },
        },
        "leftTables": result["left"]["tables"],
        "rightTables": result["right"]["tables"],
        "leftFtsCount": result["left"]["ftsPostings"]["count"],
        "leftFtsSha256": result["left"]["ftsPostings"]["sha256"],
        "rightFtsCount": result["right"]["ftsPostings"]["count"],
        "rightFtsSha256": result["right"]["ftsPostings"]["sha256"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if result["usableSemanticEquivalence"] else 1


if __name__ == "__main__":
    sys.exit(main())
