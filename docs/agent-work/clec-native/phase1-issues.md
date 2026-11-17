# CLEC native Phase 1 corrective issues

This ledger tracks every defect, structural gap, and verification gap found during independent review of commit `8415e34` and records the verified fix for each item at code head `e7b1647`.

## P1 atomicity defects

1. **`P1-SYNC-BUDGET`: `sync` commits before `--max-bytes` budget fitting.**
   At `8415e34`, `cli.rs` ran `sync_local` before `serialize_fixed`. Running `clec sync --manifest B --max-bytes 1` after installing release A exited 2 with `OUTPUT_BUDGET_TOO_SMALL`, deleted `A.sqlite`, and activated B (`14941f9a...`).
   **Resolution (`a5aeae4`, verified at `e7b1647`).** `cli.rs` now calls `sync_local_with_prepare`, which runs `serialize_fixed` while holding `.sync.lock` and before `active.json` is renamed. On budget rejection, `clec` exits 2 with `OUTPUT_BUDGET_TOO_SMALL`, keeps release A active (`e6d4f3a2...`), leaves `A.sqlite` intact, removes `B.sqlite`, and continues serving `search` on A.

2. **`P1-SYNC-ACTIVATION`: Split activation state (`current` and `config.json`) plus post-commit fallible work.**
   At `8415e34`, `snapshot.rs` updated `current` before `write_configured_manifest` and `compute_managed_bytes`. Obstructing `config.json` with a directory exited 4 with `IO_ERROR` after activating release B.
   **Resolution (`a5aeae4`, verified at `e7b1647`).** `snapshot.rs` replaces `current` and `config.json` with one atomic activation record (`active.json`). Manifest checks, zstd decompression, SQLite validation, projected `storageBytes`, and formatted CLI output complete before renaming `.active.tmp` to `active.json`. Old-release cleanup runs best effort after commit with no false failure. Unit tests and `verify_phase1.py` prove preservation of the prior active release on budget rejection, directory obstruction of `active.json`, `.sync.lock` contention (`SYNC_LOCKED`), idempotent reuse, and `--data-dir` relocation.

## P1 import correctness defects

3. **`P1-IMPORT-FTS`: FTS5 validation checks row counts only, not postings.**
   At `8415e34`, `store.rs` accepted a repacked valid-hash database whose `search` FTS5 table was cleared and repopulated with empty tokens (`''`, `''`), causing `search alpha` to return zero hits.
   **Resolution (`36994fb`, verified at `e7b1647`).** `CorpusStore::validate_fts_postings` inspects `fts5vocab(main, search, instance)` and `search_docsize` against source-derived normalized `title_tokens` and `body_tokens` for every `(rowid, col, offset, term)` tuple and per-column token count. Both empty postings and misplaced same-count postings reject with exit 5 (`INTEGRITY_MISMATCH`) before activation.

4. **`P1-IMPORT-CUES`: Cue metadata, span containment, and continuation links are unchecked against canonical ingest.**
   At `8415e34`, `store.rs` accepted repacked valid-hash databases with shifted cue timestamps (`+86400000` ms), wrong `passage_spans.cue_ordinal` (`0` changed to `1`), and forged continuation links.
   **Resolution (`36994fb`, verified at `e7b1647`).** `CorpusStore::validate_cues_and_diagnostics` and `CorpusStore::validate_passages_and_fts` reuse `ingest::extract_source` and `ingest::segment_source` directly without duplicating parser code. Import rejects shifted cue timestamps, wrong `cue_ordinal`, span offsets outside cue payloads, plain-text spans carrying a `cue_ordinal`, and invalid `is_continuation`/`continued_from`/`continued_to` adjacency with exit 5 (`INVALID_PACKAGE` or `INTEGRITY_MISMATCH`) while accepting valid `HardCut` subtitle subspans.

## P2 global budget cap defect

5. **`P2-GLOBAL-CAP`: `--max-bytes` bypass on `--help` and `--version`.**
   At `8415e34`, `clec --max-bytes 1 --help` exited 0 and emitted 1098 bytes on stdout.
   **Resolution (`a5aeae4`, verified at `e7b1647`).** `cli.rs` checks `--max-bytes` on `DisplayHelp` and `DisplayVersion` paths before printing stdout, returning exit 2 with `OUTPUT_BUDGET_TOO_SMALL` on stderr and empty stdout when exceeded. Error envelopes on stderr remain outside the stdout budget.

## Structural, domain, and evidence fixes

6. **`STRUCT-DOMAIN-DESER`: Transparent `Deserialize` and public `ByteSpan` fields bypass constructors.**
   **Resolution (`ac997b5`, verified at `e7b1647`).** `domain.rs` routes `Deserialize` through validated `parse`/`new` constructors for `WorkId`, `SourceId`, `PassageId`, `ReleaseHash`, `DateYmd`, and `ByteSpan`, makes `ByteSpan` fields private with read accessors, removes unused derives, and emits regex/range constraints in `JsonSchema`.

7. **`STRUCT-STORE-BOUNDARY`: Public `CorpusStore::connection` leaks SQLite schema into `retrieval`.**
   **Resolution (`ac997b5`, verified at `e7b1647`).** `CorpusStore::query_bm25_candidates` owns the SQLite BM25 query and returns typed candidates, `pub fn connection` is removed, `retrieval` owns fusion and diversity, and internal modules/types in `clec_core` are narrowed to `pub(crate)`.

