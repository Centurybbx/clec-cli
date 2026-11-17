# CLEC native Phase 1 report

Phase 1 delivers the `native/` Rust crate (`clec_core`, `clec`, and `clec-publish`), the `evaluation/clec-v1/` verification protocol and blackbox driver, and the architecture, issue ledger, and completion records in `docs/agent-work/clec-native/`.

## Baseline and corrective scope

Base commit `cc35732` preserved `cli/`, `backend/`, `collection/`, and `evaluation/audio-check/` untouched. Independent review of the initial Phase 1 head (`8415e34`) found two P1 sync atomicity defects, two P1 import validation defects, one P2 stdout budget bypass on help/version, and structural and blackbox oracle gaps tracked in `docs/agent-work/clec-native/phase1-issues.md`.

All code and test fixes landed cleanly through committed code head `e7b1647` (`e7b1647d485e1ba6fed21d5d2644e88579476733`). This final documentation commit updates `phase1-issues.md` and `phase1-report.md` only and records the exact verified code head `e7b1647`.

## Implemented deliverables

- **`native/src/domain.rs`.** Typed IDs (`WorkId`, `SourceId`, `PassageId`, `ReleaseHash`), `SourceRole`, `Attribution`, `BoundaryKind`, encapsulated `ByteSpan`, `DateYmd`, `ClecError`, and `ErrorEnvelope`. `Deserialize` routes through validated `parse` and `new` constructors, and `JsonSchema` emits regex and range constraints.
- **`native/src/ingest.rs`.** UTF-8 validation, BOM/CRLF/emoji/overlap-preserving SRT/STR/VTT cue parsing with recovery diagnostics, and Unicode scalar segmentation (`1000..1200` target, `2000` hard cap, continuation tracking, and multi-span subtitle cue grouping).
- **`native/src/lexical.rs`.** Search-only normalization via `ferrous-opencc` (`tw2s`), NFKC, lowercasing, `jieba-rs` segmentation, and hex-encoded FTS5 tokens preserving `0050`, `QQQ`, and `4%`.
- **`native/src/store.rs`.** `clec-native-v1` SQLite schema (`rusqlite` bundled), exact-content `blobs` sharing, legacy format 1/2/3 rejection, store-owned `query_bm25_candidates`, pre-activation FTS5 postings and `search_docsize` verification (`fts5vocab`), canonical cue/segmentation/continuation re-verification via `ingest`, span-in-cue containment checks, and span-verified `read` and literal `--find`.
- **`native/src/retrieval.rs`.** 1 to 4 query execution over store-owned BM25 top-100 candidates, deterministic RRF fusion, and work-aware diversity (`per_work = 2` before backfill up to 5 whole passages).
- **`native/src/snapshot.rs` and `native/src/bin/clec-publish.rs`.** Publisher builds `corpus.sqlite.zst` and `manifest.json`; local `sync` validates compressed/decompressed hashes and full SQLite contents under `.sync.lock`, prepares projected `storageBytes` and formatted CLI output before atomically replacing `active.json`, reuses identical releases idempotently, and cleans up superseded `.sqlite` files best effort after commit.
- **`native/src/cli.rs` and `native/src/bin/clec.rs`.** `clap` parser with `suggestions` disabled, `schemars`-derived schema, non-TTY JSON stdout, empty stdout with structured JSON stderr on errors, and `--max-bytes` enforcement across all stdout paths including `--help` and `--version`.

## Verification evidence at code head `e7b1647`

All checks below ran on macOS arm64 (`rustc 1.93.0`, `cargo 1.93.0`, `Python 3.14.3`) on clean committed code head `e7b1647d485e1ba6fed21d5d2644e88579476733` (`gitDirty = false`). Release binary SHA-256 hashes at `e7b1647` are `8be08f0241b01e17e7bff2684fdb8e70b6651b87a8a5efd64103592ca71c1fb2` (`clec`) and `a836395f7bf93b94b5aece9766a6a317c20ff5b3ef34ae12e238dc227d366716` (`clec-publish`).

- `cd native && cargo fmt --check`: pass.
- `cd native && cargo clippy --locked --all-targets -- -D warnings`: pass.
- `cd native && cargo test --locked`: 19 of 19 unit tests pass.
- `cd native && cargo build --release --locked`: pass.
- `python3 evaluation/clec-v1/verify_phase1.py --clec native/target/release/clec --publish native/target/release/clec-publish --report /tmp/clec-phase1-verify-e7b1647.json`: 7 of 7 blackbox suites pass (`no_data_lifecycle`, `parser_and_unsupported_flags`, `authored_edge_fixtures`, `authored_ranking_and_diversity`, `real_00318_00575_e2e`, `sync_atomicity_and_import_guards`, `known_bad_controls`).
- Before/after repro probes (`/tmp/clec_repro_probes.py`) comparing `8415e34` vs `e7b1647`: budget rejection now preserves release A (`e6d4f3a2...`) and `A.sqlite`; `active.json` directory obstruction fails before activation and preserves `A.sqlite`; empty/misplaced FTS postings exit 5 (`INTEGRITY_MISMATCH`); shifted cue timestamps, wrong `cue_ordinal`, and forged continuations exit 5 (`INVALID_PACKAGE`); `--max-bytes 1 --help` exits 2 with empty stdout and `OUTPUT_BUDGET_TOO_SMALL` on stderr.

## Phase 1 limits and unverified items

- Proves correctness, provenance, sync atomicity, error handling, budget fitting, and navigation on authored fixtures and the 2-work `00318`/`00575` mini-corpus (`machine_unverified`); does not measure full-corpus retrieval quality or multi-hop synthesis quality.
- Verified on macOS arm64 only; Linux and Windows behavior is unverified.
- HTTP manifest/artifact bootstrap, global full-corpus packaging, SAG2/LLM modes, cross-format fuzzy deduplication, and npm/binary distribution remain unsupported and are declared unsupported in `clec schema`.
- Original author log rows (`2026-11-17T12:30:00Z..2026-11-17T14:12:00Z`) in `.audit/clec-native-phase1.tsv` remain `UNVERIFIED` for historical sequencing, and the unavailable prior author transcript audit is `INCONCLUSIVE`.
- Independent Astra acceptance review at the new committed head has not yet run; the parent thread coordinates fresh Astra verification after handoff.
