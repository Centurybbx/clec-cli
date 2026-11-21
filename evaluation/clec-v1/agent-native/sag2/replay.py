#!/usr/bin/env python3
"""Compare Jev round transport with constant synthetic scores on local development material."""

import argparse
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "phase3"))
from score import stream_sha256


class ConstantScores(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers["Content-Length"])
        if self.path != "/decisions" or not 1 <= size <= 65536:
            self.send_error(400)
            return
        raw = self.rfile.read(size)
        assert len(raw) == size
        request = json.loads(raw)
        state_text = request["state"]
        state = json.loads(state_text)
        seeds = state["previously_retrieved_evidence"]
        questions = request["questions"]
        with self.server.record_lock:
            self.server.records.append({
                "model": request["model"],
                "seedCount": len(seeds),
                "stateSha256": hashlib.sha256(state_text.encode()).hexdigest(),
                "bodyBytes": len(raw),
                "keys": sorted(questions),
            })
        response = json.dumps({
            "model": "synthetic-clec-reference",
            "answers": {key: {"type": "noul", "noul": 0.5} for key in questions},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_args):
        pass


def evaluate(binary, case, data_dir, release, requested_model=None):
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), ConstantScores) as server:
        server.records = []
        server.record_lock = threading.Lock()
        loopback = threading.Thread(target=server.serve_forever)
        loopback.start()
        env = {"PATH": "/usr/bin:/bin", "JEV_API_KEY": "offline-replay-sentinel",
               "JEV_BASE_URL": f"http://127.0.0.1:{server.server_port}/decisions"}
        if requested_model is not None:
            env["JEV_MODEL"] = requested_model
        try:
            result = subprocess.run(
                [str(binary), "--json", "--max-bytes", "32768", "--data-dir", str(data_dir),
                 "search", "--sag2", "--release", release, "--limit", "5", case["question"]],
                env=env,
                capture_output=True, timeout=95,
            )
        finally:
            server.shutdown()
            loopback.join()
        if result.returncode == 0:
            assert not result.stderr and len(result.stdout) <= 32768
            data = json.loads(result.stdout)["data"]
            outcome = {"revision": data["algorithmRevision"], "pool": data["candidateCounts"],
                       "calls": data["calls"], "limits": data["limits"],
                       "consumption": data["consumption"], "stopReason": data["stopReason"],
                       "roundsCompleted": data["roundsCompleted"],
                       "requestedModel": data["requestedModel"]}
        else:
            assert not result.stdout
            outcome = {"error": json.loads(result.stderr)["error"]}
        batches = server.records
        for with_seeds in (False, True):
            round_batches = [batch for batch in batches if bool(batch["seedCount"]) == with_seeds]
            assert len({batch["stateSha256"] for batch in round_batches}) <= 1
            keys = [key for batch in round_batches for key in batch["keys"]]
            assert len(keys) == len(set(keys))
        return {"id": case["id"], "exitCode": result.returncode, **outcome, "batches": batches}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("before", "after", "data-dir", "development-cases", "output"):
        parser.add_argument(f"--{flag}", required=True, type=Path)
    args = parser.parse_args()
    cases = json.loads(args.development_cases.read_bytes())
    if cases["split"] != "development":
        parser.error("this replay consumes only development cases")
    release = cases["corpusSha256"]
    assert json.loads((args.data_dir / "active.json").read_bytes())["release"] == release
    args.output.mkdir(mode=0o700)
    profiles = {}
    for name, binary in (("before", args.before), ("after", args.after)):
        rows = []
        for case in cases["cases"]:
            row = evaluate(binary.resolve(strict=True), case, args.data_dir.resolve(), release)
            rows.append(row)
        profiles[name] = {"sha256": stream_sha256(binary), "cases": rows}
    for before, after in zip(profiles["before"]["cases"], profiles["after"]["cases"], strict=True):
        assert before["id"] == after["id"]
        for arm in (before, after):
            assert arm["batches"], arm["id"]
            assert all(1 <= batch["bodyBytes"] <= 65536 for batch in arm["batches"]), arm["id"]
        assert after["exitCode"] == 0 and "error" not in after, after
        assert after["roundsCompleted"] == 2 and after["stopReason"] == "completed", after
        assert after["requestedModel"] == "typesafe/jev-1.14", after
        assert all(batch["model"] == "typesafe/jev-1.14" for batch in after["batches"]), after
        limits = after["limits"]
        assert limits["admissionPolicy"] == "calibrated_jev_1_14_body_bounded", limits
        assert limits["maxRequestBodyBytes"] == 65536, limits
        assert limits["maxQuestionEstimatedTokens"] is None, limits
        assert limits["maxBatchEstimatedTokens"] is None, limits
        assert after["pool"]["contextOmittedCount"] == 0, after
        assert after["pool"]["secondPool"] > 0 and after["pool"]["seedsSelected"] == 10, after
        round0 = [batch for batch in after["batches"] if batch["seedCount"] == 0]
        round1 = [batch for batch in after["batches"] if batch["seedCount"] > 0]
        assert round0 and round1, after
        assert {batch["seedCount"] for batch in round1} == {10}, after

    alias_model = "~typesafe/jev-latest"
    alias_row = evaluate(
        args.after.resolve(strict=True), cases["cases"][0], args.data_dir.resolve(), release,
        requested_model=alias_model,
    )
    assert alias_row["exitCode"] == 2 and "error" in alias_row, alias_row
    alias_err = alias_row["error"]
    assert alias_err["code"] == "SAG2_BUDGET_EXHAUSTED", alias_err
    assert "full scoring context" in alias_err["message"], alias_err
    assert "uncalibrated model question estimate limit" in alias_err["message"], alias_err
    assert "uncalibrated_conservative_byte_bound" in alias_err["message"], alias_err
    assert alias_err["sag2Stage"]["completedStage"] == "expansion_retrieval", alias_err
    assert alias_err["sag2Stage"]["roundsCompleted"] == 1, alias_err
    assert alias_row["batches"] and all(batch["seedCount"] == 0 for batch in alias_row["batches"])
    assert all(batch["model"] == alias_model for batch in alias_row["batches"])
    assert alias_err["sag2Stage"]["httpAttempts"] == len(alias_row["batches"])

    alias_control = {
        "release": release,
        "binarySha256": profiles["after"]["sha256"],
        "caseSha256": stream_sha256(args.development_cases),
        "requestedModel": alias_model,
        **alias_row,
    }
    (args.output / "uncalibrated-alias-control.json").write_text(
        json.dumps(alias_control, indent=2) + "\n"
    )
    report = {"release": release, "caseSha256": stream_sha256(args.development_cases),
              "provider": "loopback constant score 0.5", "profiles": profiles,
              "aliasControlFile": "uncalibrated-alias-control.json"}
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(args.output / "report.json")


if __name__ == "__main__":
    main()
