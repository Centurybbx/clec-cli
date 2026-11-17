#!/usr/bin/env python3
"""Streaming semantic digest comparison for clec-native-v2 SQLite corpora."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
from typing import Any
import zlib


BUCKET_COUNT = 64


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
    return {"dbPath": str(db_path), "tables": tables, "ftsPostings": postings}


def compare_databases(left_db: Path, right_db: Path) -> dict[str, Any]:
    left = compute_semantic_digest(left_db)
    right = compute_semantic_digest(right_db)
    mismatches: list[dict[str, Any]] = []
    for table_name in sorted(left["tables"]):
        if left["tables"][table_name] != right["tables"][table_name]:
            mismatches.append(
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
        mismatches.append(
            {
                "section": "ftsPostings",
                "left": {"count": left["ftsPostings"]["count"], "sha256": left["ftsPostings"]["sha256"]},
                "right": {"count": right["ftsPostings"]["count"], "sha256": right["ftsPostings"]["sha256"]},
            }
        )
    return {
        "schemaVersion": 1,
        "semanticallyEqual": len(mismatches) == 0,
        "mismatches": mismatches,
        "left": left,
        "right": right,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare logical/semantic digests of two clec-native-v2 SQLite DBs")
    parser.add_argument("--left", required=True, type=Path)
    parser.add_argument("--right", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    result = compare_databases(args.left.resolve(), args.right.resolve())
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "semanticallyEqual": result["semanticallyEqual"],
        "mismatches": result["mismatches"],
        "leftTables": result["left"]["tables"],
        "rightTables": result["right"]["tables"],
        "leftFtsCount": result["left"]["ftsPostings"]["count"],
        "leftFtsSha256": result["left"]["ftsPostings"]["sha256"],
        "rightFtsCount": result["right"]["ftsPostings"]["count"],
        "rightFtsSha256": result["right"]["ftsPostings"]["sha256"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if result["semanticallyEqual"] else 1


if __name__ == "__main__":
    sys.exit(main())
