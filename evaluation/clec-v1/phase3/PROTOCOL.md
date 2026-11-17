# CLEC v1 Phase 3 Evaluation Protocol

This protocol defines the Phase 3 retrieval evaluation contract, ablation plan, pre-registered numerical gates, and runtime benchmarking rules on `clec-native-v2`.

## Scope and current status

Phase 3 scaffold and synthetic correctness fixtures verify the evaluation harness itself. This phase does not claim retrieval quality gains, parameter tuning results, or host-model answer quality. Real dataset scoring waits until the parent thread provides independently verified annotation datasets and blind query rewrites.

Do not modify `native/` retrieval behavior or ranking parameters while scaffolding this harness.

## Annotation JSON contract (`schemaVersion: 1`)

The evaluator accepts JSON datasets matching this schema:

```json
{
  "schemaVersion": 1,
  "corpusSha256": "5b14d29d703806cf9710b527425afdb43e833f33f8f30ab3c28b70f835114cb5",
  "split": "development",
  "questions": [
    {
      "id": "opaque-question-id",
      "category": "condition_and_provenance",
      "question": "Question text without answer keywords",
      "answerable": true,
      "workKeys": ["clectw:short-00318"],
      "evidence": [
        {
          "claimId": "claim-1",
          "sourceId": "s_...",
          "path": "collection/web/clectw/transcripts/short-00318.txt",
          "spans": [{"startByte": 120, "endByte": 210}],
          "quote": "Exact UTF-8 slice from blobs.raw_bytes",
          "kind": "required"
        }
      ],
      "notes": "Optional annotation notes"
    }
  ]
}
```

Contract semantics:

- **Opaque IDs and native `SourceId`s.** `id` and `claimId` are opaque strings. `sourceId` must be a full native `s_...` identifier present in the active `clec-native-v2` database.
- **Original UTF-8 byte spans.** Gold `spans` (`startByte`, `endByte`) are half-open UTF-8 byte offsets into `blobs.raw_bytes` of `sourceId`, not `PassageId`s, so evaluation stays valid if passage segmentation changes.
- **AND necessity within `claimId`.** Multiple `evidence` items under the same `claimId` define AND necessity: every item is required to complete the chain.
- **Explicit extension for alternative exact ranges.** If two exact byte ranges express an equivalent obligation under one claim, an `evidence` item may carry an optional string field `alternativeGroup`. Items sharing `(claimId, alternativeGroup)` form a disjunction where covering any one satisfies that group. Items without `alternativeGroup` remain individually required.
- **Canonical alias proof.** When a gold `evidence` item points to a non-canonical `SourceId` collapsed in `source_canonical_map`, a hit on the canonical `SourceId` counts only when `source_canonical_map` proves identical `(canonical_source_id, work_id, role, equivalence_hash)` and the hit's spans cover the matching occurrence in the shared canonical projection. Identical filenames across distinct works never alias.
- **Unanswerable questions (`answerable: false`).** Retrieval returning irrelevant hits on an unanswerable question is normal. The scorer never awards success for empty retrieval. Marking insufficiency requires a later host-model evaluation.

## Planned ranking comparison and confounds

1. **Same-corpus algorithm comparison (`clec-native-v2`).** Compare single-query default BM25 (`clec search <query>`) against current multi-query RRF (`clec search <q1> [<q2>...]`) on the exact same `5b14...` corpus, same `--limit`, same `--per-work`, and same serialized UTF-8 byte budget.
2. **Legacy 0.3.0 baseline separation.** Any historical `0.3.0` product baseline lives in a separately labeled comparison because its corpus (`12,532` uncollapsed sources) and passage segmentation differ. It is never presented as a controlled algorithm ablation.
3. **Runtime query isolation.** Runtime search queries come strictly from `question` or a blind rewrite file (`--query-angle blind_rewrite`). Gold quotes, evidence paths, work keys, and annotation notes never enter runtime queries.

## Pre-registered numerical gates

These gates are fixed before real Phase 3 scoring runs:

1. **Ground-truth validation gate.** `corpusSha256` must match the active corpus release, every `sourceId` and `workKey` must resolve, and every gold `spans` slice must decode from `blobs.raw_bytes` to match `quote` byte-for-byte. Any failure marks the evaluation `inconclusive` rather than dropping cases or reporting zero.
2. **Citation raw-span validity (`0` fabrication).** `100%` of returned passage and original-read spans in CLI outputs must lie within `blobs.raw_bytes` and reconstruct returned `text` identically (`0` fabricated quotes, `0` wrong byte ranges).
3. **Critical condition and counterexample preservation.** Every `condition` and `counterexample` item in a question's `evidence` list is tracked separately (`conditionCoverage`, `counterexampleCoverage`) and required for `completeChain`. Missing any `condition` or `counterexample` fails that chain (`0` critical condition losses for a passing complete chain).
4. **Denominator honesty.** Timeouts, nonzero exits, and budget errors stay in the scheduled denominator (`scheduledCount`), carry `null` coverage and `completeChain: null`, and record `stopReason`.
5. **Fixed serialized UTF-8 byte budget.** Evidence accumulation stops at the first hit exceeding `--max-bytes` (and separately accounts for supplemental read bytes if reads are issued) without skipping oversized hits to select later smaller hits. UTF-8 byte budgets are never reported as model token counts.
6. **Quality gain threshold.** Promotion thresholds require first measuring the `default_bm25` baseline and verifying dataset sample adequacy across categories before fixing a numeric delta target. No arbitrary `90%` target is claimed ahead of baseline measurement.

## Runtime benchmarking protocol (`bench.py`)

Any future latency comparison must use `evaluation/clec-v1/phase3/bench.py` with at least `5` interleaved runs (`A, B, A, B, ...`), reporting median, min-max range, error counts, work counts, and host load average. Whole-process CLI timing (binary startup, query execution, passage verification) and SQLite-only FTS query timing are measured and reported separately.
