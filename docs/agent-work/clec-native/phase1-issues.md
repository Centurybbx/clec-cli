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
