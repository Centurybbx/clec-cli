# Stage 6A Native Packaging, Cache Safety, Short Skill, and MSRV Report

Stage 6A delivers bounded platform cache path resolution and shared-cache ownership guards in `native/`, replaces the active old Node TypeScript CLI in `cli/` with dependency-free native `@clec/cli@1.0.0-dev.0` packaging and deterministic release staging, migrates active docs, `tools/export_cli.py`, and `.github/workflows/ci.yml`, authors the short distributable Skill `cli/skills/clec/SKILL.md`, and verifies actual `rustc 1.89.0` locked builds/tests and isolated `npm` installation on macOS `arm64`.

All Stage 6A deliverables remain reversible local work pending independent parent review. Stage 6B host-answer evaluation, cross-OS execution, production default endpoint configuration, live Jev verification, and Stage 3 retrieval quality remain separate open gates.

Independent review at `b45bdcc` accepted the native cache/MSRV scope and requested three packaging/Skill/CI changes. The coordinator corrected CI lint selection and the Skill context example in `47bc77f`. Hydrogen then implemented the remaining artifact-admission boundary across `892f354` (minimal `native/build.rs` and `native/src/build_identity.rs` compile metadata) and `795deb3` (`cli/scripts/artifact-admission.mjs`, `cli/scripts/build-receipt.mjs`, `cli/scripts/stage.mjs`, `cli/scripts/install.mjs`, `cli/test/packaging.test.mjs`), followed by fresh MSRV `1.89.0` builds, restaging, and isolated verification in `.cache/stage6a-v2/`. All historical `345f84f` / `7b62eec` / `b45bdcc` measurements remain attributed to their earlier commits; note that at `b45bdcc`, `.cache/stage6a/staged_1/provenance.json` recorded `features: []` and `testHooksIncluded: false` unconditionally without inspecting binary compile metadata or bound build receipts. Independent parent review of the updated artifacts remains pending.

## Tested commits and gate status

- **Base commit:** `607a99b47e51215f0fb26bcf38a418be5c71fb14` (Stage 5 mock contract accepted at `e2b6195b9ff893aebffa6b06ea6b5441ba626b1c`).
- **Previous Stage 6A candidate heads (historical):** `345f84f99ea55f37da69fafa1999a4eda3db1e36` (native cache safety) and `7b62eece74f66222699225f570f067304e8f964b` (initial packaging/Skill).
- **Current native and packaging code head:** `795deb33f149cbf7547849970429acc5f5d63f70` (`892f354` added compile-time build identity metadata; core CLI/cache/transport/ranking/Jev code remains unchanged from `345f84f`).

| Gate | Status | Evidence summary |
| --- | --- | --- |
| `SAFE_CACHE` | Accepted at `b45bdcc` (native scope) | Before/after temp-fixture repros (`.cache/stage6a/before-repro.json`, `.cache/stage6a/after-repro.json`) and unit tests in `native/src/cli.rs` and `native/src/snapshot.rs` (unchanged since `345f84f`) |
| `ACTUAL_MSRV` | Verified at `795deb3` on `darwin-arm64` | Installed `rustc 1.89.0` (`29483883e`); `cargo +1.89.0 build --locked --release --bins` (`.cache/stage6a-v2/logs/msrv-build.log`), `clec_test_fixture` `--features test-hooks` build (`.cache/stage6a-v2/logs/msrv-test-hook-build.log`), `cargo +1.89.0 test --locked` (`60 + 1 + 18 = 79` tests in `.cache/stage6a-v2/logs/msrv-test.log`), `cargo +stable fmt --check`, and `cargo +stable clippy --locked --all-targets -- -D warnings` (default + `test-hooks`) passed |
| `LOCAL_PACKAGING` | Verified at `795deb3` (pending parent review) | Bound receipt (`.cache/stage6a-v2/logs/darwin-arm64-build-receipt.json`) and `cli/scripts/stage.mjs` partial staging produced identical `SHA256SUMS` across `.cache/stage6a-v2/staged_1` and `staged_2`; `npm test --prefix cli` (`6/6` including real `darwin-arm64` wrong-tuple and renamed `clec_test_fixture` rejections) and 38-file `tools/export_cli.py` export (`npm test` + `cargo +1.89.0 check --locked`) passed |
| `SKILL_PACKAGED` | Verified at `795deb3` | `cli/skills/clec/SKILL.md` (`17` lines, `2,938` B, SHA-256 `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b`, updated in `47bc77f`) is byte-identical in source, consumer archive, and installed npm package; authored fixture smoke with `--context 1` and `--context 2` passed; zero global Skill writes |
| `LOCAL_INSTALLED_ARTIFACT` | Verified at `795deb3` on `darwin-arm64` | Isolated `npm install --global --offline` into space+Unicode prefix linked `bin/clec` directly to native `bin/clec.exe`; `PATH`-stripped direct-vs-installed parity, consumer/maintainer archive verification, `SIGTERM`/`SIGINT` FIFO parity, repeat/uninstall/`--ignore-scripts`/rebuild repair, 8 negative installer rejections, and `otool -L` linkage inspection passed (`.cache/stage6a-v2/logs/installed-artifact-receipt-v2.json`) |
| `CROSS_OS_SUPPORT` | `OPEN` | Only `darwin-arm64` (`macOS 26.4.1`, `minos 11.0`, `sdk 26.4`) executed; `darwin-x64`, `linux-x64` (`musl`/`glibc`), `linux-arm64` (`musl`/`glibc`), and `win32-x64` (`cmd`/PowerShell) unexecuted |
| `HOST_ANSWER_QUALITY` | `OPEN` | Stage 6B preregistration draft recorded in `evaluation/clec-v1/phase6/PROTOCOL.md`; zero host-answer author/runtime/judge runs performed |
| `PRODUCTION_DEFAULT` | `OPEN` | `BUILTIN_DEFAULT_MANIFEST_URL = None` (`schema.defaultConfigured = false`) |
| `LIVE_JEV` | `OPEN` | `schema.providerVerified = false`; zero live provider calls or credentials read |
| `STAGE3_QUALITY` | `FAILED` / `OPEN` | `P3-QUALITY-CRITICAL-CONDITIONS` and `P3-QUALITY-EXACT-TOP5-CHAINS` remain open; consumed holdout untouched |

