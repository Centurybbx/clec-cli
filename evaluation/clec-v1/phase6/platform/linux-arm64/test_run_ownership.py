import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("linux_driver", pathlib.Path(__file__).with_name("verify_linux_arm64.py"))
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


class RunOwnershipTests(unittest.TestCase):
    def test_output_roots_and_unit_attempts_are_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "run"
            run = DRIVER.VerificationRun(root)
            with self.assertRaises(FileExistsError):
                DRIVER.VerificationRun(root)
            with run.unit("guests"):
                (root / "evidence").write_bytes(b"retained")
            run.close()
            resumed = DRIVER.VerificationRun(root)
            try:
                with self.assertRaises(FileExistsError):
                    with resumed.unit("guests"):
                        self.fail("Repeated unit entered")
                self.assertEqual((root / "evidence").read_bytes(), b"retained")
            finally:
                resumed.close()

    def test_failed_unit_evidence_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = DRIVER.VerificationRun(pathlib.Path(tmp) / "run")
            try:
                with self.assertRaisesRegex(RuntimeError, "deliberate failure"):
                    with run.unit("stage"):
                        (run.root / "partial.log").write_text("retain failure")
                        raise RuntimeError("deliberate failure")
                with self.assertRaises(FileExistsError):
                    with run.unit("stage"):
                        self.fail("Failed unit reused")
                self.assertEqual((run.root / "partial.log").read_text(), "retain failure")
            finally:
                run.close()

    def test_legacy_evidence_directory_is_not_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "sentinel.log").write_text("original")
            with self.assertRaisesRegex(RuntimeError, "no run identity"):
                DRIVER.VerificationRun(root)
            self.assertEqual((root / "sentinel.log").read_text(), "original")
            self.assertFalse((root / ".driver.lock").exists())

    def test_two_runs_cleanup_only_recorded_owned_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = DRIVER.VerificationRun(pathlib.Path(tmp) / "a")
            second = DRIVER.VerificationRun(pathlib.Path(tmp) / "b")
            own_id, other_id = "a" * 64, "b" * 64
            (first.resources / "own.cid").write_text(own_id)
            (second.resources / "other.cid").write_text(other_id)
            commands = []

            def docker(cmd, **kwargs):
                commands.append(cmd)
                if cmd[:3] == ["docker", "container", "inspect"]:
                    self.assertEqual(cmd[-1], own_id)
                    return subprocess.CompletedProcess(cmd, 0, json.dumps([{"Config": {"Labels": {DRIVER.OWNER_LABEL: first.id}}}]), "")
                if cmd[:3] == ["docker", "volume", "inspect"]:
                    self.assertEqual(cmd[-1], first.volume)
                    return subprocess.CompletedProcess(cmd, 0, json.dumps([{"Labels": {DRIVER.OWNER_LABEL: first.id}}]), "")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            try:
                with patch.object(DRIVER.subprocess, "run", side_effect=docker):
                    self.assertEqual(first.cleanup_resources(), ([own_id], [first.volume]))
                self.assertIn(["docker", "rm", "-f", own_id], commands)
                self.assertIn(["docker", "volume", "rm", first.volume], commands)
                self.assertFalse(any(other_id in cmd or second.volume in cmd for cmd in commands))
                self.assertFalse(any("ps" in cmd or "ls" in cmd for cmd in commands))
            finally:
                first.close()
                second.close()

    def test_foreign_label_and_unobservable_resource_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = DRIVER.VerificationRun(pathlib.Path(tmp) / "run")
            try:
                (run.resources / "bad.cid").write_text("f" * 64)
                foreign = subprocess.CompletedProcess([], 0, json.dumps([{"Config": {"Labels": {DRIVER.OWNER_LABEL: "foreign"}}}]), "")
                with patch.object(DRIVER.subprocess, "run", return_value=foreign) as mock:
                    with self.assertRaisesRegex(RuntimeError, "ownership mismatch"):
                        run.cleanup_resources()
                    self.assertEqual(mock.call_count, 1)
                unavailable = subprocess.CompletedProcess([], 1, "", "Cannot connect to Docker daemon")
                with patch.object(DRIVER.subprocess, "run", return_value=unavailable):
                    with self.assertRaisesRegex(RuntimeError, "Cannot establish"):
                        run.cleanup_resources()
            finally:
                run.close()

    def test_docker_run_records_exact_cid_and_unique_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = DRIVER.VerificationRun(pathlib.Path(tmp) / "a")
            second = DRIVER.VerificationRun(pathlib.Path(tmp) / "b")
            try:
                cmd = ["docker", "run", "--rm", "--name", "clec-linux-arm64-guest", "image", "true"]
                a, b = first.container_command(cmd), second.container_command(cmd)
                self.assertNotEqual(a[a.index("--name") + 1], b[b.index("--name") + 1])
                self.assertIn(f"{DRIVER.OWNER_LABEL}={first.id}", a)
                self.assertEqual(pathlib.Path(a[a.index("--cidfile") + 1]).parent, first.resources)
                self.assertEqual(cmd, ["docker", "run", "--rm", "--name", "clec-linux-arm64-guest", "image", "true"])
            finally:
                first.close()
                second.close()


if __name__ == "__main__":
    unittest.main()
