#!/usr/bin/env python3
"""Rerunnable Linux ARM64 container build, staging, and glibc/musl verification driver."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[5]
UNIT_DIR = pathlib.Path(__file__).resolve().parent
FIXTURES_DIR = UNIT_DIR / "fixtures"
CACHE_ROOT = REPO_ROOT / ".cache" / "phase6-linux-arm64"

PINNED_IMAGES = {
    "builder_rust": {
        "tag": "rust:1.89.0-alpine3.22",
        "ref": "rust@sha256:4b800f2e72e04be908e5f634c504c741bd943b763d1d8ad7b096cc340e1b5b46",
        "expectedPlatform": "linux/arm64",
    },
    "guest_glibc": {
        "tag": "node:22-bookworm-slim",
        "ref": "node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee",
        "expectedPlatform": "linux/arm64",
    },
    "guest_musl": {
        "tag": "node:22-alpine",
        "ref": "node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a",
        "expectedPlatform": "linux/arm64",
    },
}

CARGO_VOLUME = "clec-linux-arm64-cargo"


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def run_checked(cmd, cwd=None, capture=True):
    res = subprocess.run(cmd, cwd=cwd, text=True, capture_output=capture)
    if res.returncode != 0:
        raise RuntimeError(
            f"Command failed ({res.returncode}): {' '.join(cmd)}\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
        )
    return res


def ensure_dirs():
    for sub in ("logs", "logs/build", "logs/fixtures", "logs/glibc", "logs/musl", "receipts", "bin", "releases"):
        (CACHE_ROOT / sub).mkdir(parents=True, exist_ok=True)


def verify_pinned_images():
    info = {}
    for role, meta in PINNED_IMAGES.items():
        res = run_checked(["docker", "image", "inspect", meta["ref"]])
        insp = json.loads(res.stdout)[0]
        actual_platform = f"{insp.get('Os')}/{insp.get('Architecture')}"
        if actual_platform != meta["expectedPlatform"]:
            raise RuntimeError(f"Image {role} platform {actual_platform} != {meta['expectedPlatform']}")
        info[role] = {
            "tag": meta["tag"],
            "ref": meta["ref"],
            "id": insp["Id"],
            "repoDigests": insp.get("RepoDigests", []),
            "platform": actual_platform,
            "sizeBytes": insp.get("Size"),
        }
    return info


def unit_build():
    ensure_dirs()
    images_info = verify_pinned_images()

    src_export = CACHE_ROOT / "src-export"
    if src_export.exists():
        shutil.rmtree(src_export)
    run_checked(["python3", str(REPO_ROOT / "tools" / "export_cli.py"), str(src_export)])

    native_hashes = {}
    for p in sorted((src_export / "native").rglob("*")):
        if p.is_file():
            rel = p.relative_to(src_export).as_posix()
            native_hashes[rel] = sha256_file(p)

    repo_lock_sha = sha256_file(REPO_ROOT / "native" / "Cargo.lock")
    if native_hashes.get("native/Cargo.lock") != repo_lock_sha:
        raise RuntimeError("Exported Cargo.lock SHA-256 mismatch")

    run_checked(["docker", "volume", "create", CARGO_VOLUME])

    bin_dir = CACHE_ROOT / "bin"
    release_out = bin_dir / "release"
    if release_out.exists():
        shutil.rmtree(release_out)
    release_out.mkdir(parents=True, exist_ok=True)

    container_script = r"""
set -eu
apk add --no-cache musl-dev file >/tmp/apk.log 2>&1
uname -a
cat /etc/os-release
rustc --version --verbose
cargo --version
echo "===BUILD_START==="
cargo build --manifest-path /src/native/Cargo.toml --locked --release --bins -j 2
echo "===BUILD_DONE==="
for b in clec clec-publish clec-validate; do
  echo "===INSPECT:$b==="
  file "/work/target/release/$b"
  readelf -h "/work/target/release/$b"
  readelf -l "/work/target/release/$b"
  readelf -d "/work/target/release/$b" || true
  cp "/work/target/release/$b" "/out/release/$b"
