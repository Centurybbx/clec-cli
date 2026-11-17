# CLEC Native Phase 1 Architecture and Workflow

This document records the settled Phase 1 design for the Rust `native/` package (`clec_core`, `clec`, and `clec-publish`).

## Module boundaries

The crate `native/src/` organizes code by domain ownership instead of pipeline step files.

- `domain`: typed IDs (`WorkId`, `SourceId`, `PassageId`, `ReleaseHash`), `SourceRole`, `Attribution`, `ByteSpan`, `DateYmd`, `ClecError`, and error exit/remedy mapping, with `Deserialize` routed through validated constructors, encapsulated `ByteSpan` accessors, and constraint-aware `JsonSchema` output.
- `ingest`: UTF-8 validation, BOM/CRLF-preserving text extraction, SRT/STR/VTT cue parsing with recovery diagnostics, and Unicode scalar segmentation (`1000..1200` target, `2000` hard cap, multi-span passage mapping).
- `lexical`: Traditional-to-Simplified conversion via `ferrous-opencc` (`tw2s`), NFKC normalization, lowercasing, `jieba-rs` segmentation, and explicit preservation of ticker/number/percent tokens (`0050`, `qqq`, `4%`).
- `store`: `clec-native-v1` SQLite schema via bundled `rusqlite`, exact-content `blobs` sharing, schema/blob/source/cue/span/continuation/FTS5-postings pre-activation validation, store-owned BM25 candidate queries, and read queries verified against raw bytes.
- `retrieval`: 1 to 4 query execution over store-owned BM25 top-100 candidates per query, deterministic RRF fusion, and work-aware diversity (default 2 per work before backfill up to 5).
- `snapshot`: publisher build (`corpus.sqlite` + `corpus.sqlite.zst` + `manifest.json`) and atomic local `sync` with OS file locking (`std::fs::File::lock`), single authoritative activation record (`active.json`), pre-commit validation and output/budget preparation, idempotent reuse, and best-effort post-commit cleanup.
- `cli`: `clap` parser (`suggestions` disabled), `schemars`-derived schema output, non-TTY JSON output, consistent `--max-bytes` stdout enforcement (including `--help` and `--version`), stdout/stderr error separation, and subcommand dispatch.

## Corpus format `clec-native-v1`

The SQLite schema stores explicit domain entities and raw UTF-8 provenance. Legacy format revisions 1, 2, and 3 are rejected with no compatibility layer.

- `metadata(key, value)`: holds `corpus_format = 'clec-native-v1'` and `segmentation_revision`.
- `blobs(content_hash, raw_bytes, byte_len)`: stores exact raw source bytes once per SHA-256 digest.
- `works(id, work_key, title)`: explicit `w_...` identity supplied by publisher intake.
- `sources(id, work_id, path, title, role, attribution, quality, date, date_basis, origin, content_hash)`: explicit `s_...` identity derived from work, path, metadata, and `content_hash`.
- `source_diagnostics(source_id, ordinal, message)`: cue extraction warnings and recovery notes.
- `cues(source_id, ordinal, original_identifier, raw_start_byte, raw_end_byte, text_start_byte, text_end_byte, start_ms, end_ms)`: numeric SQLite integer columns for cue times and half-open UTF-8 byte spans.
- `passages(id, source_id, work_id, ordinal, boundary, is_continuation, continued_from, continued_to, text)`: explicit `p_...` identity derived from `source_id`, `segmentation_revision`, and its ordered span list.
- `passage_spans(passage_id, span_ordinal, start_byte, end_byte, cue_ordinal)`: ordered half-open UTF-8 byte spans into `blobs.raw_bytes`. Plain text uses one span; combined subtitle cues list every cue payload span without claiming contiguity across timestamps.
- `search` (`fts5` over `title_tokens`, `body_tokens`, `content=''`, `tokenize='ascii'`): stores hex-encoded normalized tokens so SQLite never strips `%` or splits mixed alphanumeric tokens.
- `inventory(path, work_key, status, reason, content_hash)`: records admitted and excluded intake inputs.

## Throughput checkpoint

1. **Correctness invariant.** Every `read` and `search` passage verifies its text against `blobs.raw_bytes` and `passage_spans` before returning. Any mismatch triggers `INTEGRITY_MISMATCH`. Pre-activation `sync` validates FTS5 postings (`rowid`, column, offset, token) against source-derived normalized tokens, re-extracts cues and segmentation via `ingest` to verify cue metadata and span containment, and verifies continuation adjacency.
2. **Atomic activation.** One authoritative record (`active.json`) in `--data-dir` stores the active `release` hash and `manifestPath`. All fallible work (manifest checks, zstd decompression, SQLite validation, projected `storageBytes`, and `--max-bytes` output preparation) completes under `.sync.lock` before `active.json` is atomically replaced. Post-commit cleanup of superseded `.sqlite` files runs best effort without failing a committed sync.
3. **Isolation and safety.** All tests and verification runs use disposable temporary directories. Existing user installs and tracked raw collection files stay untouched.
4. **Verifiable delivery sequence.** Each module unit ends with `cargo test --locked` before starting the next unit, followed by `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo build --release --locked`, and the blackbox verification script. Acceptance requires independent Astra review at the final committed head.
5. **Phase 1 boundaries.** Network bootstrap, global full-corpus packaging, SAG2/LLM calls, cross-format fuzzy deduplication, and non-macOS CI remain out of scope and are declared unsupported in `clec schema`.
