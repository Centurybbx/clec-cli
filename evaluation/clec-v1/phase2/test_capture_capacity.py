#!/usr/bin/env python3
"""Behavior tests for capture_capacity.py and semantic_compare.py."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import capture_capacity as cc
import semantic_compare as sc


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class CaptureCapacityTests(unittest.TestCase):
    def test_parse_darwin_time_l_output(self) -> None:
        sample = (
            "      121.97 real        96.03 user        11.00 sys\n"
            "           478150656  maximum resident set size\n"
            "           529974280  peak memory footprint\n"
        )
        parsed = cc.parse_time_output(sample, "Darwin")
        self.assertEqual(parsed["wallSeconds"], 121.97)
        self.assertEqual(parsed["userSeconds"], 96.03)
        self.assertEqual(parsed["sysSeconds"], 11.00)
        self.assertEqual(parsed["maxRssBytes"], 478150656)
        self.assertEqual(parsed["peakFootprintBytes"], 529974280)

    def test_posting_size_estimate_scope_is_explicit(self) -> None:
        self.assertEqual(cc.estimate_posting_buckets_bytes(10, 40), 190)

    def test_end_to_end_capacity_capture_on_2001_passage_fixture(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        pub_bin = repo_root / "native" / "target" / "release" / "clec-publish"
        clec_bin = repo_root / "native" / "target" / "release" / "clec"
        if not pub_bin.is_file() or not clec_bin.is_file():
            self.skipTest("release binaries not built yet")

        with tempfile.TemporaryDirectory(prefix="clec-cap-test-") as tmp_str:
            tmp = Path(tmp_str)
            ws = tmp / "ws"
            ws.mkdir()
            sources = []
            for i in range(1, 2002):
                name = f"f{i:04d}.txt"
                (ws / name).write_text(f"tok{i:04d} cap test body", encoding="utf-8")
                sources.append(
                    {
                        "work": "wcap",
                        "path": name,
                        "title": f"Cap {i:04d}",
                        "role": "document",
                        "attribution": "authored_fixture",
                        "quality": "fixture",
                        "status": "ready",
                    }
                )
            intake = tmp / "intake.json"
            intake.write_text(
                json.dumps({"schemaVersion": 1, "works": [{"key": "wcap", "title": "Cap"}], "sources": sources}),
                encoding="utf-8",
            )
            out_dir = tmp / "cap-out"
            report_path = tmp / "cap-report.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parent / "capture_capacity.py"),
                    "--publish",
                    str(pub_bin),
                    "--clec",
                    str(clec_bin),
                    "--workspace",
                    str(ws),
                    "--intake",
                    str(intake),
                    "--out-dir",
                    str(out_dir),
                    "--report",
                    str(report_path),
                    "--sample-interval-ms",
                    "10",
                    "--keep-artifacts",
                ],
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["manifest"]["counts"]["passages"], 2001)
            self.assertGreater(report["publish"]["timeCommandMetrics"]["maxRssBytes"], 0)
            self.assertGreater(report["sync"]["timeCommandMetrics"]["maxRssBytes"], 0)
            for phase_key in ("publish", "sync"):
                ds = report[phase_key]["diskSampling"]
                self.assertEqual(ds["measurementBasis"], "polled_10ms_sampled_lower_bound")
                self.assertEqual(set(ds["envTempVars"]), {"TMPDIR", "SQLITE_TMPDIR", "TEMP", "TMP"})
                self.assertGreaterEqual(ds["maxObservedCombinedAllocatedBytes"], 0)
            self.assertGreaterEqual(
                report["publish"]["diskSampling"]["maxObservedCombinedLogicalBytes"],
                report["manifest"]["compressedBytes"],
            )
            self.assertGreaterEqual(
                report["sync"]["diskSampling"]["maxObservedCombinedLogicalBytes"],
                report["manifest"]["bytes"],
            )
            est = report["scopedComponentStorageEstimate"]
            self.assertEqual(est["scope"], "scoped_component_estimate_only_not_full_filesystem_bound")
            self.assertIn("sqlite_wal_shm_and_rollback_journals", est["uncoveredOverheads"])
            self.assertGreater(est["publishScopedComponentPeakBytes"], report["manifest"]["bytes"])
            self.assertGreater(est["syncScopedComponentPeakBytes"], report["manifest"]["bytes"])
            self.assertTrue(report["workspaceBaselineUnchanged"])
            self.assertTrue((out_dir / "publish-target" / "release" / "manifest.json").is_file())
            self.assertTrue((out_dir / "sync-data" / f"{report['manifest']['sha256']}.sqlite").is_file())

    def test_semantic_compare_ignores_row_insert_order_and_catches_posting_or_map_shift(self) -> None:
        with tempfile.TemporaryDirectory(prefix="clec-sem-test-") as tmp_str:
            tmp = Path(tmp_str)
            db_a = tmp / "a.sqlite"
            db_b = tmp / "b.sqlite"
            db_bad = tmp / "bad.sqlite"

            def make_db(path: Path, reverse_map: bool, alter_posting: bool) -> None:
                with sqlite3.connect(path) as conn:
                    conn.executescript(
                        """
                        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                        CREATE TABLE blobs(content_hash TEXT PRIMARY KEY, raw_bytes BLOB NOT NULL, byte_len INTEGER NOT NULL);
                        CREATE TABLE works(id TEXT PRIMARY KEY, work_key TEXT UNIQUE NOT NULL, title TEXT NOT NULL);
                        CREATE TABLE sources(id TEXT PRIMARY KEY, work_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL, attribution TEXT NOT NULL, quality TEXT NOT NULL, date TEXT, date_basis TEXT, origin TEXT, content_hash TEXT NOT NULL);
                        CREATE TABLE source_canonical_map(source_id TEXT PRIMARY KEY, canonical_source_id TEXT NOT NULL, equivalence_hash TEXT NOT NULL, projection_kind TEXT NOT NULL, equivalence_basis TEXT NOT NULL);
                        CREATE TABLE source_diagnostics(source_id TEXT NOT NULL, ordinal INTEGER NOT NULL, message TEXT NOT NULL);
                        CREATE TABLE cues(source_id TEXT NOT NULL, ordinal INTEGER NOT NULL, original_identifier TEXT, raw_start_byte INTEGER NOT NULL, raw_end_byte INTEGER NOT NULL, text_start_byte INTEGER NOT NULL, text_end_byte INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);
                        CREATE TABLE inventory(path TEXT NOT NULL, work_key TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, content_hash TEXT);
                        CREATE TABLE passages(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, work_id TEXT NOT NULL, ordinal INTEGER NOT NULL, boundary TEXT NOT NULL, is_continuation INTEGER NOT NULL, continued_from TEXT, continued_to TEXT, text TEXT NOT NULL);
                        CREATE TABLE passage_spans(passage_id TEXT NOT NULL, span_ordinal INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, cue_ordinal INTEGER);
                        CREATE VIRTUAL TABLE search USING fts5(title_tokens, body_tokens, content='', tokenize='ascii');
                        """
                    )
                    conn.execute("INSERT INTO metadata VALUES('corpus_format','clec-native-v2')")
                    conn.execute("INSERT INTO works VALUES('w_1','k1','Work 1')")
                    conn.execute("INSERT INTO blobs VALUES('h1', X'616263', 3)")
                    conn.execute(
                        "INSERT INTO sources VALUES('s_1','w_1','a.txt','A','document','authored_fixture','fixture',NULL,NULL,NULL,'h1')"
                    )
                    conn.execute(
                        "INSERT INTO sources VALUES('s_2','w_1','b.txt','B','document','authored_fixture','fixture',NULL,NULL,NULL,'h1')"
                    )
                    map_rows = [
                        ("s_1", "s_1", "eq1", "plain_text", "canonical_by_timing_and_format"),
                        ("s_2", "s_1", "eq1", "plain_text", "collapsed_to_canonical"),
                    ]
                    if reverse_map:
                        map_rows.reverse()
                    conn.executemany("INSERT INTO source_canonical_map VALUES(?,?,?,?,?)", map_rows)
                    conn.execute("INSERT INTO passages VALUES('p_1','s_1','w_1',0,'whole',0,NULL,NULL,'abc')")
                    conn.execute("INSERT INTO passage_spans VALUES('p_1',0,0,3,NULL)")
                    body_tok = "t99" if alter_posting else "t616263"
                    conn.execute("INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(1, 't61', ?)", (body_tok,))

            make_db(db_a, reverse_map=False, alter_posting=False)
            make_db(db_b, reverse_map=True, alter_posting=False)
            make_db(db_bad, reverse_map=False, alter_posting=True)

            eq_res = sc.compare_databases(db_a, db_b)
            self.assertTrue(eq_res["contentEqual"], eq_res.get("contentMismatches"))
            self.assertFalse(eq_res["usableSemanticEquivalence"])
            self.assertFalse(eq_res["semanticallyEqual"])
            self.assertEqual(eq_res["verdict"], "content_only_validity_inconclusive")
            self.assertEqual(eq_res["structuralValidity"]["left"]["status"], "inconclusive")
            self.assertEqual(eq_res["structuralValidity"]["right"]["status"], "inconclusive")

            bad_res = sc.compare_databases(db_a, db_bad)
            self.assertFalse(bad_res["contentEqual"])
            self.assertFalse(bad_res["usableSemanticEquivalence"])
            self.assertFalse(bad_res["semanticallyEqual"])
            self.assertEqual([m["section"] for m in bad_res["contentMismatches"]], ["ftsPostings"])

    def test_semantic_compare_requires_native_validity_and_rejects_fts_shadow_corruptions_and_stale_receipts(
        self,
    ) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        pub_bin = repo_root / "native" / "target" / "release" / "clec-publish"
        clec_bin = repo_root / "native" / "target" / "release" / "clec"
        val_bin = repo_root / "native" / "target" / "release" / "clec-validate"
        sem_script = Path(__file__).resolve().parent / "semantic_compare.py"
        self.assertTrue(val_bin.is_file(), f"missing clec-validate binary: {val_bin}")

        with tempfile.TemporaryDirectory(prefix="clec-sem-native-") as tmp_str:
            tmp = Path(tmp_str)
            ws = tmp / "ws"
            ws.mkdir()
            (ws / "a.txt").write_text("0050與QQQ投資討論\n每年4%提領原則\n", encoding="utf-8")
            (ws / "b.txt").write_text("退休生活費規劃與資產配置\n保留適當現金緩衝\n", encoding="utf-8")
            intake = tmp / "intake.json"
            intake.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [
                            {"key": "w1", "title": "Work 1"},
                            {"key": "w2", "title": "Work 2"},
                        ],
                        "sources": [
                            {
                                "work": "w1",
                                "path": "a.txt",
                                "title": "A",
                                "role": "document",
                                "attribution": "authored_fixture",
                                "quality": "fixture",
                                "status": "ready",
                            },
                            {
                                "work": "w2",
                                "path": "b.txt",
                                "title": "B",
                                "role": "document",
                                "attribution": "authored_fixture",
                                "quality": "fixture",
                                "status": "ready",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            rel = tmp / "rel"
            subprocess.run(
                [str(pub_bin), "--workspace", str(ws), "--intake", str(intake), "--output", str(rel)],
                check=True,
                capture_output=True,
            )
            manifest = json.loads((rel / "manifest.json").read_text(encoding="utf-8"))
            data_dir = tmp / "data"
            subprocess.run(
                [str(clec_bin), "--data-dir", str(data_dir), "sync", "--manifest", str(rel / "manifest.json")],
                check=True,
                capture_output=True,
            )
            clean_db = data_dir / f"{manifest['sha256']}.sqlite"
            clean_sha = _sha256_file(clean_db)

            vacuumed_db = tmp / "vacuumed.sqlite"
            shutil.copy2(clean_db, vacuumed_db)
            with sqlite3.connect(vacuumed_db) as conn:
                conn.execute("PRAGMA page_size=8192")
                conn.execute("VACUUM")
            vac_sha = _sha256_file(vacuumed_db)
            self.assertNotEqual(clean_sha, vac_sha)

            bad_data_db = tmp / "bad_search_data.sqlite"
            shutil.copy2(clean_db, bad_data_db)
            with sqlite3.connect(bad_data_db) as conn:
                conn.execute("UPDATE search_data SET block=X'000000' WHERE id=1")
                conn.commit()
            bad_data_sha = _sha256_file(bad_data_db)

            bad_docsize_db = tmp / "bad_search_docsize.sqlite"
            shutil.copy2(clean_db, bad_docsize_db)
            with sqlite3.connect(bad_docsize_db) as conn:
                conn.execute("UPDATE search_docsize SET sz=X'0000' WHERE id=1")
                conn.commit()
            bad_docsize_sha = _sha256_file(bad_docsize_db)

            left_receipt = tmp / "left-receipt.json"
            right_receipt = tmp / "right-receipt.json"
            ok_proc = subprocess.run(
                [
                    sys.executable,
                    str(sem_script),
                    "--left",
                    str(clean_db),
                    "--right",
                    str(vacuumed_db),
                    "--validator",
                    str(val_bin),
                    "--write-left-receipt",
                    str(left_receipt),
                    "--write-right-receipt",
                    str(right_receipt),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(ok_proc.returncode, 0, ok_proc.stderr)
            ok_out = json.loads(ok_proc.stdout)
            self.assertTrue(ok_out["contentEqual"])
            self.assertTrue(ok_out["usableSemanticEquivalence"])
            self.assertTrue(ok_out["semanticallyEqual"])
            self.assertEqual(ok_out["verdict"], "usable_semantic_equivalence")
            self.assertTrue(ok_out["structuralValidity"]["bothValid"])
            self.assertEqual(_sha256_file(clean_db), clean_sha)
            self.assertEqual(_sha256_file(vacuumed_db), vac_sha)

            for bad_db, bad_sha in ((bad_data_db, bad_data_sha), (bad_docsize_db, bad_docsize_sha)):
                bad_proc = subprocess.run(
                    [
                        sys.executable,
                        str(sem_script),
                        "--left",
                        str(clean_db),
                        "--right",
                        str(bad_db),
                        "--validator",
                        str(val_bin),
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(bad_proc.returncode, 0)
                bad_out = json.loads(bad_proc.stdout)
                self.assertTrue(bad_out["contentEqual"])
                self.assertFalse(bad_out["usableSemanticEquivalence"])
                self.assertFalse(bad_out["semanticallyEqual"])
                self.assertEqual(bad_out["verdict"], "structural_validation_failed")
                self.assertEqual(bad_out["structuralValidity"]["left"]["status"], "valid")
                self.assertEqual(bad_out["structuralValidity"]["right"]["status"], "invalid")
                self.assertEqual(_sha256_file(clean_db), clean_sha)
                self.assertEqual(_sha256_file(bad_db), bad_sha)

            content_only_proc = subprocess.run(
                [
                    sys.executable,
                    str(sem_script),
                    "--left",
                    str(clean_db),
                    "--right",
                    str(vacuumed_db),
                    "--content-only",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(content_only_proc.returncode, 0)
            co_out = json.loads(content_only_proc.stdout)
            self.assertTrue(co_out["contentEqual"])
            self.assertFalse(co_out["usableSemanticEquivalence"])
            self.assertFalse(co_out["semanticallyEqual"])
            self.assertEqual(co_out["verdict"], "content_only_validity_inconclusive")

            reuse_proc = subprocess.run(
                [
                    sys.executable,
                    str(sem_script),
                    "--left",
                    str(clean_db),
                    "--right",
                    str(vacuumed_db),
                    "--validator",
                    str(val_bin),
                    "--left-receipt",
                    str(left_receipt),
                    "--right-receipt",
                    str(right_receipt),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(reuse_proc.returncode, 0, reuse_proc.stderr)

            swapped_proc = subprocess.run(
                [
                    sys.executable,
                    str(sem_script),
                    "--left",
                    str(clean_db),
                    "--right",
                    str(vacuumed_db),
                    "--validator",
                    str(val_bin),
                    "--left-receipt",
                    str(left_receipt),
                    "--right-receipt",
                    str(left_receipt),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(swapped_proc.returncode, 0)
            swapped_out = json.loads(swapped_proc.stdout)
            self.assertFalse(swapped_out["usableSemanticEquivalence"])
            self.assertFalse(swapped_out["semanticallyEqual"])
            self.assertEqual(swapped_out["structuralValidity"]["right"]["status"], "stale_receipt")

            stale_bin_receipt = tmp / "stale-bin-receipt.json"
            r_obj = json.loads(right_receipt.read_text(encoding="utf-8"))
            r_obj["binarySha256"] = "0" * 64
            stale_bin_receipt.write_text(json.dumps(r_obj), encoding="utf-8")
            stale_bin_proc = subprocess.run(
                [
                    sys.executable,
                    str(sem_script),
                    "--left",
                    str(clean_db),
                    "--right",
                    str(vacuumed_db),
                    "--validator",
                    str(val_bin),
                    "--left-receipt",
                    str(left_receipt),
                    "--right-receipt",
                    str(stale_bin_receipt),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(stale_bin_proc.returncode, 0)
            stale_bin_out = json.loads(stale_bin_proc.stdout)
            self.assertFalse(stale_bin_out["usableSemanticEquivalence"])
            self.assertEqual(stale_bin_out["structuralValidity"]["right"]["status"], "stale_receipt")

            changed_db = tmp / "changed.sqlite"
            shutil.copy2(vacuumed_db, changed_db)
            with sqlite3.connect(changed_db) as conn:
                conn.execute("UPDATE works SET title='Changed Title' WHERE work_key='w1'")
                conn.commit()
            changed_proc = subprocess.run(
                [
                    sys.executable,
                    str(sem_script),
                    "--left",
                    str(clean_db),
                    "--right",
                    str(changed_db),
                    "--validator",
                    str(val_bin),
                    "--left-receipt",
                    str(left_receipt),
                    "--right-receipt",
                    str(right_receipt),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(changed_proc.returncode, 0)
            changed_out = json.loads(changed_proc.stdout)
            self.assertFalse(changed_out["contentEqual"])
            self.assertFalse(changed_out["usableSemanticEquivalence"])
            self.assertEqual(changed_out["structuralValidity"]["right"]["status"], "stale_receipt")


if __name__ == "__main__":
    unittest.main()
