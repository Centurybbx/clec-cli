#!/usr/bin/env python3
"""Rerunnable blackbox verification driver for CLEC native Phase 1 binaries."""

from __future__ import annotations

import argparse
import datetime as dt
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

from compression import zstd as py_zstd


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


def verify_spans_against_sqlite(
    db_path: Path,
    passage_id: str,
    returned_text: str,
    returned_spans: list[dict[str, Any]],
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
        parts = []
        for sp in returned_spans:
            parts.append(raw_bytes[sp["startByte"] : sp["endByte"]].decode("utf-8"))
        reconstructed = "\n".join(parts)
        assert reconstructed == returned_text, (
            f"reconstructed text mismatch for {passage_id}: "
            f"{reconstructed[:80]!r} != {returned_text[:80]!r}"
        )


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

    git_head = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

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
            st = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "--offline", "status"], clean_env, log))
            assert st["ready"] is False and st["activeRelease"] is None
            sc = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "schema"], clean_env, log))
            assert sc["corpusFormat"] == "clec-native-v1"
            unsupported_names = {u["name"] for u in sc["unsupportedFeatures"]}
            assert {"sag2", "http_bootstrap", "cross_format_dedup"}.issubset(unsupported_names)
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "退休"], clean_env, log), "NO_DATA")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "read", "p_" + "0" * 24], clean_env, log), "NO_DATA")
            return "status/schema/help/version work offline without snapshot; search/read fail with NO_DATA"

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
                "00:99.000 --> 00:01.000\r\n無效時間戳\r\n"
            )
            (ws / "edge.vtt").write_bytes(vtt_text.encode("utf-8"))
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
            manifest = json.loads((rel_dir / "manifest.json").read_text(encoding="utf-8"))
            corpora_logged.append({"name": "edge-fixtures", **manifest})
            assert manifest["counts"]["blobs"] == 4, manifest["counts"]  # shared_a & shared_b share 1 blob
            assert manifest["counts"]["sources"] == 5, manifest["counts"]

            edge_data = tmp / "edge-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sync", "--manifest", str(rel_dir / "manifest.json")], clean_env, log))
            assert synced["reused"] is False

            # Check 0050, QQQ, 4% do NOT match numbers_only.txt
            for q in ("0050", "qqq", "4%"):
                res = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", q], clean_env, log))
                assert res["hits"], f"expected hits for {q}"
                assert all(h["work"]["workKey"] != "num-work" for h in res["hits"]), res["hits"]

            # Check shared bytes kept two separate works and sources
            srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sources", "Shared"], clean_env, log))
            assert len(srcs["items"]) == 2
            assert srcs["items"][0]["workId"] != srcs["items"][1]["workId"]
            assert srcs["items"][0]["sourceId"] != srcs["items"][1]["sourceId"]

            # Check ASR hard-cut continuation & context read
            asr_hits = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", "財富"], clean_env, log))
            assert len(asr_hits["hits"]) >= 2
            first_asr = asr_hits["hits"][0]
            read_asr = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "read", first_asr["passageId"], "--context", "1"], clean_env, log))
            item = read_asr["items"][0]
            assert item["next"] is not None and len(item["context"]) >= 1
            assert len(item["text"]) <= 2000

            # Check VTT multi-span cues, diagnostics, and original BOM/CRLF read
            vtt_srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sources", "Edge VTT"], clean_env, log))
            vtt_sid = vtt_srcs["items"][0]["sourceId"]
            vtt_orig = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "read", vtt_sid, "--original"], clean_env, log))
            assert vtt_orig["items"][0]["originalText"] == vtt_text

            vtt_hits = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", "退休"], clean_env, log))
            vtt_hit = next(h for h in vtt_hits["hits"] if h["source"]["sourceId"] == vtt_sid)
            assert len(vtt_hit["spans"]) == 2
            assert len(vtt_hit["cues"]) == 2
            assert vtt_hit["cues"][0]["startMs"] == 1000 and vtt_hit["cues"][1]["startMs"] == 2000
            assert vtt_hit["diagnostics"], "expected malformed timestamp diagnostic"
            db_file = edge_data / f"{synced['release']}.sqlite"
            verify_spans_against_sqlite(db_file, vtt_hit["passageId"], vtt_hit["text"], vtt_hit["spans"])

            edge_budget = assert_ok_json(
                run_cmd(clec_bin, ["--data-dir", str(edge_data), "--max-bytes", "3500", "search", "0050", "財富"], clean_env, log)
            )
            assert edge_budget["budget"]["usedBytes"] <= 3500
            assert edge_budget["budget"]["omittedCount"] >= 1
            assert len(edge_budget["hits"]) >= 1
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(edge_data), "--max-bytes", "64", "search", "0050"], clean_env, log),
                "OUTPUT_BUDGET_TOO_SMALL",
            )
            return "BOM/CRLF/emoji/overlaps/diagnostics, 0050/QQQ/4%, ASR hard cuts, tight-budget omission, and shared-blob dual-work provenance verified"

        def check_real_mini_corpus(log: list[dict[str, Any]]) -> str:
            # Publish directly from repo_root workspace pointing to tracked evaluation/audio-check files
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
            manifest1 = json.loads((rel1 / "manifest.json").read_text(encoding="utf-8"))
            corpora_logged.append({"name": "real-mini-00318-00575", **manifest1})

            real_data = tmp / "real-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(rel1 / "manifest.json")], clean_env, log))
            assert synced["counts"]["works"] == 2 and synced["counts"]["sources"] == 6

            # Traditional vs Simplified equivalence and deterministic multi-query RRF
            trad = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "search", "資產配置 退休", "現金 質押"], clean_env, log))
            simp = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "search", "资产配置 退休", "现金 质押"], clean_env, log))
            assert [h["passageId"] for h in trad["hits"]] == [h["passageId"] for h in simp["hits"]]
            assert len(trad["hits"]) == 5
            work_keys = {h["work"]["workKey"] for h in trad["hits"]}
            assert work_keys == {"ep-00318", "ep-00575"}
            assert any(
                sum(1 for h in trad["hits"] if h["work"]["workKey"] == wk) >= 2
                for wk in work_keys
            ), "work diversity must preserve second fact from same work"

            # Verify every hit against raw SQLite bytes
            db_file = real_data / f"{synced['release']}.sqlite"
            for hit in trad["hits"]:
                verify_spans_against_sqlite(db_file, hit["passageId"], hit["text"], hit["spans"])
                assert hit["source"]["attribution"] == "machine_unverified"

            # Verify read s_ --original and literal --find (unnormalized)
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

            # Simplified literal --find must NOT match Traditional source
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

            # Idempotent repeat sync
            reused = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync"], clean_env, log))
            assert reused["reused"] is True

            # Rollback checks: corrupt manifest, corrupt zstd, tampered cue, legacy format
            corrupt_rel = tmp / "corrupt-rel"
            corrupt_rel.mkdir()
            shutil.copy2(rel1 / "manifest.json", corrupt_rel / "manifest.json")
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

            tampered_rel = tmp / "tampered-rel"
            tampered_rel.mkdir()
            raw_sqlite = py_zstd.decompress((rel1 / "corpus.sqlite.zst").read_bytes())
            tampered_db = tampered_rel / "tampered.sqlite"
            tampered_db.write_bytes(raw_sqlite)
            with sqlite3.connect(tampered_db) as tconn:
                tconn.execute("UPDATE passages SET text = 'tampered text' WHERE rowid = (SELECT min(rowid) FROM passages)")
                tconn.commit()
            tampered_bytes = tampered_db.read_bytes()
            tampered_db.unlink()
            tampered_zst = py_zstd.compress(tampered_bytes)
            (tampered_rel / "corpus.sqlite.zst").write_bytes(tampered_zst)
            m_tampered = dict(manifest1)
            m_tampered["bytes"] = len(tampered_bytes)
            m_tampered["sha256"] = hashlib.sha256(tampered_bytes).hexdigest()
            m_tampered["compressedBytes"] = len(tampered_zst)
            m_tampered["compressedSha256"] = hashlib.sha256(tampered_zst).hexdigest()
            (tampered_rel / "manifest.json").write_text(json.dumps(m_tampered), encoding="utf-8")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(tampered_rel / "manifest.json")], clean_env, log), "INTEGRITY_MISMATCH")

            st_after_fail = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "status"], clean_env, log))
            assert st_after_fail["activeRelease"] == synced["release"]

            # Rebuild identical release -> stable IDs
            rel2 = tmp / "real-release-2"
            pub2 = run_cmd(pub_bin, ["--workspace", str(repo_root), "--intake", str(intake_path), "--output", str(rel2)], clean_env, log)
            assert pub2.returncode == 0
            data2 = tmp / "real-data-2"
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data2), "sync", "--manifest", str(rel2 / "manifest.json")], clean_env, log))
            trad2 = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data2), "search", "資產配置 退休", "現金 質押"], clean_env, log))
            assert [h["passageId"] for h in trad2["hits"]] == [h["passageId"] for h in trad["hits"]]
            assert [h["source"]["sourceId"] for h in trad2["hits"]] == [h["source"]["sourceId"] for h in trad["hits"]]

            # Modify one byte in a copy of 00318.txt, rebuild, sync, and prove old PassageId is rejected
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

            # Relocate data dir and delete release dir
            shutil.rmtree(rel3)
            relocated = tmp / "relocated-real-data"
            real_data.rename(relocated)
            reloc_search = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(relocated), "search", "00865B"], clean_env, log))
            assert len(reloc_search["hits"]) >= 1
            return "real 00318/00575 e2e, RRF, work diversity, literal find, budget, rollback, rebuild stability/drift, and relocation verified"

        def check_known_bad_controls(log: list[dict[str, Any]]) -> str:
            # Control 1: prove verify_spans_against_sqlite catches wrong text
            db_dir = tmp / "ctrl-ws"
            db_dir.mkdir()
            (db_dir / "c.txt").write_text("測試原文第一句。", encoding="utf-8")
            (tmp / "ctrl-intake.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [{"key": "ctrl", "title": "Control"}],
                        "sources": [{"work": "ctrl", "path": "c.txt", "title": "C", "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"}],
                    }
                ),
                encoding="utf-8",
            )
            ctrl_rel = tmp / "ctrl-rel"
            assert run_cmd(pub_bin, ["--workspace", str(db_dir), "--intake", str(tmp / "ctrl-intake.json"), "--output", str(ctrl_rel)], clean_env, log).returncode == 0
            ctrl_data = tmp / "ctrl-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(ctrl_data), "sync", "--manifest", str(ctrl_rel / "manifest.json")], clean_env, log))
            hit = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(ctrl_data), "search", "測試"], clean_env, log))["hits"][0]
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

            caught_bad_err = False
            fake_proc = subprocess.CompletedProcess(args=["fake"], returncode=2, stdout="leak", stderr="{}")
            try:
                assert_err_json(fake_proc)
            except AssertionError:
                caught_bad_err = True
            assert caught_bad_err, "known-bad stdout-leak control was not caught"
            return "all 3 known-bad controls caught expected mismatches"

        run_check("no_data_lifecycle", check_no_data)
        run_check("parser_and_unsupported_flags", check_parser_and_unsupported)
        run_check("authored_edge_fixtures", check_edge_fixtures_e2e)
        run_check("real_00318_00575_e2e", check_real_mini_corpus)
        run_check("known_bad_controls", check_known_bad_controls)

    report = {
        "schemaVersion": 1,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "gitHead": git_head,
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
