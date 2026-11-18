#!/usr/bin/env python3
"""Rerunnable Linux container build, staging, and glibc/musl verification driver."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager
from dataclasses import dataclass

REPO_ROOT = pathlib.Path(__file__).resolve().parents[5]
UNIT_DIR = pathlib.Path(__file__).resolve().parent
FIXTURES_DIR = UNIT_DIR / "fixtures"
CACHE_ROOT = None
RUN = None


@dataclass(frozen=True)
class LinuxProfile:
    target_tuple: str
    platform: str
    rust_target: str
    elf_machine: str
    test_args: tuple[str, ...]
    images: dict[str, str]
    cargo_tmpfs_mib: int = 0


IMAGE_TAGS = {
    "builder_rust": "rust:1.89.0-alpine3.22",
    "guest_glibc": "node:22-bookworm-slim",
    "guest_musl": "node:22-alpine",
}
ARM64 = LinuxProfile(
    "linux-arm64", "linux/arm64", "aarch64-unknown-linux-musl", "AArch64", (),
    {
        "builder_rust": "rust@sha256:4b800f2e72e04be908e5f634c504c741bd943b763d1d8ad7b096cc340e1b5b46",
        "guest_glibc": "node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee",
        "guest_musl": "node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a",
    },
)
X64 = LinuxProfile(
    "linux-x64", "linux/amd64", "x86_64-unknown-linux-musl", "Advanced Micro Devices X86-64", ("--release",),
    {
        "builder_rust": "docker.io/library/rust@sha256:f9617326395be71547efa3c8b8d58b89ff958afc594596713bceb585aabc067e",
        "guest_glibc": "docker.io/library/node@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc",
        "guest_musl": "docker.io/library/node@sha256:12f54cafa58d0e96554ae05871e29663ff7241836377dc9a7916449b8adb062c",
    },
    cargo_tmpfs_mib=1536,
)
PROFILES = {profile.target_tuple: profile for profile in (ARM64, X64)}


class VerificationRun:
    def __init__(self, root, profile=ARM64):
        self.profile = profile
        self.root = pathlib.Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = self.root / ".driver.lock"
        self.lock_fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            manifest = self.root / "run.json"
            if manifest.exists():
                record = json.loads(manifest.read_text())
                self.id = record["runId"]
                if record.get("schemaVersion") != 1 or not re.fullmatch(r"[0-9a-f]{32}", self.id):
                    raise RuntimeError("Invalid verification run identity")
                if record.get("root") != str(self.root):
                    raise RuntimeError("Verification run root changed")
                if record.get("profile", ARM64.target_tuple) != self.profile.target_tuple:
                    raise RuntimeError("Verification run profile changed")
            else:
                if set(self.root.iterdir()) != {self.lock}:
                    raise RuntimeError("Existing output directory has no run identity")
                self.id = uuid.uuid4().hex
                with manifest.open("x") as fh:
                    json.dump({
                        "schemaVersion": 1,
                        "runId": self.id,
                        "root": str(self.root),
                        "profile": self.profile.target_tuple,
                    }, fh)
            self.resources = self.root / "resources"
            self.resources.mkdir(exist_ok=True)
        except BaseException:
            self.close()
            raise

    @property
    def volume(self):
        return f"clec-{self.profile.target_tuple}-{self.id}-cargo"

    @property
    def owner_label(self):
        return f"org.clec.{self.profile.target_tuple}.run"

    def close(self):
        os.close(self.lock_fd)
        self.lock.unlink()

    @contextmanager
    def unit(self, name):
        marker = self.root / f"unit-{name}.started"
        with marker.open("x") as fh:
            fh.write(name + "\n")
        yield
        with (self.root / f"unit-{name}.completed").open("x") as fh:
            fh.write(name + "\n")

    def container_command(self, cmd):
        if cmd[:2] != ["docker", "run"]:
            return cmd
        cmd = list(cmd)
        if "--name" in cmd:
            idx = cmd.index("--name") + 1
            cmd[idx] = f"{cmd[idx]}-{self.id}"
        cid = self.resources / f"{uuid.uuid4().hex}.cid"
        return cmd[:2] + [
            "--pull", "never", "--platform", self.profile.platform,
            "--label", f"{self.owner_label}={self.id}", "--cidfile", str(cid),
        ] + cmd[2:]

    def inspect_owned(self, kind, identity):
        res = subprocess.run(["docker", kind, "inspect", identity], text=True, capture_output=True, timeout=30)
        if res.returncode:
            if "no such container" in res.stderr.lower() or "no such volume" in res.stderr.lower():
                return None
            raise RuntimeError(f"Cannot establish resource ownership: {res.stderr}")
        obj = json.loads(res.stdout)[0]
        labels = obj.get("Config", {}).get("Labels", {}) if kind == "container" else obj.get("Labels", {})
        if not labels or labels.get(self.owner_label) != self.id:
            raise RuntimeError(f"Resource ownership mismatch: {identity}")
        return obj

    def cleanup_resources(self):
        containers = []
        for cid_file in sorted(self.resources.glob("*.cid")):
            identity = cid_file.read_text().strip()
            if not re.fullmatch(r"[0-9a-f]{64}", identity):
                raise RuntimeError(f"Invalid recorded container ID: {cid_file}")
            if self.inspect_owned("container", identity) is not None:
                run_checked(["docker", "rm", "-f", identity])
                containers.append(identity)
        volumes = []
        if self.inspect_owned("volume", self.volume) is not None:
            run_checked(["docker", "volume", "rm", self.volume])
            volumes.append(self.volume)
        return containers, volumes


def run_process(cmd, **kwargs):
    return subprocess.run(RUN.container_command(cmd) if RUN else cmd, timeout=kwargs.pop("timeout", 3600), **kwargs)


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def run_checked(cmd, cwd=None, capture=True):
    res = run_process(cmd, cwd=cwd, text=True, capture_output=capture)
    if res.returncode != 0:
        raise RuntimeError(
            f"Command failed ({res.returncode}): {' '.join(cmd)}\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
        )
    return res


def ensure_dirs():
    for sub in ("logs", "logs/build", "logs/fixtures", "receipts", "bin", "releases"):
        (CACHE_ROOT / sub).mkdir(parents=True, exist_ok=True)


def verify_pinned_images(*roles):
    info = {}
    for role in roles:
        ref = RUN.profile.images[role]
        res = run_checked(["docker", "image", "inspect", ref])
        insp = json.loads(res.stdout)[0]
        actual_platform = f"{insp.get('Os')}/{insp.get('Architecture')}"
        if actual_platform != RUN.profile.platform:
            raise RuntimeError(f"Image {role} platform {actual_platform} != {RUN.profile.platform}")
        info[role] = {
            "tag": IMAGE_TAGS[role],
            "ref": ref,
            "id": insp["Id"],
            "repoDigests": insp.get("RepoDigests", []),
            "platform": actual_platform,
            "sizeBytes": insp.get("Size"),
        }
    return info


def unit_build():
    ensure_dirs()
    images_info = verify_pinned_images("builder_rust")

    src_export = CACHE_ROOT / "src-export"
    run_checked(["python3", str(REPO_ROOT / "tools" / "export_cli.py"), str(src_export)])

    native_hashes = {}
    for p in sorted((src_export / "native").rglob("*")):
        if p.is_file():
            rel = p.relative_to(src_export).as_posix()
            native_hashes[rel] = sha256_file(p)

    repo_lock_sha = sha256_file(REPO_ROOT / "native" / "Cargo.lock")
    if native_hashes.get("native/Cargo.lock") != repo_lock_sha:
        raise RuntimeError("Exported Cargo.lock SHA-256 mismatch")

    if RUN.profile.cargo_tmpfs_mib:
        cargo_mount = ["--tmpfs", f"/work:exec,rw,nosuid,size={RUN.profile.cargo_tmpfs_mib}m"]
    else:
        if RUN.inspect_owned("volume", RUN.volume) is not None:
            raise RuntimeError("Build volume already exists")
        run_checked(["docker", "volume", "create", "--label", f"{RUN.owner_label}={RUN.id}", RUN.volume])
        RUN.inspect_owned("volume", RUN.volume)
        cargo_mount = ["-v", f"{RUN.volume}:/work:rw"]

    bin_dir = CACHE_ROOT / "bin"
    release_out = bin_dir / "release"
    release_out.mkdir()

    cargo_args = ["--manifest-path", "/src/native/Cargo.toml", "--locked", "-j", "2"]
    build_argv = ["cargo", "build", *cargo_args, "--release", "--bins"]
    test_argv = ["cargo", "test", *cargo_args, *RUN.profile.test_args]
    container_script = r"""
