#!/usr/bin/env python3
"""Exercise the published CLI contract on a synthetic, offline-only corpus."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest


class DeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[4]
        cls.binary = root / "native/target/release/clec"
        publish = cls.binary.with_name("clec-publish")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        workspace = Path(cls.tmp.name)
        cls.data_dir = workspace / "data"
        cls.raw = {}
        works, sources = [], []
        long_title = "標題 \"\\ 😀\x1f" * 120

        def add_source(i, path, text, role):
            key = f"work-{i}"
            works.append({"key": key, "title": long_title})
            sources.append({
                "work": key, "path": path, "title": long_title, "role": role,
                "attribution": "authored_fixture", "quality": "fixture", "status": "ready",
                "date": "2024-01-01", "dateBasis": "fixture",
            })
            cls.raw[path] = text.encode("utf-8")
            (workspace / path).write_bytes(cls.raw[path])

        for i in range(50):
            add_source(i, f"{i}.txt", f"唯一短段{i}。共同定位" + " 引號 \"\\😀\t" * 170, "document")
        subtitle = "\n".join(f"{i + 1}\n00:00:00,001 --> 00:00:00,020\n"
                             f"密集字幕{i}共同定位\n" for i in range(150))
        add_source(50, "dense.srt", subtitle, "transcript")

        intake = workspace / "intake.json"
        intake.write_text(json.dumps({"schemaVersion": 1, "works": works, "sources": sources}))
        output = workspace / "release"
        result = subprocess.run([publish, "--workspace", workspace, "--intake", intake,
                                 "--output", output], capture_output=True, check=True)
        cls.release = json.loads(result.stdout)["sha256"]
        cls.cli("sync", "--manifest", str(output / "manifest.json"))

    @classmethod
    def cli(cls, *args, cap=65536, error=None):
        result = subprocess.run([cls.binary, "--data-dir", cls.data_dir, "--offline",
                                 "--json", "--max-bytes", str(cap), *args],
                                capture_output=True, timeout=30)
        if error is not None:
            response = json.loads(result.stderr)
            assert result.returncode and not result.stdout and response["error"]["code"] == error
            return response["error"]
        if result.returncode:
            raise AssertionError(result.stderr.decode())
        assert len(result.stdout) <= cap and not result.stderr
        response = json.loads(result.stdout)
        assert response["ok"] is True
        data = response["data"]
        if "budget" in data:
            assert data["budget"]["usedBytes"] == len(result.stdout)
        return data

    def test_search_width_and_exact_retry(self):
        for args, expected, cap in [
            ((), 20, 32768),
            (("--limit", "1"), 1, 32768),
            (("--limit", "50"), 50, 65536),
        ]:
            search = self.cli("search", "共同定位", *args, cap=cap)
            self.assertEqual(len(search["hits"]), expected)
            self.assertEqual(search["budget"]["omittedIds"], [])
            self.assertEqual(search["release"], self.release)
            for hit in search["hits"][:5]:
                self.assertTrue(hit["excerpt"])
                self.assertNotIn("text", hit)
                self.assertNotIn("cues", hit)
                self.assertNotIn("spans", hit)
                item = self.cli("read", hit["passageId"], "--release", self.release)["items"][0]
                span = hit["excerptSpan"]
                raw = self.raw[item["source"]["path"]]
                self.assertEqual(raw[span["startByte"]:span["endByte"]].decode(), hit["excerpt"])
                self.assertLess(len(hit["source"]["title"]), len(item["source"]["title"]))
        p0 = self.cli("search", "共同定位", "--limit", "20", "--offset", "0", cap=32768)
        p1 = self.cli("search", "共同定位", "--limit", "20", "--offset", "20", cap=32768)
        p2 = self.cli("search", "共同定位", "--limit", "20", "--offset", "40", cap=32768)
        self.assertEqual((len(p0["hits"]), p0["hasMore"], p0["nextOffset"]), (20, True, 20))
        self.assertEqual((len(p1["hits"]), p1["hasMore"], p1["nextOffset"]), (20, True, 40))
        self.assertEqual((len(p2["hits"]), p2["hasMore"]), (12, False))
        self.assertNotIn("nextOffset", p2)
        stitched = [h["passageId"] for p in (p0, p1, p2) for h in p["hits"]]
        self.assertEqual(len(set(stitched)), 52)
        args = ("search", "共同定位", "--limit", "20", "--release", self.release)
        required = self.cli(*args, cap=1, error="OUTPUT_BUDGET_TOO_SMALL")["requiredBytes"]
        self.cli(*args, cap=required - 1, error="OUTPUT_BUDGET_TOO_SMALL")
        data = self.cli(*args, cap=required)
        self.assertEqual(len(data["hits"]), 1)
        self.assertEqual(data["budget"]["omittedCount"], 19)
        self.assertEqual(len(data["budget"]["omittedIds"]), 19)
        self.assertEqual(data["nextOffset"], 1)
        self.cli("search", "共同定位", "--limit", "51", error="INVALID_ARGUMENT")

    def test_ordered_read_prefix_pin_cues_and_exact_retry(self):
        dense = self.cli("search", "密集字幕", "--role", "transcript", "--limit", "1")["hits"][0]
        small = self.cli("search", "共同定位", "--role", "document", "--limit", "1")["hits"][0]
        self.assertEqual(dense["timeRange"], {"startMs": 1, "endMs": 20})
        pid, sid = dense["passageId"], small["passageId"]
        pin = ("--release", self.release)
        compact = self.cli("read", pid, *pin)["items"][0]
        timed = self.cli("read", pid, "--cues", *pin)["items"][0]
        self.assertNotIn("cues", compact)
        self.assertEqual(compact["context"], [])
        self.assertGreater(len(timed["cues"]), 20)
        self.assertEqual(compact["spans"], timed["spans"])
        raw = self.raw["dense.srt"]
        self.assertEqual(compact["text"], "\n".join(
            raw[span["startByte"]:span["endByte"]].decode() for span in compact["spans"]
        ))
        self.cli("read", pid, "--release", "0" * 64, error="VERSION_UNAVAILABLE")
        order = ("read", sid, pid, sid, "--cues", *pin)
        first_fit = self.cli(*order, cap=1, error="OUTPUT_BUDGET_TOO_SMALL")["requiredBytes"]
        partial = self.cli(*order, cap=first_fit)
        self.assertEqual([item["passageId"] for item in partial["items"]], [sid])
        self.assertEqual(partial["release"], self.release)
        self.assertEqual(partial["budget"]["omittedIds"], [pid, sid])
        required = partial["budget"]["nextRequiredBytes"]
        self.cli("read", pid, "--cues", *pin, cap=required - 1, error="OUTPUT_BUDGET_TOO_SMALL")
        next_read = self.cli("read", pid, "--cues", *pin, cap=required)
        self.assertEqual(next_read["items"], [timed])
        self.assertEqual([item["passageId"] for item in self.cli(*order)["items"]], [sid, pid, sid])
        missing = self.cli("read", sid, "p_" + "0" * 24, *pin, cap=1, error="EVIDENCE_NOT_FOUND")
        self.assertEqual(missing["inputIndex"], 1)

    def test_schema_advertises_current_contract(self):
        schema = self.cli("schema")
        commands = {command["name"]: command for command in schema["commands"]}
        search = {option["id"]: option for option in commands["search"]["options"]}
        read = {option["id"]: option for option in commands["read"]["options"]}
        self.assertEqual(search["limit"]["defaultValues"], ["20"])
        self.assertIn("offset", search)
        self.assertEqual(read["context"]["defaultValues"], ["0"])
        self.assertIn("release", read)
        self.assertIn("cues", read)
        self.assertIn("excerptSpan", json.dumps(schema["envelopes"]["search"]))
        self.assertIn("requiredBytes", json.dumps(schema["envelopes"]["error"]))


if __name__ == "__main__":
    unittest.main()