## Measured artifacts and hashes

### MSRV `1.89.0` release binaries at `795deb3` (`.cache/stage6a-v2/target-msrv/release/`)

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `.cache/stage6a-v2/target-msrv/release/clec` | 15,775,504 | `083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7` |
| `.cache/stage6a-v2/target-msrv/release/clec-publish` | 10,058,992 | `7594d7cd4b9619d461669b03dd1eae889eabcef33f64147fa4cd32c171196529` |
| `.cache/stage6a-v2/target-msrv/release/clec-validate` | 9,271,200 | `23e5d1f1fce715a63c7045eeb9d3395fd68d08ae9a7688d260a496f13c9af6dd` |
| `.cache/stage6a-v2/target-msrv/release/examples/clec_test_fixture` (negative-test hook fixture only) | 15,818,496 | `25690e6994343ccbc84521fe4828a340377998366055b3c1f3edeceacdb729e2` |

### Staged partial release package at `795deb3` (`.cache/stage6a-v2/staged_1/`)

`inventory.json` and `provenance.json` bind `sourceCommit: 795deb33f149cbf7547849970429acc5f5d63f70` (`sourceDirty: false`), `rustc 1.89.0 (29483883e 2025-08-04)`, `cargoLockSha256: 200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda`, `features: []`, and `testHooksIncluded: false` to exact artifact SHA-256 hashes, explicitly marking `complete: false`, `publishable: false`, and `darwin-x64`, `linux-x64`, `linux-arm64`, and `win32-x64` missing.

| Staged file | Bytes | SHA-256 |
| --- | --- | --- |
| `clec-cli-1.0.0-dev.0.tgz` | 7,907,480 | `b1e641dea80f85a6d80208155b7b59dbe214fde9eb75e1dff259f4ea782d58e4` |
| `clec-v1.0.0-dev.0-darwin-arm64.tar.gz` | 7,899,694 | `231c683b03bfb1949d0ff6794446bedfc94e9dad2dba39d2dbac8fa2a2b43691` |
| `clec-maintainer-v1.0.0-dev.0-darwin-arm64.tar.gz` | 10,630,413 | `9a17127ee8b2ea79d4496276ba940c71abbfb1ba0be9d2649d46265c27af3568` |
| `inventory.json` | 1,913 | `c3a1052aacf28ccdd2418283f029f8707e9f133ef54072f6b66eb34fdc3adcc5` |
| `provenance.json` | 5,816 | `1d4f669212a1bfac375c50536b94501578bbe0bdf891afca0c46a2fdd2fd17fe` |
| `SHA256SUMS` | 473 | `a7e57c88696329f50f89efad50cd730311675365a687baee3e2dbab24fe5a75a` |

### Historical MSRV `1.89.0` release binaries (`345f84f99ea55f37da69fafa1999a4eda3db1e36`, superseded)

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `.cache/stage6a/target-msrv/release/clec` | 15,775,392 | `8666e3caeb6c3a363a050f53b3a62d27e25cc0459a7538aa2dcc7271e7662889` |
| `.cache/stage6a/target-msrv/release/clec-publish` | 10,058,976 | `ac6477f7501deb13fd6b15ef5f76107511152ee225da3f2923d2efa95a01fbc6` |
| `.cache/stage6a/target-msrv/release/clec-validate` | 9,271,200 | `8cc9ad3747fa0698a94beed08b50218c5641f540ba78065d623ecdf6d3b41ab5` |

