# Stage 6A Linux ARM64 Container Verification Report

This report records real `linux/arm64` (`aarch64-unknown-linux-musl`) container compilation, deterministic partial staging, and offline installation plus execution verification across `glibc` and `musl` Linux guest containers. The work runs stacked on commit `3999d3ef4cd96ddbf03b39aaba0395dccb3996d8` without modifying `native/`, `cli/`, `tools/`, `.github/`, or prior Stage 6A reports and protocols.

## Verdict and scope boundaries

The Linux ARM64 container execution and repaired rerun workflow are accepted within this scope. The author passed all six units at `6fdeaad612da052903f85e994e95405e15fc7a15`. Independent review passed fresh installation and native execution in both guest environments, exact UTF-8, budgets, rollback and cleanup. That review requested a bounded driver fix because reruns reused output directories and cleanup selected containers by shared prefix. Fresh independent review `3127ccae` accepted the repair at `a9b6c6d1d2ae4b211a7228ec6e11e40fdde308df`, including actual Docker cleanup that left the other run alive.

This gate provides container-guest execution evidence on a local macOS `arm64` host running Docker Desktop `4.40.0` (`ServerVersion 28.0.4`, `OSType linux`, `Architecture aarch64`, kernel `6.10.14-linuxkit`). It does not establish bare-metal Linux behavior, minimum kernel baselines, `darwin-x64`, `linux-x64`, `win32-x64` (`cmd`/PowerShell), Stage 6B host-answer quality, production endpoint availability (`defaultConfigured: false`), live Jev verification (`providerVerified: false`), rights or licensing (`cli/NOTICES.md` unassigned), or Stage 3 retrieval quality.

## Source, toolchain, and pinned container inventory

- **Branch base:** `3999d3ef4cd96ddbf03b39aaba0395dccb3996d8` (native source unchanged since `795deb33f149cbf7547849970429acc5f5d63f70`; `git diff 795deb3 -- native/` is empty).
- **Pinned inputs:** `native/Cargo.lock` SHA-256 `200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda`, `cli/skills/clec/SKILL.md` SHA-256 `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b`, `cli/README.md` SHA-256 `e2a7ac9b3cce55848f8c7c802748cdedf0880738c1733a1df89d40e9be67dd74`.

| Role | Tag and pinned digest | Image ID | Guest OS, kernel, and runtime pins |
| --- | --- | --- | --- |
| Builder | `rust:1.89.0-alpine3.22` (`rust@sha256:4b800f2e72e04be908e5f634c504c741bd943b763d1d8ad7b096cc340e1b5b46`) | `sha256:7dc37e5c91f9dcd5c4bcbf0b90b6c728af6ffc58188878fb227c3e5dd4e9d8cc` | Alpine Linux `3.22.1`, `aarch64`, `6.10.14-linuxkit`, `musl 1.2.5`, `rustc 1.89.0 (29483883e 2025-08-04)`, `cargo 1.89.0 (c24e10642 2025-06-23)` |
| Guest (`glibc`) | `node:22-bookworm-slim` (`node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`) | `sha256:b06790a7ce8f827fd695d4a148ba260b351d658af126b6deb27af3823a1675a1` | Debian GNU/Linux `12 (bookworm)`, `aarch64`, `6.10.14-linuxkit`, `Debian GLIBC 2.36-9+deb12u14`, `node v22.23.5`, `npm 10.9.9` |
| Guest (`musl`) | `node:22-alpine` (`node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a`) | `sha256:fd6e7c5e242aaf648004a761573a2b930792eb46b1be852862b595dfdaa11b36` | Alpine Linux `3.24.4`, `aarch64`, `6.10.14-linuxkit`, `musl 1.2.6`, `node v22.23.5`, `npm 10.9.9` |

Docker pulls used an isolated empty `DOCKER_CONFIG` and `DOCKER_HOST` pointing at `~/.docker/run/docker.sock` because host `docker-credential-desktop` stalled in the non-interactive session. No user credentials were read or mounted.

## Container build, static ELF verification, and Rust tests

`tools/export_cli.py` exported the 38-file allowlist into a temporary directory mounted read-only (`/src:ro`) into `clec-linux-arm64-builder` (`--cpus 2`, `--memory 4g`, `CARGO_BUILD_JOBS=2`, `CMAKE_BUILD_PARALLEL_LEVEL=2`, isolated volume `clec-linux-arm64-cargo`). Only `musl-dev` and `file` were installed for the release build:

```sh
cargo build --manifest-path /src/native/Cargo.toml --locked --release --bins -j 2
```

All three `aarch64-unknown-linux-musl` release binaries compile cleanly with `features: []` and `testHooks: false` (`CLEC_BUILD_IDENTITY_V1` verified). Inspection via `file` and `readelf -h -l -d` inside a `--network none --read-only` container confirms ELF64 little-endian `AArch64` `ET_EXEC` static binaries with zero `PT_INTERP` segments and zero `DYNAMIC` or `NEEDED` entries.

