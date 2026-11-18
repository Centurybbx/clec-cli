# Stage 6 Linux x64 packaging verification

The static CLEC Linux x64 release passed all 79 Rust 1.89 tests and the consumer archive and offline npm checks in amd64 glibc and musl containers on Apple Silicon. The shared Linux verifier uses `--profile linux-x64` to select amd64 image pins, the package tuple, and the ELF machine. The original invocation still selects ARM64.

Independent review `c373711d` accepted candidate `f93f44ba384290b1ab34305987ecb14ef0995358`. It reran cold offline npm installation and installed CLI behavior in the pinned x64 glibc and musl guests, installer rejection controls, both ARM64 default-profile guests, and run-ownership tests. The coordinator integrated the verifier and checked that the integrated platform sources match the reviewed commit. Original author evidence links below resolve in `/Users/century/.t3/worktrees/clec/t3-64956391-884c0ac8c4b35244`. Independent results are in that checkout's `.cache/review-linux6-4O9gbzJk/`.

## Source and build

The source base is `6886ff11b89564337cebca54e956d0841558afa2`. The last commit affecting `native/` is `892f354f61621f9b1b51f1f52e4b9cb69cc2d15c`. All 38 exported files matched their Git blobs byte for byte. The read-only export's `native/Cargo.lock` SHA-256 was `200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda`. [Export SHA-256 manifest](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/export-matches-base.sha256)

Docker Desktop 4.40.0 used Engine 28.0.4 on an arm64 LinuxKit 6.10.14 VM with 8,218,316,800 bytes of RAM. The pinned Rust builder resolved to `linux/amd64` with image ID `sha256:c7db8072fa10b38ffff96132697449d8aece6dfc91f8a689491279bc56970d39`. Inside it, `uname` reported `x86_64` and `rustc -vV` reported host `x86_64-unknown-linux-musl` on Alpine 3.22.1, with Rust 1.89.0 (`29483883e`, LLVM 20.1.7) and Cargo 1.89.0 (`c24e10642`). Cargo used the compiler's host target. The build used a two-job limit, two CPUs, and 4 GiB container memory. The test harness used two test threads. Build and tests shared the release target directory. [Engine and initial capacity](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/storage-before-pull.log) · [Builder stdout](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-msrv/logs/build/builder.stdout.log) · [Builder stderr](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-msrv/logs/build/builder.stderr.log)

```sh
cargo build --manifest-path /src/native/Cargo.toml --locked -j 2 --release --bins
cargo test --manifest-path /src/native/Cargo.toml --locked -j 2 --release
```

The fresh tmpfs build completed both commands with exit 0. Six suites reported 79 passed, zero failed, and zero ignored. The count includes 60 library unit tests, one publisher test and 18 protocol integration tests. The three release binaries copied out before test compilation matched the staged payloads byte for byte. Cargo used the default feature set. The feature-gated `test-hooks` suite, a debug-profile rerun, Rust formatting, and Clippy were outside this packaging pass. [Fresh build and test observation](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-msrv/receipts/container-build-observation.json) · [Fresh binary comparison](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/fresh-build-matches-staged.sha256)

## Release artifacts

All three binaries are ELF64 x86-64 static PIEs. The builder's `readelf` output has no `PT_INTERP` program header and no dynamic `NEEDED` entry. Each binary embeds the requested target, the observed lock hash and Rust 1.89.0, the release profile, an empty feature set, and disabled test hooks. [Container build observation and exact Docker argv](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-tmpfs/receipts/container-build-observation.json) · [Schema v2 inspected-prebuilt receipt](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-tmpfs/receipts/linux-x64-prebuilt-receipt.json)

| Binary | Bytes | SHA-256 |
| --- | ---: | --- |
| `clec` | 18,409,712 | `7415c1db8e55c32ab8d6dcebdd3a86eaf73c99a5582171d99ef7ef8bb4962f1d` |
| `clec-publish` | 10,464,528 | `15d7e26d59064c0c2f9007714b28b311d747548ca16b22a0e981f41aabab7002` |
| `clec-validate` | 9,459,992 | `40fd0fb1ea72be038898f1dc629adbf1107098d111fc23b04bbb37481460a02c` |

