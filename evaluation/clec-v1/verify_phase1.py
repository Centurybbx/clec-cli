#!/usr/bin/env python3
"""Rerunnable blackbox verification driver for CLEC native Phase 1 binaries."""

from __future__ import annotations

import argparse
from compression import zstd as py_zstd
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from typing import Any

if sys.version_info < (3, 14):
    raise SystemExit("verify_phase1.py requires Python >= 3.14 (uses stdlib compression.zstd)")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_cmd(
    binary: Path,
    args: list[str],
    env: dict[str, str],
    cmd_log: list[dict[str, Any]],
) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        [str(binary), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    cmd_log.append(
        {
            "argv": [str(binary), *args],
            "exitCode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    )
    return proc


def assert_ok_json(proc: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert proc.returncode == 0, f"expected exit 0, got {proc.returncode}: stderr={proc.stderr}"
    assert proc.stderr == "", f"expected empty stderr on success, got: {proc.stderr}"
    obj = json.loads(proc.stdout)
    assert obj.get("schemaVersion") == 1 and obj.get("ok") is True, obj
    return obj["data"]


def assert_err_json(
    proc: subprocess.CompletedProcess[str],
    expected_code: str | None = None,
) -> dict[str, Any]:
    assert proc.returncode != 0, f"expected nonzero exit, got 0: stdout={proc.stdout}"
    assert proc.stdout == "", f"expected empty stdout on error, got: {proc.stdout}"
    obj = json.loads(proc.stderr)
    assert obj.get("schemaVersion") == 1 and obj.get("ok") is False, obj
    err = obj["error"]
    for key in ("code", "message", "remedy", "next"):
        assert err.get(key), f"missing error.{key}: {obj}"
    if expected_code is not None:
        assert err["code"] == expected_code, f"expected {expected_code}, got {err}"
    return err


def normalize_span_list(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for sp in spans:
        item: dict[str, Any] = {
            "startByte": sp["startByte"],
            "endByte": sp["endByte"],
        }
        if sp.get("cueOrdinal") is not None:
            item["cueOrdinal"] = sp["cueOrdinal"]
        normalized.append(item)
    return normalized


def verify_spans_against_sqlite(
    db_path: Path,
    passage_id: str,
    returned_text: str,
    returned_spans: list[dict[str, Any]],
    expected_spans: list[dict[str, Any]] | None = None,
) -> None:
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        row = conn.execute(
            "SELECT b.raw_bytes, s.content_hash FROM passages p "
            "JOIN sources s ON s.id = p.source_id "
            "JOIN blobs b ON b.content_hash = s.content_hash "
            "WHERE p.id = ?",
            (passage_id,),
        ).fetchone()
        assert row is not None, f"missing passage {passage_id} in sqlite"
        raw_bytes, content_hash = row
        assert hashlib.sha256(raw_bytes).hexdigest() == content_hash

        stored_rows = conn.execute(
            "SELECT start_byte, end_byte, cue_ordinal FROM passage_spans "
            "WHERE passage_id = ? ORDER BY span_ordinal",
            (passage_id,),
        ).fetchall()
        stored_spans = [
            {
                "startByte": r[0],
                "endByte": r[1],
                **({"cueOrdinal": r[2]} if r[2] is not None else {}),
            }
            for r in stored_rows
        ]
        norm_returned = normalize_span_list(returned_spans)
        assert norm_returned == stored_spans, (
            f"returned spans differ from stored passage_spans for {passage_id}: "
            f"{norm_returned} != {stored_spans}"
        )
        if expected_spans is not None:
            norm_expected = normalize_span_list(expected_spans)
            assert norm_returned == norm_expected, (
                f"returned spans differ from expected authored mapping for {passage_id}: "
                f"{norm_returned} != {norm_expected}"
            )

        parts = []
        for sp in norm_returned:
            parts.append(raw_bytes[sp["startByte"] : sp["endByte"]].decode("utf-8"))
        reconstructed = "\n".join(parts)
        assert reconstructed == returned_text, (
            f"reconstructed text mismatch for {passage_id}: "
            f"{reconstructed[:80]!r} != {returned_text[:80]!r}"
        )


def repack_tampered_release(
    src_rel: Path,
    dst_rel: Path,
    mutate_fn: Any,
) -> Path:
    dst_rel.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((src_rel / "manifest.json").read_text(encoding="utf-8"))
    raw_sqlite = py_zstd.decompress((src_rel / "corpus.sqlite.zst").read_bytes())
    tampered_db = dst_rel / "tampered.sqlite"
    tampered_db.write_bytes(raw_sqlite)
    with sqlite3.connect(tampered_db) as tconn:
        mutate_fn(tconn)
        tconn.commit()
    tampered_bytes = tampered_db.read_bytes()
    tampered_db.unlink()
    tampered_zst = py_zstd.compress(tampered_bytes)
    (dst_rel / "corpus.sqlite.zst").write_bytes(tampered_zst)
    m_tampered = dict(manifest)
    m_tampered["bytes"] = len(tampered_bytes)
    m_tampered["sha256"] = hashlib.sha256(tampered_bytes).hexdigest()
    m_tampered["compressedBytes"] = len(tampered_zst)
    m_tampered["compressedSha256"] = hashlib.sha256(tampered_zst).hexdigest()
    manifest_out = dst_rel / "manifest.json"
    manifest_out.write_text(json.dumps(m_tampered), encoding="utf-8")
    return manifest_out


def log_corpus_record(corpora_logged: list[dict[str, Any]], name: str, manifest_path: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    corpora_logged.append(
        {
            "name": name,
            "manifestPath": str(manifest_path),
            "corpusFormat": manifest["corpusFormat"],
            "decompressedSha256": manifest["sha256"],
            "compressedSha256": manifest["compressedSha256"],
            "bytes": manifest["bytes"],
            "compressedBytes": manifest["compressedBytes"],
            "counts": manifest["counts"],
        }
    )
    return manifest


def git_source_state(repo_root: Path) -> tuple[str, bool, str | None]:
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
    dirty = bool(status_out.strip())
    if not dirty:
        return git_head, False, None
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
    return git_head, True, h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Blackbox Phase 1 verifier for CLEC native")
    parser.add_argument("--clec", required=True, type=Path, help="Path to clec binary")
    parser.add_argument("--publish", required=True, type=Path, help="Path to clec-publish binary")
    parser.add_argument("--report", type=Path, help="Optional JSON report output path")
    args = parser.parse_args()

    clec_bin = args.clec.resolve()
    pub_bin = args.publish.resolve()
    assert clec_bin.is_file(), f"missing clec binary: {clec_bin}"
    assert pub_bin.is_file(), f"missing clec-publish binary: {pub_bin}"

    repo_root = Path(__file__).resolve().parents[2]
    audio_check = repo_root / "evaluation" / "audio-check"
    assert (audio_check / "00318.txt").is_file()
    assert (audio_check / "00575.txt").is_file()

    git_head, git_dirty, git_dirty_digest = git_source_state(repo_root)

    clean_env = {
        k: v
        for k, v in os.environ.items()
        if not any(tok in k.upper() for tok in ("API_KEY", "TOKEN", "SECRET"))
    }
    clean_env["OPENAI_API_KEY"] = "dummy-must-not-trigger"
    clean_env["GEMINI_API_KEY"] = "dummy-must-not-trigger"

    checks: list[dict[str, Any]] = []
    corpora_logged: list[dict[str, Any]] = []

    def run_check(name: str, fn: Any) -> None:
        cmd_log: list[dict[str, Any]] = []
        try:
            detail = fn(cmd_log)
            checks.append(
                {
                    "name": name,
                    "status": "PASS",
                    "commands": cmd_log,
                    "detail": detail or "ok",
                }
            )
        except Exception as exc:
            checks.append(
                {
                    "name": name,
                    "status": "FAIL",
                    "commands": cmd_log,
                    "detail": f"{type(exc).__name__}: {exc}",
                }
            )

    with tempfile.TemporaryDirectory(prefix="clec-v1-verify-") as tmp_str:
        tmp = Path(tmp_str)
        empty_data = tmp / "empty-data"

        def check_no_data(log: list[dict[str, Any]]) -> str:
            for help_args in (["--help"], ["--version"]):
                p = run_cmd(clec_bin, help_args, clean_env, log)
                assert p.returncode == 0 and p.stdout and p.stderr == ""
            for cap_args in (["--max-bytes", "1", "--help"], ["--max-bytes", "1", "--version"]):
                assert_err_json(run_cmd(clec_bin, cap_args, clean_env, log), "OUTPUT_BUDGET_TOO_SMALL")
            st = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "--offline", "status"], clean_env, log))
            assert st["ready"] is False and st["activeRelease"] is None
            sc = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "schema"], clean_env, log))
            assert sc["corpusFormat"] == "clec-native-v1"
            unsupported_names = {u["name"] for u in sc["unsupportedFeatures"]}
            assert {"sag2", "http_bootstrap", "cross_format_dedup"}.issubset(unsupported_names)
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "退休"], clean_env, log), "NO_DATA")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "read", "p_" + "0" * 24], clean_env, log), "NO_DATA")
            return "status/schema/help/version, --max-bytes help/version cap, and NO_DATA verified"

        def check_parser_and_unsupported(log: list[dict[str, Any]]) -> str:
            bad_cmd = run_cmd(clec_bin, ["serch", "退休"], clean_env, log)
            err = assert_err_json(bad_cmd, "INVALID_ARGUMENT")
            assert "similar" not in err["message"] and "Did you mean" not in err["message"]
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search"], clean_env, log), "INVALID_ARGUMENT")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "q1", "q2", "q3", "q4", "q5"], clean_env, log), "INVALID_ARGUMENT")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "退休", "--sag2"], clean_env, log), "UNSUPPORTED_FEATURE")
            return "clap parser errors and --sag2 exit nonzero with structured stderr JSON and no fuzzy suggestions"

        def check_edge_fixtures_e2e(log: list[dict[str, Any]]) -> str:
            ws = tmp / "edge-ws"
            ws.mkdir()
            vtt_text = (
                "\ufeffWEBVTT\r\n\r\n"
                "NOTE ignored block\r\n\r\n"
                "id\r\n00:01.000 --> 00:03.000 position:10%\r\n<b>退休😀條件</b>\r\n第二行\r\n\r\n"
                "id\r\n00:02.000 --> 00:04.000\r\n重疊測試 0050 與 QQQ 和 4% 法則\r\n\r\n"
                "2562047788015:12:55.806 --> 2562047788015:12:55.807\r\n極限時間戳\r\n\r\n"
                "2562047788015:12:55.807 --> 2562047788015:12:55.808\r\n超過有號整數上限\r\n\r\n"
                "5124095576031:00:00.000 --> 5124095576031:00:01.000\r\n溢位時間戳\r\n\r\n"
                "99999999999999999999:00:00.000 --> 99999999999999999999:00:01.000\r\n超大整數\r\n\r\n"
                "00:99.000 --> 00:01.000\r\n無效時間戳\r\n"
            )
            vtt_raw = vtt_text.encode("utf-8")
            (ws / "edge.vtt").write_bytes(vtt_raw)
            cue1_payload = "<b>退休😀條件</b>\r\n第二行".encode("utf-8")
            cue2_payload = "重疊測試 0050 與 QQQ 和 4% 法則".encode("utf-8")
            cue3_payload = "極限時間戳".encode("utf-8")
            cue1_start = vtt_raw.index(cue1_payload)
            cue2_start = vtt_raw.index(cue2_payload)
            cue3_start = vtt_raw.index(cue3_payload)
            expected_vtt_spans = [
                {"startByte": cue1_start, "endByte": cue1_start + len(cue1_payload), "cueOrdinal": 0},
                {"startByte": cue2_start, "endByte": cue2_start + len(cue2_payload), "cueOrdinal": 1},
                {"startByte": cue3_start, "endByte": cue3_start + len(cue3_payload), "cueOrdinal": 2},
            ]

            shared_bytes = "相同位元組在不同作品下保留各自來源身份與0050配置。\n".encode("utf-8")
            (ws / "shared_a.txt").write_bytes(shared_bytes)
            (ws / "shared_b.txt").write_bytes(shared_bytes)
            (ws / "asr_long.txt").write_text("財富自由退休規劃" * 560, encoding="utf-8")
            (ws / "numbers_only.txt").write_text("存了50萬現金與4個月預備金，不含百分比。\n", encoding="utf-8")
            (ws / "bad.srt").write_text("not a subtitle", encoding="utf-8")

            intake_path = tmp / "edge-intake.json"
            intake_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [
                            {"key": "edge-vtt", "title": "Edge Subtitle Work"},
                            {"key": "shared-w1", "title": "Shared Bytes Work 1"},
                            {"key": "shared-w2", "title": "Shared Bytes Work 2"},
                            {"key": "asr-long", "title": "Long ASR Work"},
                            {"key": "num-work", "title": "Bare Number Work"},
                        ],
                        "sources": [
                            {"work": "edge-vtt", "path": "edge.vtt", "title": "Edge VTT", "role": "transcript", "attribution": "machine_unverified", "quality": "fixture", "status": "ready"},
                            {"work": "shared-w1", "path": "shared_a.txt", "title": "Shared A", "role": "document", "attribution": "publisher_verified", "quality": "fixture", "status": "ready"},
                            {"work": "shared-w2", "path": "shared_b.txt", "title": "Shared B", "role": "summary", "attribution": "unverified_transcript", "quality": "fixture", "status": "ready"},
                            {"work": "asr-long", "path": "asr_long.txt", "title": "Long ASR", "role": "transcript", "attribution": "machine_unverified", "quality": "fixture", "status": "ready"},
                            {"work": "num-work", "path": "numbers_only.txt", "title": "Bare Numbers", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "edge-vtt", "path": "bad.srt", "title": "Bad SRT", "role": "transcript", "attribution": "machine_unverified", "quality": "fixture", "status": "ready"},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            rel_dir = tmp / "edge-release"
            pub = run_cmd(pub_bin, ["--workspace", str(ws), "--intake", str(intake_path), "--output", str(rel_dir)], clean_env, log)
            assert pub.returncode == 0, pub.stderr
            manifest_path = rel_dir / "manifest.json"
            manifest = log_corpus_record(corpora_logged, "edge-fixtures", manifest_path)
            assert manifest["counts"]["blobs"] == 4, manifest["counts"]
            assert manifest["counts"]["sources"] == 5, manifest["counts"]

            edge_data = tmp / "edge-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sync", "--manifest", str(manifest_path)], clean_env, log))
            assert synced["reused"] is False

            for q in ("0050", "qqq", "4%"):
                res = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", q], clean_env, log))
                assert res["hits"], f"expected hits for {q}"
                assert all(h["work"]["workKey"] != "num-work" for h in res["hits"]), res["hits"]

            srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sources", "Shared"], clean_env, log))
            assert len(srcs["items"]) == 2
            assert srcs["items"][0]["workId"] != srcs["items"][1]["workId"]
            assert srcs["items"][0]["sourceId"] != srcs["items"][1]["sourceId"]

            asr_hits = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", "財富"], clean_env, log))
            assert len(asr_hits["hits"]) >= 2
            first_asr = asr_hits["hits"][0]
            read_asr = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "read", first_asr["passageId"], "--context", "1"], clean_env, log))
            item = read_asr["items"][0]
            assert item["next"] is not None and len(item["context"]) >= 1
            assert len(item["text"]) <= 2000

            vtt_srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sources", "Edge VTT"], clean_env, log))
            vtt_sid = vtt_srcs["items"][0]["sourceId"]
            vtt_orig = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "read", vtt_sid, "--original"], clean_env, log))
            assert vtt_orig["items"][0]["originalText"] == vtt_text

            vtt_hits = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", "退休"], clean_env, log))
            vtt_hit = next(h for h in vtt_hits["hits"] if h["source"]["sourceId"] == vtt_sid)
            assert len(vtt_hit["spans"]) == 3
            assert len(vtt_hit["cues"]) == 3
            assert vtt_hit["cues"][0]["startMs"] == 1000 and vtt_hit["cues"][1]["startMs"] == 2000
            assert vtt_hit["cues"][2]["endMs"] == (1 << 63) - 1
            assert len(vtt_hit["diagnostics"]) == 4, vtt_hit["diagnostics"]
            db_file = edge_data / f"{synced['release']}.sqlite"
            verify_spans_against_sqlite(db_file, vtt_hit["passageId"], vtt_hit["text"], vtt_hit["spans"], expected_vtt_spans)

            edge_budget_proc = run_cmd(clec_bin, ["--data-dir", str(edge_data), "--max-bytes", "3500", "search", "0050", "財富"], clean_env, log)
            edge_budget = assert_ok_json(edge_budget_proc)
            assert edge_budget["budget"]["usedBytes"] == len(edge_budget_proc.stdout.encode("utf-8"))
            assert edge_budget["budget"]["usedBytes"] <= 3500
            assert edge_budget["budget"]["omittedCount"] >= 1
            assert len(edge_budget["hits"]) >= 1
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(edge_data), "--max-bytes", "64", "search", "0050"], clean_env, log),
                "OUTPUT_BUDGET_TOO_SMALL",
            )

            pad_ws = tmp / "pad-ws"
            pad_ws.mkdir()
            (pad_ws / "a.txt").write_text("alpha budget boundary.", encoding="utf-8")
            (pad_ws / "b.txt").write_text("beta budget boundary.", encoding="utf-8")
            for pad in (416, 417, 418):
                pad_intake = tmp / f"pad-intake-{pad}.json"
                pad_intake.write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "works": [{"key": "demo", "title": "Demo"}],
                            "sources": [
                                {"work": "demo", "path": "a.txt", "title": "Demo" + ("." * pad), "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                                {"work": "demo", "path": "b.txt", "title": "Beta", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
                pad_rel = tmp / f"pad-rel-{pad}"
                assert run_cmd(pub_bin, ["--workspace", str(pad_ws), "--intake", str(pad_intake), "--output", str(pad_rel)], clean_env, log).returncode == 0
                pad_data = tmp / f"pad-data-{pad}"
                assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(pad_data), "sync", "--manifest", str(pad_rel / "manifest.json")], clean_env, log))
                src_proc = run_cmd(clec_bin, ["--data-dir", str(pad_data), "sources", "--limit", "1"], clean_env, log)
                src_res = assert_ok_json(src_proc)
                actual_len = len(src_proc.stdout.encode("utf-8"))
                assert src_res["budget"]["usedBytes"] == actual_len, (pad, src_res["budget"]["usedBytes"], actual_len)

                cap4_proc = run_cmd(clec_bin, ["--data-dir", str(pad_data), "--max-bytes", "2000", "sources", "--limit", "1"], clean_env, log)
                cap4_res = assert_ok_json(cap4_proc)
                cap4_len = len(cap4_proc.stdout.encode("utf-8"))
                assert cap4_res["budget"]["usedBytes"] == cap4_len
                if len(str(cap4_len)) == 4 and len(str(cap4_len - 1)) == 4:
                    exact_proc = run_cmd(clec_bin, ["--data-dir", str(pad_data), "--max-bytes", str(cap4_len), "sources", "--limit", "1"], clean_env, log)
                    exact_res = assert_ok_json(exact_proc)
                    assert exact_res["budget"]["usedBytes"] == len(exact_proc.stdout.encode("utf-8")) == cap4_len
                    assert_err_json(
                        run_cmd(clec_bin, ["--data-dir", str(pad_data), "--max-bytes", str(cap4_len - 1), "sources", "--limit", "1"], clean_env, log),
                        "OUTPUT_BUDGET_TOO_SMALL",
                    )

            return "BOM/CRLF/emoji/overlaps/timestamp-overflow/diagnostics, authored VTT offsets, 0050/QQQ/4%, ASR hard cuts, fixed-point budget boundaries, and shared-blob dual-work provenance verified"

        def check_authored_ranking_and_diversity(log: list[dict[str, Any]]) -> str:
            ws = tmp / "rank-ws"
            ws.mkdir()
            docs = {
                "w1_a.txt": "0050 核心配置長期持有。",
                "w1_b.txt": "0050 第二個獨立事實：保留現金與緊急預備金。",
                "w1_c.txt": "0050 第三個獨立事實：定期再平衡降低波動。",
                "w1_d.txt": "0050 第四個獨立事實：比較手續費與內扣費用。",
                "w2_a.txt": "美股 QQQ 與 0050 搭配時，遵守 4% 提領原則。",
                "w2_b.txt": "0050 與 QQQ 的海外所得稅務差異。",
                "w3_a.txt": "存了50萬現金與4個月生活費，不含百分比。",
                "w4_a.txt": "0050 作為台幣核心資產。",
            }
            for fname, body in docs.items():
                (ws / fname).write_text(body, encoding="utf-8")

            intake_path = tmp / "rank-intake.json"
            intake_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [
                            {"key": "w1", "title": "Work One"},
                            {"key": "w2", "title": "Work Two"},
                            {"key": "w3", "title": "Work Three"},
                            {"key": "w4", "title": "Work Four"},
                        ],
                        "sources": [
                            {"work": "w1", "path": "w1_a.txt", "title": "W1 Fact A", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w1", "path": "w1_b.txt", "title": "W1 Fact B", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w1", "path": "w1_c.txt", "title": "W1 Fact C", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w1", "path": "w1_d.txt", "title": "W1 Fact D", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w2", "path": "w2_a.txt", "title": "W2 Fact A", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w2", "path": "w2_b.txt", "title": "W2 Fact B", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w3", "path": "w3_a.txt", "title": "W3 Bare Numbers", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "w4", "path": "w4_a.txt", "title": "W4 Fact A", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            rel_dir = tmp / "rank-release"
            pub = run_cmd(pub_bin, ["--workspace", str(ws), "--intake", str(intake_path), "--output", str(rel_dir)], clean_env, log)
            assert pub.returncode == 0, pub.stderr
            manifest_path = rel_dir / "manifest.json"
            log_corpus_record(corpora_logged, "authored-ranking-diversity", manifest_path)

            rank_data = tmp / "rank-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "sync", "--manifest", str(manifest_path)], clean_env, log))
            db_file = rank_data / f"{synced['release']}.sqlite"

            div = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "0050"], clean_env, log))
            assert div["totalCandidates"] == 7, div
            assert len(div["hits"]) == 5
            assert all(h["work"]["workKey"] != "w3" for h in div["hits"])
            per_work_counts = {}
            for h in div["hits"]:
                wk = h["work"]["workKey"]
                per_work_counts[wk] = per_work_counts.get(wk, 0) + 1
                raw_len = len(docs[h["source"]["path"]].encode("utf-8"))
                verify_spans_against_sqlite(db_file, h["passageId"], h["text"], h["spans"], [{"startByte": 0, "endByte": raw_len}])
            assert per_work_counts == {"w1": 2, "w2": 2, "w4": 1}, per_work_counts

            q_4pct = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "4%"], clean_env, log))
            q_qqq = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "qqq"], clean_env, log))
            ranks_4pct = {h["source"]["path"]: idx for idx, h in enumerate(q_4pct["hits"])}
            ranks_qqq = {h["source"]["path"]: idx for idx, h in enumerate(q_qqq["hits"])}
            assert set(ranks_4pct.keys()) == {"w2_a.txt"}
            assert set(ranks_qqq.keys()) == {"w2_a.txt", "w2_b.txt"}

            fused = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "4%", "qqq"], clean_env, log))
            assert [h["source"]["path"] for h in fused["hits"]] == ["w2_a.txt", "w2_b.txt"]
            expected_w2a = 1.0 / (60.0 + ranks_4pct["w2_a.txt"] + 1.0) + 1.0 / (60.0 + ranks_qqq["w2_a.txt"] + 1.0)
            expected_w2b = 1.0 / (60.0 + ranks_qqq["w2_b.txt"] + 1.0)
            assert abs(fused["hits"][0]["rrfScore"] - expected_w2a) < 1e-12
            assert abs(fused["hits"][1]["rrfScore"] - expected_w2b) < 1e-12
            assert fused["hits"][0]["matchedQueries"] == ["4%", "qqq"]
            assert fused["hits"][1]["matchedQueries"] == ["qqq"]
            return "independently computed RRF scores, per-work=2 two-distinct-fact diversity cap, and authored span offsets verified"

        def check_real_mini_corpus(log: list[dict[str, Any]]) -> str:
            intake_path = tmp / "real-intake.json"
            intake_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [
                            {"key": "ep-00318", "title": "00318 資產配置與退休提領"},
                            {"key": "ep-00575", "title": "00575 現金與股票質押"},
                        ],
                        "sources": [
                            {"work": "ep-00318", "path": "evaluation/audio-check/00318.txt", "title": "00318 TXT", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"},
                            {"work": "ep-00318", "path": "evaluation/audio-check/00318.srt", "title": "00318 SRT", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"},
                            {"work": "ep-00318", "path": "evaluation/audio-check/00318.vtt", "title": "00318 VTT", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"},
                            {"work": "ep-00575", "path": "evaluation/audio-check/00575.txt", "title": "00575 TXT", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"},
                            {"work": "ep-00575", "path": "evaluation/audio-check/00575.srt", "title": "00575 SRT", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"},
                            {"work": "ep-00575", "path": "evaluation/audio-check/00575.vtt", "title": "00575 VTT", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            rel1 = tmp / "real-release-1"
            pub1 = run_cmd(pub_bin, ["--workspace", str(repo_root), "--intake", str(intake_path), "--output", str(rel1)], clean_env, log)
            assert pub1.returncode == 0, pub1.stderr
            manifest1_path = rel1 / "manifest.json"
            manifest1 = log_corpus_record(corpora_logged, "real-mini-00318-00575", manifest1_path)

            real_data = tmp / "real-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(manifest1_path)], clean_env, log))
            assert synced["counts"]["works"] == 2 and synced["counts"]["sources"] == 6

            trad = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "search", "資產配置 退休", "現金 質押"], clean_env, log))
            simp = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "search", "资产配置 退休", "现金 质押"], clean_env, log))
            assert [h["passageId"] for h in trad["hits"]] == [h["passageId"] for h in simp["hits"]]
            assert len(trad["hits"]) == 5
            assert {h["work"]["workKey"] for h in trad["hits"]} == {"ep-00318", "ep-00575"}

            db_file = real_data / f"{synced['release']}.sqlite"
            for hit in trad["hits"]:
                verify_spans_against_sqlite(db_file, hit["passageId"], hit["text"], hit["spans"])
                assert hit["source"]["attribution"] == "machine_unverified"

            all_sources = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sources", "00318.srt"], clean_env, log))
            srt_sid = next(s["sourceId"] for s in all_sources["items"] if s["path"].endswith("00318.srt"))
            orig_resp = assert_ok_json(
                run_cmd(
                    clec_bin,
                    ["--data-dir", str(real_data), "read", srt_sid, "--original", "--find", "台灣"],
                    clean_env,
                    log,
                )
            )
            orig_item = orig_resp["items"][0]
            assert orig_item["originalText"] == (audio_check / "00318.srt").read_text(encoding="utf-8")
            assert len(orig_item["literalMatches"]) >= 1

            orig_simp = assert_ok_json(
                run_cmd(
                    clec_bin,
                    ["--data-dir", str(real_data), "read", srt_sid, "--original", "--find", "台湾"],
                    clean_env,
                    log,
                )
            )
            assert orig_simp["items"][0]["literalMatches"] == []

            budget_bytes = 15000
            budgeted = assert_ok_json(
                run_cmd(
                    clec_bin,
                    ["--data-dir", str(real_data), "--max-bytes", str(budget_bytes), "search", "資產配置 退休"],
                    clean_env,
                    log,
                )
            )
            assert budgeted["budget"]["usedBytes"] <= budget_bytes
            assert budgeted["budget"]["omittedCount"] >= 1
            assert len(budgeted["hits"]) >= 1

            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(real_data), "--max-bytes", "3500", "search", "資產配置 退休"], clean_env, log),
                "OUTPUT_BUDGET_TOO_SMALL",
            )
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(real_data), "--max-bytes", "64", "search", "退休"], clean_env, log),
                "OUTPUT_BUDGET_TOO_SMALL",
            )
            empty_ok = assert_ok_json(
                run_cmd(clec_bin, ["--data-dir", str(real_data), "--max-bytes", "500", "search", "zzznonexistenttoken999"], clean_env, log)
            )
            assert empty_ok["hits"] == []
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(real_data), "--max-bytes", "100", "search", "zzznonexistenttoken999"], clean_env, log),
                "OUTPUT_BUDGET_TOO_SMALL",
            )

            reused = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync"], clean_env, log))
            assert reused["reused"] is True

            corrupt_rel = tmp / "corrupt-rel"
            corrupt_rel.mkdir()
            shutil.copy2(manifest1_path, corrupt_rel / "manifest.json")
            zbytes = bytearray((rel1 / "corpus.sqlite.zst").read_bytes())
            zbytes[12] ^= 0xFF
            (corrupt_rel / "corpus.sqlite.zst").write_bytes(bytes(zbytes))
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(corrupt_rel / "manifest.json")], clean_env, log), "INTEGRITY_MISMATCH")

            bad_json_manifest = tmp / "bad-manifest.json"
            bad_json_manifest.write_text("{not json", encoding="utf-8")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(bad_json_manifest)], clean_env, log), "INVALID_PACKAGE")

            legacy_manifest = tmp / "legacy-manifest.json"
            m_legacy = dict(manifest1)
            m_legacy["corpusFormat"] = "3"
            legacy_manifest.write_text(json.dumps(m_legacy), encoding="utf-8")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(legacy_manifest)], clean_env, log), "INVALID_PACKAGE")

            tampered_text_manifest = repack_tampered_release(
                rel1,
                tmp / "tampered-passage-text",
                lambda c: c.execute("UPDATE passages SET text = 'tampered text' WHERE rowid = (SELECT min(rowid) FROM passages)"),
            )
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(tampered_text_manifest)], clean_env, log), "INTEGRITY_MISMATCH")

            st_after_fail = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "status"], clean_env, log))
            assert st_after_fail["activeRelease"] == synced["release"]

            rel2 = tmp / "real-release-2"
            pub2 = run_cmd(pub_bin, ["--workspace", str(repo_root), "--intake", str(intake_path), "--output", str(rel2)], clean_env, log)
            assert pub2.returncode == 0
            data2 = tmp / "real-data-2"
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data2), "sync", "--manifest", str(rel2 / "manifest.json")], clean_env, log))
            trad2 = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data2), "search", "資產配置 退休", "現金 質押"], clean_env, log))
            assert [h["passageId"] for h in trad2["hits"]] == [h["passageId"] for h in trad["hits"]]
            assert [h["source"]["sourceId"] for h in trad2["hits"]] == [h["source"]["sourceId"] for h in trad["hits"]]

            mod_ws = tmp / "mod-ws"
            (mod_ws / "evaluation" / "audio-check").mkdir(parents=True)
            for fname in ("00318.txt", "00318.srt", "00318.vtt", "00575.txt", "00575.srt", "00575.vtt"):
                shutil.copy2(audio_check / fname, mod_ws / "evaluation" / "audio-check" / fname)
            txt_p = mod_ws / "evaluation" / "audio-check" / "00318.txt"
            txt_p.write_text(txt_p.read_text(encoding="utf-8") + "\n", encoding="utf-8")
            rel3 = tmp / "real-release-3"
            assert run_cmd(pub_bin, ["--workspace", str(mod_ws), "--intake", str(intake_path), "--output", str(rel3)], clean_env, log).returncode == 0
            old_txt_hit = next(h for h in trad["hits"] if h["source"]["path"].endswith("00318.txt"))
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(rel3 / "manifest.json")], clean_env, log))
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "read", old_txt_hit["passageId"]], clean_env, log), "EVIDENCE_NOT_FOUND")

            shutil.rmtree(rel3)
            relocated = tmp / "relocated-real-data"
            real_data.rename(relocated)
            reloc_search = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(relocated), "search", "00865B"], clean_env, log))
            assert len(reloc_search["hits"]) >= 1
            return "real 00318/00575 e2e, Traditional/Simplified lexical equivalence, literal find, budget, tampered passage text rollback, rebuild stability/drift, and relocation verified"

        def check_sync_atomicity_and_import_guards(log: list[dict[str, Any]]) -> str:
            ws_a = tmp / "atom-ws-a"
            ws_b = tmp / "atom-ws-b"
            ws_a.mkdir()
            ws_b.mkdir()
            (ws_a / "a.srt").write_text(
                "1\n00:00:01,000 --> 00:00:02,000\nalpha investment.\n\n2\n00:00:03,000 --> 00:00:04,000\nbeta savings.\n",
                encoding="utf-8",
            )
            (ws_a / "b.txt").write_text("second source delta planning.", encoding="utf-8")
            (ws_b / "a.srt").write_text(
                "1\n00:00:01,000 --> 00:00:02,000\ngamma retirement.\n",
                encoding="utf-8",
            )

            intake_a = tmp / "atom-intake-a.json"
            intake_b = tmp / "atom-intake-b.json"
            intake_a.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [{"key": "demo", "title": "Demo"}],
                        "sources": [
                            {"work": "demo", "path": "a.srt", "title": "Title Alpha", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                            {"work": "demo", "path": "b.txt", "title": "Title Beta", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            intake_b.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [{"key": "demo", "title": "Demo"}],
                        "sources": [
                            {"work": "demo", "path": "a.srt", "title": "Title Gamma", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            rel_a = tmp / "atom-rel-a"
            rel_b = tmp / "atom-rel-b"
            assert run_cmd(pub_bin, ["--workspace", str(ws_a), "--intake", str(intake_a), "--output", str(rel_a)], clean_env, log).returncode == 0
            assert run_cmd(pub_bin, ["--workspace", str(ws_b), "--intake", str(intake_b), "--output", str(rel_b)], clean_env, log).returncode == 0
            sha_a = json.loads((rel_a / "manifest.json").read_text(encoding="utf-8"))["sha256"]
            sha_b = json.loads((rel_b / "manifest.json").read_text(encoding="utf-8"))["sha256"]

            atom_data = tmp / "atom-data"
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(rel_a / "manifest.json")], clean_env, log))
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(atom_data), "--max-bytes", "1", "sync", "--manifest", str(rel_b / "manifest.json")], clean_env, log),
                "OUTPUT_BUDGET_TOO_SMALL",
            )
            st_budget = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "status"], clean_env, log))
            assert st_budget["activeRelease"] == sha_a
            assert (atom_data / f"{sha_a}.sqlite").is_file()
            assert not (atom_data / f"{sha_b}.sqlite").exists()
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "search", "alpha"], clean_env, log))

            with (atom_data / ".sync.lock").open("r+b") as lock_f:
                fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    assert_err_json(
                        run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(rel_b / "manifest.json")], clean_env, log),
                        "SYNC_LOCKED",
                    )
                finally:
                    fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)

            tamper_cases = [
                (
                    "tamper-cue-time",
                    lambda c: c.execute("UPDATE cues SET start_ms = start_ms + 86400000, end_ms = end_ms + 86400000"),
                    "INVALID_PACKAGE",
                ),
                (
                    "tamper-wrong-cue-link",
                    lambda c: c.execute("UPDATE passage_spans SET cue_ordinal = 1 WHERE span_ordinal = 0"),
                    "INVALID_PACKAGE",
                ),
                (
                    "tamper-span-payload",
                    lambda c: c.execute(
                        "UPDATE passage_spans SET start_byte = start_byte + 1 "
                        "WHERE cue_ordinal IS NOT NULL AND span_ordinal = 0"
                    ),
                    "INTEGRITY_MISMATCH",
                ),
                (
                    "tamper-span-payload-matching-text",
                    lambda c: c.executescript(
                        "UPDATE passage_spans SET start_byte = start_byte + 1 "
                        "WHERE cue_ordinal IS NOT NULL AND span_ordinal = 0;"
                        "UPDATE passages SET text = 'lpha investment.' || char(10) || 'beta savings.' "
                        "WHERE id = (SELECT passage_id FROM passage_spans WHERE cue_ordinal IS NOT NULL LIMIT 1);"
                    ),
                    "INVALID_PACKAGE",
                ),
                (
                    "tamper-empty-fts",
                    lambda c: c.executescript(
                        "INSERT INTO search(search) VALUES('delete-all');"
                        "INSERT INTO search(rowid, title_tokens, body_tokens) SELECT rowid, '', '' FROM passages;"
                    ),
                    "INTEGRITY_MISMATCH",
                ),
                (
                    "tamper-fts-stats-zero",
                    lambda c: c.execute("UPDATE search_data SET block=x'000000' WHERE id=1"),
                    "INTEGRITY_MISMATCH",
                ),
                (
                    "tamper-fts-stats-skewed",
                    lambda c: c.execute("UPDATE search_data SET block=x'010101' WHERE id=1"),
                    "INTEGRITY_MISMATCH",
                ),
                (
                    "tamper-fts-structure",
                    lambda c: c.execute("UPDATE search_data SET block=x'ffffffffffffffff' WHERE id=10"),
                    "INVALID_PACKAGE",
                ),
                (
                    "tamper-fts-segment",
                    lambda c: c.execute("UPDATE search_data SET block=x'ff00ff' WHERE id > 10"),
                    "INVALID_PACKAGE",
                ),
                (
                    "tamper-misplaced-fts",
                    lambda c: c.executescript(
                        "INSERT INTO search(search) VALUES('delete-all');"
                        "INSERT INTO search(rowid, title_tokens, body_tokens) VALUES"
                        "(1, 't7469746c65 t62657461', 't616c706861 t696e766573746d656e74 t62657461 t736176696e6773'),"
                        "(2, 't7469746c65 t616c706861', 't7365636f6e64 t736f75726365 t64656c7461 t706c616e6e696e67');"
                    ),
                    "INTEGRITY_MISMATCH",
                ),
                (
                    "tamper-continuation",
                    lambda c: c.execute("UPDATE passages SET is_continuation = 1, continued_from = id"),
                    "INVALID_PACKAGE",
                ),
            ]
            for name, mutator, expected_code in tamper_cases:
                m_tamper = repack_tampered_release(rel_a, tmp / name, mutator)
                assert_err_json(
                    run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(m_tamper)], clean_env, log),
                    expected_code,
                )
            st_after_tamper = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "status"], clean_env, log))
            assert st_after_tamper["activeRelease"] == sha_a

            manifest_a_obj = json.loads((rel_a / "manifest.json").read_text(encoding="utf-8"))
            expected_manifest_a = str((rel_a / "manifest.json").resolve())

            invalid_zstd_dir = tmp / "invalid-zstd-reuse"
            invalid_zstd_dir.mkdir()
            bad_zstd_payload = b"not a zstd stream"
            (invalid_zstd_dir / "corpus.sqlite.zst").write_bytes(bad_zstd_payload)
            m_bad_zstd = dict(manifest_a_obj)
            m_bad_zstd["compressedBytes"] = len(bad_zstd_payload)
            m_bad_zstd["compressedSha256"] = hashlib.sha256(bad_zstd_payload).hexdigest()
            (invalid_zstd_dir / "manifest.json").write_text(json.dumps(m_bad_zstd), encoding="utf-8")

            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(invalid_zstd_dir / "manifest.json")], clean_env, log),
                "INVALID_PACKAGE",
            )
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(tmp / "fresh-invalid-zstd"), "sync", "--manifest", str(invalid_zstd_dir / "manifest.json")], clean_env, log),
                "INVALID_PACKAGE",
            )
            st_after_bad_zstd = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "status"], clean_env, log))
            assert st_after_bad_zstd["activeRelease"] == sha_a
            assert st_after_bad_zstd["manifestPath"] == expected_manifest_a

            wrong_decomp_dir = tmp / "wrong-decomp-reuse"
            wrong_decomp_dir.mkdir()
            wrong_zstd_payload = py_zstd.compress(b"valid zstd stream wrong decompressed payload")
            (wrong_decomp_dir / "corpus.sqlite.zst").write_bytes(wrong_zstd_payload)
            m_wrong_decomp = dict(manifest_a_obj)
            m_wrong_decomp["compressedBytes"] = len(wrong_zstd_payload)
            m_wrong_decomp["compressedSha256"] = hashlib.sha256(wrong_zstd_payload).hexdigest()
            (wrong_decomp_dir / "manifest.json").write_text(json.dumps(m_wrong_decomp), encoding="utf-8")

            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(wrong_decomp_dir / "manifest.json")], clean_env, log),
                "INTEGRITY_MISMATCH",
            )
            st_after_wrong_decomp = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "status"], clean_env, log))
            assert st_after_wrong_decomp["manifestPath"] == expected_manifest_a

            valid_alt_dir = tmp / "valid-alt-reuse"
            valid_alt_dir.mkdir()
            shutil.copy2(rel_a / "corpus.sqlite.zst", valid_alt_dir / "corpus.sqlite.zst")
            shutil.copy2(rel_a / "manifest.json", valid_alt_dir / "manifest.json")
            reused_alt = assert_ok_json(
                run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(valid_alt_dir / "manifest.json")], clean_env, log)
            )
            assert reused_alt["reused"] is True
            (valid_alt_dir / "corpus.sqlite.zst").write_bytes(bad_zstd_payload)
            (valid_alt_dir / "manifest.json").write_text(json.dumps(m_bad_zstd), encoding="utf-8")
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(valid_alt_dir / "manifest.json")], clean_env, log),
                "INVALID_PACKAGE",
            )
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "search", "alpha"], clean_env, log))

            obs_data = tmp / "obs-data"
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(obs_data), "sync", "--manifest", str(rel_a / "manifest.json")], clean_env, log))
            (obs_data / "active.json").unlink()
            (obs_data / "active.json").mkdir()
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(obs_data), "sync", "--manifest", str(rel_b / "manifest.json")], clean_env, log),
                "IO_ERROR",
            )
            assert (obs_data / f"{sha_a}.sqlite").is_file()
            assert not (obs_data / f"{sha_b}.sqlite").exists()
            return "budget atomicity, lock contention, activation obstruction, cue/span/continuation tampering, and empty/misplaced FTS postings rejection verified"

        def check_known_bad_controls(log: list[dict[str, Any]]) -> str:
            db_dir = tmp / "ctrl-ws"
            db_dir.mkdir()
            (db_dir / "c.srt").write_text(
                "1\n00:00:01,000 --> 00:00:02,000\nalpha\n\n2\n00:00:03,000 --> 00:00:04,000\nalpha\n",
                encoding="utf-8",
            )
            (tmp / "ctrl-intake.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [{"key": "ctrl", "title": "Control"}],
                        "sources": [{"work": "ctrl", "path": "c.srt", "title": "C", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"}],
                    }
                ),
                encoding="utf-8",
            )
            ctrl_rel = tmp / "ctrl-rel"
            assert run_cmd(pub_bin, ["--workspace", str(db_dir), "--intake", str(tmp / "ctrl-intake.json"), "--output", str(ctrl_rel)], clean_env, log).returncode == 0
            ctrl_data = tmp / "ctrl-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(ctrl_data), "sync", "--manifest", str(ctrl_rel / "manifest.json")], clean_env, log))
            hit = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(ctrl_data), "search", "alpha"], clean_env, log))["hits"][0]
            db_file = ctrl_data / f"{synced['release']}.sqlite"

            caught_wrong_text = False
            try:
                verify_spans_against_sqlite(db_file, hit["passageId"], "錯誤文字", hit["spans"])
            except AssertionError:
                caught_wrong_text = True
            assert caught_wrong_text, "known-bad wrong-text control was not caught"

            caught_wrong_span = False
            bad_spans = [{"startByte": 0, "endByte": 3}]
            try:
                verify_spans_against_sqlite(db_file, hit["passageId"], hit["text"], bad_spans)
            except AssertionError:
                caught_wrong_span = True
            assert caught_wrong_span, "known-bad wrong-span control was not caught"

            caught_same_text_wrong_occurrence = False
            second_occ = dict(hit["spans"][1])
            swapped_spans = [second_occ, second_occ]
            try:
                verify_spans_against_sqlite(db_file, hit["passageId"], hit["text"], swapped_spans)
            except AssertionError:
                caught_same_text_wrong_occurrence = True
            assert caught_same_text_wrong_occurrence, "known-bad same-text wrong-occurrence control was not caught"

            caught_bad_err = False
            fake_proc = subprocess.CompletedProcess(args=["fake"], returncode=2, stdout="leak", stderr="{}")
            try:
                assert_err_json(fake_proc)
            except AssertionError:
                caught_bad_err = True
            assert caught_bad_err, "known-bad stdout-leak control was not caught"
            return "all 4 known-bad controls caught expected mismatches (including identical-text wrong occurrence)"

        run_check("no_data_lifecycle", check_no_data)
        run_check("parser_and_unsupported_flags", check_parser_and_unsupported)
        run_check("authored_edge_fixtures", check_edge_fixtures_e2e)
        run_check("authored_ranking_and_diversity", check_authored_ranking_and_diversity)
        run_check("real_00318_00575_e2e", check_real_mini_corpus)
        run_check("sync_atomicity_and_import_guards", check_sync_atomicity_and_import_guards)
        run_check("known_bad_controls", check_known_bad_controls)

    report = {
        "schemaVersion": 1,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "gitHead": git_head,
        "gitDirty": git_dirty,
        "gitDirtyDigest": git_dirty_digest,
        "binaries": {
            "clec": {"path": str(clec_bin), "sha256": sha256_file(clec_bin)},
            "clecPublish": {"path": str(pub_bin), "sha256": sha256_file(pub_bin)},
        },
        "corpora": corpora_logged,
        "checks": checks,
        "summary": {
            "total": len(checks),
            "passed": sum(1 for c in checks if c["status"] == "PASS"),
            "failed": sum(1 for c in checks if c["status"] == "FAIL"),
            "allPassed": all(c["status"] == "PASS" for c in checks),
        },
    }

    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")

    print(
        json.dumps(
            {
                "summary": report["summary"],
                "checks": [{"name": c["name"], "status": c["status"], "detail": c["detail"]} for c in checks],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["summary"]["allPassed"] else 1


if __name__ == "__main__":
    sys.exit(main())
