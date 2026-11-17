# CLEC native Phase 1 report

Phase 1 delivers the `native/` Rust crate (`clec_core`, `clec`, and `clec-publish`), the `evaluation/clec-v1/` verification protocol and blackbox driver, and the architecture, issue ledger, and completion records in `docs/agent-work/clec-native/`.

## Baseline and corrective scope

Base commit `cc35732` preserved `cli/`, `backend/`, `collection/`, and `evaluation/audio-check/` untouched. Independent review of `8415e34` surfaced eight defects resolved through `509ad27`. Subsequent independent Astra review of `509ad27` confirmed four additional defects tracked in `docs/agent-work/clec-native/phase1-issues.md` (`P1-FTS-ENGINE-STATE`, `P2-REUSE-INCOMING-VALIDATION`, `DATA-CUE-TIMESTAMP-OVERFLOW`, `BUG-BUDGET-USED-BYTES-FIXEDPOINT`).

All round 2 code and blackbox fixes landed through committed code head `9016757` (`901675715a5e326a094fb16a95612ecf846310dd`). This documentation commit updates `phase1-issues.md` and `phase1-report.md` only and records verified code head `9016757`.

## Implemented deliverables

- **`native/src/domain.rs`.** Typed IDs (`WorkId`, `SourceId`, `PassageId`, `ReleaseHash`), `SourceRole`, `Attribution`, `BoundaryKind`, encapsulated `ByteSpan`, `DateYmd`, `ClecError`, and `ErrorEnvelope`. `Deserialize` routes through validated `parse` and `new` constructors, and `JsonSchema` emits regex and range constraints.
- **`native/src/ingest.rs`.** UTF-8 validation, BOM/CRLF/emoji/overlap-preserving SRT/STR/VTT cue parsing with checked SQLite `i64::MAX`-bounded millisecond timestamps and recovery diagnostics, and Unicode scalar segmentation (`1000..1200` target, `2000` hard cap, continuation tracking, and multi-span subtitle cue grouping).
- **`native/src/lexical.rs`.** Search-only normalization via `ferrous-opencc` (`tw2s`), NFKC, lowercasing, `jieba-rs` segmentation, and hex-encoded FTS5 tokens preserving `0050`, `QQQ`, and `4%`.
- **`native/src/store.rs`.** `clec-native-v1` SQLite schema (`rusqlite` bundled), exact-content `blobs` sharing, legacy format 1/2/3 rejection, store-owned `query_bm25_candidates`, read-only active corpus opening (`open_readonly`), owned writable staging validation (`validate_staging_db`) running native SQLite FTS5 `integrity-check` (rolled-back transaction preserving exact bytes), live `bm25` statistics verification, FTS5 postings and `search_docsize` verification (`fts5vocab`), canonical cue/segmentation/continuation re-verification via `ingest`, span-in-cue containment checks, and span-verified `read` and literal `--find`.
- **`native/src/retrieval.rs`.** 1 to 4 query execution over store-owned BM25 top-100 candidates, deterministic RRF fusion, and work-aware diversity (`per_work = 2` before backfill up to 5 whole passages).
- **`native/src/snapshot.rs` and `native/src/bin/clec-publish.rs`.** Publisher builds `corpus.sqlite.zst` and `manifest.json`; local `sync` runs one streaming zstd and compressed/decompressed hash verification helper (`stream_verify_zstd_artifact`) before any reuse decision or activation, validates staging SQLite contents under `.sync.lock`, prepares projected `storageBytes` and formatted CLI output before atomically replacing `active.json`, reuses identical valid releases idempotently, and cleans up superseded `.sqlite` files best effort after commit.
- **`native/src/cli.rs` and `native/src/bin/clec.rs`.** `clap` parser with `suggestions` disabled, `schemars`-derived schema, non-TTY JSON stdout, empty stdout with structured JSON stderr on errors, convergent fixed-point `usedBytes` calculation (`converge_rendered_bytes`), and `--max-bytes` enforcement across all stdout paths including `--help` and `--version`.

## Verification evidence at code head `9016757`

All checks below ran on macOS arm64 (`rustc 1.93.0`, `cargo 1.93.0`, `Python 3.14.3`) against committed code head `901675715a5e326a094fb16a95612ecf846310dd`. Release binary SHA-256 hashes at `9016757` are `cf680bcc41f8da08c3c5d8f12804af90de45fc51e50a5856a46b8f47dcdce45c` (`clec`) and `b881d6db69b8f70543daae70e0c3ddd00d81bbaeee06a6cdc4fcab65e09a82e2` (`clec-publish`).

- `cd native && cargo fmt --check`: pass.
- `cd native && cargo clippy --locked --all-targets -- -D warnings`: pass.
- `cd native && cargo test --locked`: 23 of 23 unit tests pass.
- `cd native && cargo build --release --locked`: pass.
- `python3 evaluation/clec-v1/verify_phase1.py --clec native/target/release/clec --publish native/target/release/clec-publish --report /tmp/clec-phase1-verify-final.json`: 7 of 7 blackbox suites pass (`no_data_lifecycle`, `parser_and_unsupported_flags`, `authored_edge_fixtures`, `authored_ranking_and_diversity`, `real_00318_00575_e2e`, `sync_atomicity_and_import_guards`, `known_bad_controls`).
- Before/after repro probes (`/tmp/clec_repro_round2.py` comparing `509ad27` vs `9016757` on copies of the review artifacts): `bad-stats` (`id=1` `x'000000'`) now rejects at `sync` with exit 5 (`INTEGRITY_MISMATCH`) instead of activating and crashing `search`; cached `invalid-zstd` reuse now rejects with exit 5 (`INVALID_PACKAGE`) and preserves release A and its `manifestPath` instead of returning `reused: true`; overflowing cue `5124095576031:00:00,000` now emits an `Invalid timestamp` diagnostic (causing empty-cue rejection in `clec-publish`) instead of wrapping to `2048384`; `sources --limit 1` with 417-period and 418-period titles now reports `budget.usedBytes == 1001` (`stdoutBytes == 1001`) and `1002` (`stdoutBytes == 1002`) instead of `1000` and `1001`.

## Phase 1 limits and unverified items

- Proves correctness, provenance, sync atomicity, error handling, budget fitting, and navigation on authored fixtures and the 2-work `00318`/`00575` mini-corpus (`machine_unverified`); does not measure full-corpus retrieval quality or multi-hop synthesis quality.
- Verified on macOS arm64 only; Linux and Windows behavior is unverified.
- HTTP manifest/artifact bootstrap, global full-corpus packaging, SAG2/LLM modes, cross-format fuzzy deduplication, and npm/binary distribution remain unsupported and are declared unsupported in `clec schema`.
- Original author log rows (`2026-11-17T12:30:00Z..2026-11-17T14:12:00Z`) in `.audit/clec-native-phase1.tsv` remain `UNVERIFIED` for historical sequencing, and the unavailable prior author transcript audit is `INCONCLUSIVE`.
- Independent Astra acceptance review at the new committed head has not yet run; the parent thread coordinates fresh Astra verification after handoff.
