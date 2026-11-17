#!/usr/bin/env python3
"""Single-run local HTTP capacity feasibility capture for full clec-native-v2 package."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def dir_usage(root: Path) -> tuple[int, int]:
    if not root.exists():
        return 0, 0
    logical_total = 0
    allocated_total = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            st = entry.stat(follow_symlinks=False)
                            logical_total += st.st_size
                            blocks = getattr(st, "st_blocks", None)
                            allocated_total += (blocks * 512) if blocks is not None else st.st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return logical_total, allocated_total


def parse_darwin_time_l(stderr_text: str) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    wall_m = re.search(
        r"^\s*([0-9]+(?:\.[0-9]+)?)\s+real\s+([0-9]+(?:\.[0-9]+)?)\s+user\s+([0-9]+(?:\.[0-9]+)?)\s+sys\b",
        stderr_text,
        re.M,
    )
    if wall_m:
        parsed["wallSeconds"] = float(wall_m.group(1))
        parsed["userSeconds"] = float(wall_m.group(2))
        parsed["sysSeconds"] = float(wall_m.group(3))
    rss_m = re.search(r"^\s*(\d+)\s+maximum resident set size\b", stderr_text, re.M)
    if rss_m:
        parsed["maxRssBytes"] = int(rss_m.group(1))
    foot_m = re.search(r"^\s*(\d+)\s+peak memory footprint\b", stderr_text, re.M)
    if foot_m:
        parsed["peakFootprintBytes"] = int(foot_m.group(1))
    return parsed


def host_snapshot(target: Path) -> dict[str, Any]:
    phys_ram = None
    if platform.system() == "Darwin":
        phys_ram = int(
            subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, check=True).stdout.strip()
        )
    vfs = os.statvfs(target)
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "physicalRamBytes": phys_ram,
        "diskTotalBytes": vfs.f_frsize * vfs.f_blocks,
        "diskFreeBytes": vfs.f_frsize * vfs.f_bavail,
        "loadAverage1m5m15m": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
    }


def serve_readonly_release(release_dir: Path) -> tuple[ThreadingHTTPServer, list[dict[str, Any]], threading.Thread]:
    manifest_path = release_dir / "manifest.json"
    zst_path = release_dir / "corpus.sqlite.zst"
    requests_log: list[dict[str, Any]] = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def do_GET(self) -> None:
            with lock:
                requests_log.append({"method": "GET", "path": self.path})
            if self.path == "/manifest.json":
                data = manifest_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                self.wfile.flush()
                return
            if self.path == "/corpus.sqlite.zst":
                st = zst_path.stat()
                self.send_response(200)
                self.send_header("Content-Type", "application/zstd")
                self.send_header("Content-Length", str(st.st_size))
                self.end_headers()
                with zst_path.open("rb") as f:
                    for chunk in iter(lambda: f.read(262_144), b""):
                        self.wfile.write(chunk)
                self.wfile.flush()
                return
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, requests_log, thread


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture single-run HTTP acquisition and validation capacity receipt")
    parser.add_argument("--clec", required=True, type=Path)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()

    clec_bin = args.clec.resolve()
    release_dir = args.release_dir.resolve()
    out_dir = args.out_dir.resolve()
    assert clec_bin.is_file(), f"missing clec: {clec_bin}"
    manifest_file = release_dir / "manifest.json"
    zst_file = release_dir / "corpus.sqlite.zst"
    assert manifest_file.is_file() and zst_file.is_file()

    if out_dir.exists():
        shutil.rmtree(out_dir)
    data_dir = out_dir / "data"
    tmp_dir = out_dir / "tmp"
    data_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    manifest_obj = json.loads(manifest_file.read_text(encoding="utf-8"))
    zst_sha = sha256_file(zst_file)
    assert zst_sha == manifest_obj["compressedSha256"]

    host_before = host_snapshot(out_dir)
    httpd, requests_log, srv_thread = serve_readonly_release(release_dir)
    port = httpd.server_address[1]
    manifest_url = f"http://127.0.0.1:{port}/manifest.json"

    stop_event = threading.Event()
    peak_data_logical = 0
    peak_data_alloc = 0
    peak_tmp_logical = 0
    peak_tmp_alloc = 0
    peak_combined_logical = 0
    peak_combined_alloc = 0
    samples = 0

    def sampler() -> None:
        nonlocal peak_data_logical, peak_data_alloc, peak_tmp_logical, peak_tmp_alloc
        nonlocal peak_combined_logical, peak_combined_alloc, samples
        while not stop_event.is_set():
            dl, da = dir_usage(data_dir)
            tl, ta = dir_usage(tmp_dir)
            peak_data_logical = max(peak_data_logical, dl)
            peak_data_alloc = max(peak_data_alloc, da)
            peak_tmp_logical = max(peak_tmp_logical, tl)
            peak_tmp_alloc = max(peak_tmp_alloc, ta)
            peak_combined_logical = max(peak_combined_logical, dl + tl)
            peak_combined_alloc = max(peak_combined_alloc, da + ta)
            samples += 1
            time.sleep(0.05)

    sample_thread = threading.Thread(target=sampler, daemon=True)
    sample_thread.start()

    env = dict(os.environ)
    env.pop("CLEC_DATA_DIR", None)
    env["TMPDIR"] = str(tmp_dir)
    env["SQLITE_TMPDIR"] = str(tmp_dir)
    env["TEMP"] = str(tmp_dir)
    env["TMP"] = str(tmp_dir)

    cmd = [
        "/usr/bin/time",
        "-l",
        str(clec_bin),
        "--data-dir",
        str(data_dir),
        "sync",
        "--manifest",
        manifest_url,
    ]
    t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
    finally:
        stop_event.set()
        sample_thread.join(timeout=5)
        httpd.shutdown()
        httpd.server_close()
        srv_thread.join(timeout=5)
    elapsed_wall = time.monotonic() - t0

    assert proc.returncode == 0, f"full HTTP sync failed rc={proc.returncode}: stderr={proc.stderr}"
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    sync_out = json.loads(lines[0])
    assert sync_out["ok"] is True
    sync_data = sync_out["data"]
    assert sync_data["release"] == manifest_obj["sha256"]

    db_path = data_dir / f"{manifest_obj['sha256']}.sqlite"
    assert db_path.is_file()
    actual_db_sha = sha256_file(db_path)
    assert actual_db_sha == manifest_obj["sha256"]
    assert not (data_dir / ".incoming.zst.tmp").exists()
    assert not (data_dir / ".incoming.sqlite.tmp").exists()

    st_proc = subprocess.run(
        [str(clec_bin), "--data-dir", str(data_dir), "--offline", "status"],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    st_data = json.loads(st_proc.stdout)["data"]
    assert st_data["ready"] is True
    assert st_data["storageBytes"] == sync_data["storageBytes"]

    s_proc = subprocess.run(
        [str(clec_bin), "--data-dir", str(data_dir), "--offline", "search", "0050"],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    s_data = json.loads(s_proc.stdout)["data"]
    assert len(s_data["hits"]) > 0

    time_metrics = parse_darwin_time_l(proc.stderr)
    receipt = {
        "schemaVersion": 1,
        "measurementKind": "single_run_capacity_feasibility_not_speed_benchmark",
        "timestampUtc": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "sourceReleaseDir": str(release_dir),
        "clecBinary": str(clec_bin),
        "clecBinarySha256": sha256_file(clec_bin),
        "manifestUrl": manifest_url,
        "httpRequests": requests_log,
        "counts": sync_data["counts"],
        "compressedBytes": manifest_obj["compressedBytes"],
        "compressedSha256": zst_sha,
        "sqliteBytes": db_path.stat().st_size,
        "sqliteSha256": actual_db_sha,
        "storageBytes": sync_data["storageBytes"],
        "elapsedWallSeconds": round(elapsed_wall, 3),
        "timeMetrics": time_metrics,
        "diskSampling": {
            "method": "polled_50ms_sampled_lower_bound",
            "samples": samples,
            "peakDataDirLogicalBytes": peak_data_logical,
            "peakDataDirAllocatedBytes": peak_data_alloc,
            "peakTmpDirLogicalBytes": peak_tmp_logical,
            "peakTmpDirAllocatedBytes": peak_tmp_alloc,
            "peakCombinedLogicalBytes": peak_combined_logical,
            "peakCombinedAllocatedBytes": peak_combined_alloc,
        },
        "hostBefore": host_before,
        "offlineSmoke": {
            "statusReady": st_data["ready"],
            "search0050Hits": len(s_data["hits"]),
        },
    }
    receipt_path = out_dir / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
