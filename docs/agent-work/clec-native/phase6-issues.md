# CLEC native Stage 6A issues and acceptance ledger

This ledger tracks Stage 6A implementation work stacked on accepted Stage 5 head `607a99b47e51215f0fb26bcf38a418be5c71fb14` (mock contract accepted at `e2b6195b9ff893aebffa6b06ea6b5441ba626b1c`).

## Independent review follow-up at `b45bdcc`

### Residual admission findings at `505e21d`

Review `59acf672` reproduced two remaining P2 gaps. Receipt capture promoted current-checkout observations and a caller-supplied, unexecuted command into build provenance for an unrelated prebuilt binary. Artifact admission also allowed musl and custom `PT_INTERP` loaders under a `musl-static` tuple. No actual current Linux artifact was demonstrated broken; this is structural admission evidence.

The coordinator corrected the small ELF predicate to reject every present `PT_INTERP` segment, including empty strings and zero-length segments. Added x64 and arm64 fixtures failed before the correction with the predicted missing exception for the musl interpreter; afterward five packaging tests pass, with the optional real-binary test skipped in the root checkout because its build cache is absent. This does not claim Linux execution. Independent review and restaging are pending. Source/build-command provenance classification still requires a coherent receipt-model correction.

Review `ff034441` accepted native cache safety and MSRV lifecycle. Review `2d508eb7` requested three packaging corrections. Its executable probes established wrong-target, empty, and renamed test-hook payload admission, unsupported CI lint-toolchain selection, and an invalid Skill context example. No public artifacts were released.

The coordinator corrected the two small configuration/documentation findings. CI lint commands explicitly select `+stable`, whose rustfmt and Clippy components the workflow installs; MSRV build/test commands still select `+1.89.0`. The Skill now gives `--context 1` and separately explains `--context 2`. Local stable component checks and formatting pass; the actual native parser accepts context `1` and reaches `NO_DATA` on an empty offline fixture. This is no claim of a dispatched CI run. The original npm size was corrected to the measured 7,904,121 bytes. Two narration comments were removed without behavior changes.

## Artifact-admission resolution at `892f354` and `795deb3` (pending independent review)

The artifact-admission fix was implemented in two verifiable commits on top of coordinator commit `47bc77f` while preserving all earlier `b45bdcc` and `345f84f` records as historical measurements at their recorded commits:

1. **Minimal native compile-time metadata (`892f354`).** `native/build.rs` captures Cargo `TARGET`, `PROFILE`, active `CARGO_CFG_FEATURE` list, `rustc --version`, and `native/Cargo.lock` SHA-256 (`200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda`). `native/src/build_identity.rs` exposes `clec_build_identity!` and `retain` for each binary entrypoint (`clec`, `clec-publish`, `clec-validate`, `clec_test_fixture`), leaving all public `clec` CLI commands, flags, schemas, cache paths, HTTP transport, ranking, and Jev code unchanged. `tools/export_cli.py` includes `native/build.rs` in the 38-file export allowlist.
2. **Coherent admission boundary, bound receipts, and installer validation (`795deb3`).** `cli/scripts/artifact-admission.mjs` validates nonempty regular files, Mach-O 64 / ELF64 / PE32+ executable headers and architectures (including rejecting `glibc` `PT_INTERP` in `musl-static` slots, Fat Mach-O, and PE DLLs), exact-once `CLEC_BUILD_IDENTITY_V1` compile metadata, unsigned local `clec-build-receipt` bindings (`cli/scripts/build-receipt.mjs`), and full `inventory.json` target schemas against `TARGET_MATRIX`. `cli/scripts/stage.mjs` admits every consumer and maintainer slot before writing any archive, derives `provenance.json` strictly from verified build receipts, rejects `unknown`, dirty-tree production builds, wrong tuples, slot swaps, and renamed `test-hooks` builds, and separates `structuralIdentity` from `executionEvidence`. `cli/scripts/install.mjs` reuses the same boundary to validate full tuple metadata, checksums, lengths, executable format, and non-`test-hooks` identity, failing closed and reporting any placeholder-restoration failure honestly.
3. **Verification.** `cargo +stable fmt --check`, `cargo +stable clippy --locked --all-targets -- -D warnings` (default and `test-hooks`), `cargo +1.89.0 test --locked` (`60 + 1 + 18 = 79` tests plus `test-hooks` `build_identity`), `npm test --prefix cli` (`6/6` including real MSRV `clec` wrong-tuple and renamed `clec_test_fixture` rejections), deterministic double repack in `.cache/stage6a-v2/staged_{1,2}`, isolated `npm` install/uninstall/`--ignore-scripts`/rebuild, `PATH`-stripped direct-vs-installed parity, `tools/export_cli.py` + `cargo +1.89.0 check --locked` on the exported tree, and negative installer probes all passed. Independent parent review remains pending.

