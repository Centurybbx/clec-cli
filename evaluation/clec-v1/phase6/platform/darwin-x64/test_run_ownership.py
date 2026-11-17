import pathlib
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from verify_darwin_x64 import fresh_root, run_checked, write_json


class RunOwnershipTests(unittest.TestCase):
    def test_parallel_runs_do_not_adopt_existing_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = pathlib.Path(temp)
            previous = parent / "run-previous"
            previous.mkdir()
            sentinel = previous / "receipt.json"
            sentinel.write_bytes(b"previous evidence")
            with ThreadPoolExecutor(max_workers=2) as workers:
                runs = list(workers.map(fresh_root, [parent, parent]))
            self.assertEqual(len(set(runs)), 2)
            self.assertNotIn(previous, runs)
            self.assertEqual(sentinel.read_bytes(), b"previous evidence")

    def test_receipt_write_is_exclusive(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt = fresh_root(pathlib.Path(temp)) / "receipt.json"
            write_json(receipt, {"attempt": 1})
            saved = receipt.read_bytes()
            with self.assertRaises(FileExistsError):
                write_json(receipt, {"attempt": 2})
            self.assertEqual(receipt.read_bytes(), saved)

    def test_failed_command_logs_survive_second_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            stem = fresh_root(pathlib.Path(temp)) / "attempt"
            with self.assertRaisesRegex(RuntimeError, "Command exited 7"):
                run_checked(["/bin/sh", "-c", "printf 'original evidence'; exit 7"], log_stem=stem)
            saved = stem.with_suffix(".json").read_bytes()
            with self.assertRaises(FileExistsError):
                run_checked(["/bin/true"], log_stem=stem)
            self.assertEqual(stem.with_suffix(".json").read_bytes(), saved)
            self.assertEqual(stem.with_suffix(".stdout").read_bytes(), b"original evidence")


if __name__ == "__main__":
    unittest.main()
