# CLEC v1 Phase 2 Verification Protocol

This protocol defines how to verify Phase 2 native corpus preparation, canonical equivalence deduplication, bounded-memory full-corpus publishing, local sync validation, and CLI behavior on `clec-native-v2`.

## Scope and limits

Phase 2 proves reproducible intake preparation, conservative work grouping, deterministic cross-format deduplication inside `clec_core`, complete provenance retention across all `12,532` admitted sources and `17,972` inventory entries, bounded-resource full-corpus packaging and validation on the local macOS arm64 host, and regression coverage for all Phase 1 invariants. Phase 2 does not claim full-corpus retrieval quality (Phase 3), HTTP bootstrap (Phase 4), SAG2 synthesis (Phase 5), or foreign OS support (Phase 6).

## Evaluation separation

1. **Public regression fixtures (`evaluation/clec-v1/phase2/verify_phase2.py` and `evaluation/audio-check/`).** Exercises authored edge cases, synthetic triples, false-friend non-merge controls, `00318`/`00575` canonical collapse, and tamper/atomicity guards.
2. **Full local corpus build and smoke (`tools/prepare_phase2_intake.py`, `clec-publish`, `clec`).** Runs against `/Users/century/vibing/clec` read-only inputs with output artifacts kept strictly in ignored `.cache/phase2/` and `.audit/`. Any quoted corpus text stays out of committed docs.
3. **Heldout evaluation.** Private heldout payloads remain unread and unmixed with retrieval tuning.

## Capacity feasibility procedure

Before running the full `12,532`-source build:

1. Record host physical RAM (`sysctl hw.memsize`) and free filesystem space (`df -k .`).
2. Run deterministic ascending sample builds (`50` works and `500` works) via `/usr/bin/time -l` for both `clec-publish` and `clec sync`, logging maximum resident set size (`maxRssBytes`), wall seconds, output `.sqlite` and `.zst` sizes, sampled target and `TMPDIR` peak disk, error count, and counts (`works`, `sources`, `canonicalSources`, `blobs`, `passages`, `cues`, `inventory`).
3. Verify the full build only after the `500`-work sample confirms bounded memory growth well below host physical RAM.
4. Run `evaluation/clec-v1/phase2/capture_capacity.py` on the full intake with `TMPDIR` isolated inside the measured run tree, polling target directories and `TMPDIR` every `50` ms while `/usr/bin/time -l` captures max RSS and wall time. Report the polled maximum explicitly as a sampled lower bound alongside the conservative analytical storage bound (`sqliteBytes + 2 * postingBucketSetBytes`, plus prior `sqliteBytes` when replacing an active release).
5. Label all capacity runs explicitly as single-run capacity feasibility measurements, not comparative speed benchmarks.

## Required Phase 2 verification checks

1. **Deterministic intake and reconciliation.** Two independent invocations of `tools/prepare_phase2_intake.py` yield identical SHA-256 digests for `intake.json` and `reconciliation.json`. Every one of the `12,532` old admitted sources and `17,972` old inventory records maps explicitly to a Phase 2 entry with zero silent drops.
2. **Synthetic triples and false friends.**
   - Valid `srt`/`txt`/`md` (`# 語音筆記：...` + `## [ts – ts]`) and `srt`/`vtt`/`txt` triples under one work and role collapse to one canonical subtitle representative (`passages` and `search` contain only canonical passages) while all three `SourceId`s return verbatim `originalText`.
   - False friends never merge: identical title/filename across distinct works, shared archive origin URL across distinct container IDs, punctuation/number edits, unrecognized `.md` renderers, same-text different-role sources (`summary` vs. `transcript`), and identical raw bytes across distinct works (`blobs` shared, `works`/`sources`/`passages` independent).
3. **Canonical validation, 64-bucket scaling, and tamper controls.** `clec sync` rejects packages where a non-canonical source carries passages, where a canonical `.txt` beats an equivalent valid `.srt`, where `source_canonical_map` omits a source or disagrees on `(work_id, role, equivalence_hash)`, or where any Phase 1 tamper control (`bad-stats`, `invalid-zstd` reuse, shifted cue time, wrong `cue_ordinal`, misplaced FTS posting, continuation tamper) is applied. A synthetic `2,001`-passage fixture exercises the `> 2,000` passage `64`-bucket validation path and rejects row `64`/`65` boundary swaps, last-row `2,001` missing or duplicate postings, and global FTS stats corruption while keeping the prior active release intact and leaving zero temporary bucket or staging files behind.
4. **Full corpus validation and CLI smoke.** Full `clec-publish` and `clec sync` succeed cleanly; `clec status`, `clec search`, `clec read p_... --context 1`, `clec read s_... --original` (on both canonical and non-canonical `SourceId`s), `clec sources --canonical-only`, and failed-sync rollback preserve prior active state; baseline root SHA-256 hashes remain unchanged after completion.
