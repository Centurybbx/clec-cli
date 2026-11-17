# CLEC v1 Phase 1 Verification Protocol

This protocol defines how to verify the Phase 1 Rust binaries (`clec-publish` and `clec`) against functional correctness, exact provenance, error handling, and output budget invariants.

## Scope and limits

Phase 1 proves correctness and source navigation on authored edge fixtures and a bounded real-source corpus (`evaluation/audio-check/00318` and `00575`). It does not claim full-corpus retrieval quality, multi-hop semantic superiority, cross-platform compatibility beyond the tested macOS host, or HTTP bootstrap readiness.

The `clec` and `clec-publish` binaries have no Python or system SQLite runtime requirement. The development verification driver `evaluation/clec-v1/verify_phase1.py` requires Python 3.14 or newer because it uses standard-library `compression.zstd` to construct tampered zstd packages for rollback tests.

## Separation of evaluation sets

Keep development regressions separate from future sealed heldout scoring.

1. **Development regression suite.** Runs locally via `evaluation/clec-v1/verify_phase1.py` against authored edge fixtures and the two tracked `evaluation/audio-check/` episodes (`00318` and `00575`, marked `machine_unverified`). Failures block Phase 1 acceptance.
2. **Sealed work-group heldout suite (Phase 2+).** Reserved for future evaluation on unseen work groups and full-corpus retrieval metrics. Do not tune Phase 1 rules against private heldout payloads, and do not report Phase 1 development checks as full-corpus quality scores.

## Verification artifact schema

Each run of `verify_phase1.py` writes one JSON report with these fields.

- `schemaVersion`: integer `1`.
- `timestamp`: ISO-8601 UTC timestamp.
- `gitHead`: current commit SHA.
- `gitDirty`: boolean indicating whether the git working tree has uncommitted or untracked changes.
- `gitDirtyDigest`: SHA-256 hex digest over git status and diff when `gitDirty` is true, or `null` when clean.
- `binaries`: `clec` and `clecPublish` objects, each with `path` and `sha256`.
- `corpora`: list of built release records, each with `name`, `manifestPath`, `corpusFormat`, `decompressedSha256`, `compressedSha256`, `bytes`, `compressedBytes`, and `counts`.
- `checks`: ordered list of test records. Every record logs `name`, `status` (`PASS` or `FAIL`), `commands` (each with `argv`, `exitCode`, `stdout`, `stderr`), and `detail`.
- `summary`: `total`, `passed`, `failed`, and `allPassed` boolean.

Failures stay visible in `checks` and exit with nonzero status.

## Required check categories and known-bad controls

Every verification run must pass all functional checks and confirm that known-bad controls fail as expected.

1. **No-data lifecycle.** `status`, `schema`, `--help`, and `--version` succeed without an active corpus and without network access. `search` and `read` fail with nonzero exit, empty stdout, and one JSON error object on stderr.
2. **Parser and unsupported flags.** Unknown flags, missing arguments, 0 or 5 queries, and `--sag2` exit nonzero with empty stdout, structured JSON on stderr (`code`, `message`, `remedy`, `next`), and no fuzzy suggestions.
3. **Authored edge fixtures and ranking/diversity oracle.** Exercise BOM, CRLF, emoji (4-byte UTF-8), overlapping subtitle cues, malformed cue recovery with diagnostics, unpunctuated long text hard cuts, Q/A boundaries, duplicate bytes shared across two distinct `WorkId` values, and `0050` / `QQQ` / `4%` lexical preservation. Verify an independently calculated multi-query RRF (`1 / (60 + rank + 1)` summed across queries, ties broken by best rank then `PassageId`) and work-aware diversity (`per_work = 2`) suite where one work holds multiple distinct facts, and assert returned `spans` match both stored SQLite `passage_spans` and authored raw-byte offsets.
4. **Tracked real mini-corpus (`00318` and `00575`).** Publish `.txt`, `.srt`, and `.vtt` sources with explicit `WorkId` entries and `machine_unverified` attribution. Verify Traditional/Simplified lexical equivalence, multi-query deterministic RRF ordering, `read p_... --context 1`, `read s_... --original`, literal `--find`, and multi-span subtitle provenance matching stored SQLite offsets.
5. **Output budget (`--max-bytes`).** Verify that `search` omits trailing whole results and reports `omittedCount` rather than truncating JSON or passage text, and that an impossibly small `--max-bytes` returns `OUTPUT_BUDGET_TOO_SMALL` on `search`, `sync`, `status`, `--help`, and `--version`. Error envelopes on stderr are outside the stdout byte cap.
6. **Sync atomicity, integrity, relocation, idempotence, and rollback.** Verify zstd decompression, compressed/decompressed hash validation, idempotent repeat sync, readable relocated `--data-dir`, and preservation of the prior active release and config on corrupt manifest, corrupt zstd payload, legacy format 1/2/3 package, tampered passage text, tampered cue timestamps, wrong `cue_ordinal`, tampered span payload, empty FTS5 postings, misplaced same-count FTS5 postings, tampered continuation links, `--max-bytes` rejection on `sync`, activation-record filesystem obstruction, and `.sync.lock` contention.
7. **Rebuild ID stability and drift protection.** Rebuilding identical inputs yields identical `WorkId`, `SourceId`, and `PassageId` values. Rebuilding after editing one byte changes the affected `SourceId` and `PassageId` so stale IDs cannot resolve silently to new text.
8. **Known-bad controls.** Run negative probes inside the driver to prove the harness catches wrong returned text, wrong byte-span offsets with identical reconstructed text (repeated identical occurrence), and wrong error envelopes rather than passing on nonempty output.