done
echo "===TEST_START==="
apk add --no-cache openssl python3 >/tmp/apk-test.log 2>&1
cargo test --manifest-path /src/native/Cargo.toml --locked -j 2
echo "===TEST_DONE==="
"""
    cname = "clec-linux-arm64-builder"
    subprocess.run(["docker", "rm", "-f", cname], capture_output=True)

    docker_cmd = [
        "docker",
        "run",
        "--rm",
        "--name",
        cname,
        "--cpus",
        "2",
        "--memory",
        "4g",
        "-v",
        f"{src_export}:/src:ro",
        "-v",
        f"{CARGO_VOLUME}:/work:rw",
        "-v",
        f"{bin_dir}:/out:rw",
        "-e",
        "CARGO_HOME=/work/cargo-home",
        "-e",
        "CARGO_TARGET_DIR=/work/target",
        "-e",
        "CARGO_BUILD_JOBS=2",
        "-e",
        "CMAKE_BUILD_PARALLEL_LEVEL=2",
        PINNED_IMAGES["builder_rust"]["ref"],
        "sh",
        "-c",
        container_script,
    ]
    res = subprocess.run(docker_cmd, text=True, capture_output=True)
    (CACHE_ROOT / "logs" / "build" / "builder.stdout.log").write_text(res.stdout, encoding="utf-8")
    (CACHE_ROOT / "logs" / "build" / "builder.stderr.log").write_text(res.stderr, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"Builder container failed ({res.returncode}); see logs/build/builder.stderr.log")

    elf_checks = {}
    for b in ("clec", "clec-publish", "clec-validate"):
        bpath = release_out / b
        if not bpath.is_file():
            raise RuntimeError(f"Missing built binary: {bpath}")
        inspect_res = run_checked(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--name",
                f"clec-linux-arm64-elfcheck-{b}",
                "-v",
                f"{release_out}:/bins:ro",
                PINNED_IMAGES["builder_rust"]["ref"],
                "sh",
                "-c",
                f"readelf -h -l -d /bins/{b}",
            ]
        )
        elf_text = inspect_res.stdout + inspect_res.stderr
        (CACHE_ROOT / "logs" / "build" / f"readelf-{b}.log").write_text(elf_text, encoding="utf-8")
        if "ELF64" not in elf_text or "AArch64" not in elf_text:
            raise RuntimeError(f"{b} is not ELF64 AArch64")
        if "INTERP" in elf_text or "Requesting program interpreter" in elf_text:
            raise RuntimeError(f"{b} contains PT_INTERP")
        if "NEEDED" in elf_text:
            raise RuntimeError(f"{b} contains dynamic NEEDED entries")
        elf_checks[b] = {
            "bytes": bpath.stat().st_size,
            "sha256": sha256_file(bpath),
            "elf64Aarch64": True,
            "ptInterpAbsent": True,
            "neededAbsent": True,
        }

    test_results = re.findall(r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored", res.stdout)
    total_passed = sum(int(m[0]) for m in test_results)
    total_failed = sum(int(m[1]) for m in test_results)
    if total_failed != 0 or total_passed == 0:
        raise RuntimeError(f"Unexpected container cargo test summary: {test_results}")

    git_head = run_checked(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"]).stdout.strip()
    native_commit = run_checked(["git", "-C", str(REPO_ROOT), "log", "-n", "1", "--format=%H", "--", "native/"]).stdout.strip()

    obs = {
        "schemaVersion": 1,
        "observationKind": "clec-container-build-observation",
        "gitHead": git_head,
        "nativeTreeCommit": native_commit,
        "sourceMount": "read-only 38-file export from tools/export_cli.py",
        "cargoLockSha256": repo_lock_sha,
        "nativeInputFileSha256": native_hashes,
        "builderImage": images_info["builder_rust"],
        "containerArgs": [
            "--cpus 2",
            "--memory 4g",
            "CARGO_BUILD_JOBS=2",
            "CMAKE_BUILD_PARALLEL_LEVEL=2",
            "-v src-export:/src:ro",
        ],
        "executedCargoBuild": "cargo build --manifest-path /src/native/Cargo.toml --locked --release --bins -j 2",
        "executedCargoTest": "cargo test --manifest-path /src/native/Cargo.toml --locked -j 2",
        "containerCargoTestSuites": len(test_results),
        "containerCargoTestPassed": total_passed,
        "containerCargoTestFailed": total_failed,
        "binaries": elf_checks,
        "logs": {
            "stdout": ".cache/phase6-linux-arm64/logs/build/builder.stdout.log",
            "stderr": ".cache/phase6-linux-arm64/logs/build/builder.stderr.log",
        },
    }
    (CACHE_ROOT / "receipts" / "container-build-observation.json").write_text(
        json.dumps(obs, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"unit": "build", "binaries": elf_checks, "testsPassed": total_passed}, indent=2))


def unit_stage():
    ensure_dirs()
    receipt_path = CACHE_ROOT / "receipts" / "linux-arm64-prebuilt-receipt.json"
    run_checked(
        [
            "node",
            str(REPO_ROOT / "cli" / "scripts" / "build-receipt.mjs"),
            "--tuple",
            "linux-arm64",
            "--target-dir",
            str(CACHE_ROOT / "bin"),
            "--cargo-lock",
            str(REPO_ROOT / "native" / "Cargo.lock"),
            "--host-baseline",
            "linux-arm64-alpine-3.22-container",
            "--build-command",
            "cargo build --manifest-path /src/native/Cargo.toml --locked --release --bins -j 2",
            "--out",
            str(receipt_path),
        ]
    )
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt["receiptKind"] != "clec-inspected-prebuilt-receipt":
        raise RuntimeError(f"Expected inspected-prebuilt receipt, got {receipt['receiptKind']}")
    if receipt["provenance"]["source"]["status"] != "not_verified_unknown":
        raise RuntimeError("Receipt provenance.source must remain not_verified_unknown")

    stage_input_path = CACHE_ROOT / "receipts" / "stage-input-linux-arm64.json"
    stage_input = {
        "targets": {
            "linux-arm64": {
                "clec": str(CACHE_ROOT / "bin" / "release" / "clec"),
                "clecPublish": str(CACHE_ROOT / "bin" / "release" / "clec-publish"),
                "clecValidate": str(CACHE_ROOT / "bin" / "release" / "clec-validate"),
                "buildReceipt": str(receipt_path),
                "executionEvidence": "verified-linux-arm64-container-pending",
            }
        }
    }
    stage_input_path.write_text(json.dumps(stage_input, indent=2) + "\n", encoding="utf-8")

    staged_results = []
    for idx in (1, 2):
        out_dir = CACHE_ROOT / f"staged-{idx}"
        if out_dir.exists():
            shutil.rmtree(out_dir)
        res = run_checked(
            [
                "node",
                str(REPO_ROOT / "cli" / "scripts" / "stage.mjs"),
                "--input",
                str(stage_input_path),
                "--output",
                str(out_dir),
                "--allow-partial",
                "--cargo-lock",
                str(REPO_ROOT / "native" / "Cargo.lock"),
            ]
        )
        staged_results.append(json.loads(res.stdout))

    sums1 = sha256_file(CACHE_ROOT / "staged-1" / "SHA256SUMS")
    sums2 = sha256_file(CACHE_ROOT / "staged-2" / "SHA256SUMS")
    if sums1 != sums2:
        raise RuntimeError(f"Non-deterministic staging SHA256SUMS: {sums1} != {sums2}")

    inv = json.loads((CACHE_ROOT / "staged-1" / "inventory.json").read_text(encoding="utf-8"))
    prov = json.loads((CACHE_ROOT / "staged-1" / "provenance.json").read_text(encoding="utf-8"))
    if inv["complete"] is not False or inv["publishable"] is not False:
        raise RuntimeError("Partial inventory must mark complete=false, publishable=false")
    if prov["provenanceClassification"] != "inspected-prebuilt":
        raise RuntimeError("Expected inspected-prebuilt provenance classification")

    # Verify SKILL.md and README.md byte equality inside npm tarball and consumer archive
    inspect_tmp = CACHE_ROOT / "stage-inspect-tmp"
    if inspect_tmp.exists():
        shutil.rmtree(inspect_tmp)
    inspect_tmp.mkdir(parents=True)
    run_checked(["tar", "-xzf", str(CACHE_ROOT / "staged-1" / "clec-cli-1.0.0-dev.0.tgz"), "-C", str(inspect_tmp)])
    run_checked(["tar", "-xzf", str(CACHE_ROOT / "staged-1" / "clec-v1.0.0-dev.0-linux-arm64.tar.gz"), "-C", str(inspect_tmp)])

    src_skill = sha256_file(REPO_ROOT / "cli" / "skills" / "clec" / "SKILL.md")
    src_readme = sha256_file(REPO_ROOT / "cli" / "README.md")
    for p in (
        inspect_tmp / "package" / "skills" / "clec" / "SKILL.md",
        inspect_tmp / "clec-v1.0.0-dev.0-linux-arm64" / "skills" / "clec" / "SKILL.md",
    ):
        if sha256_file(p) != src_skill:
            raise RuntimeError(f"Skill SHA-256 mismatch in {p}")
    for p in (
        inspect_tmp / "package" / "README.md",
        inspect_tmp / "clec-v1.0.0-dev.0-linux-arm64" / "README.md",
    ):
        if sha256_file(p) != src_readme:
            raise RuntimeError(f"README SHA-256 mismatch in {p}")
    shutil.rmtree(inspect_tmp)

    summary = {
        "unit": "stage",
        "sha256sumsSha256": sums1,
        "deterministic": True,
        "complete": inv["complete"],
        "publishable": inv["publishable"],
        "skillSha256": src_skill,
        "readmeSha256": src_readme,
        "artifacts": staged_results[0]["artifacts"],
    }
    (CACHE_ROOT / "receipts" / "staging-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


def unit_fixtures():
    ensure_dirs()
    maint_dir = CACHE_ROOT / "maintainer-bin"
    if maint_dir.exists():
        shutil.rmtree(maint_dir)
    maint_dir.mkdir(parents=True)
    run_checked(
        [
            "tar",
            "-xzf",
            str(CACHE_ROOT / "staged-1" / "clec-maintainer-v1.0.0-dev.0-linux-arm64.tar.gz"),
            "-C",
            str(maint_dir),
        ]
    )
    cons_dir = CACHE_ROOT / "consumer-bin"
    if cons_dir.exists():
        shutil.rmtree(cons_dir)
    cons_dir.mkdir(parents=True)
    run_checked(
        [
            "tar",
            "-xzf",
            str(CACHE_ROOT / "staged-1" / "clec-v1.0.0-dev.0-linux-arm64.tar.gz"),
            "-C",
            str(cons_dir),
        ]
    )

    rel_dir = CACHE_ROOT / "releases"
    for sub in ("release-a", "release-b", "release-b-corrupt"):
        p = rel_dir / sub
        if p.exists():
            shutil.rmtree(p)

    maint_inner = f"/maintainer/clec-maintainer-v1.0.0-dev.0-linux-arm64"
    cons_inner = f"/consumer/clec-v1.0.0-dev.0-linux-arm64"
    script = f"""