The inspected-prebuilt receipt leaves both source and build invocation at `not_verified_unknown`. The separate unsigned build observation records the local build, exact Docker argv, source export hashes, and binary hashes. The unchanged stager produced six byte-identical files in each of two output directories. Only `linux-x64` is present. The other four slots are missing, with `complete` and `publishable` both false. The Skill and README in the consumer archive and npm tarball match the repository files. All three archives carry the source notices. [Staging receipt](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-tmpfs/receipts/staging-summary.json) · [Inventory](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-tmpfs/staged-1/inventory.json) · [Staged checksums](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/verification-tmpfs/staged-1/SHA256SUMS) · [Archive inspection](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/archive-inspection.log)

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| `clec-v1.0.0-dev.0-linux-x64.tar.gz` | 8,518,281 | `4d37dcb1229ab65a85652e75163f8a8177c2e7033e0b50db7b65a0b428215dab` |
| `clec-maintainer-v1.0.0-dev.0-linux-x64.tar.gz` | 10,751,435 | `cf79637c3c24a50f683cf11f5684b72776aaa933d349d2354884848d90cc4f` |
| `clec-cli-1.0.0-dev.0.tgz` | 8,529,137 | `4445ae73fa93753aa4886a20fe91990732d2407a5c3dc9b664ec2c65aee1f3ab` |

## Offline amd64 guest execution

Both pinned guest images resolved to `linux/amd64` and reported `x86_64` inside the guest. Debian 12 reported glibc 2.36 (`2.36-9+deb12u14`) and image ID `sha256:b774d993885c47eca14db241ba8cc7e5789235142f76e4a2a6a65ec350a1bac0`. Alpine 3.24.4 reported musl 1.2.6 and image ID `sha256:8049382e2048cff27289992d304206b4208b5b4f5110a19a5dbe21c18a0b8603`. Both used Node 22.23.5 and npm 10.9.9. Containers ran with networking disabled, read-only root filesystems, 256 MiB private tmpfs, two CPUs and 1 GiB of memory. npm used private home, config, prefix, and cache paths. [Image resolution](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-x64-parity/receipts/guests.json) · [Debian guest receipt](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-x64-parity/logs/glibc/guest-receipt.json) · [Alpine guest receipt](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-x64-parity/logs/musl/guest-receipt.json)

- Offline npm install linked `bin/clec` directly to the installed native executable under a prefix containing spaces and Chinese characters. Both installed copies and the extracted consumer binary matched the staged `clec` hash above. With a nonexistent PATH, installed and direct invocations matched exit status, stdout and stderr for version, help, schema, status without HOME, search and passage reads. The guest checked no-data errors and confirmed `defaultConfigured` and `providerVerified` were false.
- The archived publisher and validator built and validated two snapshots from the tracked authored fixtures. In both guests, search and read round-tripped exact UTF-8 spans and the original BOM and CRLF. The 4,000-byte search limit returned 3,242 bytes and omitted two whole hits. [Fixture summary](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/x64-fixtures.log) · [Debian budget result](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-x64-parity/logs/glibc/commands/empty-path-search-omission-budget.stdout)
- Corrupt Release B failed sync with `INTEGRITY_MISMATCH`. The check verified Release A stayed active and its SQLite bytes, the unrelated marker, and the unrelated hash-shaped SQLite file survived. Valid Release B then became active and CLEC removed the prior native snapshot. Concurrent sync returned exits 0 and 4 in each guest, with `SYNC_LOCKED` on the losing attempt.
- `--ignore-scripts` left the placeholder installed. Debian's fallback shell returned 127 and Alpine's direct spawn returned `ENOEXEC`. Checksum mismatch, an ARM64 ELF in the x64 slot, and an x64 ELF with `PT_INTERP` each failed with exit 1 and left the placeholder in place. [Debian command records](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-x64-parity/logs/glibc/commands) · [Alpine command records](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-x64-parity/logs/musl/commands)