### Artifact-admission data shape and ownership sketch

1. **Compile-time metadata (`native/build.rs`, `native/src/build_identity.rs`).** Captures Cargo `TARGET`, `PROFILE`, active `CARGO_CFG_FEATURE` list, `RUSTC --version`, and `native/Cargo.lock` SHA-256, and embeds one retained `CLEC_BUILD_IDENTITY_V1` JSON marker per binary entrypoint (`clec`, `clec-publish`, `clec-validate`, `clec_test_fixture`) without altering any public `clec` CLI command, flag, or schema. `tools/export_cli.py` includes `native/build.rs` in the source allowlist.
2. **Coherent admission boundary (`cli/scripts/artifact-admission.mjs`, `cli/scripts/targets.mjs`).** Shared by `build-receipt.mjs`, `stage.mjs`, and `install.mjs`. Validates nonempty regular files, Mach-O 64 / ELF64 / PE32+ executable headers and CPU architectures (plus `musl-static` non-glibc `PT_INTERP` checks), exact-once `CLEC_BUILD_IDENTITY_V1` metadata, bound `clec-build-receipt` files, and full `inventory.json` target metadata against `TARGET_MATRIX`.
3. **Bound build receipt and staging (`cli/scripts/build-receipt.mjs`, `cli/scripts/stage.mjs`).** `build-receipt.mjs` emits `clec-build-receipt` JSON (`trustModel: "unsigned-local-build-receipt"`) from an actual build or inspected target directory tied to exact artifact byte lengths and SHA-256 hashes. `stage.mjs` refuses `unknown`, missing, or contradictory provenance fields, admits all consumer and maintainer slots before writing archives, rejects any binary or receipt with `testHooks` / `test-hooks`, and records `structuralIdentity` separately from `executionEvidence` while keeping `complete` and `publishable: false` honest.
4. **Installer (`cli/scripts/install.mjs`).** Validates `inventory.json` header, full tuple schema (`platform`, `arch`, `rustTarget`, `binaryName`, `libc`, safe `payloadPath`), regular file status, byte length, SHA-256, executable container/arch, and non-`test-hooks` identity; fails closed and reports any placeholder-restoration failure honestly.

## Carried-forward open gates

1. **Live Jev provider (`OPEN`).** `schema.providerVerified` remains `false`. No live provider API calls or credentials are authorized or used in Stage 6A.
2. **Production default endpoint (`OPEN`).** `BUILTIN_DEFAULT_MANIFEST_URL` stays `None` (`schema.defaultConfigured` is `false`). No public `clec-native-v2` release endpoint exists yet.
3. **Stage 3 retrieval quality (`FAILED` / `OPEN`).** `P3-QUALITY-CRITICAL-CONDITIONS` and `P3-QUALITY-EXACT-TOP5-CHAINS` remain open. The Stage 3 holdout is consumed and closed; no private Phase 3 labels, frozen questions, outcomes, blind sets, or reviews are read or rerun.
4. **Cross-OS platform support (`OPEN`).** Only local `darwin-arm64` execution is verifiable on this host. `darwin-x64`, `linux-x64` (`x86_64-unknown-linux-musl`), `linux-arm64` (`aarch64-unknown-linux-musl`), and `win32-x64` (`x86_64-pc-windows-msvc`) remain unverified without native target execution.
5. **Stage 6B host-answer quality (`OPEN`).** Deferred to an independent follow-up unit after Stage 6A acceptance. Stage 6A authors the distributable Skill and a concise Stage 6B preregistration draft without running host-answer author, runtime, or judge evaluations.

## Source hazards tracked for Stage 6A