set -eu
{maint_inner}/clec-publish --workspace /fixtures/release-a/workspace --intake /fixtures/release-a/intake.json --output /releases/release-a >/tmp/pub-a.json
{maint_inner}/clec-publish --workspace /fixtures/release-b/workspace --intake /fixtures/release-b/intake.json --output /releases/release-b >/tmp/pub-b.json
{cons_inner}/clec --offline --data-dir /tmp/val-data-a sync --manifest /releases/release-a/manifest.json >/tmp/sync-a.json
{cons_inner}/clec --offline --data-dir /tmp/val-data-b sync --manifest /releases/release-b/manifest.json >/tmp/sync-b.json
{maint_inner}/clec-validate --identity --out /releases/validator-identity.json >/dev/null
{maint_inner}/clec-validate --db /tmp/val-data-a/*.sqlite --out /releases/validate-a.json >/dev/null
{maint_inner}/clec-validate --db /tmp/val-data-b/*.sqlite --out /releases/validate-b.json >/dev/null
cp /tmp/pub-a.json /releases/publish-a.json
cp /tmp/pub-b.json /releases/publish-b.json
"""
    res = run_checked(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            "/tmp:exec,rw,nosuid,size=128m",
            "--cpus",
            "2",
            "--memory",
            "1g",
            "--name",
            "clec-linux-arm64-publish",
            "-v",
            f"{maint_dir}:/maintainer:ro",
            "-v",
            f"{cons_dir}:/consumer:ro",
            "-v",
            f"{FIXTURES_DIR}:/fixtures:ro",
            "-v",
            f"{rel_dir}:/releases:rw",
            PINNED_IMAGES["guest_musl"]["ref"],
            "sh",
            "-c",
            script,
        ]
    )
    (CACHE_ROOT / "logs" / "fixtures" / "publish.log").write_text(res.stdout + res.stderr, encoding="utf-8")

    # Create corrupt release-b copy (tampered corpus.sqlite.zst)
    corrupt_dir = rel_dir / "release-b-corrupt"
    shutil.copytree(rel_dir / "release-b", corrupt_dir)
    zst_path = corrupt_dir / "corpus.sqlite.zst"
    zbytes = bytearray(zst_path.read_bytes())
    zbytes[12] ^= 0xFF
    zst_path.write_bytes(bytes(zbytes))

    val_a = json.loads((rel_dir / "validate-a.json").read_text(encoding="utf-8"))
    val_b = json.loads((rel_dir / "validate-b.json").read_text(encoding="utf-8"))
    if not val_a.get("valid") or not val_b.get("valid"):
        raise RuntimeError("Linux clec-validate failed on authored fixture snapshots")

    print(
        json.dumps(
            {
                "unit": "fixtures",
                "releaseASha256": val_a["dbSha256"],
                "releaseBSha256": val_b["dbSha256"],
                "releaseACounts": val_a["counts"],
                "releaseBCounts": val_b["counts"],
            },
            indent=2,
        )
    )


def unit_guests():
    ensure_dirs()
    clec_sha = sha256_file(CACHE_ROOT / "bin" / "release" / "clec")
    skill_sha = sha256_file(REPO_ROOT / "cli" / "skills" / "clec" / "SKILL.md")
    readme_sha = sha256_file(REPO_ROOT / "cli" / "README.md")

    guest_script = UNIT_DIR / "guest_verify.mjs"
    receipts = {}
    for libc_label, img_role in (("glibc", "guest_glibc"), ("musl", "guest_musl")):
        out_dir = CACHE_ROOT / "logs" / libc_label
        if out_dir.exists():
            shutil.rmtree(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            "/tmp:exec,rw,nosuid,size=256m",
            "--cpus",
            "2",
            "--memory",
            "1g",
            "--name",
            f"clec-linux-arm64-guest-{libc_label}",
            "-v",
            f"{CACHE_ROOT / 'staged-1'}:/staged:ro",
            "-v",
            f"{CACHE_ROOT / 'releases'}:/releases:ro",
            "-v",
            f"{FIXTURES_DIR}:/fixtures:ro",
            "-v",
            f"{guest_script}:/verify/guest_verify.mjs:ro",
            "-v",
            f"{out_dir}:/out:rw",
            "-e",
            "HOME=/tmp/clec-home",
            "-e",
            f"CLEC_LIBC_LABEL={libc_label}",
            "-e",
            f"CLEC_EXPECTED_SHA256={clec_sha}",
            "-e",
            f"CLEC_SKILL_SHA256={skill_sha}",
            "-e",
            f"CLEC_README_SHA256={readme_sha}",
            PINNED_IMAGES[img_role]["ref"],
            "sh",
            "-c",
            "mkdir -p /tmp/clec-home && node /verify/guest_verify.mjs",
        ]
        res = subprocess.run(cmd, text=True, capture_output=True)
        (out_dir / "runner.stdout.log").write_text(res.stdout, encoding="utf-8")
        (out_dir / "runner.stderr.log").write_text(res.stderr, encoding="utf-8")
        if res.returncode != 0:
            raise RuntimeError(
                f"Guest {libc_label} verification failed ({res.returncode}):\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
            )
        receipts[libc_label] = json.loads((out_dir / "guest-receipt.json").read_text(encoding="utf-8"))

    if receipts["glibc"]["installedBinarySha256"] != receipts["musl"]["installedBinarySha256"]:
        raise RuntimeError("Installed static binary SHA-256 differs between glibc and musl guests")
    print(json.dumps({"unit": "guests", "glibc": "PASS", "musl": "PASS", "sha256": clec_sha}, indent=2))


def unit_cleanup():
    # Remove only task-owned containers, volume, and regenerable intermediate dirs after retaining binaries/logs/receipts/staged outputs
    ps = run_checked(["docker", "ps", "-a", "--format", "{{.Names}}"]).stdout.splitlines()
    removed_containers = []
    for name in ps:
        if name.startswith("clec-linux-arm64-"):
            run_checked(["docker", "rm", "-f", name])
            removed_containers.append(name)

    vols = run_checked(["docker", "volume", "ls", "--format", "{{.Name}}"]).stdout.splitlines()
    removed_volumes = []
    if CARGO_VOLUME in vols:
        run_checked(["docker", "volume", "rm", CARGO_VOLUME])
        removed_volumes.append(CARGO_VOLUME)

    removed_dirs = []
    for sub in ("src-export", "maintainer-bin", "consumer-bin", "docker-cfg"):
        p = CACHE_ROOT / sub
        if p.exists():
            shutil.rmtree(p)
            removed_dirs.append(str(p.relative_to(REPO_ROOT)))

    summary = {
        "unit": "cleanup",
        "removedContainers": removed_containers,
        "removedVolumes": removed_volumes,
        "removedTempDirs": removed_dirs,
    }
    (CACHE_ROOT / "receipts" / "cleanup.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--unit",
        choices=["build", "stage", "fixtures", "guests", "cleanup", "all"],
        default="all",
    )
    args = parser.parse_args()
    if args.unit == "build":
        unit_build()
    elif args.unit == "stage":
        unit_stage()
    elif args.unit == "fixtures":
        unit_fixtures()
    elif args.unit == "guests":
        unit_guests()
    elif args.unit == "cleanup":
        unit_cleanup()
    else:
        unit_build()
        unit_stage()
        unit_fixtures()
        unit_guests()
        unit_cleanup()


if __name__ == "__main__":
    main()
