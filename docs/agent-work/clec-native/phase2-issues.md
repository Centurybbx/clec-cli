# CLEC native Phase 2 corrective issues

This ledger records confirmed Unit A defects found during independent review of head `f4d04a7` and tracks each verified fix.

## Unit A findings (at `f4d04a7`)

1. **`P2-DETERMINISM-CANONICAL-MAP`: `clec-publish` produces non-deterministic SQLite and `.zst` hashes across identical runs.**
   At `f4d04a7`, `native/src/snapshot.rs` builds `groups: HashMap<(String, SourceRole, String), Vec<usize>>` and iterates `groups.values()` when inserting rows into `source_canonical_map`. Three identical synthetic builds with multiple equivalence groups produced three distinct SQLite SHA-256 digests (`847844f4...`, `4df2948d...`, `d1715021...`, recorded in `.cache/before-repro/before_repro.json`).
   **Status.** OPEN (fix planned: replace non-deterministic `HashMap` iteration with domain-sorted `BTreeMap` and canonical row sorting, verify 3+ synthetic repeat builds and 2 sequential full-corpus rebuilds produce byte-identical SQLite and `.zst` digests, and prove logical equality against the preserved `5b14` reference corpus via streaming semantic digests over all tables and `fts5vocab` postings mapped by `PassageId`).

2. **`P2-CAPACITY-DELETED-ARTIFACTS`: Deleted `a409...` capacity-run artifacts leave table-content equality unproved.**
   In the prior worktree's `.cache/phase2/capacity-run/`, the built `.sqlite` and `.sqlite.zst` files for `a4091fa6...` were removed after `capture_capacity.py` ran, even though `capacity-report.json` recorded `"artifactsKept": true`. Aggregate row counts matched `5b14`, but row-level content and posting equality were not verified.
   **Status.** OPEN (fix planned: append honest correction in `docs/agent-work/clec-native/phase2-report.md`, preserve future deterministic full-corpus `publish-target` and `sync-data` artifacts plus raw logs in this worktree's `.cache/phase2/`, and run full semantic comparison against `5b14`).

3. **`P2-CAPACITY-MEASUREMENT-CONTRACT`: `3.0016 GB` figure is a scoped component estimate, and `capture_capacity.py` sets only `TMPDIR`.**
   At `f4d04a7`, `capture_capacity.py` sets only `TMPDIR` (omitting `SQLITE_TMPDIR`, `TEMP`, `TMP`), walks directories for logical byte size only (omitting allocated disk blocks), and labels `sqliteBytes + 2 * postingBucketSetBytes + 65536` as a conservative worst-case storage bound without listing excluded SQLite journals, temp B-tree spills, filesystem allocation slack, and OS buffers.
   **Status.** OPEN (fix planned: set `TMPDIR`, `SQLITE_TMPDIR`, `TEMP`, and `TMP` explicitly; report both logical bytes and allocated blocks as `polled_50ms_sampled_lower_bound`; extract `estimate_posting_buckets_bytes` and separate scoped component storage estimates with explicit uncovered-overhead list; remove line 254 narration comment; reconcile `evaluation/clec-v1/phase2/PROTOCOL.md` and rerun full capacity capture with retained artifacts and 14 baseline input hash checks).