1. **`P6-DATA-DIR-HOME-FALLBACK` (`FIXED` locally at `345f84f`, pending independent acceptance).** `native/src/cli.rs::resolve_data_dir` previously fell back to `.` (`PathBuf::from(".")`) when `HOME` was unset or empty, which created `./.local/share/clec/active.json` in a fresh working-directory repro (`.cache/stage6a/before-repro.json`).
   - **Resolution.** `native/src/cli.rs` now enforces `--data-dir` > nonempty `CLEC_DATA_DIR` > platform default (`~/.local/share/clec/native-v2` on Unix, `%LOCALAPPDATA%/clec/native-v2` with `%USERPROFILE%/AppData/Local/clec/native-v2` fallback on Windows), removes the `.` fallback, returns `ErrorCode::InvalidDataDir` (exit 4) when unavailable, and keeps `schema`, `--help`, and `--version` independent of data directory resolution (`.cache/stage6a/after-repro.json`). Windows path resolution is verified via unit tests only; native Windows execution remains `OPEN`.
2. **`P6-SHARED-CACHE-CLEANUP-HAZARD` (`FIXED` locally at `345f84f`, pending independent acceptance).** `native/src/snapshot.rs::cleanup_old_releases` previously deleted every 71-character `*.sqlite` file in `data_dir` except the active `<sha>.sqlite`, and a fresh repro in a shared directory with a legacy `current` marker deleted both legacy `<sha>.sqlite` and unrelated 71-character `*.sqlite` files (`.cache/stage6a/before-repro.json`).
   - **Resolution.** `native/src/snapshot.rs` adds `ensure_not_legacy_cache_dir` before lock acquisition, staging, bootstrap, dry-run, or status in any directory containing `current`, advising a separate directory. `cleanup_old_releases` and `compute_projected_managed_bytes` act strictly on the established previous native active artifact recorded in `active.json` prior to sync (`prev_release != active_release`). Legacy files, unrelated 71-character `.sqlite` files, unknown files, prior snapshots on budget/validation failure, and relocated explicit native directories are preserved (`.cache/stage6a/after-repro.json`).

## Source and caller inventory

### Active CLI consumer and packaging callers (migrated in one wave)

| Path | Current role | Stage 6A action |
| --- | --- | --- |
| `native/Cargo.toml`, `native/Cargo.lock` | `clec-native` crate (`0.1.0`) | Bump crate version to `1.0.0-dev.0` aligned with `@clec/cli`; keep dependencies and MSRV `1.89.0` locked |
| `native/src/cli.rs` | `resolve_data_dir`, `--data-dir` help text, `schema` independence | Fix `P6-DATA-DIR-HOME-FALLBACK` and `native-v2` default path |
| `native/src/snapshot.rs` | `cleanup_old_releases`, cache admission, `compute_projected_managed_bytes` | Fix `P6-SHARED-CACHE-CLEANUP-HAZARD` |
| `native/src/sag2/jev.rs`, `native/tests/sag2_protocol.rs` | `User-Agent` header-cap unit expectation (`0.1.0` hardcoded `192` bytes) | Derive expected length from `env!("CARGO_PKG_VERSION")` without weakening cap checks |
| `cli/package.json`, `cli/package-lock.json`, `cli/tsconfig.json` | Old Node `0.3.0` TypeScript CLI with `opencc-js`, `typescript`, `@types/node` | Replace with dependency-free `@clec/cli@1.0.0-dev.0` native packaging (`bin.clec -> bin/clec.exe`), remove TS deps and lockfile |
| `cli/src/*.ts`, `cli/test/*.test.mjs` | Old Node CLI command implementations and tests | Delete obsolete TS command sources after audit; replace `cli/test/` with native packaging and installation tests |
| `cli/docs/agent-guide.md` | Legacy `clec guide research` / `schema search` / `--format json` body | Replace with pointer to `cli/skills/clec/SKILL.md` and host Skill discovery/install notes |
| `cli/.github/workflows/ci.yml` | Old Node CLI CI matrix | Move to root `.github/workflows/ci.yml` for Rust + packaging checks (YAML only; not execution proof) |
| `tools/export_cli.py` | Copies old TS allowlist to `Centurybbx/clec-cli` checkout | Retire TS export path; replace with explicit native + packaging + Skill + workflow allowlist export into a fresh directory |
| `README.md`, `cli/README.md` | Documents old Node `0.3.0` commands (`guide`, `coverage`, `--format json`) | Update active consumer/publisher docs to native `clec` (`1.0.0-dev.0`), `native-v2` cache, no invented URLs/remotes |