8. **`EVIDENCE-BLACKBOX-ORACLES`: Weak span oracle, tautological diversity test, mislabeled tamper test, protocol field drift, and narration comments.**
   **Resolution (`a32cda8` and `e7b1647`).** `PROTOCOL.md` and `verify_phase1.py` now emit matching report fields (`gitHead`, `gitDirty`, `gitDirtyDigest`, `manifestPath`, `decompressedSha256`). `verify_spans_against_sqlite` compares returned offsets against stored `passage_spans` and authored expected offsets. A dedicated `authored_ranking_and_diversity` check proves independently computed RRF scores and two-distinct-fact `per_work = 2` diversity. `sync_atomicity_and_import_guards` tests budget atomicity, lock contention, activation obstruction, passage-text tampering, cue-time shifts, wrong `cue_ordinal`, wrong span payload, empty/misplaced FTS postings, and continuation tampering. `known_bad_controls` checks identical-text wrong-occurrence spans. The 15 narration comments in `verify_phase1.py` were removed.

9. **`EVIDENCE-AUDIT-LOG`: Synthetic future timestamps and unverifiable step history in original `.audit/clec-native-phase1.tsv`.**
   **Resolution (local `.audit/clec-native-phase1.tsv`).** Original rows were preserved append-only. A new `start` row opened the Hydrogen run with real UTC timestamps (`date -u`), superseding the prior chronology and per-step sequencing as `UNVERIFIED` and marking the unavailable prior author transcript audit as `INCONCLUSIVE`.

## Round 2 defects found at `509ad27`

This section tracks the four defects confirmed during independent Astra review at `509ad27`.

10. **`P1-FTS-ENGINE-STATE`: Corrupt FTS5 engine state (`search_data` averages/totals) passes postings checks and crashes at search time.**
    At `509ad27`, repacking a valid corpus after `UPDATE search_data SET block=x'000000' WHERE id=1` and updating manifest hashes/lengths allows `clec sync` to exit 0, then `clec search alpha` exits 1 with `INTERNAL_ERROR` (`database disk image malformed`). `store.rs` verifies `fts5vocab` postings and `search_docsize` but misses FTS5 global statistics and engine state.
    **Resolution (`5b84308`, verified at code head `9016757`).** Testing the premise against `bad-stats` and bundled SQLite 3.54.1 showed that `INSERT INTO search(search) VALUES('integrity-check')` checks segment B-trees and structure (`id=10`) but skips `fts5StorageLoadTotals` (`id=1`) on `content=''` tables. `store.rs` now isolates owned writable staging validation (`CorpusStore::validate_staging_db`) from read-only active queries (`CorpusStore::open_readonly`), runs native SQLite FTS5 `integrity-check` inside an explicit `BEGIN ... ROLLBACK` transaction (preserving exact hashed bytes with zero full-corpus memory copy), and executes `validate_fts_bm25_probe` (`SELECT rowid, bm25(search, 4.0, 1.0) ...`) against expected canonical BM25 scores. Both `bad-stats` (`id=1` `x'000000'`), skewed `id=1` stats (`x'010101'`), corrupt `id=10` structure, and corrupt segment blocks reject with exit 5 before activation.

11. **`P2-REUSE-INCOMING-VALIDATION`: Invalid incoming package accepted on cached release reuse.**
    At `509ad27`, after installing valid release A, syncing a second manifest with A's decompressed `sha256` and `counts`, an artifact containing `b"not a zstd stream"`, and matching `compressedBytes`/`compressedSha256` exits 0 with `reused: true` and overwrites `active.json.manifestPath` (while a fresh `--data-dir` rejects with exit 5 `INVALID_PACKAGE`). `snapshot.rs` returns on the reuse check before streaming zstd decompression and decompressed hash validation.
    **Resolution (`0dc1f88`, verified at code head `9016757`).** `snapshot.rs` now routes both reuse and fresh-install paths through one streaming helper (`stream_verify_zstd_artifact`) that verifies the zstd stream, decompressed byte length, and decompressed SHA-256 before any reuse response or `active.json` mutation. Both fresh and cached syncs reject malformed zstd (`INVALID_PACKAGE`) and valid zstd of wrong bytes (`INTEGRITY_MISMATCH`) with exit 5 while preserving active release A and its `manifestPath`.

12. **`DATA-CUE-TIMESTAMP-OVERFLOW`: Unchecked subtitle cue timestamp arithmetic wraps `u64` in release builds.**
    At `509ad27`, parsing `5124095576031:00:00,000 --> 5124095576031:00:01,000` wraps `u64` arithmetic in `ingest::parse_timestamp_ms`, publishing and importing `startMs: 2048384` and `endMs: 2049384` with empty `diagnostics`.
    **Resolution (`fac0906`, verified at code head `9016757`).** `ingest::parse_timestamp_ms` uses checked arithmetic (`checked_mul`/`checked_add`) and enforces SQLite's signed 64-bit integer bound (`i64::try_from(total_ms)`), emitting `"Invalid timestamp"` diagnostics without panicking, wrapping, or rejecting valid longform hours. `snapshot.rs` also uses checked `i64::try_from` when writing cue timestamps.

13. **`BUG-BUDGET-USED-BYTES-FIXEDPOINT`: Two-pass budget estimation misses decimal-digit boundary shifts.**
    At `509ad27`, padding a source title with 417 periods in `sources --limit 1` yields 1001 stdout UTF-8 bytes while reporting `budget.usedBytes: 1000`. `cli::fit_list_budget` runs two fixed estimation passes before final render instead of converging to a fixed point.
    **Resolution (`c17aae2`, verified at code head `9016757`).** `cli::fit_list_budget` calls `converge_rendered_bytes`, iterating until `rendered.len() == used_bytes` (bounded at 32 steps). `sources`, `search`, and `read` now report `budget.usedBytes == len(stdout_bytes)` across decimal-digit transitions, JSON escaping, tight `--max-bytes` caps, and omitted-ID tracking.