| Binary | Bytes | SHA-256 | Static ELF checks |
| --- | --- | --- | --- |
| `clec` | 16,955,400 | `99512f1b8163b3a6a66c881ec18b9d85166ceb5688f8dc2858044810e742bd33` | ELF64 AArch64, no `PT_INTERP`, no `NEEDED` |
| `clec-publish` | 10,174,488 | `a8546598ef60601d6e7155eec44b9d239568727659b8953c2bcc9735739dc4e0` | ELF64 AArch64, no `PT_INTERP`, no `NEEDED` |
| `clec-validate` | 9,225,328 | `8bdcdef6c1e556c73330448d21eaa0566e1955dcf0fc990c6c4dfafb621295bf` | ELF64 AArch64, no `PT_INTERP`, no `NEEDED` |

After copying out the three release binaries, the builder container installed `openssl` and `python3` solely for `distribution::tests` (which spawns `openssl` and `python3` to serve local test certificates) and ran `cargo test --manifest-path /src/native/Cargo.toml --locked -j 2`. All `79` tests across 6 suites passed (`60` lib unit tests, `1` `clec-publish` bin test, `18` `sag2_protocol` integration tests; `0` failed, `0` ignored). Running `cargo test` in this LinuxKit container does not verify Windows or macOS TLS/DNS/SIGKILL matrices.

## Honest provenance and deterministic partial staging

Because `cli/scripts/build-receipt.mjs --run-build` runs `cargo` on the macOS host rather than inside Docker, the Linux payload was admitted via `cli/scripts/build-receipt.mjs` without `--run-build`. That emits a schema v2 `clec-inspected-prebuilt-receipt` (`.cache/phase6-linux-arm64/receipts/linux-arm64-prebuilt-receipt.json`) with `provenance.source` and `provenance.buildInvocation` kept strictly as `not_verified_unknown`, paired with a separate retained container observation receipt (`.cache/phase6-linux-arm64/receipts/container-build-observation.json`) recording the source commit, read-only input SHA-256 hashes, pinned builder digest, executed `cargo` argv, logs, and ELF digests.

Two independent runs of `cli/scripts/stage.mjs --allow-partial --cargo-lock native/Cargo.lock` into `.cache/phase6-linux-arm64/staged-{1,2}` produced identical `SHA256SUMS` (`9af7a48632a3583d8bf53dd332c06eb97bbe8e2e194995b491e60c8f568f536a`). `inventory.json` and `provenance.json` (`inspected-prebuilt`) mark `complete: false`, `publishable: false`, `linux-arm64` present (`musl-static`, `elf-64`, `aarch64-unknown-linux-musl`), and the other four targets missing. `cli/skills/clec/SKILL.md` and `cli/README.md` inside both `clec-cli-1.0.0-dev.0.tgz` and `clec-v1.0.0-dev.0-linux-arm64.tar.gz` match source SHA-256 digests byte-for-byte.

| Staged artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `clec-cli-1.0.0-dev.0.tgz` | 8,302,630 | `be81a3e48ae2616472d4a2d7e4a3881c6a6019885e83bf032b4a30bf7c6b6596` |
| `clec-v1.0.0-dev.0-linux-arm64.tar.gz` | 8,292,724 | `e99fb81bcca1e2d83facb718a917731ca2e78ab4b0f66f13b293b58fe059a465` |
| `clec-maintainer-v1.0.0-dev.0-linux-arm64.tar.gz` | 10,650,555 | `6d755df3c24a50f683cf11f5684b72776aaa53645baa0fbcd4a5b770823ff675` |
| `inventory.json` | 2,243 | `0243d8b45b2f9a9b8647af644fa560dc4c3cd7e23a9098671e19be11a73bbfb9` |
| `provenance.json` | 7,094 | `f773762a9c4d51bf76f40de995f5432d0d3ca094287d4df2e4833dd3fadb046e` |
| `SHA256SUMS` | 471 | `9af7a48632a3583d8bf53dd332c06eb97bbe8e2e194995b491e60c8f568f536a` |

## Authored fixture publishing and glibc/musl guest checks

Inside a `--network none --read-only` Linux container, the staged Linux `clec-publish` and `clec-validate` binaries built and validated two public authored UTF-8 releases (`release-a`: `2` works, `4` sources, `3` canonical sources with `dup_a.txt` collapsed into `sub_a.srt`, `4` passages, `2` cues, `doc_a.txt` with UTF-8 BOM `\xef\xbb\xbf`, CRLF `\r\n`, `0050`, `QQQ`, `4%`, Traditional Chinese, and `😀`, plus `notes_b.md` containing instruction-like text; `release-b`: `1` work, `1` source), plus a tampered `release-b-corrupt` snapshot. Release A DB SHA-256 is `6a59bef096905d2566de78137cc7394486497478b50e7e36e222445b1b13ce2e`, and Release B DB SHA-256 is `16d1be36ed1537cba68de7812453b894d71ce11e2e4ffbc8d9ba60aa3f9d909f`.

