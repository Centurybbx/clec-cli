#!/usr/bin/env python3
"""Behavior tests for capture_capacity.py."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import capture_capacity as cc


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
            self.assertGreaterEqual(report["publish"]["diskSampling"]["maxObservedCombinedBytes"], report["manifest"]["compressedBytes"])
            self.assertGreaterEqual(report["sync"]["diskSampling"]["maxObservedCombinedBytes"], report["manifest"]["bytes"])
            self.assertEqual(report["publish"]["diskSampling"]["measurementBasis"], "polled_10ms_lower_bound")
            self.assertGreater(report["conservativeStorageBounds"]["publishConservativePeakBoundBytes"], report["manifest"]["bytes"])
            self.assertGreater(report["conservativeStorageBounds"]["syncConservativePeakBoundBytes"], report["manifest"]["bytes"])
            self.assertTrue(report["workspaceBaselineUnchanged"])


if __name__ == "__main__":
    unittest.main()