The ARM64 default profile staged copies of all three retained ARM64 binaries twice and published and validated the authored snapshots. Both ARM64 guests passed after the placeholder assertion was corrected to accept the observed Alpine error. The final command parity checks passed in a fresh run on each architecture. The original source binaries matched their before-run checksums. Seven local run-ownership tests passed. The ARM regression used retained binaries. [ARM staging](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/arm-stage.log) · [ARM guest summary](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/linux-arm64-parity-guests.log) · [Original ARM checksums](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/arm-original-after.log) · [Ownership tests](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/ownership-tests.log)

## Capacity and retained evidence

The disk-backed trial stopped at 2,278,899,712 host bytes free before producing binaries. The next run copied only the prior run's owned Cargo intermediates from a read-only Docker mount into tmpfs. It completed the release build, then stopped during test compilation at 2,180,820,992 host bytes free. Both exits were 137 from the host disk guard. The first trial's exact labeled volume was removed after the binaries and their logs were retained. Docker later reclaimed the space, allowing the two amd64 Node images to be pulled. The fresh build and test run reached at least 2,316,398,592 bytes free in the host samples and ended with 1,009,480 KiB used in the Cargo tmpfs. The smallest sampled host reserve across the build attempts was 2,180,820,992 bytes. The attempts and regressions have distinct run identities and logs. [Disk-backed trial](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/storage-build-close.log) · [Tmpfs trial](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/storage-build-tmpfs.log) · [Volume cleanup](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/interrupted-disk-cleanup.log) · [Guest pulls and capacity](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/storage-pull-guests.log) · [Full build capacity](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/storage-build-msrv.log) · [Final storage](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/storage-final.log) · [Audit log](../../../.cache/phase6-linux-x64-runs/run-UMbrXp2j/decisions.tsv)

These results cover Docker Desktop amd64 execution on an ARM host for the exact LinuxKit kernel, images and Node version above. Bare-metal x64, older Linux kernels and libc baselines, other Node releases, npm upgrade or uninstall, and npx remain open. The partial package is for local verification. Release publication remains open.

## Reproduce

Run from the repository root. Use an empty task-specific Docker config and the socket for your local engine. Use a separate host-space monitor with a 2 GiB cutoff during image extraction, build, and tests. The verifier alone does not enforce that host-space reserve. The x64 profile uses a 1,536 MiB Cargo tmpfs inside the builder to reduce Docker disk growth. The three image digests below identify the official `linux/amd64` image manifests.

```sh
parent="$PWD/.cache/phase6-linux-x64-runs"
mkdir -p "$parent"
evidence="$(mktemp -d "$parent/run-XXXXXXXX")"
export DOCKER_CONFIG="$evidence/docker-config"
export DOCKER_HOST=unix:///Users/century/.docker/run/docker.sock
mkdir "$DOCKER_CONFIG"

docker pull --platform linux/amd64 docker.io/library/rust@sha256:f9617326395be71547efa3c8b8d58b89ff958afc594596713bceb585aabc067e
docker pull --platform linux/amd64 docker.io/library/node@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc
docker pull --platform linux/amd64 docker.io/library/node@sha256:12f54cafa58d0e96554ae05871e29663ff7241836377dc9a7916449b8adb062c

driver=evaluation/clec-v1/phase6/platform/linux-arm64/verify_linux_arm64.py
python3 -B "$driver" --profile linux-x64 --unit all --run-root "$evidence/verification"
python3 -B -m unittest discover -s evaluation/clec-v1/phase6/platform/linux-arm64 -p 'test_*.py' -v
```

For tight disk budgets, run `--unit build` with only the Rust image present, then pull the Node images and run `stage`, `fixtures`, `guests`, and `cleanup` on the same dedicated root. Each unit is attempted once. Cleanup uses exact CID files and a run label to check ownership before removing resources.