set -eu
apk add --no-cache musl-dev file
uname -a
cat /etc/os-release
rustc --version --verbose
cargo --version
test "$(rustc --version | cut -d ' ' -f 2)" = 1.89.0
test "$(rustc -vV | sed -n 's/^host: //p')" = "$CLEC_RUST_TARGET"
df -k /work
echo "===BUILD_START==="
BUILD_COMMAND
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
test_exit=0
(apk add --no-cache openssl python3 && TEST_COMMAND) || test_exit=$?
df -k /work
du -sk /work/target /work/cargo-home
printf '===TEST_EXIT:%s===\n' "$test_exit"
"""
    container_script = container_script.replace("BUILD_COMMAND", " ".join(build_argv)).replace("TEST_COMMAND", " ".join(test_argv))
    cname = f"clec-{RUN.profile.target_tuple}-builder"

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
        *cargo_mount,
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
        "-e",
        "RUST_TEST_THREADS=2",
        "-e",
        f"CLEC_RUST_TARGET={RUN.profile.rust_target}",
        RUN.profile.images["builder_rust"],
        "sh",
        "-c",
        container_script,
    ]
    build_logs = CACHE_ROOT / "logs" / "build"
    docker_argv = RUN.container_command(docker_cmd)
    with (build_logs / "builder.argv.json").open("x") as log:
        json.dump(docker_argv, log, indent=2)
    with (build_logs / "builder.stdout.log").open("x") as stdout, (build_logs / "builder.stderr.log").open("x") as stderr:
        res = subprocess.run(docker_argv, stdout=stdout, stderr=stderr, timeout=3600)
    build_stdout = (build_logs / "builder.stdout.log").read_text()
    if "===BUILD_DONE===" not in build_stdout.splitlines():
        raise RuntimeError(f"Builder exited {res.returncode} before completing release build; see logs/build")

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
                f"clec-{RUN.profile.target_tuple}-elfcheck-{b}",
                "-v",
                f"{release_out}:/bins:ro",
                RUN.profile.images["builder_rust"],
                "sh",
                "-c",
                f"readelf -h -l -d /bins/{b}",
            ]
        )
        elf_text = inspect_res.stdout + inspect_res.stderr
        (CACHE_ROOT / "logs" / "build" / f"readelf-{b}.log").write_text(elf_text, encoding="utf-8")
        if "ELF64" not in elf_text or RUN.profile.elf_machine not in elf_text:
            raise RuntimeError(f"{b} is not ELF64 {RUN.profile.elf_machine}")
        if "INTERP" in elf_text or "Requesting program interpreter" in elf_text:
            raise RuntimeError(f"{b} contains PT_INTERP")
        if "NEEDED" in elf_text:
            raise RuntimeError(f"{b} contains dynamic NEEDED entries")
        elf_checks[b] = {
            "bytes": bpath.stat().st_size,
            "sha256": sha256_file(bpath),
            "elf64Machine": RUN.profile.elf_machine,
            "ptInterpAbsent": True,
            "neededAbsent": True,
        }

    test_results = re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", build_stdout)
    total_passed = sum(int(m[0]) for m in test_results)
    total_failed = sum(int(m[1]) for m in test_results)
    test_exit_marker = re.search(r"^===TEST_EXIT:(\d+)===$", build_stdout, re.MULTILINE)
    test_exit = int(test_exit_marker[1]) if test_exit_marker else None

    git_head = run_checked(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"]).stdout.strip()
    native_commit = run_checked(["git", "-C", str(REPO_ROOT), "log", "-n", "1", "--format=%H", "--", "native/"]).stdout.strip()

    obs = {
        "schemaVersion": 1,
        "observationKind": "clec-container-build-observation",
        "gitHead": git_head,
        "nativeTreeCommit": native_commit,
        "sourceMount": "read-only export from tools/export_cli.py",
        "exportFileSha256": {
            p.relative_to(src_export).as_posix(): sha256_file(p)
            for p in sorted(src_export.rglob("*")) if p.is_file()
        },
        "cargoLockSha256": repo_lock_sha,
        "nativeInputFileSha256": native_hashes,
        "builderImage": images_info["builder_rust"],
        "containerArgv": docker_argv,
        "executedCargoBuild": " ".join(build_argv),
        "cargoTestCommand": " ".join(test_argv),
        "containerExit": res.returncode,
        "testStepExit": test_exit,
        "containerCargoTestSuites": len(test_results),
        "containerCargoTestPassed": total_passed,
        "containerCargoTestFailed": total_failed,
        "containerCargoTestIgnored": sum(int(m[2]) for m in test_results),
        "binaries": elf_checks,
        "logs": {
            "stdout": str(CACHE_ROOT / "logs/build/builder.stdout.log"),
            "stderr": str(CACHE_ROOT / "logs/build/builder.stderr.log"),
        },
    }
    (CACHE_ROOT / "receipts" / "container-build-observation.json").write_text(
        json.dumps(obs, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"unit": "build", "binaries": elf_checks, "testsPassed": total_passed}, indent=2))
    if res.returncode != 0 or test_exit != 0 or total_failed != 0 or total_passed == 0:
        raise RuntimeError(f"Test step exit {test_exit}, suite results {test_results}; build observation retained")


def unit_stage():
    ensure_dirs()
    receipt_path = CACHE_ROOT / "receipts" / f"{RUN.profile.target_tuple}-prebuilt-receipt.json"
    run_checked(
        [
            "node",
            str(REPO_ROOT / "cli" / "scripts" / "build-receipt.mjs"),
            "--tuple",
            RUN.profile.target_tuple,
            "--target-dir",
            str(CACHE_ROOT / "bin"),
            "--cargo-lock",
            str(REPO_ROOT / "native" / "Cargo.lock"),
            "--host-baseline",
            f"{RUN.profile.target_tuple}-alpine-3.22-container",
            "--build-command",
            "cargo build --manifest-path /src/native/Cargo.toml --locked --release --bins -j 2",
            "--out",
            str(receipt_path),
        ]
    )
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt["schemaVersion"] != 2 or receipt["receiptKind"] != "clec-inspected-prebuilt-receipt":
        raise RuntimeError(f"Expected inspected-prebuilt receipt, got {receipt['receiptKind']}")
    for key in ("source", "buildInvocation"):
        if receipt["provenance"][key]["status"] != "not_verified_unknown":
            raise RuntimeError(f"Receipt provenance.{key} must remain not_verified_unknown")
    identity = receipt["verifiedEmbeddedMetadata"]
    if (identity["profile"], identity["features"], identity["testHooksIncluded"]) != ("release", [], False):
        raise RuntimeError(f"Unexpected release binary metadata: {identity}")
    if not identity["rustcVersion"].startswith("rustc 1.89.0 "):
        raise RuntimeError(f"Unexpected release compiler: {identity['rustcVersion']}")

    stage_input_path = CACHE_ROOT / "receipts" / f"stage-input-{RUN.profile.target_tuple}.json"
    stage_input = {
        "targets": {
            RUN.profile.target_tuple: {
                "clec": str(CACHE_ROOT / "bin" / "release" / "clec"),
                "clecPublish": str(CACHE_ROOT / "bin" / "release" / "clec-publish"),
                "clecValidate": str(CACHE_ROOT / "bin" / "release" / "clec-validate"),
                "buildReceipt": str(receipt_path),
                "executionEvidence": f"verified-{RUN.profile.target_tuple}-container-pending",
            }
        }
    }
    stage_input_path.write_text(json.dumps(stage_input, indent=2) + "\n", encoding="utf-8")

    staged_results = []
    staged_hashes = []
    for idx in (1, 2):
        out_dir = CACHE_ROOT / f"staged-{idx}"
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
        staged_hashes.append({p.name: sha256_file(p) for p in sorted(out_dir.iterdir())})

    if staged_hashes[0] != staged_hashes[1]:
        raise RuntimeError(f"Non-deterministic staging outputs: {staged_hashes}")

    inv = json.loads((CACHE_ROOT / "staged-1" / "inventory.json").read_text(encoding="utf-8"))
    prov = json.loads((CACHE_ROOT / "staged-1" / "provenance.json").read_text(encoding="utf-8"))
    if inv["complete"] is not False or inv["publishable"] is not False:
        raise RuntimeError("Partial inventory must mark complete=false, publishable=false")
    if prov["provenanceClassification"] != "inspected-prebuilt":
        raise RuntimeError("Expected inspected-prebuilt provenance classification")

    inspect_tmp = CACHE_ROOT / "stage-inspect-tmp"
    inspect_tmp.mkdir(parents=True)
    run_checked(["tar", "-xzf", str(CACHE_ROOT / "staged-1" / "clec-cli-1.0.0-dev.0.tgz"), "-C", str(inspect_tmp)])
    run_checked(["tar", "-xzf", str(CACHE_ROOT / "staged-1" / f"clec-v1.0.0-dev.0-{RUN.profile.target_tuple}.tar.gz"), "-C", str(inspect_tmp)])

    src_skill = sha256_file(REPO_ROOT / "cli" / "skills" / "clec" / "SKILL.md")
    src_readme = sha256_file(REPO_ROOT / "cli" / "README.md")
    for p in (
        inspect_tmp / "package" / "skills" / "clec" / "SKILL.md",
        inspect_tmp / f"clec-v1.0.0-dev.0-{RUN.profile.target_tuple}" / "skills" / "clec" / "SKILL.md",
    ):
        if sha256_file(p) != src_skill:
            raise RuntimeError(f"Skill SHA-256 mismatch in {p}")
    for p in (
        inspect_tmp / "package" / "README.md",
        inspect_tmp / f"clec-v1.0.0-dev.0-{RUN.profile.target_tuple}" / "README.md",
    ):
        if sha256_file(p) != src_readme:
            raise RuntimeError(f"README SHA-256 mismatch in {p}")
    shutil.rmtree(inspect_tmp)

    summary = {
        "unit": "stage",
        "sha256sumsSha256": staged_hashes[0]["SHA256SUMS"],
        "outputSha256": staged_hashes[0],
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
    verify_pinned_images("guest_musl")
    maint_dir = CACHE_ROOT / "maintainer-bin"
    maint_dir.mkdir(parents=True)
    run_checked(
        [
            "tar",
            "-xzf",
            str(CACHE_ROOT / "staged-1" / f"clec-maintainer-v1.0.0-dev.0-{RUN.profile.target_tuple}.tar.gz"),
            "-C",
            str(maint_dir),
        ]
    )
    cons_dir = CACHE_ROOT / "consumer-bin"
    cons_dir.mkdir(parents=True)
    run_checked(
        [
            "tar",
            "-xzf",
            str(CACHE_ROOT / "staged-1" / f"clec-v1.0.0-dev.0-{RUN.profile.target_tuple}.tar.gz"),
            "-C",
            str(cons_dir),
        ]
    )

    rel_dir = CACHE_ROOT / "releases"

    maint_inner = f"/maintainer/clec-maintainer-v1.0.0-dev.0-{RUN.profile.target_tuple}"
    cons_inner = f"/consumer/clec-v1.0.0-dev.0-{RUN.profile.target_tuple}"
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
            f"clec-{RUN.profile.target_tuple}-publish",
            "-v",
            f"{maint_dir}:/maintainer:ro",
            "-v",
            f"{cons_dir}:/consumer:ro",
            "-v",
            f"{FIXTURES_DIR}:/fixtures:ro",
            "-v",
            f"{rel_dir}:/releases:rw",
            RUN.profile.images["guest_musl"],
            "sh",
            "-c",
            script,
        ]
    )
    (CACHE_ROOT / "logs" / "fixtures" / "publish.log").write_text(res.stdout + res.stderr, encoding="utf-8")

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
    images = verify_pinned_images("guest_glibc", "guest_musl")
    clec_sha = sha256_file(CACHE_ROOT / "bin" / "release" / "clec")
    skill_sha = sha256_file(REPO_ROOT / "cli" / "skills" / "clec" / "SKILL.md")
    readme_sha = sha256_file(REPO_ROOT / "cli" / "README.md")

    guest_script = UNIT_DIR / "guest_verify.mjs"
    receipts = {}
    for libc_label, img_role in (("glibc", "guest_glibc"), ("musl", "guest_musl")):
        out_dir = CACHE_ROOT / "logs" / libc_label
        out_dir.mkdir()
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
            f"clec-{RUN.profile.target_tuple}-guest-{libc_label}",
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
            "NPM_CONFIG_USERCONFIG=/tmp/clec-home/user.npmrc",
            "-e",
            "NPM_CONFIG_GLOBALCONFIG=/tmp/clec-home/global.npmrc",
            "-e",
            f"CLEC_TUPLE={RUN.profile.target_tuple}",
            "-e",
            f"CLEC_LIBC_LABEL={libc_label}",
            "-e",
            f"CLEC_EXPECTED_SHA256={clec_sha}",
            "-e",
            f"CLEC_SKILL_SHA256={skill_sha}",
            "-e",
            f"CLEC_README_SHA256={readme_sha}",
            RUN.profile.images[img_role],
            "sh",
            "-c",
            "mkdir -p /tmp/clec-home && node /verify/guest_verify.mjs",
        ]
        res = run_process(cmd, text=True, capture_output=True)
        (out_dir / "runner.stdout.log").write_text(res.stdout, encoding="utf-8")
        (out_dir / "runner.stderr.log").write_text(res.stderr, encoding="utf-8")
        if res.returncode != 0:
            raise RuntimeError(
                f"Guest {libc_label} verification failed ({res.returncode}):\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
            )
        receipts[libc_label] = json.loads((out_dir / "guest-receipt.json").read_text(encoding="utf-8"))

    if receipts["glibc"]["installedBinarySha256"] != receipts["musl"]["installedBinarySha256"]:
        raise RuntimeError("Installed static binary SHA-256 differs between glibc and musl guests")
    summary = {"unit": "guests", "images": images, "glibc": "PASS", "musl": "PASS", "sha256": clec_sha}
    (CACHE_ROOT / "receipts" / "guests.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


def unit_cleanup():
    removed_containers, removed_volumes = RUN.cleanup_resources()

    removed_dirs = []
    for sub in ("maintainer-bin", "consumer-bin"):
        p = CACHE_ROOT / sub
        if p.exists():
            shutil.rmtree(p)
            removed_dirs.append(str(p.relative_to(CACHE_ROOT)))

    summary = {
        "unit": "cleanup",
        "removedContainers": removed_containers,
        "removedVolumes": removed_volumes,
        "removedTempDirs": removed_dirs,
    }
    (CACHE_ROOT / "receipts" / "cleanup.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


def main():
    global CACHE_ROOT, RUN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--unit",
        choices=["build", "stage", "fixtures", "guests", "cleanup", "all"],
        default="all",
    )
    parser.add_argument("--run-root", type=pathlib.Path, help="Dedicated run directory; completed or failed units cannot be repeated here")
    parser.add_argument("--profile", choices=PROFILES, default=ARM64.target_tuple)
    args = parser.parse_args()
    profile = PROFILES[args.profile]
    if args.run_root is None:
        parent = REPO_ROOT / ".cache" / f"phase6-{profile.target_tuple}-runs"
        parent.mkdir(parents=True, exist_ok=True)
        root = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    else:
        root = args.run_root
    RUN = VerificationRun(root, profile)
    CACHE_ROOT = RUN.root
    print(json.dumps({"runId": RUN.id, "runRoot": str(CACHE_ROOT)}), flush=True)
    units = {"build": unit_build, "stage": unit_stage, "fixtures": unit_fixtures, "guests": unit_guests, "cleanup": unit_cleanup}
    try:
        for name in units if args.unit == "all" else (args.unit,):
            with RUN.unit(name):
                units[name]()
    finally:
        RUN.close()


if __name__ == "__main__":
    main()
