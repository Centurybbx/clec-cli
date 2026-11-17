# CLEC native Phase 1 corrective issues

This ledger tracks every defect, structural gap, and verification gap found during independent review of commit `8415e34` and defines the acceptance check for each item.

## P1 atomicity defects

1. **`P1-SYNC-BUDGET`: `sync` commits before `--max-bytes` budget fitting.**
   At `8415e34`, `cli.rs` runs `sync_local` before `serialize_fixed`. Running `clec sync --manifest B --max-bytes 1` after installing release A returns `OUTPUT_BUDGET_TOO_SMALL`, activates B, and deletes `A.sqlite`.
   **Acceptance.** Prepare and budget-check the formatted `sync` output while holding `.sync.lock` and before committing the activation record. On budget rejection, return `OUTPUT_BUDGET_TOO_SMALL`, keep release A active and searchable, and leave `A.sqlite` intact.

2. **`P1-SYNC-ACTIVATION`: Split activation state (`current` and `config.json`) plus post-commit fallible work.**
   At `8415e34`, `snapshot.rs` updates `current` before `write_configured_manifest` and `compute_managed_bytes`. Obstructing `config.json` with a directory returns `IO_ERROR` after activating release B.
   **Acceptance.** Replace the split pointer and config files with one atomic activation record (`active.json`). Prepare SQLite validation, projected `storageBytes`, and formatted CLI output before renaming `.active.tmp` to `active.json`. Keep old-release cleanup best effort after commit with no false failure, and verify filesystem obstruction, budget rejection, lock contention (`SYNC_LOCKED`), idempotence, and relocation.

## P1 import correctness defects

3. **`P1-IMPORT-FTS`: FTS5 validation checks row counts only, not postings.**
   At `8415e34`, `store.rs` accepts a repacked valid-hash database whose `search` FTS5 table was cleared and repopulated with empty tokens (`''`, `''`), causing `search` queries to return zero hits.
   **Acceptance.** Validate source-derived normalized `title_tokens` and `body_tokens` postings in `search` (via `fts5vocab` instance inspection) for exact `(rowid, column, offset, token)` match against expected tokens for every passage. Reject empty postings and misplaced postings with identical total counts before activation.

4. **`P1-IMPORT-CUES`: Cue metadata, span containment, and continuation links are unchecked against canonical ingest.**
   At `8415e34`, `store.rs` accepts repacked valid-hash databases with shifted cue timestamps (`+86400000` ms) and wrong `passage_spans.cue_ordinal` (`0` changed to `1` while bytes remain cue 0), and parses `continued_from`/`continued_to` without verifying segmentation or adjacency.
   **Acceptance.** Re-extract expected cues and segmentation directly through `ingest::extract_source` and `ingest::segment_source` (no duplicate parser). Verify complete cue metadata, require every subtitle span to lie inside its referenced cue payload (allowing valid `HardCut` subspans) and plain-text spans to carry `cue_ordinal = None`, and verify `is_continuation`, `continued_from`, and `continued_to` against actual adjacency and segmentation before activation.

## P2 global budget cap defect

5. **`P2-GLOBAL-CAP`: `--max-bytes` bypass on `--help` and `--version`.**
   At `8415e34`, `clec --max-bytes 1 --help` exits 0 and emits 1098 bytes because `clap` exits early on `DisplayHelp` and `DisplayVersion`.
   **Acceptance.** Enforce `--max-bytes` consistently on stdout for `--help`, `--version`, and `help` subcommands, returning `OUTPUT_BUDGET_TOO_SMALL` on stderr with empty stdout and exit code 2 when exceeded. Error envelopes on stderr remain exempt from the stdout cap.

## Structural, domain, and evidence fixes

6. **`STRUCT-DOMAIN-DESER`: Transparent `Deserialize` and public `ByteSpan` fields bypass constructors.**
   Route `Deserialize` through validated `parse` or `new` constructors for `WorkId`, `SourceId`, `PassageId`, `ReleaseHash`, `DateYmd`, and `ByteSpan`. Encapsulate `ByteSpan` fields behind getters, drop unused derives, and reflect format constraints in `JsonSchema`.

7. **`STRUCT-STORE-BOUNDARY`: Public `CorpusStore::connection` leaks SQLite schema into `retrieval`.**
   Remove public `CorpusStore::connection`, move BM25 candidate querying into a store-owned method returning typed candidates, keep RRF fusion and diversity in `retrieval`, and narrow internal items to `pub(crate)`.

8. **`EVIDENCE-BLACKBOX-ORACLES`: Weak span oracle, tautological diversity test, mislabeled tamper test, protocol field drift, and narration comments.**
   Strengthen `verify_spans_against_sqlite` to check stored `passage_spans` offsets and authored expected mappings. Add an independently specified authored RRF and two-distinct-fact same-work diversity suite. Rename the passage-text tamper test accurately and add true cue-time, wrong-cue, wrong-span, empty-FTS, misplaced-FTS, and continuation tamper probes plus atomicity, obstruction, lock, and help-cap checks. Strengthen `known_bad_controls` for same-text wrong-occurrence offsets. Reconcile `PROTOCOL.md` and `verify_phase1.py` report fields (`gitHead`, `gitDirty`, `gitDirtyDigest`, `manifestPath`, `decompressedSha256`), and delete the 15 narration comments in `verify_phase1.py`.

9. **`EVIDENCE-AUDIT-LOG`: Synthetic future timestamps and unverifiable step history in original `.audit/clec-native-phase1.tsv`.**
   Preserve original rows append-only, open a new Hydrogen run with real UTC timestamps, supersede the historical chronology and per-step sequence as `UNVERIFIED`, and record the unavailable prior author transcript audit as `INCONCLUSIVE`.
