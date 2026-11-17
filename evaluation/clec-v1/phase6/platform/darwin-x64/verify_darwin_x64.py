#!/usr/bin/env python3
"""Rerunnable darwin-x64 Rosetta build, staging, and CLI verification driver."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[5]
UNIT_DIR = pathlib.Path(__file__).resolve().parent
SHARED_FIXTURES_DIR = REPO_ROOT / "evaluation" / "clec-v1" / "phase6" / "platform" / "linux-arm64" / "fixtures"
UNIVERSAL_NODE = pathlib.Path("/usr/local/bin/node")
NPM_CLI_JS = pathlib.Path("/usr/local/lib/node_modules/npm/bin/npm-cli.js")
MIN_RESERVE_KIB = 2 * 1024 * 1024
STOP_MARGIN_KIB = 256 * 1024
BASE = "9a0124487f3fca68e99376646c28ed47874d0c13"
TARGET = "x86_64-apple-darwin"
RUNS_DIR = REPO_ROOT / ".cache" / "phase6-darwin-x64-runs"
AUDIT = REPO_ROOT / ".audit" / "phase6-darwin-x64.tsv"


def fresh_root(parent):
    parent.mkdir(parents=True, exist_ok=True)
    return pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=parent))


def write_json(path, value):
    with path.open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")


def audit(root, phase, result):
    AUDIT.parent.mkdir(exist_ok=True)
    try:
        with AUDIT.open("x") as file:
            file.write("utc_timestamp\tunit\tdecision_or_action\twhy\tevidence\tresult\n")
    except FileExistsError:
        pass
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with AUDIT.open("a") as file:
        file.write(f"{stamp}\t{phase}\trun_phase\tretain exclusive evidence\t{root}\t{result}\n")


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def check_disk_reserve(path: pathlib.Path) -> int:
    res = subprocess.run(["df", "-k", str(path)], text=True, capture_output=True, check=True)
    lines = res.stdout.strip().splitlines()
    avail_kib = int(lines[-1].split()[3])
    if avail_kib < MIN_RESERVE_KIB:
        raise RuntimeError(f"Disk reserve breached: avail={avail_kib} KiB < {MIN_RESERVE_KIB} KiB")
    return avail_kib


def run_checked(cmd, *, cwd=REPO_ROOT, env=None, timeout=1800, log_stem=None):
    if log_stem is None:
        return subprocess.run(cmd, cwd=cwd, env=env, text=True, capture_output=True,
                              timeout=timeout, check=True)

    stdout_path = log_stem.with_suffix(".stdout")
    stderr_path = log_stem.with_suffix(".stderr")
    meta = {"argv": cmd, "cwd": str(cwd)}
    with stdout_path.open("x") as stdout, stderr_path.open("x") as stderr:
        with subprocess.Popen(cmd, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                              start_new_session=True) as child:
            started = time.monotonic()
            try:
                while child.poll() is None:
                    free_kib = check_disk_reserve(log_stem.parent)
                    meta["lowestObservedAvailableKiB"] = min(
                        free_kib, meta.get("lowestObservedAvailableKiB", free_kib)
                    )
                    if free_kib < MIN_RESERVE_KIB + STOP_MARGIN_KIB:
                        raise RuntimeError(f"Disk reserve guard stopped command at {free_kib} KiB free")
                    if time.monotonic() - started > timeout:
                        raise TimeoutError(f"Command timed out after {timeout}s")
                    time.sleep(0.25)
            except BaseException as error:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                meta["error"] = str(error)
                raise
            finally:
                meta["returncode"] = child.wait()
                write_json(log_stem.with_suffix(".json"), meta)
    if meta["returncode"] != 0:
        raise RuntimeError(f"Command exited {meta['returncode']}: {cmd!r}. See {stderr_path}")
    return subprocess.CompletedProcess(cmd, 0, stdout_path.read_text(), stderr_path.read_text())


def unit_prepare(root):
    avail_kib = check_disk_reserve(root)
    uname_m = run_checked(["arch", "-x86_64", "/usr/bin/uname", "-m"]).stdout.strip()
    proc_trans = run_checked(["arch", "-x86_64", "/usr/sbin/sysctl", "-n", "sysctl.proc_translated"]).stdout.strip()
    if uname_m != "x86_64" or proc_trans != "1":
        raise RuntimeError(f"Unexpected Rosetta state: uname={uname_m}, proc_translated={proc_trans}")
    sdk_path = run_checked(["xcrun", "--show-sdk-path"]).stdout.strip()
    host_version = run_checked(["sw_vers"]).stdout.strip()
    sdk_version = run_checked(["xcrun", "--show-sdk-version"]).stdout.strip()
    rustc_verbose = run_checked(["rustc", "+1.89.0", "--version", "--verbose"]).stdout.strip()
    targets = run_checked(["rustup", "+1.89.0", "target", "list", "--installed"]).stdout.splitlines()
    if "x86_64-apple-darwin" not in targets:
        raise RuntimeError("x86_64-apple-darwin target not installed on rustup +1.89.0")

    thin_node = root / "x64-tools" / "node"
    run_checked(["lipo", "-thin", "x86_64", str(UNIVERSAL_NODE), "-output", str(thin_node)])
    thin_node.chmod(0o755)
    thin_lipo = run_checked(["lipo", "-info", str(thin_node)]).stdout.strip()
    probe = run_checked(
        ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", str(thin_node), "-p",
         "JSON.stringify({arch:process.arch,platform:process.platform,version:process.version,execPath:process.execPath})"]
    ).stdout.strip()

    probe = json.loads(probe)
    if (probe["platform"], probe["arch"]) != ("darwin", "x64"):
        raise RuntimeError(f"Expected native execution of thin x64 Node under Rosetta: {probe}")
    obs = {
        "availKiB": avail_kib,
        "rosettaUname": uname_m,
        "rosettaProcTranslated": proc_trans,
        "sdkPath": sdk_path,
        "sdkVersion": sdk_version,
        "hostVersion": host_version,
        "rustcVerbose": rustc_verbose,
        "installedTargets": targets,
        "universalNodePath": str(UNIVERSAL_NODE),
        "universalNodeSha256": sha256_file(UNIVERSAL_NODE),
        "thinNodePath": str(thin_node),
        "thinNodeSha256": sha256_file(thin_node),
        "thinNodeLipo": thin_lipo,
        "thinNodeProbe": probe,
        "npmCliJs": str(NPM_CLI_JS),
    }
    write_json(root / "receipts" / "env-observation.json", obs)


def unit_build(root):
    check_disk_reserve(root)
    src_export = root / "src-export"
    paths = ["native", "cli", "tools", ".github", "README.md", ".gitignore",
             str(SHARED_FIXTURES_DIR.relative_to(REPO_ROOT))]
    run_checked(["git", "diff", "--exit-code", BASE, "--", *paths])
    untracked = run_checked(["git", "ls-files", "--others", "--exclude-standard", "--", *paths]).stdout
    if untracked:
        raise RuntimeError(f"Unexpected untracked input files:\n{untracked}")
    source_commit = run_checked(["git", "rev-parse", "HEAD"]).stdout.strip()
    run_checked([sys.executable, str(REPO_ROOT / "tools" / "export_cli.py"), str(src_export)],
                log_stem=root / "logs" / "build" / "export")
    export_hashes = tree_hashes(src_export)
    target_dir = root / "target-x64"
    build_env = {
        "CARGO_TARGET_DIR": str(target_dir), "CARGO_INCREMENTAL": "0",
        "CARGO_PROFILE_TEST_DEBUG": "0", "CARGO_NET_OFFLINE": "true", "RUST_TEST_THREADS": "2",
    }
    env = dict(os.environ, **build_env)
    cargo = ["cargo", "+1.89.0"]
    common = ["--manifest-path", "native/Cargo.toml", "--locked", "--target", TARGET, "-j", "2"]
    build_argv = [*cargo, "build", *common, "--release", "--bins"]
    hook_argv = [*cargo, "build", *common, "--release", "--features", "test-hooks",
                 "--example", "clec_test_fixture"]
    write_json(root / "receipts" / "cargo-context.json", {
        "cwd": str(src_export), "overrides": build_env, "sourceCommit": source_commit,
        "exportSha256": export_hashes,
    })
    run_checked(build_argv, cwd=src_export, env=env, log_stem=root / "logs" / "build" / "cargo-release-bins")
    avail_after_release = check_disk_reserve(root)
    run_checked(hook_argv, cwd=src_export, env=env, log_stem=root / "logs" / "build" / "cargo-hook-fixture")
    release_src = target_dir / "x86_64-apple-darwin" / "release"
    retained_bins = {}
    for name in ("clec", "clec-publish", "clec-validate"):
        src = release_src / name
        dst = root / "bin" / "release" / name
        shutil.copy2(src, dst)
        dst.chmod(0o755)
        lipo = run_checked(["lipo", "-archs", str(dst)]).stdout.strip()
        header = run_checked(["otool", "-hv", str(dst)]).stdout.strip()
        libs = run_checked(["otool", "-L", str(dst)]).stdout.strip()
        deps = [line.strip().split(" (compatibility version")[0] for line in libs.splitlines()[1:]]
        if lipo != "x86_64" or not re.search(r"\bEXECUTE\b", header):
            raise RuntimeError(f"Expected thin x86_64 MH_EXECUTE: {dst}")
        if not deps or any(
            lib not in {"/usr/lib/libSystem.B.dylib", "/usr/lib/libiconv.2.dylib"}
            and not re.fullmatch(r"/System/Library/Frameworks/(Security|CoreFoundation)\.framework/Versions/[^/]+/\1", lib)
            for lib in deps
        ):
            raise RuntimeError(f"Unexpected dynamic dependencies: {deps}")
        retained_bins[name] = {
            "path": str(dst),
            "bytes": dst.stat().st_size,
            "sha256": sha256_file(dst),
            "file": run_checked(["file", str(dst)]).stdout.strip(),
            "lipo": run_checked(["lipo", "-info", str(dst)]).stdout.strip(),
            "otoolHv": header,
            "otoolL": libs,
            "otoolBuildVersion": run_checked(["otool", "-l", str(dst)]).stdout.strip(),
        }

    hook_dst = root / "bin" / "test-hooks" / "clec_test_fixture"
    shutil.copy2(release_src / "examples" / "clec_test_fixture", hook_dst)
    hook_dst.chmod(0o755)

    test_argv = [*cargo, "test", *common]
    test_norun_argv = [*test_argv, "--no-run", "--message-format=json"]
    norun_res = run_checked(test_norun_argv, cwd=src_export, env=env,
                            log_stem=root / "logs" / "tests" / "cargo-test-norun")
    test_exes = []
    for line in norun_res.stdout.splitlines():
        msg = json.loads(line)
        if msg.get("reason") == "compiler-artifact" and msg.get("profile", {}).get("test") and msg.get("executable"):
            exe = msg["executable"]
            arch = run_checked(["lipo", "-archs", exe]).stdout.strip()
            if arch != "x86_64":
                raise RuntimeError(f"Unexpected test executable arch {arch}: {exe}")
            test_exes.append({
                "path": exe,
                "sha256": sha256_file(pathlib.Path(exe)),
                "target": msg["target"]["name"],
                "lipo": run_checked(["lipo", "-info", exe]).stdout.strip(),
            })

    if not test_exes:
        raise RuntimeError("Cargo reported no x64 test executables")
    test_res = run_checked(test_argv, cwd=src_export, env=env, log_stem=root / "logs" / "tests" / "cargo-test-x64")
    avail_after_tests = check_disk_reserve(root)
    if tree_hashes(src_export) != export_hashes:
        raise RuntimeError("Exported inputs changed during compilation")
    obs = {
        "sourceCommit": source_commit,
        "baseline": BASE,
        "sdkPath": run_checked(["xcrun", "--show-sdk-path"]).stdout.strip(),
        "rustcVersion": run_checked(["rustc", "+1.89.0", "--version", "--verbose"]).stdout.strip(),
        "exportSha256": export_hashes,
        "cwd": str(src_export),
        "cargoEnvOverrides": build_env,
        "buildArgv": build_argv,
        "hookArgv": hook_argv,
        "testArgv": test_argv,
        "testExecutables": test_exes,
        "testSummaryLines": [ln for ln in test_res.stdout.splitlines() if ln.startswith("test result:")],
        "binaries": retained_bins,
        "hookFixture": {"path": str(hook_dst), "bytes": hook_dst.stat().st_size, "sha256": sha256_file(hook_dst)},
        "diskKiB": {
            "afterRelease": avail_after_release,
            "afterTests": avail_after_tests,
        },
    }
    write_json(root / "receipts" / "cross-build-observation.json", obs)
    shutil.rmtree(target_dir)
    write_json(root / "receipts" / "cleanup-receipt.json", {
        "removed": str(target_dir), "availableKiB": check_disk_reserve(root),
    })


def unit_stage(root):
    source = root / "src-export"
    cargo_lock = source / "native" / "Cargo.lock"
    node = str(root / "x64-tools" / "node")
    scripts = source / "cli" / "scripts"
    rel_dir = root / "bin" / "release"
    receipts = root / "receipts"
    logs = root / "logs" / "build"
    receipt_path = receipts / "darwin-x64-prebuilt-receipt.json"
    run_checked([
        node, str(scripts / "build-receipt.mjs"), "--tuple", "darwin-x64",
        "--clec", str(rel_dir / "clec"), "--clec-publish", str(rel_dir / "clec-publish"),
        "--clec-validate", str(rel_dir / "clec-validate"), "--toolchain", "1.89.0",
        "--cargo-lock", str(cargo_lock), "--host-baseline", "darwin-x64-rosetta-arm64-host",
        "--out", str(receipt_path),
    ], cwd=source, log_stem=logs / "build-receipt")
    receipt = json.loads(receipt_path.read_text())
    assert receipt["schemaVersion"] == 2
    assert receipt["receiptKind"] == "clec-inspected-prebuilt-receipt"
    for field in ("source", "buildInvocation"):
        assert receipt["provenance"][field]["status"] == "not_verified_unknown"
    embedded = receipt["verifiedEmbeddedMetadata"]
    assert embedded["rustcVersion"].startswith("rustc 1.89.0 ")
    assert embedded["cargoLockSha256"] == sha256_file(cargo_lock)
    assert embedded["profile"] == "release" and embedded["features"] == []
    assert embedded["testHooksIncluded"] is False
    for artifact in receipt["artifacts"].values():
        assert artifact["embeddedMetadata"]["target"] == TARGET
        assert artifact["sha256"] == sha256_file(rel_dir / artifact["binaryName"])

    stage_input = receipts / "stage-input.json"
    write_json(stage_input, {"targets": {"darwin-x64": {
        "clec": str(rel_dir / "clec"),
        "clecPublish": str(rel_dir / "clec-publish"),
        "clecValidate": str(rel_dir / "clec-validate"),
        "buildReceipt": str(receipt_path),
    }}})
    for index in (1, 2):
        run_checked([
            node, str(scripts / "stage.mjs"), "--input", str(stage_input),
            "--output", str(root / f"staged-{index}"), "--allow-partial", "--cargo-lock", str(cargo_lock),
        ], cwd=source, log_stem=logs / f"stage-{index}")
    staged = root / "staged-1"
    file_hashes = tree_hashes(staged)
    assert file_hashes == tree_hashes(root / "staged-2"), "Staging identical inputs changed artifact bytes"
    inv = json.loads((staged / "inventory.json").read_text())
    prov = json.loads((staged / "provenance.json").read_text())
    assert inv["complete"] is False and inv["publishable"] is False
    assert [name for name, entry in inv["targets"].items() if entry["status"] == "present"] == ["darwin-x64"]
    assert prov["provenanceClassification"] == "inspected-prebuilt"

    consumer = "clec-v1.0.0-dev.0-darwin-x64"
    for name, prefix in (("clec-cli-1.0.0-dev.0.tgz", "package"), (consumer + ".tar.gz", consumer)):
        with tarfile.open(staged / name, "r:gz") as archive:
            for path in ("skills/clec/SKILL.md", "README.md", "NOTICES.md"):
                packaged = archive.extractfile(f"{prefix}/{path}").read()
                assert packaged == (source / "cli" / path).read_bytes()
            assert not any("clec_test_fixture" in member.name for member in archive)
    write_json(receipts / "stage-summary.json", {
        "complete": inv["complete"],
        "publishable": inv["publishable"],
        "provenanceClassification": prov["provenanceClassification"],
        "stagedFiles": {
            name: {"bytes": (staged / name).stat().st_size, "sha256": digest}
            for name, digest in file_hashes.items()
        },
    })


def unit_fixtures(root):
    fixtures = root / "fixtures"
    shutil.copytree(SHARED_FIXTURES_DIR, fixtures)
    bins = root / "bin" / "release"
    releases = root / "releases"
    logs = root / "logs" / "fixtures"
    env = {"PATH": str(root / "absent-path")}
    for name in ("release-a", "release-b"):
        snapshot = releases / name
        local = root / f"validate-{name}"
        run_checked([
            str(bins / "clec-publish"), "--workspace", str(fixtures / name / "workspace"),
            "--intake", str(fixtures / name / "intake.json"), "--output", str(snapshot),
        ], cwd=root, env=env, log_stem=logs / f"publish-{name}")
        actual = run_checked([
            str(bins / "clec"), "--offline", "--data-dir", str(local), "sync",
            "--manifest", str(snapshot / "manifest.json"),
        ], cwd=root, env=env, log_stem=logs / f"sync-{name}")
        digest = json.loads(actual.stdout)["data"]["release"]
        report = root / "receipts" / f"validate-{name}.json"
        run_checked([
            str(bins / "clec-validate"), "--db", str(local / f"{digest}.sqlite"),
            "--out", str(report),
        ], cwd=root, env=env, log_stem=logs / f"validate-{name}")
        validated = json.loads(report.read_text())
        assert validated["valid"] is True and validated["dbSha256"] == digest
    corrupt = releases / "release-b-corrupt"
    shutil.copytree(releases / "release-b", corrupt)
    manifest_path = corrupt / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


def unit_verify(root):
    public_inputs = {directory: tree_hashes(directory) for directory in (
        SHARED_FIXTURES_DIR, root / "fixtures", root / "releases",
    )}
    assert public_inputs[SHARED_FIXTURES_DIR] == public_inputs[root / "fixtures"]
    tools = root / "x64-tools"
    run_checked(
        [str(tools / "node"), str(UNIT_DIR / "verify_x64_cli.mjs"), str(root)],
        cwd=root, env={"PATH": f"{tools}:/usr/bin:/bin"}, log_stem=root / "logs" / "cli" / "runner",
    )
    for directory, hashes in public_inputs.items():
        assert tree_hashes(directory) == hashes, f"Fixture bytes changed: {directory}"
    write_json(root / "receipts" / "fixture-inputs.json", {
        str(path): hashes for path, hashes in public_inputs.items()
    })


def tree_hashes(directory):
    return {
        file.relative_to(directory).as_posix(): sha256_file(file)
        for file in sorted(directory.rglob("*")) if file.is_file()
    }


def interrupt(signum, _):
    raise InterruptedError(f"Received {signal.Signals(signum).name}")


def main():
    if not __debug__:
        raise RuntimeError("Run without Python optimization to enable assertions")
    signal.signal(signal.SIGTERM, interrupt)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    root = fresh_root(RUNS_DIR)
    print(f"RUN_ROOT={root}", flush=True)
    for folder in ("logs/build", "logs/tests", "logs/fixtures", "logs/cli", "receipts",
                   "bin/release", "bin/test-hooks", "x64-tools", "releases"):
        (root / folder).mkdir(parents=True)
    write_json(root / "run.json", {
        "root": str(root), "target": TARGET, "baseline": BASE,
        "verifierSha256": {name: sha256_file(UNIT_DIR / name)
                           for name in ("verify_darwin_x64.py", "verify_x64_cli.mjs")},
    })
    for phase in (unit_prepare, unit_build, unit_stage, unit_fixtures, unit_verify):
        name = phase.__name__.removeprefix("unit_")
        audit(root, name, "started")
        try:
            phase(root)
        except BaseException:
            audit(root, name, "failed")
            raise
        audit(root, name, "passed")
    print(f"PASS {root}", flush=True)


if __name__ == "__main__":
    main()
