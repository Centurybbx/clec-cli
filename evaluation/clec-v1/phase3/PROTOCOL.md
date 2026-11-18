# CLEC Phase 3 Evaluation Protocol

This protocol defines the Phase 3 retrieval evaluation contract, ablation plan, pre-registered numerical gates, and runtime benchmarking rules on `clec-native-v2`.

## Scope and current status

Phase 3 scaffold and synthetic correctness fixtures verify the evaluation harness itself. This phase does not claim retrieval quality gains, parameter tuning results, or host-model answer quality. Real dataset scoring waits until the parent thread provides independently verified annotation datasets and blind query rewrites.

Do not modify `native/` retrieval behavior or ranking parameters while scaffolding this harness.

Use [the local verification guide](LOCAL-VERIFICATION.md) to rerun development cases on a full corpus and compare a change against a saved baseline.

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
- **AND necessity within `claimId`.** Multiple `evidence` items under the same `claimId` define AND necessity. Every item is required to complete the chain.
- **Explicit extension for alternative exact ranges.** If two exact byte ranges express an equivalent obligation under one claim, an `evidence` item may carry an optional string field `alternativeGroup`. Items sharing `(claimId, alternativeGroup)` form a disjunction where covering any one satisfies that group. Items without `alternativeGroup` remain individually required.
- **Canonical alias proof and exact coordinate projection.** When a gold `evidence` item points to a non-canonical `SourceId` collapsed in `source_canonical_map`, a hit on the canonical `SourceId` counts only when `source_canonical_map` proves identical `(canonical_source_id, work_id, role, equivalence_hash)` AND the hit's validated spans cover the exact non-whitespace character-range occurrence of the gold span under `equiv-v1` Unicode whitespace folding (`projection.py`). Partial token boundaries are preserved so subranges like `100/1000` Chinese characters or `1/10` English characters never pass by word overlap. Identical filenames across distinct works never alias.
- **Unanswerable questions (`answerable: false`).** Retrieval returning irrelevant hits on an unanswerable question is normal. The scorer never awards success for empty retrieval. Marking insufficiency requires a later host-model evaluation.

## Outcome artifact contract (`outcomeSchemaVersion: 2`)

Saved evaluation outcomes must use `outcomeSchemaVersion: 2` and preserve raw CLI stdout and stderr UTF-8 strings for each step (`steps[]` containing `step`, `argv`, `exitCode`, `timedOut`, `stdoutUtf8`, `stderrUtf8`).

- **Strict UTF-8 byte capture without newline translation.** `adapter.py` captures subprocess stdout and stderr as raw bytes with no CRLF translation and decodes strictly as UTF-8. Undecodable output sets `stdoutUtf8` (or `stderrUtf8`) to `null` alongside `stdoutDecodeError`, `stdoutRawByteLen`, `stdoutRawSha256`, and bounded base64 raw bytes, marking the question non-completed and unverifiable.
- **No trusted byte-count fields.** `score.py` parses JSON and measures UTF-8 byte length directly from `stdoutUtf8`. Pre-computed byte-count fields or pre-parsed `hits`/`reads` dicts are never trusted.
- **Execution boundary coherence.** `score.py` derives scoreability from every recorded step and rejects failed, timed-out, undecodable, or status-incoherent steps with `null` coverage and `completeChain: null`.
- **Execution grammar and command-plan binding.** Scoreable `completed` outcomes require `stopReason: null`, a valid declared query plan (`mode`, `queryAngle`, `queries`), an initial `search` step whose recorded `argv` matches the adapter command contract and declared queries, and at most one supplemental `read --context 1` step on a non-empty `search` whose requested and returned `passageId`s bind to the preceding `search` hits. Unsupported step sequences, missing or contradictory `argv`, and query or ID mismatches stay in the scheduled denominator as non-scoreable with `null` coverage, `completeChain: null`, and `conditionLoss: null`.
- **Legacy pre-parsed outcomes unsupported.** Unversioned or legacy outcome dicts lacking `outcomeSchemaVersion: 2` and verifiable raw `stdoutUtf8` cannot prove native stdout byte budgets and are rejected as `inconclusive` (`unsupported_outcome_version`).
- **Errors stay on stderr.** Subprocess error JSON on `stderrUtf8` does not count toward stdout byte budgets.
- **Evaluator memory separation.** `CorpusIndexView` uses a bounded lazy blob/cue cache so evaluator memory stays bounded and separate from consumer `clec` RSS.

