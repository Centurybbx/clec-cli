#!/usr/bin/env python3
"""Rerunnable blackbox verification driver for CLEC native Phase 2 binaries."""

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
    raise SystemExit("verify_phase2.py requires Python >= 3.14 (uses stdlib compression.zstd)")


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

        parts = [raw_bytes[sp["startByte"] : sp["endByte"]].decode("utf-8") for sp in norm_returned]
        reconstructed = "\n".join(parts)
        assert reconstructed == returned_text, (
            f"reconstructed text mismatch for {passage_id}: "
            f"{reconstructed[:80]!r} != {returned_text[:80]!r}"
        )


def repack_tampered_release(src_rel: Path, dst_rel: Path, mutate_fn: Any) -> Path:
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
    diff_unstaged = subprocess.run(["git", "-C", str(repo_root), "diff"], capture_output=True, check=True).stdout
    diff_staged = subprocess.run(["git", "-C", str(repo_root), "diff", "--cached"], capture_output=True, check=True).stdout
    h = hashlib.sha256()
    h.update(status_out.encode("utf-8"))
    h.update(b"\x00")
    h.update(diff_unstaged)
    h.update(b"\x00")
    h.update(diff_staged)
    return git_head, True, h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Blackbox Phase 2 verifier for CLEC native")
    parser.add_argument("--clec", required=True, type=Path, help="Path to clec binary")
    parser.add_argument("--publish", required=True, type=Path, help="Path to clec-publish binary")
    parser.add_argument("--report", type=Path, help="Optional JSON report output path")
    args = parser.parse_args()

    clec_bin = args.clec.resolve()
    pub_bin = args.publish.resolve()
    assert clec_bin.is_file(), f"missing clec binary: {clec_bin}"
    assert pub_bin.is_file(), f"missing clec-publish binary: {pub_bin}"

    repo_root = Path(__file__).resolve().parents[3]
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
            checks.append({"name": name, "status": "PASS", "commands": cmd_log, "detail": detail or "ok"})
        except Exception as exc:
            checks.append(
                {
                    "name": name,
                    "status": "FAIL",
                    "commands": cmd_log,
                    "detail": f"{type(exc).__name__}: {exc}",
                }
            )

    with tempfile.TemporaryDirectory(prefix="clec-v2-verify-") as tmp_str:
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
            assert sc["corpusFormat"] == "clec-native-v2"
            assert sc["phase"] == "phase5"
            assert sc["defaultConfigured"] is False
            assert sc["providerVerified"] is False
            for rev_key in ("tokenizationRevision", "normalizationRevision", "dictionaryRevision", "equivalenceRevision"):
                assert sc.get(rev_key), f"missing {rev_key} in schema"
            unsupported_names = {u["name"] for u in sc["unsupportedFeatures"]}
            assert "sag2" not in unsupported_names
            assert "http_bootstrap" not in unsupported_names
            assert "cross_format_dedup" not in unsupported_names
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "退休"], clean_env, log), "NO_DATA")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "read", "p_" + "0" * 24], clean_env, log), "NO_DATA")
            return "Phase 2 schema, revisions, --max-bytes help/version cap, and NO_DATA verified"

        def check_parser_and_unsupported(log: list[dict[str, Any]]) -> str:
            err = assert_err_json(run_cmd(clec_bin, ["serch", "退休"], clean_env, log), "INVALID_ARGUMENT")
            assert "similar" not in err["message"] and "Did you mean" not in err["message"]
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search"], clean_env, log), "INVALID_ARGUMENT")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "q1", "q2", "q3", "q4", "q5"], clean_env, log), "INVALID_ARGUMENT")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(empty_data), "search", "退休", "--sag2"], clean_env, log), "INVALID_JEV_CONFIG")
            return "clap parser errors and unconfigured --sag2 exit nonzero with structured stderr JSON and no fuzzy suggestions"

        def check_synthetic_triples_and_false_friends(log: list[dict[str, Any]]) -> str:
            ws = tmp / "triple-ws"
            ws.mkdir()

            srt_a = "1\n00:00:01,000 --> 00:00:02,000\n合成三元組測試\n\n2\n00:00:02,000 --> 00:00:04,000\n資產配置0050與QQQ\n"
            txt_a = "合成三元組測試\n\n資產配置0050與QQQ\n"
            md_a = "# 語音筆記：測試錄音\n\n## [0:00:01,000 – 0:00:02,000]\n合成三元組測試\n\n## [0:00:02,000 – 0:00:04,000]\n資產配置0050與QQQ\n"
            (ws / "arch_01.srt").write_text(srt_a, encoding="utf-8")
            (ws / "arch_01.txt").write_text(txt_a, encoding="utf-8")
            (ws / "arch_01.md").write_text(md_a, encoding="utf-8")

            srt_b = "1\n00:00:01,000 --> 00:00:03,000\n局部轉寫三元組 4% 法則\n"
            vtt_b = "WEBVTT\n\n00:01.000 --> 00:03.000\n局部轉寫三元組 4% 法則\n"
            txt_b = "局部轉寫三元組 4% 法則\n"
            (ws / "loc.srt").write_text(srt_b, encoding="utf-8")
            (ws / "loc.vtt").write_text(vtt_b, encoding="utf-8")
            (ws / "loc.txt").write_text(txt_b, encoding="utf-8")

            dup_body = "完全相同的位元組但在不同作品中必須分開索引\n"
            (ws / "shared_1.txt").write_text(dup_body, encoding="utf-8")
            (ws / "shared_2.txt").write_text(dup_body, encoding="utf-8")
            (ws / "ff_punct.txt").write_text("合成三元組測試。\n\n資產配置0050與QQQ\n", encoding="utf-8")
            (ws / "ff_num.txt").write_text("合成三元組測試\n\n資產配置0050與QQQ 5%\n", encoding="utf-8")
            (ws / "ff_unknown.md").write_text("# 額外標題\n\n合成三元組測試\n\n資產配置0050與QQQ\n", encoding="utf-8")
            (ws / "same_role_summary.txt").write_text(txt_b, encoding="utf-8")
            (ws / "same_work_qa.md").write_text("Q：為何保留現金？\nA：預留生活費。\n", encoding="utf-8")

            intake_path = tmp / "triple-intake.json"
            intake_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [
                            {"key": "archive:00001", "title": "Archive Group 1"},
                            {"key": "archive:00002", "title": "Archive Group 2"},
                            {"key": "local-asr:ep1", "title": "Local ASR Ep1"},
                        ],
                        "sources": [
                            {"work": "archive:00001", "path": "arch_01.srt", "title": "Same Title", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready", "origin": "https://drive.google.com/shared"},
                            {"work": "archive:00001", "path": "arch_01.txt", "title": "Same Title", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready", "origin": "https://drive.google.com/shared"},
                            {"work": "archive:00001", "path": "arch_01.md", "title": "Same Title", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready", "origin": "https://drive.google.com/shared"},
                            {"work": "archive:00001", "path": "ff_punct.txt", "title": "Same Title", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready"},
                            {"work": "archive:00001", "path": "ff_num.txt", "title": "Same Title", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready"},
                            {"work": "archive:00001", "path": "ff_unknown.md", "title": "Same Title", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready"},
                            {"work": "archive:00001", "path": "shared_1.txt", "title": "Identical Name.txt", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready", "origin": "https://drive.google.com/shared"},
                            {"work": "archive:00002", "path": "shared_2.txt", "title": "Identical Name.txt", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive_probable_asr", "status": "ready", "origin": "https://drive.google.com/shared"},
                            {"work": "local-asr:ep1", "path": "loc.srt", "title": "Local Ep1", "role": "transcript", "attribution": "machine_unverified", "quality": "local_asr", "status": "ready"},
                            {"work": "local-asr:ep1", "path": "loc.vtt", "title": "Local Ep1", "role": "transcript", "attribution": "machine_unverified", "quality": "local_asr", "status": "ready"},
                            {"work": "local-asr:ep1", "path": "loc.txt", "title": "Local Ep1", "role": "transcript", "attribution": "machine_unverified", "quality": "local_asr", "status": "ready"},
                            {"work": "local-asr:ep1", "path": "same_role_summary.txt", "title": "Local Ep1 Summary", "role": "summary", "attribution": "original_unknown", "quality": "summary", "status": "ready"},
                            {"work": "local-asr:ep1", "path": "same_work_qa.md", "title": "Local Ep1 QA", "role": "qa", "attribution": "original_unknown", "quality": "qa", "status": "ready"},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            rel_dir = tmp / "triple-release"
            pub = run_cmd(pub_bin, ["--workspace", str(ws), "--intake", str(intake_path), "--output", str(rel_dir)], clean_env, log)
            assert pub.returncode == 0, pub.stderr
            manifest_path = rel_dir / "manifest.json"
            manifest = log_corpus_record(corpora_logged, "synthetic-triples-false-friends", manifest_path)
            assert manifest["counts"]["works"] == 3, manifest["counts"]
            assert manifest["counts"]["sources"] == 13, manifest["counts"]
            assert manifest["counts"]["canonicalSources"] == 9, manifest["counts"]
            assert manifest["counts"]["blobs"] == 11, manifest["counts"]

            data_dir = tmp / "triple-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data_dir), "sync", "--manifest", str(manifest_path)], clean_env, log))
            assert synced["counts"]["canonicalSources"] == 9

            all_srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data_dir), "sources", "--limit", "50"], clean_env, log))
            assert len(all_srcs["items"]) == 13
            canon_srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data_dir), "sources", "--canonical-only", "--limit", "50"], clean_env, log))
            assert len(canon_srcs["items"]) == 9
            canon_paths = {s["path"] for s in canon_srcs["items"]}
            assert {"arch_01.srt", "loc.srt", "same_role_summary.txt", "same_work_qa.md", "shared_1.txt", "shared_2.txt", "ff_punct.txt", "ff_num.txt", "ff_unknown.md"} == canon_paths

            arch_txt_id = next(s["sourceId"] for s in all_srcs["items"] if s["path"] == "arch_01.txt")
            arch_srt_id = next(s["sourceId"] for s in all_srcs["items"] if s["path"] == "arch_01.srt")
            orig_txt = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data_dir), "read", arch_txt_id, "--original"], clean_env, log))
            assert orig_txt["items"][0]["originalText"] == txt_a
            assert orig_txt["items"][0]["source"]["canonicalSourceId"] == arch_srt_id
            assert len(orig_txt["items"][0]["equivalentSources"]) == 3

            hits_shared = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data_dir), "search", "不同作品"], clean_env, log))
            assert {h["work"]["workKey"] for h in hits_shared["hits"]} == {"archive:00001", "archive:00002"}

            hits_role = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(data_dir), "search", "局部轉寫"], clean_env, log))
            assert {h["source"]["role"] for h in hits_role["hits"]} == {"transcript", "summary"}

            noncanon_passage_manifest = repack_tampered_release(
                rel_dir,
                tmp / "tamper-noncanon-passage",
                lambda c: c.execute(
                    "UPDATE passages SET source_id = ? WHERE source_id = ?",
                    (arch_txt_id, arch_srt_id),
                ),
            )
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(data_dir), "sync", "--manifest", str(noncanon_passage_manifest)], clean_env, log),
                "INVALID_PACKAGE",
            )

            swap_canon_manifest = repack_tampered_release(
                rel_dir,
                tmp / "tamper-swap-canon",
                lambda c: c.execute(
                    "UPDATE source_canonical_map SET canonical_source_id = ?, equivalence_basis = CASE WHEN source_id = ? THEN 'canonical_by_timing_and_format' ELSE 'collapsed_to_canonical' END WHERE canonical_source_id = ?",
                    (arch_txt_id, arch_txt_id, arch_srt_id),
                ),
            )
            assert_err_json(
                run_cmd(clec_bin, ["--data-dir", str(data_dir), "sync", "--manifest", str(swap_canon_manifest)], clean_env, log),
                "INVALID_PACKAGE",
            )
            return "synthetic triples, false friends, same-work role preservation, dual-work shared blob, and canonical tamper guards verified"

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
            assert manifest["counts"]["canonicalSources"] == 5, manifest["counts"]

            edge_data = tmp / "edge-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sync", "--manifest", str(manifest_path)], clean_env, log))
            assert synced["reused"] is False

            for q in ("0050", "qqq", "4%"):
                res = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", q], clean_env, log))
                assert res["hits"] and all(h["work"]["workKey"] != "num-work" for h in res["hits"])

            vtt_srcs = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "sources", "Edge VTT"], clean_env, log))
            vtt_sid = vtt_srcs["items"][0]["sourceId"]
            vtt_hits = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(edge_data), "search", "退休"], clean_env, log))
            vtt_hit = next(h for h in vtt_hits["hits"] if h["source"]["sourceId"] == vtt_sid)
            assert len(vtt_hit["spans"]) == 3 and vtt_hit["cues"][2]["endMs"] == (1 << 63) - 1
            assert len(vtt_hit["diagnostics"]) == 4
            db_file = edge_data / f"{synced['release']}.sqlite"
            verify_spans_against_sqlite(db_file, vtt_hit["passageId"], vtt_hit["text"], vtt_hit["spans"], expected_vtt_spans)

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
                assert src_res["budget"]["usedBytes"] == len(src_proc.stdout.encode("utf-8"))
            return "BOM/CRLF/emoji/overlaps/timestamp-overflow/diagnostics, authored VTT offsets, 0050/QQQ/4%, ASR hard cuts, and fixed-point budget boundaries verified"

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
                        "works": [{"key": f"w{i}", "title": f"Work {i}"} for i in range(1, 5)],
                        "sources": [
                            {"work": f.split("_")[0], "path": f, "title": f, "role": "document", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"}
                            for f in docs
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            rel_dir = tmp / "rank-release"
            assert run_cmd(pub_bin, ["--workspace", str(ws), "--intake", str(intake_path), "--output", str(rel_dir)], clean_env, log).returncode == 0
            log_corpus_record(corpora_logged, "authored-ranking-diversity", rel_dir / "manifest.json")

            rank_data = tmp / "rank-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "sync", "--manifest", str(rel_dir / "manifest.json")], clean_env, log))
            db_file = rank_data / f"{synced['release']}.sqlite"
            div = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "0050"], clean_env, log))
            assert div["totalCandidates"] == 7 and len(div["hits"]) == 5
            per_work: dict[str, int] = {}
            for h in div["hits"]:
                wk = h["work"]["workKey"]
                per_work[wk] = per_work.get(wk, 0) + 1
                verify_spans_against_sqlite(db_file, h["passageId"], h["text"], h["spans"])
            assert per_work == {"w1": 2, "w2": 2, "w4": 1}

            q_4pct = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "4%"], clean_env, log))
            q_qqq = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "qqq"], clean_env, log))
            r4 = {h["source"]["path"]: i for i, h in enumerate(q_4pct["hits"])}
            rq = {h["source"]["path"]: i for i, h in enumerate(q_qqq["hits"])}
            fused = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(rank_data), "search", "4%", "qqq"], clean_env, log))
            assert abs(fused["hits"][0]["rrfScore"] - (1.0 / (60.0 + r4["w2_a.txt"] + 1.0) + 1.0 / (60.0 + rq["w2_a.txt"] + 1.0))) < 1e-12
            return "RRF fusion and per-work=2 diversity cap verified"

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
                            {"work": f"ep-{ep}", "path": f"evaluation/audio-check/{ep}.{ext}", "title": f"{ep} {ext.upper()}", "role": "transcript", "attribution": "machine_unverified", "quality": "machine_asr_whisper_small", "status": "ready"}
                            for ep in ("00318", "00575")
                            for ext in ("txt", "srt", "vtt")
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
            assert manifest1["counts"]["works"] == 2
            assert manifest1["counts"]["sources"] == 6
            assert manifest1["counts"]["canonicalSources"] == 2

            real_data = tmp / "real-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(manifest1_path)], clean_env, log))
            trad = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "search", "資產配置 退休", "現金 質押"], clean_env, log))
            simp = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "search", "资产配置 退休", "现金 质押"], clean_env, log))
            assert [h["passageId"] for h in trad["hits"]] == [h["passageId"] for h in simp["hits"]]
            assert all(h["source"]["path"].endswith(".srt") for h in trad["hits"])
            db_file = real_data / f"{synced['release']}.sqlite"
            for hit in trad["hits"]:
                verify_spans_against_sqlite(db_file, hit["passageId"], hit["text"], hit["spans"])

            all_sources = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sources", "00318"], clean_env, log))
            assert len(all_sources["items"]) == 3
            txt_sid = next(s["sourceId"] for s in all_sources["items"] if s["path"].endswith("00318.txt"))
            srt_sid = next(s["sourceId"] for s in all_sources["items"] if s["path"].endswith("00318.srt"))
            orig_txt = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "read", txt_sid, "--original"], clean_env, log))
            assert orig_txt["items"][0]["originalText"] == (audio_check / "00318.txt").read_text(encoding="utf-8")
            assert orig_txt["items"][0]["source"]["canonicalSourceId"] == srt_sid

            legacy_v1_manifest = tmp / "legacy-v1-manifest.json"
            m_v1 = dict(manifest1)
            m_v1["corpusFormat"] = "clec-native-v1"
            legacy_v1_manifest.write_text(json.dumps(m_v1), encoding="utf-8")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync", "--manifest", str(legacy_v1_manifest)], clean_env, log), "INVALID_PACKAGE")

            reused = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(real_data), "sync"], clean_env, log))
            assert reused["reused"] is True
            return "real 00318/00575 canonical collapse (6 -> 2), non-canonical original read, Traditional/Simplified search, and clec-native-v1 rejection verified"

        def check_sync_atomicity_and_import_guards(log: list[dict[str, Any]]) -> str:
            ws_a = tmp / "atom-ws-a"
            ws_b = tmp / "atom-ws-b"
            ws_a.mkdir()
            ws_b.mkdir()
            (ws_a / "a.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nalpha investment.\n\n2\n00:00:03,000 --> 00:00:04,000\nbeta savings.\n", encoding="utf-8")
            (ws_a / "b.txt").write_text("second source delta planning.", encoding="utf-8")
            (ws_b / "a.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\ngamma retirement.\n", encoding="utf-8")

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
                        "sources": [{"work": "demo", "path": "a.srt", "title": "Title Gamma", "role": "transcript", "attribution": "authored_fixture", "quality": "fixture", "status": "ready"}],
                    }
                ),
                encoding="utf-8",
            )
            rel_a = tmp / "atom-rel-a"
            rel_b = tmp / "atom-rel-b"
            assert run_cmd(pub_bin, ["--workspace", str(ws_a), "--intake", str(intake_a), "--output", str(rel_a)], clean_env, log).returncode == 0
            assert run_cmd(pub_bin, ["--workspace", str(ws_b), "--intake", str(intake_b), "--output", str(rel_b)], clean_env, log).returncode == 0
            sha_a = json.loads((rel_a / "manifest.json").read_text(encoding="utf-8"))["sha256"]

            atom_data = tmp / "atom-data"
            assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(rel_a / "manifest.json")], clean_env, log))
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "--max-bytes", "1", "sync", "--manifest", str(rel_b / "manifest.json")], clean_env, log), "OUTPUT_BUDGET_TOO_SMALL")

            with (atom_data / ".sync.lock").open("r+b") as lock_f:
                fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    assert_err_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(rel_b / "manifest.json")], clean_env, log), "SYNC_LOCKED")
                finally:
                    fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)

            for name, mutator, expected_code in [
                ("tamper-cue-time", lambda c: c.execute("UPDATE cues SET start_ms = start_ms + 86400000, end_ms = end_ms + 86400000"), "INVALID_PACKAGE"),
                ("tamper-wrong-cue-link", lambda c: c.execute("UPDATE passage_spans SET cue_ordinal = 1 WHERE span_ordinal = 0"), "INVALID_PACKAGE"),
                ("tamper-empty-fts", lambda c: c.executescript("INSERT INTO search(search) VALUES('delete-all'); INSERT INTO search(rowid, title_tokens, body_tokens) SELECT rowid, '', '' FROM passages;"), "INTEGRITY_MISMATCH"),
                ("tamper-fts-stats-zero", lambda c: c.execute("UPDATE search_data SET block=x'000000' WHERE id=1"), "INTEGRITY_MISMATCH"),
                ("tamper-fts-structure", lambda c: c.execute("UPDATE search_data SET block=x'ffffffffffffffff' WHERE id=10"), "INVALID_PACKAGE"),
                ("tamper-continuation", lambda c: c.execute("UPDATE passages SET is_continuation = 1, continued_from = id"), "INVALID_PACKAGE"),
            ]:
                m_tamper = repack_tampered_release(rel_a, tmp / name, mutator)
                assert_err_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(m_tamper)], clean_env, log), expected_code)

            manifest_a_obj = json.loads((rel_a / "manifest.json").read_text(encoding="utf-8"))
            invalid_zstd_dir = tmp / "invalid-zstd-reuse"
            invalid_zstd_dir.mkdir()
            bad_zstd_payload = b"not a zstd stream"
            (invalid_zstd_dir / "corpus.sqlite.zst").write_bytes(bad_zstd_payload)
            m_bad_zstd = dict(manifest_a_obj)
            m_bad_zstd["compressedBytes"] = len(bad_zstd_payload)
            m_bad_zstd["compressedSha256"] = hashlib.sha256(bad_zstd_payload).hexdigest()
            (invalid_zstd_dir / "manifest.json").write_text(json.dumps(m_bad_zstd), encoding="utf-8")
            assert_err_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "sync", "--manifest", str(invalid_zstd_dir / "manifest.json")], clean_env, log), "INVALID_PACKAGE")

            st_after = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(atom_data), "status"], clean_env, log))
            assert st_after["activeRelease"] == sha_a
            return "sync atomicity, lock contention, pre-reuse zstd validation, FTS engine/postings guards, and cue/continuation guards verified"

        def check_known_bad_controls(log: list[dict[str, Any]]) -> str:
            db_dir = tmp / "ctrl-ws"
            db_dir.mkdir()
            (db_dir / "c.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nalpha\n\n2\n00:00:03,000 --> 00:00:04,000\nalpha\n", encoding="utf-8")
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

            for bad_text, bad_spans in [
                ("錯誤文字", hit["spans"]),
                (hit["text"], [{"startByte": 0, "endByte": 3}]),
                (hit["text"], [dict(hit["spans"][1]), dict(hit["spans"][1])]),
            ]:
                caught = False
                try:
                    verify_spans_against_sqlite(db_file, hit["passageId"], bad_text, bad_spans)
                except AssertionError:
                    caught = True
                assert caught

            caught_bad_err = False
            try:
                assert_err_json(subprocess.CompletedProcess(args=["fake"], returncode=2, stdout="leak", stderr="{}"))
            except AssertionError:
                caught_bad_err = True
            assert caught_bad_err
            return "all 4 known-bad controls caught expected mismatches"

        def check_large_64_bucket_regression(log: list[dict[str, Any]]) -> str:
            ws = tmp / "large-2001-ws"
            ws.mkdir()
            passage_count = 2001
            sources = []
            for i in range(1, passage_count + 1):
                rel_name = f"p{i:04d}.txt"
                (ws / rel_name).write_text(f"tok{i:04d} alpha beta", encoding="utf-8")
                sources.append(
                    {
                        "work": "w2001",
                        "path": rel_name,
                        "title": f"Title {i:04d}",
                        "role": "document",
                        "attribution": "authored_fixture",
                        "quality": "fixture",
                        "status": "ready",
                    }
                )
            intake_path = tmp / "large-2001-intake.json"
            intake_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [{"key": "w2001", "title": "Large 64 Bucket Fixture"}],
                        "sources": sources,
                    }
                ),
                encoding="utf-8",
            )
            rel_dir = tmp / "large-2001-rel"
            pub = run_cmd(pub_bin, ["--workspace", str(ws), "--intake", str(intake_path), "--output", str(rel_dir)], clean_env, log)
            assert pub.returncode == 0, pub.stderr
            manifest = log_corpus_record(corpora_logged, "large-2001-64bucket", rel_dir / "manifest.json")
            assert manifest["counts"]["passages"] == passage_count, manifest["counts"]

            large_data = tmp / "large-2001-data"
            synced = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(large_data), "sync", "--manifest", str(rel_dir / "manifest.json")], clean_env, log))
            active_sha = synced["release"]
            assert active_sha == manifest["sha256"]
            for tok in ("tok0064", "tok0065", "tok2001"):
                res = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(large_data), "search", tok], clean_env, log))
                assert len(res["hits"]) == 1, (tok, res)

            def rewrite_search(conn: sqlite3.Connection, mutator: Any) -> None:
                conn.execute("CREATE VIRTUAL TABLE temp.__v USING fts5vocab(main, search, instance)")
                by_doc: dict[int, dict[str, list[str]]] = {}
                for doc, col, term in conn.execute("SELECT doc, col, term FROM temp.__v ORDER BY doc, col, offset"):
                    by_doc.setdefault(int(doc), {"title_tokens": [], "body_tokens": []})[col].append(term)
                conn.execute("DROP TABLE temp.__v")
                mutator(by_doc)
                conn.execute("INSERT INTO search(search) VALUES('delete-all')")
                for doc in sorted(by_doc):
                    conn.execute(
                        "INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(?, ?, ?)",
                        (doc, " ".join(by_doc[doc]["title_tokens"]), " ".join(by_doc[doc]["body_tokens"])),
                    )

            def swap_64_65(by_doc: dict[int, dict[str, list[str]]]) -> None:
                by_doc[64]["body_tokens"], by_doc[65]["body_tokens"] = (
                    by_doc[65]["body_tokens"],
                    by_doc[64]["body_tokens"],
                )

            def drop_last_posting(by_doc: dict[int, dict[str, list[str]]]) -> None:
                by_doc[2001]["body_tokens"] = by_doc[2001]["body_tokens"][:-1]

            def dup_last_posting(by_doc: dict[int, dict[str, list[str]]]) -> None:
                toks = by_doc[2001]["body_tokens"]
                by_doc[2001]["body_tokens"] = [*toks[:-1], toks[-2]]

            for name, mutator in (
                ("large-boundary-64-65", lambda c: rewrite_search(c, swap_64_65)),
                ("large-missing-2001", lambda c: rewrite_search(c, drop_last_posting)),
                ("large-duplicate-2001", lambda c: rewrite_search(c, dup_last_posting)),
                ("large-global-stats-2001", lambda c: c.execute("UPDATE search_data SET block=x'000000' WHERE id=1")),
            ):
                m_bad = repack_tampered_release(rel_dir, tmp / name, mutator)
                assert_err_json(
                    run_cmd(clec_bin, ["--data-dir", str(large_data), "sync", "--manifest", str(m_bad)], clean_env, log),
                    "INTEGRITY_MISMATCH",
                )
                leftovers = [
                    p.name
                    for p in large_data.iterdir()
                    if p.name.startswith(".clec-fts-") or p.name in (".incoming.sqlite.tmp", ".active.tmp")
                ]
                assert not leftovers, f"leftover temp artifacts after failed {name}: {leftovers}"

            st_after = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(large_data), "status"], clean_env, log))
            assert st_after["activeRelease"] == active_sha
            res_after = assert_ok_json(run_cmd(clec_bin, ["--data-dir", str(large_data), "search", "tok2001"], clean_env, log))
            assert len(res_after["hits"]) == 1
            return "2001-passage 64-bucket sync, 64/65 boundary swap, last-row 2001 missing/duplicate postings, global stats, unchanged active state, and temp cleanup verified"

        def check_deterministic_repeat_publish(log: list[dict[str, Any]]) -> str:
            ws = tmp / "det-ws"
            ws.mkdir()
            works = []
            sources = []
            for w in range(5):
                wk = f"det-w{w:02d}"
                works.append({"key": wk, "title": f"Det Work {w:02d}"})
                body = f"確定性發布測試{w}\n多群組對比內容"
                (ws / f"w{w}.srt").write_text(f"1\n00:00:01,000 --> 00:00:02,000\n{body}\n", encoding="utf-8")
                (ws / f"w{w}.txt").write_text(body, encoding="utf-8")
                (ws / f"w{w}_sum.txt").write_text(f"摘要{w}獨立內容", encoding="utf-8")
                for path, role in ((f"w{w}.srt", "transcript"), (f"w{w}.txt", "transcript"), (f"w{w}_sum.txt", "summary")):
                    sources.append(
                        {
                            "work": wk,
                            "path": path,
                            "title": f"{wk} {path}",
                            "role": role,
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        }
                    )
            intake_fwd = tmp / "det-intake-fwd.json"
            intake_fwd.write_text(json.dumps({"schemaVersion": 1, "works": works, "sources": sources}, ensure_ascii=False), encoding="utf-8")
            intake_rev = tmp / "det-intake-rev.json"
            intake_rev.write_text(
                json.dumps({"schemaVersion": 1, "works": list(reversed(works)), "sources": list(reversed(sources))}, ensure_ascii=False),
                encoding="utf-8",
            )

            sqlite_hashes = []
            zst_hashes = []
            for idx, ipath in enumerate((intake_fwd, intake_fwd, intake_fwd, intake_rev)):
                rel = tmp / f"det-rel-{idx}"
                proc = run_cmd(pub_bin, ["--workspace", str(ws), "--intake", str(ipath), "--output", str(rel)], clean_env, log)
                assert proc.returncode == 0, proc.stderr
                m = json.loads((rel / "manifest.json").read_text(encoding="utf-8"))
                assert m["counts"]["canonicalSources"] == 10, m["counts"]
                sqlite_hashes.append(m["sha256"])
                zst_hashes.append(m["compressedSha256"])
                assert sha256_file(rel / "corpus.sqlite.zst") == m["compressedSha256"]
                decompressed = py_zstd.decompress((rel / "corpus.sqlite.zst").read_bytes())
                assert hashlib.sha256(decompressed).hexdigest() == m["sha256"]
            assert len(set(sqlite_hashes)) == 1, sqlite_hashes
            assert len(set(zst_hashes)) == 1, zst_hashes
            return f"4 repeat/permuted multi-group publishes matched byte-for-byte ({sqlite_hashes[0][:12]}...)"

        run_check("no_data_lifecycle", check_no_data)
        run_check("deterministic_repeat_publish", check_deterministic_repeat_publish)
        run_check("parser_and_unsupported_flags", check_parser_and_unsupported)
        run_check("synthetic_triples_and_false_friends", check_synthetic_triples_and_false_friends)
        run_check("authored_edge_fixtures", check_edge_fixtures_e2e)
        run_check("authored_ranking_and_diversity", check_authored_ranking_and_diversity)
        run_check("real_00318_00575_e2e", check_real_mini_corpus)
        run_check("sync_atomicity_and_import_guards", check_sync_atomicity_and_import_guards)
        run_check("large_64_bucket_2001_regression", check_large_64_bucket_regression)
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
