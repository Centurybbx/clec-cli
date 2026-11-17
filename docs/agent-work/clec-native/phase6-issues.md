# CLEC native Stage 6A issues and acceptance ledger

This ledger tracks Stage 6A implementation work stacked on accepted Stage 5 head `607a99b47e51215f0fb26bcf38a418be5c71fb14` (mock contract accepted at `e2b6195b9ff893aebffa6b06ea6b5441ba626b1c`).

## Independent review follow-up at `b45bdcc`

Review `ff034441` accepted native cache safety and MSRV lifecycle. Review `2d508eb7` requested three packaging corrections. Its executable probes established wrong-target, empty, and renamed test-hook payload admission, unsupported CI lint-toolchain selection, and an invalid Skill context example. No public artifacts were released.

The coordinator corrected the two small configuration/documentation findings. CI lint commands explicitly select `+stable`, whose rustfmt and Clippy components the workflow installs; MSRV build/test commands still select `+1.89.0`. The Skill now gives `--context 1` and separately explains `--context 2`. Local stable component checks and formatting pass; the actual native parser accepts context `1` and reaches `NO_DATA` on an empty offline fixture. This is no claim of a dispatched CI run. The original npm size was corrected to the measured 7,904,121 bytes. Two narration comments were removed without behavior changes.

Artifact admission remains OPEN pending a focused Hydrogen fix and independent review. Staging must establish executable format/architecture, bind build facts to actual artifacts, reject test-hook builds after rename, and validate installer tuple metadata. Existing package/Skill hashes remain historical receipts at their recorded code heads. Corrected artifacts must be restaged and reverified before acceptance.

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
| `LOCAL_PACKAGING` | Deterministic staging tool produces per-target consumer archives, separate maintainer archives (`clec-publish`, `clec-validate`), `inventory.json` (marked `complete: false, publishable: false` for `darwin-arm64`-only), `provenance.json`, `SHA256SUMS`, and aggregate `@clec/cli@1.0.0-dev.0` `.tgz` from strict allowlist. Identical inputs repack byte-for-byte identically. Production staging mode refuses incomplete inventory. `tools/export_cli.py` exports native allowlist into a fresh directory and builds cleanly. |
| `SKILL_PACKAGED` | `cli/skills/clec/SKILL.md` passes frontmatter/content rules, is byte-identical in `cli/`, consumer archive, and npm tarball, uses only actual installed `clec schema` / `--help` syntax, and passes isolated authored-fixture navigation smoke without modifying user global Skill dirs. |
| `LOCAL_INSTALLED_ARTIFACT` | Isolated npm pack/global install into temp prefix (including space + Unicode paths) links `clec` directly to native `bin/clec.exe`; stdout/stderr/exit/argv parity holds against direct `clec` across help, version, schema, status, `NO_DATA`, local sync, search, exact UTF-8 read, whole-item `--max-bytes`, stdin/pipe behavior, and termination parity at a waiting local fixture; commands pass after Node and Python are removed from `PATH`; repeat install, upgrade, uninstall, offline tarball install, `--ignore-scripts` honest failure, corrupt/missing/wrong-tuple rejection, and `otool -L` linkage inspection pass. |
| `ACTUAL_MSRV` | Real `rustc 1.89.0` toolchain installed locally runs `cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --release --bins` and `cargo +1.89.0 test --manifest-path native/Cargo.toml --locked` cleanly, alongside normal-toolchain `cargo fmt --check`, `cargo clippy --locked --all-targets` (default and `test-hooks`), Phase 2 blackbox (10), Phase 3 synthetic (20), Stage 5 protocol (18 normal / 19 `test-hooks`), and Phase 4/DNS regressions. |
| `CROSS_OS_SUPPORT` | `OPEN` until actual execution receipts exist on `darwin-x64`, `linux-x64` (`musl` + `glibc` hosts), `linux-arm64` (`musl` + `glibc` hosts), and `win32-x64` (`cmd` + PowerShell). |
| `HOST_ANSWER_QUALITY` | `OPEN` until Stage 6B runs 24 isolated fresh cases with independent author, isolated runtime, and independent judge. |