`evaluation/clec-v1/phase6/platform/linux-arm64/guest_verify.mjs` executed identically inside `node:22-bookworm-slim` (`glibc 2.36`) and `node:22-alpine` (`musl 1.2.6`), each with `--network none`, `--read-only` rootfs, and writable `/tmp` tmpfs + `/out` log mount. All checks passed in both guests:

- **Negative installer controls:** `--ignore-scripts` install left the non-working placeholder failing non-zero (`127` on `glibc`, `ENOEXEC` on `musl`); tampered inventory SHA-256 (`exit 1`), `linux-x64` wrong-arch ELF (`exit 1`), and `aarch64` ELF with `PT_INTERP` (`exit 1`) all failed `scripts/install.mjs` closed and restored the placeholder.
- **Isolated npm global offline install:** `npm install --global --offline` into `/tmp/clec-work/prefix space 中文` linked `bin/clec` to `bin/clec.exe` (`99512f1b8163b3a6a66c881ec18b9d85166ceb5688f8dc2858044810e742bd33`), byte-identical to the static consumer binary across both `glibc` and `musl`, with matching `SKILL.md` and `README.md` hashes.
- **Empty-PATH native execution (`PATH=/nonexistent-empty-path`, zero Node/Python):** `--version`, `--help`, `schema` (`defaultConfigured: false`, `providerVerified: false`, unset `HOME`), unset-`HOME` `status` (`exit 4`, `INVALID_DATA_DIR`, zero `./.local` fallback), pre-sync `status` (`ready: false`) and `search` (`exit 3`, `NO_DATA`), `search --offline --sag2` (`exit 2`, `OFFLINE_REQUIRED`), `--max-bytes 1 schema` (`exit 2`, `OUTPUT_BUDGET_TOO_SMALL`), `--offline sync` on `release-a` (`reused: false` then `reused: true`), `sources --canonical-only`, `search '0050 QQQ 4%' '退休 提領 😀'`, `read p_59882e554c85d6b8c32b9b16 --context 1` (installed-vs-direct stdout byte parity, UTF-8 `spans` slicing raw `doc_a.txt` bytes identically), `read s_7126a336ef6273715565f7c5 --original --find '每年提領'` (exact BOM+CRLF UTF-8 byte round-trip), `--max-bytes 4000` whole-item `budget.omittedCount > 0`, corrupt `release-b-corrupt` sync rejection (`exit 5`, `INTEGRITY_MISMATCH`) preserving `release-a`, `release-b` sync cleanup of prior native `.sqlite` while preserving `keep-unknown.txt` and unrelated 71-char `.sqlite`, concurrent sync lock contention (`exits [0, 4]` with `SYNC_LOCKED` preserving `release-a`), and pre/post release checksum immutability.

## Retention and cleanup state

Retained artifacts live under ignored `.cache/phase6-linux-arm64/` (`bin/release/`, `receipts/`, `staged-{1,2}/`, `releases/`, `logs/{build,fixtures,glibc,musl}/`) and `.audit/phase6-linux-arm64.{todo.md,tsv}`. Task-owned containers (`clec-linux-arm64-*`), volume `clec-linux-arm64-cargo`, and temporary extract/export directories were removed; pre-existing Docker images, containers, volumes, and baseline repo files remain untouched.

To rerun the full pipeline from scratch:

```sh
python3 evaluation/clec-v1/phase6/platform/linux-arm64/verify_linux_arm64.py --unit all
```

The repaired driver creates a fresh run under `.cache/phase6-linux-arm64-runs/` and prints its path. Use `--run-root PATH` to run successive units in one dedicated directory. Units cannot be repeated there, even after failure. Earlier `.cache/phase6-linux-arm64/` evidence stays unchanged.

## Coordinator ownership repair

The coordinator fixed this bounded review finding directly. Each run now owns an exclusive directory, driver lock, one-shot unit markers, unique labeled Docker names, and Docker-created CID records. Cleanup checks exact recorded IDs and labels, with no shared-prefix search. A foreign label or failed ownership observation stops cleanup. No native or packaging source changed.

Six local ownership controls pass, including two independent run contexts, failed-unit log preservation, legacy-directory refusal, concurrent-writer refusal, foreign resource rejection, and exact CID selection. Fresh fixture publishing and both guest runs exercise the repaired driver using copies of the retained Linux artifacts. This is a driver rerun, not a new Rust build. New receipts and the original-evidence hash check are recorded in the coordinator's ignored `.cache/linux-ownership-fix.json`.

The independent repair review reran the six controls and added real two-run Docker ownership checks, daemon-failure rejection and evidence-content comparisons. Its report and executable probes are retained at `/tmp/clec-ownership-review-1yJ9Zv/`. The earlier independent guest execution is retained at `/tmp/clec-linux-review-OlK7z4/`. Full compilation and the 79 Rust tests remain inspected author receipts. Neither review establishes bare-metal Linux or broader platform support.
