# Stage 6A Native Packaging, Cache Safety, Short Skill, and MSRV Report

Stage 6A delivers bounded platform cache path resolution and shared-cache ownership guards in `native/`, replaces the active old Node TypeScript CLI in `cli/` with dependency-free native `@clec/cli@1.0.0-dev.0` packaging and deterministic release staging, migrates active docs, `tools/export_cli.py`, and `.github/workflows/ci.yml`, authors the short distributable Skill `cli/skills/clec/SKILL.md`, and verifies actual `rustc 1.89.0` locked builds/tests and isolated `npm` installation on macOS `arm64`.

All Stage 6A deliverables remain reversible local work pending independent parent review. Stage 6B host-answer evaluation, cross-OS execution, production default endpoint configuration, live Jev verification, and Stage 3 retrieval quality remain separate open gates.

## Tested commits and gate status

- **Base commit:** `607a99b47e51215f0fb26bcf38a418be5c71fb14` (Stage 5 mock contract accepted at `e2b6195b9ff893aebffa6b06ea6b5441ba626b1c`).
- **Tested native code head:** `345f84f99ea55f37da69fafa1999a4eda3db1e36` (`native/` unchanged thereafter, verified by `git diff --exit-code 345f84f -- native/`).
- **Tested packaging, Skill, and tooling head:** `7b62eece74f66222699225f570f067304e8f964b`.

| Gate | Status | Evidence summary |
| --- | --- | --- |
| `SAFE_CACHE` | Verified locally (pending parent review) | Before/after temp-fixture repros (`.cache/stage6a/before-repro.json`, `.cache/stage6a/after-repro.json`) and unit tests in `native/src/cli.rs` and `native/src/snapshot.rs` |
| `ACTUAL_MSRV` | Verified on `darwin-arm64` | Installed `rustc 1.89.0` (`29483883e`); `cargo +1.89.0 build --locked --release --bins` and `cargo +1.89.0 test --locked` (`59 + 1 + 18 = 78` tests) passed; normal `fmt`, `clippy` (default + `test-hooks`), Phase 2 (`5 + 10`), Phase 3 synthetic (`20`), Stage 5 (`18` release + `19` `test-hooks`), Phase 4 (`9`), and DNS (`7`) passed |
| `LOCAL_PACKAGING` | Verified locally (pending parent review) | `cli/scripts/stage.mjs` partial staging produced identical SHA-256 outputs across two repacks (`.cache/stage6a/logs/staging-receipt.json`); production mode refuses missing tuples; `npm test --prefix cli` (`4/4`) and 34-file `tools/export_cli.py` export passed |
| `SKILL_PACKAGED` | Verified locally | `cli/skills/clec/SKILL.md` (`17` lines, `2,880` B, SHA-256 `8a31fb4fdf998a65c92a8b17b2ac1b3ad157329482a887e5f4a7ee0204ebae26`) is byte-identical in source, consumer archive, and installed npm package; authored fixture smoke passed; zero global Skill writes |
| `LOCAL_INSTALLED_ARTIFACT` | Verified on `darwin-arm64` | Isolated `npm install --global --offline` into space+Unicode prefix linked `bin/clec` directly to native `bin/clec.exe`; `12/12` direct-vs-installed parity cases passed with `node` and `python3` absent from `PATH`; `npx`, broken-pipe, `SIGTERM` waiting-fixture parity, repeat/upgrade/uninstall, `--ignore-scripts` `ENOEXEC`/`126` failure, and repair passed (`.cache/stage6a/logs/installed-artifact-receipt.json`) |
| `CROSS_OS_SUPPORT` | `OPEN` | Only `darwin-arm64` (`macOS 26.4.1`, `minos 11.0`, `sdk 26.4`) executed; `darwin-x64`, `linux-x64` (`musl`/`glibc`), `linux-arm64` (`musl`/`glibc`), and `win32-x64` (`cmd`/PowerShell) unexecuted |
| `HOST_ANSWER_QUALITY` | `OPEN` | Stage 6B preregistration draft recorded in `evaluation/clec-v1/phase6/PROTOCOL.md`; zero host-answer author/runtime/judge runs performed |
| `PRODUCTION_DEFAULT` | `OPEN` | `BUILTIN_DEFAULT_MANIFEST_URL = None` (`schema.defaultConfigured = false`) |
| `LIVE_JEV` | `OPEN` | `schema.providerVerified = false`; zero live provider calls or credentials read |
| `STAGE3_QUALITY` | `FAILED` / `OPEN` | `P3-QUALITY-CRITICAL-CONDITIONS` and `P3-QUALITY-EXACT-TOP5-CHAINS` remain open; consumed holdout untouched |

## Measured artifacts and hashes

### MSRV `1.89.0` release binaries (`345f84f99ea55f37da69fafa1999a4eda3db1e36`)

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `.cache/stage6a/target-msrv/release/clec` | 15,775,392 | `8666e3caeb6c3a363a050f53b3a62d27e25cc0459a7538aa2dcc7271e7662889` |
| `.cache/stage6a/target-msrv/release/clec-publish` | 10,058,976 | `ac6477f7501deb13fd6b15ef5f76107511152ee225da3f2923d2efa95a01fbc6` |
| `.cache/stage6a/target-msrv/release/clec-validate` | 9,271,200 | `8cc9ad3747fa0698a94beed08b50218c5641f540ba78065d623ecdf6d3b41ab5` |

### Normal `1.93.0` release binaries (`345f84f99ea55f37da69fafa1999a4eda3db1e36`)

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `.cache/stage6a/target/release/clec` | 15,541,648 | `5caa5114dc9649d5867ebd60c71b1d96aaf55a6012fd8d7f92588d91ac6caa44` |
| `.cache/stage6a/target/release/clec-publish` | 9,974,432 | `bcfe48ae37844e0c900acb1245ce5cdc7542082f911af272d3e6219343c70a30` |
| `.cache/stage6a/target/release/clec-validate` | 9,206,704 | `8777405f4e01d0234057e3f0291995f9c37d1ccc064152aa298aff4597ac1366` |

### Staged partial release package (`.cache/stage6a/staged_1/`, code head `7b62eec`)

`inventory.json` and `provenance.json` explicitly mark `complete: false` and `publishable: false` with `darwin-x64`, `linux-x64`, `linux-arm64`, and `win32-x64` missing.

| Staged file | Bytes | SHA-256 |
| --- | --- | --- |
| `clec-cli-1.0.0-dev.0.tgz` | 7,904,085 | `c49d59bd81fd4315f56387fc36f9fd9e0b768ba74f663adf41435dadd298d4ec` |
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
   - Stage complete production artifacts into a clean directory without `--allow-partial`: `node cli/scripts/stage.mjs --input <full-5-target-inputs.json> --output <release-dir> --source-commit <HEAD> --rustc-version "rustc 1.89.0 (29483883e 2025-08-04)" --cargo-lock native/Cargo.lock --build-command "cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --release --bins"`
   - Export verified public source tree with `python3 tools/export_cli.py <export-dir>` and publish via the verified GitHub release/npm scope commands once maintainer confirms destination and license.