### Preserved artifacts (untouched)

- `docs/cli-bm25-release-030.md`, `docs/cli-product-report-20261113.md`, `docs/portable-cli.md`, `docs/portable-cli-report-20261113.md`, `docs/agent-work/clec-native/phase1..5*` (historical reports and phase records).
- `backend/`, `collection/`, `clec_kb/`, `summaries/`, `evaluation/` historical runners and original corpus sources.
- All private `phase3-label*`, `phase3-frozen*`, `phase3-heldout*`, blind, outcome, and review files (unread and untouched).

## Stage 6A gate predicates

| Gate | Falsifiable acceptance predicate |
| --- | --- |
| `SAFE_CACHE` | Fresh temp fixtures prove both hazards reproduced before fix and fixed after: unset/empty `HOME` fails `status`/`sync`/`search` with `INVALID_DATA_DIR` without creating `.` cache, `schema`/`--help`/`--version` succeed without `HOME`, precedence `--data-dir` > nonempty `CLEC_DATA_DIR` > platform default passes, legacy `current` dir rejects before lock/staging mutation, and post-activation cleanup removes only the established previous native active `.sqlite` while preserving unrelated 71-char `.sqlite` files, unknown files, prior snapshots on budget/sync failure, and relocated native dirs. |
| `LOCAL_PACKAGING` | Validated artifact admission (`cli/scripts/artifact-admission.mjs`, `cli/scripts/build-receipt.mjs`, `cli/scripts/stage.mjs`) checks executable format/arch, exact-once `CLEC_BUILD_IDENTITY_V1`, and bound `clec-build-receipt` hashes/metadata for consumer and maintainer slots before writing archives, marks `complete: false, publishable: false` for `darwin-arm64`-only, separates `structuralIdentity` from `executionEvidence`, repacks byte-identically across two runs, refuses incomplete/dirty/test-hook/wrong-tuple/unknown inputs, and exports cleanly via 38-file `tools/export_cli.py`. |
| `SKILL_PACKAGED` | `cli/skills/clec/SKILL.md` passes frontmatter/content rules, is byte-identical in `cli/`, consumer archive, and npm tarball, uses only actual installed `clec schema` / `--help` syntax, and passes isolated authored-fixture navigation smoke without modifying user global Skill dirs. |
| `LOCAL_INSTALLED_ARTIFACT` | Isolated npm pack/global install into temp prefix (including space + Unicode paths) links `clec` directly to native `bin/clec.exe`; stdout/stderr/exit/argv parity holds against direct `clec` across help, version, schema, status, `NO_DATA`, local sync, search, exact UTF-8 read, whole-item `--max-bytes`, stdin/pipe behavior, and termination parity at a waiting local fixture; commands pass after Node and Python are removed from `PATH`; repeat install, upgrade, uninstall, offline tarball install, `--ignore-scripts` honest failure, corrupt/missing/wrong-tuple rejection, and `otool -L` linkage inspection pass. |
| `ACTUAL_MSRV` | Real `rustc 1.89.0` toolchain installed locally runs `cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --release --bins` and `cargo +1.89.0 test --manifest-path native/Cargo.toml --locked` cleanly, alongside normal-toolchain `cargo fmt --check`, `cargo clippy --locked --all-targets` (default and `test-hooks`), Phase 2 blackbox (10), Phase 3 synthetic (20), Stage 5 protocol (18 normal / 19 `test-hooks`), and Phase 4/DNS regressions. |
| `CROSS_OS_SUPPORT` | `OPEN` until actual execution receipts exist on `darwin-x64`, `linux-x64` (`musl` + `glibc` hosts), `linux-arm64` (`musl` + `glibc` hosts), and `win32-x64` (`cmd` + PowerShell). |
| `HOST_ANSWER_QUALITY` | `OPEN` until Stage 6B runs 24 isolated fresh cases with independent author, isolated runtime, and independent judge. |
