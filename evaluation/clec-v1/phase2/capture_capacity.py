#!/usr/bin/env python3
"""Rerunnable single-run capacity feasibility capture for clec-publish and clec sync."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any


POSTING_RECORD_HEADER_BYTES = 15
FIXED_COMPONENT_ALLOWANCE_BYTES = 65536
UNCOVERED_STORAGE_OVERHEADS = (
    "sqlite_wal_shm_and_rollback_journals",
    "sqlite_temp_btree_and_sort_spill_files",
    "filesystem_block_allocation_slack",
    "filesystem_inodes_and_directory_metadata",
    "os_and_runtime_temp_buffers",
)

DEFAULT_BASELINE_FILES = (
    "collection/sources/drive/archive-transcripts-manifest.jsonl",
    "collection/sources/drive/text-manifest.json",
    "collection/sources/drive/nested-text-manifest.json",
    "collection/sources/drive/deep-text-manifest.json",
    "collection/web/clectw/episode-inventory.jsonl",
    "collection/web/clectw/manifest.jsonl",
    "collection/web/clectw/transcript-quality-audit.jsonl",
    "collection/web/clec168/manifest.jsonl",
    "collection/web/cfnavi/manifest.jsonl",
    "collection/text/local/manifest.json",
    "collection/text/local/spreadsheets-manifest.json",
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def estimate_posting_buckets_bytes(posting_count: int, total_term_bytes: int) -> int:
    return int(posting_count) * POSTING_RECORD_HEADER_BYTES + int(total_term_bytes)


def dir_usage_and_entries(root: Path) -> tuple[int, int, list[str]]:
    if not root.exists():
        return 0, 0, []
    logical_total = 0
    allocated_total = 0
    names: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if current == root:
                                names.append(entry.name)
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            if current == root:
                                names.append(entry.name)
                            st = entry.stat(follow_symlinks=False)
                            logical_total += st.st_size
                            blocks = getattr(st, "st_blocks", None)
                            allocated_total += (blocks * 512) if blocks is not None else st.st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return logical_total, allocated_total, sorted(names)


def parse_time_output(stderr_text: str, system_name: str) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    if system_name == "Darwin":
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
    else:
        rss_m = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", stderr_text)
        if rss_m:
            parsed["maxRssBytes"] = int(rss_m.group(1)) * 1024
        user_m = re.search(r"User time \(seconds\):\s*([0-9.]+)", stderr_text)
        sys_m = re.search(r"System time \(seconds\):\s*([0-9.]+)", stderr_text)
        if user_m:
            parsed["userSeconds"] = float(user_m.group(1))
        if sys_m:
            parsed["sysSeconds"] = float(sys_m.group(1))
    return parsed


def host_resources(target_path: Path) -> dict[str, Any]:
    system_name = platform.system()
    phys_ram: int | None = None
    if system_name == "Darwin":
        out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, check=True).stdout.strip()
        phys_ram = int(out)
    elif Path("/proc/meminfo").is_file():
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                phys_ram = int(line.split()[1]) * 1024
                break
    vfs = os.statvfs(target_path)
    free_bytes = vfs.f_frsize * vfs.f_bavail
    total_bytes = vfs.f_frsize * vfs.f_blocks
    load_avg = os.getloadavg() if hasattr(os, "getloadavg") else None
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "physicalRamBytes": phys_ram,
        "diskTotalBytes": total_bytes,
        "diskFreeBytes": free_bytes,
        "loadAverage1m5m15m": list(load_avg) if load_avg else None,
    }


def _classify_transient_entry(name: str) -> str | None:
    if name.startswith(".clec-fts-"):
        return name.split(".")[1]
    if ".building." in name and name.startswith("."):
        return ".building"
    if name in (".incoming.sqlite.tmp", ".active.tmp"):
        return name
    if name.endswith(("-wal", "-shm", "-journal")) or name.startswith("etilqs_"):
        return name
    return None


def run_measured(
    *,
    label: str,
    argv: list[str],
    target_dir: Path,
    tmpdir: Path,
    time_log_path: Path,
    sample_interval: float,
) -> dict[str, Any]:
    target_dir.mkdir(parents=True, exist_ok=True)
    tmpdir.mkdir(parents=True, exist_ok=True)

    baseline_target_log, baseline_target_alloc, _ = dir_usage_and_entries(target_dir)
    baseline_tmp_log, baseline_tmp_alloc, _ = dir_usage_and_entries(tmpdir)
    baseline_combined_log = baseline_target_log + baseline_tmp_log
    baseline_combined_alloc = baseline_target_alloc + baseline_tmp_alloc

    system_name = platform.system()
    time_bin = Path("/usr/bin/time")
    if system_name == "Darwin":
        wrapped = [str(time_bin), "-l", *argv]
    else:
        wrapped = [str(time_bin), "-v", *argv]

    env = {
        k: v
        for k, v in os.environ.items()
        if not any(tok in k.upper() for tok in ("API_KEY", "TOKEN", "SECRET"))
    }
    tmp_str = str(tmpdir)
    env["TMPDIR"] = tmp_str
    env["SQLITE_TMPDIR"] = tmp_str
    env["TEMP"] = tmp_str
    env["TMP"] = tmp_str

    stats: dict[str, Any] = {
        "sampleCount": 0,
        "maxTargetLogicalBytes": baseline_target_log,
        "maxTargetAllocatedBytes": baseline_target_alloc,
        "maxTmpdirLogicalBytes": baseline_tmp_log,
        "maxTmpdirAllocatedBytes": baseline_tmp_alloc,
        "maxCombinedLogicalBytes": baseline_combined_log,
        "maxCombinedAllocatedBytes": baseline_combined_alloc,
        "maxSampleTargetEntries": [],
        "maxSampleTmpdirEntries": [],
    }
    observed_prefixes: set[str] = set()
    stop_event = threading.Event()

    def record_sample(t_log: int, t_alloc: int, t_entries: list[str], tmp_log: int, tmp_alloc: int, tmp_entries: list[str]) -> None:
        combined_log = t_log + tmp_log
        combined_alloc = t_alloc + tmp_alloc
        for name in t_entries + tmp_entries:
            tag = _classify_transient_entry(name)
            if tag:
                observed_prefixes.add(tag)
        if t_log > stats["maxTargetLogicalBytes"]:
            stats["maxTargetLogicalBytes"] = t_log
        if t_alloc > stats["maxTargetAllocatedBytes"]:
            stats["maxTargetAllocatedBytes"] = t_alloc
        if tmp_log > stats["maxTmpdirLogicalBytes"]:
            stats["maxTmpdirLogicalBytes"] = tmp_log
        if tmp_alloc > stats["maxTmpdirAllocatedBytes"]:
            stats["maxTmpdirAllocatedBytes"] = tmp_alloc
        if combined_log >= stats["maxCombinedLogicalBytes"]:
            stats["maxCombinedLogicalBytes"] = combined_log
            stats["maxSampleTargetEntries"] = t_entries
            stats["maxSampleTmpdirEntries"] = tmp_entries
        if combined_alloc > stats["maxCombinedAllocatedBytes"]:
            stats["maxCombinedAllocatedBytes"] = combined_alloc

    def sampler() -> None:
        while True:
            t_log, t_alloc, t_entries = dir_usage_and_entries(target_dir)
            tmp_log, tmp_alloc, tmp_entries = dir_usage_and_entries(tmpdir)
            stats["sampleCount"] += 1
            record_sample(t_log, t_alloc, t_entries, tmp_log, tmp_alloc, tmp_entries)
            if stop_event.wait(sample_interval):
                break

    t_start = time.monotonic()
    thread = threading.Thread(target=sampler, daemon=True)
    thread.start()
    proc = subprocess.run(wrapped, capture_output=True, text=True, env=env)
    stop_event.set()
    thread.join(timeout=5.0)
    elapsed_monotonic = time.monotonic() - t_start

    final_t_log, final_t_alloc, final_t_entries = dir_usage_and_entries(target_dir)
    final_tmp_log, final_tmp_alloc, final_tmp_entries = dir_usage_and_entries(tmpdir)
    record_sample(final_t_log, final_t_alloc, final_t_entries, final_tmp_log, final_tmp_alloc, final_tmp_entries)

    time_log_path.parent.mkdir(parents=True, exist_ok=True)
    time_log_path.write_text(proc.stderr, encoding="utf-8")
    parsed_time = parse_time_output(proc.stderr, system_name)

    return {
        "label": label,
        "argv": argv,
        "exitCode": proc.returncode,
        "stdout": proc.stdout,
        "timeLogPath": str(time_log_path),
        "elapsedMonotonicSeconds": round(elapsed_monotonic, 3),
        "timeCommandMetrics": parsed_time,
        "diskSampling": {
            "measurementBasis": f"polled_{int(round(sample_interval * 1000))}ms_sampled_lower_bound",
            "note": (
                "Polled directory walk captures a sampled lower bound across owned target and temp roots "
                "(including journals and temp files); transients shorter than the sample interval may exceed the observed peak."
            ),
            "intervalSeconds": sample_interval,
            "sampleCount": stats["sampleCount"],
            "watchedRoots": [str(target_dir), str(tmpdir)],
            "envTempVars": {"TMPDIR": tmp_str, "SQLITE_TMPDIR": tmp_str, "TEMP": tmp_str, "TMP": tmp_str},
            "targetDir": str(target_dir),
            "tmpdir": str(tmpdir),
            "baselineTargetLogicalBytes": baseline_target_log,
            "baselineTargetAllocatedBytes": baseline_target_alloc,
            "baselineTmpdirLogicalBytes": baseline_tmp_log,
            "baselineTmpdirAllocatedBytes": baseline_tmp_alloc,
            "baselineCombinedLogicalBytes": baseline_combined_log,
            "baselineCombinedAllocatedBytes": baseline_combined_alloc,
            "finalTargetLogicalBytes": final_t_log,
            "finalTargetAllocatedBytes": final_t_alloc,
            "finalTmpdirLogicalBytes": final_tmp_log,
            "finalTmpdirAllocatedBytes": final_tmp_alloc,
            "finalCombinedLogicalBytes": final_t_log + final_tmp_log,
            "finalCombinedAllocatedBytes": final_t_alloc + final_tmp_alloc,
            "maxObservedTargetLogicalBytes": stats["maxTargetLogicalBytes"],
            "maxObservedTargetAllocatedBytes": stats["maxTargetAllocatedBytes"],
            "maxObservedTmpdirLogicalBytes": stats["maxTmpdirLogicalBytes"],
            "maxObservedTmpdirAllocatedBytes": stats["maxTmpdirAllocatedBytes"],
            "maxObservedCombinedLogicalBytes": stats["maxCombinedLogicalBytes"],
            "maxObservedCombinedAllocatedBytes": stats["maxCombinedAllocatedBytes"],
            "maxObservedTransientOverBaselineLogicalBytes": max(0, stats["maxCombinedLogicalBytes"] - baseline_combined_log),
            "maxObservedTransientOverFinalLogicalBytes": max(
                0, stats["maxCombinedLogicalBytes"] - (final_t_log + final_tmp_log)
            ),
            "peakSampleTargetEntries": stats["maxSampleTargetEntries"],
            "peakSampleTmpdirEntries": stats["maxSampleTmpdirEntries"],
            "observedTransientNames": sorted(observed_prefixes),
        },
    }


def compute_scoped_component_storage_estimate(
    db_path: Path, manifest: dict[str, Any], prior_sqlite_bytes: int = 0
) -> dict[str, Any]:
    sqlite_bytes = int(manifest["bytes"])
    zst_bytes = int(manifest["compressedBytes"])
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.execute("CREATE VIRTUAL TABLE temp.__v_cap USING fts5vocab(main, search, instance)")
        posting_count, total_term_bytes = conn.execute(
            "SELECT count(*), coalesce(sum(length(term)), 0) FROM temp.__v_cap"
        ).fetchone()
    single_posting_set_bytes = estimate_posting_buckets_bytes(int(posting_count), int(total_term_bytes))
    both_posting_sets_bytes = single_posting_set_bytes * 2
    publish_validate_phase = sqlite_bytes + both_posting_sets_bytes
    publish_compress_phase = sqlite_bytes + zst_bytes
    publish_component_peak = max(publish_validate_phase, publish_compress_phase) + FIXED_COMPONENT_ALLOWANCE_BYTES
    sync_component_peak = prior_sqlite_bytes + sqlite_bytes + both_posting_sets_bytes + FIXED_COMPONENT_ALLOWANCE_BYTES
    return {
        "scope": "scoped_component_estimate_only_not_full_filesystem_bound",
        "uncoveredOverheads": list(UNCOVERED_STORAGE_OVERHEADS),
        "fixedAllowanceBytes": FIXED_COMPONENT_ALLOWANCE_BYTES,
        "sqliteBytes": sqlite_bytes,
        "compressedZstBytes": zst_bytes,
        "ftsPostingCount": int(posting_count),
        "singlePostingBucketSetBytes": single_posting_set_bytes,
        "bothPostingBucketSetsBytes": both_posting_sets_bytes,
        "publishValidateComponentBytes": publish_validate_phase,
        "publishCompressComponentBytes": publish_compress_phase,
        "publishScopedComponentPeakBytes": publish_component_peak,
        "syncScopedComponentPeakBytes": sync_component_peak,
    }


def compute_workspace_hashes(workspace: Path, baseline_json: Path | None) -> tuple[dict[str, Any], bool]:
    if baseline_json is not None and baseline_json.is_file():
        expected = json.loads(baseline_json.read_text(encoding="utf-8"))
        mismatches = []
        actual = {}
        for rel, meta in sorted(expected.items()):
            p = workspace / rel
            if not p.is_file():
                mismatches.append({"path": rel, "reason": "missing"})
                continue
            digest = sha256_file(p)
            size = p.stat().st_size
            actual[rel] = {"bytes": size, "sha256": digest}
            if digest != meta["sha256"] or size != meta["bytes"]:
                mismatches.append({"path": rel, "expected": meta, "actual": actual[rel]})
        return {"checkedFiles": len(expected), "mismatches": mismatches}, len(mismatches) == 0

    actual = {}
    for rel in DEFAULT_BASELINE_FILES:
        p = workspace / rel
        if p.is_file():
            actual[rel] = {"bytes": p.stat().st_size, "sha256": sha256_file(p)}
    return {"checkedFiles": len(actual), "hashes": actual, "mismatches": []}, True


def main() -> int:
    parser = argparse.ArgumentParser(description="Single-run capacity feasibility capture for clec-publish and clec sync")
    parser.add_argument("--publish", required=True, type=Path, help="Path to release clec-publish binary")
    parser.add_argument("--clec", required=True, type=Path, help="Path to release clec binary")
    parser.add_argument("--workspace", required=True, type=Path, help="Read-only CLEC workspace")
    parser.add_argument("--intake", required=True, type=Path, help="Path to intake.json")
    parser.add_argument("--out-dir", required=True, type=Path, help="Isolated output directory under .cache/")
    parser.add_argument("--report", required=True, type=Path, help="JSON report output path")
    parser.add_argument("--baseline-json", type=Path, help="Optional input-baseline.json to verify immutable workspace hashes")
    parser.add_argument("--sample-interval-ms", type=int, default=50, help="Directory polling interval in ms (default 50)")
    parser.add_argument("--min-free-gib", type=float, default=6.0, help="Minimum required free disk GiB before running")
    parser.add_argument("--keep-artifacts", action="store_true", help="Keep built release and synced SQLite in out-dir")
    args = parser.parse_args()

    pub_bin = args.publish.resolve()
    clec_bin = args.clec.resolve()
    workspace = args.workspace.resolve()
    intake = args.intake.resolve()
    out_dir = args.out_dir.resolve()
    assert pub_bin.is_file(), f"missing clec-publish: {pub_bin}"
    assert clec_bin.is_file(), f"missing clec: {clec_bin}"
    assert workspace.is_dir(), f"missing workspace: {workspace}"
    assert intake.is_file(), f"missing intake: {intake}"
    if args.sample_interval_ms <= 0:
        raise SystemExit("--sample-interval-ms must be positive")

    out_dir.mkdir(parents=True, exist_ok=True)
    pre_host = host_resources(out_dir)
    min_free_bytes = int(args.min_free_gib * (1024**3))
    if pre_host["diskFreeBytes"] < min_free_bytes:
        raise SystemExit(f"Insufficient free disk space: {pre_host['diskFreeBytes']} B < {min_free_bytes} B")

    pre_hashes, pre_ok = compute_workspace_hashes(workspace, args.baseline_json)
    if not pre_ok:
        raise SystemExit(f"Workspace baseline hash mismatch before run: {pre_hashes['mismatches']}")

    run_root = out_dir
    pub_parent = run_root / "publish-target"
    release_dir = pub_parent / "release"
    pub_tmp = run_root / "tmp-publish"
    data_dir = run_root / "sync-data"
    sync_tmp = run_root / "tmp-sync"
    for d in (pub_parent, pub_tmp, data_dir, sync_tmp):
        if d.exists():
            shutil.rmtree(d)

    interval = args.sample_interval_ms / 1000.0
    pub_run = run_measured(
        label="clec-publish",
        argv=[str(pub_bin), "--workspace", str(workspace), "--intake", str(intake), "--output", str(release_dir)],
        target_dir=pub_parent,
        tmpdir=pub_tmp,
        time_log_path=run_root / "publish-time.log",
        sample_interval=interval,
    )
    if pub_run["exitCode"] != 0:
        raise SystemExit(f"clec-publish failed with exit {pub_run['exitCode']}")

    manifest_path = release_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    (run_root / "publish-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    sync_run = run_measured(
        label="clec-sync",
        argv=[str(clec_bin), "--data-dir", str(data_dir), "sync", "--manifest", str(manifest_path)],
        target_dir=data_dir,
        tmpdir=sync_tmp,
        time_log_path=run_root / "sync-time.log",
        sample_interval=interval,
    )
    if sync_run["exitCode"] != 0:
        raise SystemExit(f"clec sync failed with exit {sync_run['exitCode']}")

    sync_payload = json.loads(sync_run["stdout"])
    (run_root / "sync-output.json").write_text(json.dumps(sync_payload, indent=2) + "\n", encoding="utf-8")

    db_path = data_dir / f"{manifest['sha256']}.sqlite"
    scoped_estimate = compute_scoped_component_storage_estimate(db_path, manifest, prior_sqlite_bytes=0)

    post_hashes, post_ok = compute_workspace_hashes(workspace, args.baseline_json)
    if args.baseline_json is None:
        post_ok = post_hashes.get("hashes") == pre_hashes.get("hashes")
    post_host = host_resources(out_dir)

    if not args.keep_artifacts:
        shutil.rmtree(pub_parent, ignore_errors=True)
        shutil.rmtree(data_dir, ignore_errors=True)
        shutil.rmtree(pub_tmp, ignore_errors=True)
        shutil.rmtree(sync_tmp, ignore_errors=True)

    report = {
        "schemaVersion": 2,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurementNature": "single_run_capacity_feasibility_not_speed_benchmark",
        "hostFitVerdict": "verified_for_measured_run_on_local_host_not_universal_bound",
        "binaries": {
            "clec": {"path": str(clec_bin), "sha256": sha256_file(clec_bin)},
            "clecPublish": {"path": str(pub_bin), "sha256": sha256_file(pub_bin)},
        },
        "hostBefore": pre_host,
        "hostAfter": post_host,
        "manifest": manifest,
        "publish": {k: v for k, v in pub_run.items() if k != "stdout"},
        "sync": {k: v for k, v in sync_run.items() if k != "stdout"},
        "scopedComponentStorageEstimate": scoped_estimate,
        "workspaceBaselineUnchanged": post_ok,
        "workspaceBaselineCheck": post_hashes,
        "artifactsKept": args.keep_artifacts,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "release": manifest["sha256"],
                "counts": manifest["counts"],
                "publishMaxRssBytes": pub_run["timeCommandMetrics"].get("maxRssBytes"),
                "publishSampledLowerBoundLogicalBytes": pub_run["diskSampling"]["maxObservedCombinedLogicalBytes"],
                "publishSampledLowerBoundAllocatedBytes": pub_run["diskSampling"]["maxObservedCombinedAllocatedBytes"],
                "publishScopedComponentEstimateBytes": scoped_estimate["publishScopedComponentPeakBytes"],
                "syncMaxRssBytes": sync_run["timeCommandMetrics"].get("maxRssBytes"),
                "syncSampledLowerBoundLogicalBytes": sync_run["diskSampling"]["maxObservedCombinedLogicalBytes"],
                "syncSampledLowerBoundAllocatedBytes": sync_run["diskSampling"]["maxObservedCombinedAllocatedBytes"],
                "syncScopedComponentEstimateBytes": scoped_estimate["syncScopedComponentPeakBytes"],
                "workspaceBaselineUnchanged": post_ok,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if post_ok else 1


if __name__ == "__main__":
    sys.exit(main())