## Planned ranking comparison and confounds

1. **Same-corpus algorithm comparison (`clec-native-v2`).** Compare the single-query product baseline (`clec search <query>`, labeled `single_query_product_baseline`, which runs single-query BM25 + RRF score transform + `per_work` diversity + provenance verification) against multi-query RRF (`clec search <q1> [<q2>...]`, labeled `rrf_multiquery`) on the exact same corpus, `--limit`, `--per-work`, and serialized stdout UTF-8 byte budget.
2. **Legacy 0.3.0 baseline separation.** Any historical `0.3.0` product baseline lives in a separately labeled comparison because its corpus (`12,532` uncollapsed sources) and passage segmentation differ. It is never presented as a controlled algorithm ablation.
3. **Runtime query isolation.** Runtime search queries come strictly from `question` or a blind rewrite file (`--query-angle blind_rewrite`). `eval.py` and `bench.py` extract only `(id, question)` at the dataset boundary into immutable slotted `adapter.RuntimeQuestion` records before calling `adapter.execute_dataset_queries` or `adapter.build_runtime_queries`. Both entrypoints reject gold-bearing dicts or mappings before spawning any CLI subprocess, keeping gold quotes, evidence spans, paths, work keys, answerability, and annotation notes exclusively in validation and scoring.

## Pre-registered numerical gates

These gates are fixed before real Phase 3 scoring runs:

1. **Cryptographic corpus SHA-256 and active-state validation gate.** `validate-dataset`, `run`, `score-outcomes`, and `bench.py` must verify `active.json` (`release` and `manifestPath` coherence) and stream-verify the active SQLite file's SHA-256 against `corpusSha256` before loading or scoring (caching one verified `CorpusIndexView` per run and logging `actualCorpusSha256` and `corpusFormat`). Every `sourceId` and `workKey` must resolve, and every gold `spans` slice must decode from `blobs.raw_bytes` to match `quote` byte-for-byte. Any mismatch marks the evaluation `inconclusive`.
2. **Provenance and citation raw-span validity (`0` fabrication, `0` spoofing).** `100%` of returned items across all `steps` (including hits beyond `topK`, `context` items, `sourceOriginal` reads, and items inside over-budget calls) must validate against authoritative DB `works`, `sources`, `source_canonical_map`, `passages`, `passage_spans`, and `blobs.raw_bytes` BEFORE budget selection. Invalid items fail the citation gate and contribute zero evidence to coverage, conditions, or counterexamples.
3. **Critical condition and counterexample preservation.** Every `condition` and `counterexample` item in a question's `evidence` list is tracked separately (`conditionCoverage`, `counterexampleCoverage`) and required for `completeChain`. Missing any `condition` or `counterexample` fails that chain (`0` critical condition losses for a passing complete chain).
4. **Denominator honesty.** Timeouts, nonzero exits, and budget errors stay in the scheduled denominator (`scheduledCount`), carry `null` coverage and `completeChain: null`, and record `stopReason`.
5. **Fixed serialized UTF-8 byte budgets.** Both per-call full-response caps (`stdoutByteBudget` on `search`, `readByteBudget` on `read`) and optional cumulative multi-call evidence caps (`cumulativeStdoutByteBudget` across `search` + supplemental `read` calls) are enforced on raw `stdoutUtf8` byte lengths. Budget accumulation stops at the first call exceeding the cap without skipping oversized responses to credit smaller later calls. UTF-8 byte budgets are never reported as model token counts.
6. **Quality gain threshold.** Promotion thresholds require first measuring the `single_query_product_baseline` and verifying dataset sample adequacy across categories before fixing a numeric delta target. No arbitrary `90%` target is claimed ahead of baseline measurement.

## Runtime benchmarking protocol (`bench.py`)

Any future latency comparison must use `evaluation/clec-v1/phase3/bench.py` with at least `5` interleaved runs (`A, B, A, B, ...`), warmup and query preparation strictly outside timed regions, error counts (`0` required for comparative verdicts), verified work/candidate counts, and host load average. Comparative timing requires genuinely distinct effective query plans (`1` query vs `2..4` distinct effective blind rewrites under actual product normalization); duplicate-only or semantically identical query sets are labeled `IDENTICAL_QUERY_PLANS` with `no_comparison_identical_query_plans`. Whole-process CLI timing and question-matched SQLite-only FTS5 + `per_work` diversity diagnostic probes are measured and reported separately.
