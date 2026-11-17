# CLEC Native Phase 1 Report

Phase 1 delivers the `native/` Rust crate (`clec_core`, `clec`, and `clec-publish`), the `evaluation/clec-v1/` verification protocol and blackbox driver, and the architecture and completion records in `docs/agent-work/clec-native/`.

## Baseline before changes

At base commit `cc35732`, `cli/` ran cleanly in this isolated worktree (`npm ci --prefix cli`, `npm run build --prefix cli`, `npm run typecheck --prefix cli`, and `npm test --prefix cli` passed 5 of 5 tests on Node `v25.7.0`). Existing `cli/`, `backend/`, `collection/`, and `evaluation/audio-check/` files remain unmodified.

## Implemented deliverables

- **`native/src/domain.rs`.** Typed IDs (`WorkId` `w_...`, `SourceId` `s_...`, `PassageId` `p_...`, `ReleaseHash`), `SourceRole` (`transcript`, `qa`, `summary`, `document`), `Attribution`, `BoundaryKind`, `ByteSpan`, `DateYmd`, `ClecError`, and structured JSON `ErrorEnvelope` (`code`, `message`, `remedy`, `next`).
- **`native/src/ingest.rs`.** UTF-8 validation, BOM/CRLF/emoji/overlap-preserving SRT/STR/VTT cue parsing with recovery diagnostics, and Unicode scalar segmentation (`1000..1200` target, `2000` hard cap, continuation tracking, and multi-span subtitle cue grouping).
- **`native/src/lexical.rs`.** Search-only normalization via `ferrous-opencc` (`tw2s`), NFKC, lowercasing, `jieba-rs` segmentation, and hex-encoded FTS5 tokens preserving `0050`, `QQQ`, and `4%`.
- **`native/src/store.rs`.** `clec-native-v1` SQLite schema (`rusqlite` bundled), exact-content `blobs` sharing, numeric cue metadata columns, legacy format 1/2/3 rejection, full pre-activation integrity validation, and span-verified `read` and literal `--find`.
- **`native/src/retrieval.rs`.** 1 to 4 query execution, BM25 top 100 per query, deterministic RRF fusion, and work-aware diversity (`per_work = 2` before backfill up to 5 whole passages).
- **`native/src/snapshot.rs` and `native/src/bin/clec-publish.rs`.** Publisher builds `corpus.sqlite.zst` plus `manifest.json`; local `sync --manifest FILE` verifies compressed and decompressed sizes/hashes, OS-locks `--data-dir` via `std::fs::File::lock`, validates schema/spans/cues, activates `current` atomically, reuses identical releases idempotently, and preserves the prior release on any failure.
- **`native/src/cli.rs` and `native/src/bin/clec.rs`.** `clap` parser with `suggestions` disabled, `schemars`-derived `schema`, non-TTY JSON stdout, empty stdout with structured JSON stderr on every error, `--max-bytes` whole-result budget enforcement, and offline-only `status`/`schema`/`help`/`version`.

## Verification evidence

All checks below ran on macOS arm64 (`rustc 1.93.0`, `cargo 1.93.0`, `Python 3.14.3`) against the final source and release binaries (`clec` SHA-256 `497cd61a9e08069dce484e13a72823e3ee52dab74f58b6d6db77c2d80b373e9b`, `clec-publish` SHA-256 `0c840d4c28664df2dcd13e298ed812522229b0d7fb98be8fe9d67f88f368fc8b`).

- `cd native && cargo fmt --check`: pass.
- `cd native && cargo clippy --all-targets -- -D warnings`: pass.
- `cd native && cargo test`: 14 of 14 unit tests pass.
- `cd native && cargo build --release`: pass.
- `python3 evaluation/clec-v1/verify_phase1.py --clec native/target/release/clec --publish native/target/release/clec-publish --report /tmp/clec-phase1-verify-report.json`: 5 of 5 blackbox suites pass (`no_data_lifecycle`, `parser_and_unsupported_flags`, `authored_edge_fixtures` with 5 sources and 4 shared blobs, `real_00318_00575_e2e` with 2 works, 6 sources, 6 passages, and 178 cues, and `known_bad_controls`).

## Phase 1 limits and unverified items

- Proves correctness, provenance, error handling, budget fitting, and navigation on authored fixtures and the 2-work `00318`/`00575` mini-corpus (`machine_unverified`); does not measure full-corpus retrieval quality or multi-hop synthesis quality.
- Verified on macOS arm64 only; Linux and Windows behavior is unverified.
- HTTP manifest/artifact bootstrap, global full-corpus packaging, SAG2/LLM modes, cross-format fuzzy deduplication, and npm/binary distribution are unimplemented and marked unsupported in `clec schema`.
- Independent Astra review has not yet run (parent thread coordinates review after handoff).