### Historical Normal `1.93.0` release binaries (`345f84f99ea55f37da69fafa1999a4eda3db1e36`, superseded)

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `.cache/stage6a/target/release/clec` | 15,541,648 | `5caa5114dc9649d5867ebd60c71b1d96aaf55a6012fd8d7f92588d91ac6caa44` |
| `.cache/stage6a/target/release/clec-publish` | 9,974,432 | `bcfe48ae37844e0c900acb1245ce5cdc7542082f911af272d3e6219343c70a30` |
| `.cache/stage6a/target/release/clec-validate` | 9,206,704 | `8777405f4e01d0234057e3f0291995f9c37d1ccc064152aa298aff4597ac1366` |

### Historical staged partial release package (`.cache/stage6a/staged_1/`, code head `7b62eec`, superseded)

`inventory.json` and `provenance.json` explicitly mark `complete: false` and `publishable: false` with `darwin-x64`, `linux-x64`, `linux-arm64`, and `win32-x64` missing (note: `provenance.json` at this superseded head wrote `features: []` and `testHooksIncluded: false` without binary inspection or bound build receipts; `cli/skills/clec/SKILL.md` at that head was `2,880` B, SHA-256 `8a31fb4fdf998a65c92a8b17b2ac1b3ad157329482a887e5f4a7ee0204ebae26`).

| Staged file | Bytes | SHA-256 |
| --- | --- | --- |
| `clec-cli-1.0.0-dev.0.tgz` | 7,904,121 | `c49d59bd81fd4315f56387fc36f9fd9e0b768ba74f663adf41435dadd298d4ec` |
| `clec-v1.0.0-dev.0-darwin-arm64.tar.gz` | 7,900,988 | `2690069e807c74e348d966249beec0a79bb80cea2268c6ce66da54ab3890ff0c` |
| `clec-maintainer-v1.0.0-dev.0-darwin-arm64.tar.gz` | 10,630,242 | `e9fdd04973a6a0bf259120f5c64d717ba1c8a48d01bc4db276651a8417d7019c` |
| `inventory.json` | 1,487 | `bdfe96bc6a542a0fb889855d257999760939ab1657bbcf2ff5e982e3b58c229f` |
| `provenance.json` | 2,108 | `a671ecc02a858b9335107d9cefb4d63d8f5bc123d0670b89ce01c5cd028ff218` |
| `SHA256SUMS` | 473 | `4c746d431638c6966c55411c22ce614a00199f19e482494faf144bd8d23a4666` |

## Dynamic linkage and runtime limits

- `otool -L` on MSRV `1.89.0` and `1.93.0` `clec`, `clec-publish`, and `clec-validate` shows only system libraries: `/System/Library/Frameworks/Security.framework/Versions/A/Security`, `/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation`, `/usr/lib/libiconv.2.dylib`, and `/usr/lib/libSystem.B.dylib`. Zero external SQLite, OpenSSL, Python, or Node runtime libraries are linked.
- `otool -l` (`LC_BUILD_VERSION`) records `minos 11.0`, `sdk 26.4` on build host `macOS 26.4.1 (25E253)` `arm64`. Execution is verified on `macOS 26.4.1` only.
- Installer and packaging scripts are tested on `Node v25.7.0` and `npm 11.10.1`. Node 16/18/20/22/24 and non-macOS `npm`/`cmd-shim` remain untested here.
- `npx` inherently requires Node.js and npm; direct `clec` binary execution after installation does not.

## Publication readiness packet (no public actions taken)

1. **Outstanding ownership and legal checks (maintainer-only):**
   - Confirm authoritative GitHub repository and remote (`cli/package.json` preserves `Centurybbx/clec-cli`, which returned 404 when queried earlier; root git has no remotes).
   - Confirm `@clec/cli` npm scope rights and target release version (currently local `1.0.0-dev.0`).
   - Assign an explicit repository and binary distribution license (`cli/NOTICES.md` currently records `unassigned_pending_maintainer_confirmation`).
   - Supply target execution infrastructure for `darwin-x64`, `linux-x64` (`musl` + `glibc`), `linux-arm64` (`musl` + `glibc`), and `win32-x64`, plus code-signing/notarization credentials if required by the chosen distribution channel.
2. **Proposed future staging/publication sequence (only after all 5 targets are built/verified and destination/license are confirmed):**
   - Capture bound local build receipts and stage complete production artifacts into a clean directory without `--allow-partial`:
     ```sh
     node cli/scripts/build-receipt.mjs --tuple <tuple> --target-dir <target-dir> --toolchain 1.89.0 --build-command "cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --release --bins" --out <receipt-dir>/<tuple>.json
     node cli/scripts/stage.mjs --input <full-5-target-inputs.json> --output <release-dir>
     ```
   - Export verified public source tree with `python3 tools/export_cli.py <export-dir>` and publish via the verified GitHub release/npm scope commands once maintainer confirms destination and license.
