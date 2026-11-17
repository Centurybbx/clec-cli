# CLEC Phase 3 evaluation harness corrective issues

This ledger records confirmed Unit B defects found during independent review of head `f4d04a7` (reproduced in `.cache/before-repro/before_repro.json`) and tracks each verified fix at `14ef91a`.

## Unit B findings and resolutions

1. **`P3-ALIAS-WORD-OVERLAP`: Canonical alias matching credits partial/disjoint character slices as full coverage.**
   At `f4d04a7`, `evaluation/clec-v1/phase3/score.py` converts byte spans to whitespace-delimited word index intervals. On unspaced Chinese text (`"甲"*100 + "乙"*900`, `100/1000` chars) and single-token English (`"abcdefghij"`, `1/10` chars or disjoint `"fghij"` vs `"a"`), partial or disjoint hits scored `evidenceCoverage: 1.0`, `completeChain: true`, and `conditionLoss: 0`.
   **Resolution (`14ef91a`).** `evaluation/clec-v1/phase3/projection.py` owns canonical projection and UTF-8 byte-boundary validation (`project_source`, `ProjectedSource.project_byte_spans`), mapping raw byte ranges into exact non-whitespace character coordinates under `equiv-v1` Unicode whitespace folding while preserving partial token boundaries and distinct occurrence positions.

2. **`P3-CORPUS-SHA-UNVERIFIED`: `CorpusIndexView` stores `expected_sha256` without hashing the SQLite file.**
   At `f4d04a7`, `CorpusIndexView.__init__` never reads or hashes `db_path` bytes, and `validate_dataset_against_db` accepted `"0"*64` when the dataset declared `"0"*64` against a SQLite file whose actual SHA-256 was `b0b48051...`.
   **Resolution (`14ef91a`).** `CorpusIndexView` stream-hashes the SQLite file before loading or scoring across `validate-dataset`, `run`, and `score-outcomes`, caches one verified view per run with bounded lazy blob/cue/passage caches, verifies `active.json` coherence and mid-run file stability, and logs `actualCorpusSha256` and `corpusFormat`.

3. **`P3-PROVENANCE-SPOOF`: `verify_returned_citation_spans` reads `blobs` by `sourceId` without checking DB metadata or `passageId`.**
   At `f4d04a7`, a hit with spoofed `source.path`, `source.role`, `source.workId`, `source.contentHash`, `work.workId`, and fabricated `passageId` scored `citationRawSpanValid: true` and `completeChain: true`.
   **Resolution (`14ef91a`).** `validate_returned_item` verifies every returned hit, `context` item, `sourceOriginal` item, and `sourceOverview` item against authoritative DB `works`, `sources`, `source_canonical_map`, `passages`, `passage_spans`, and `blobs.raw_bytes`.

4. **`P3-INVALID-CITATION-INFLATES-COVERAGE`: Invalid citations still award coverage and zero condition loss.**
   At `f4d04a7`, `score_question` runs `_item_covers_evidence` on unvalidated `selected_all`. A fabricated quote scored `citationRawSpanValid: false` and `completeChain: false`, while still reporting `evidenceCoverage: 1.0` and `conditionLoss: 0`.
   **Resolution (`14ef91a`).** `ValidatedEvidenceItem` isolates validated evidence from raw outputs; invalid items fail `citationRawSpanValid` and contribute zero to coverage, conditions, and counterexamples, while preserving `null` error denominators and unanswerable handling.

5. **`P3-BUDGET-BYPASS-AND-UNVERIFIED-OUTCOMES`: Scorer checks compact item JSON instead of raw CLI stdout UTF-8 bytes.**
   At `f4d04a7`, `select_items_within_utf8_budget` measured compact single-item JSON (`377` bytes) and passed a `377`-byte budget even when the response envelope measured `1,424` bytes. Saved outcomes lacked raw CLI stdout/stderr provenance.
   **Resolution (`14ef91a`).** `adapter.py` emits `outcomeSchemaVersion: 2` records with raw `stdoutUtf8` and `stderrUtf8` per step. `score.py` validates all returned citations before budget checks, enforces per-call and cumulative caps on actual raw `stdoutUtf8` bytes (stopping at the first over-budget call without skipping), checks `budget.usedBytes` consistency, keeps stderr errors outside stdout caps, and rejects legacy pre-parsed outcomes as `inconclusive`.

6. **`P3-BENCH-MISLABELED-AND-UNRELATED-PROBE`: `bench.py` runs identical commands under `default_bm25` vs `rrf_multiquery` and probes the first vocab word.**
   At `f4d04a7`, when `--blind-queries` is omitted `bench.py` executes identical single-query commands under both labels, and `sqliteOnlyProbe` queries the first `fts5vocab` term rather than the question's tokens.
   **Resolution (`14ef91a`).** `bench.py`, `adapter.py`, and `eval.py` rename the single-query baseline to `single_query_product_baseline`. `bench.py` requires distinct query plans (`1` vs `2..4` angles) or labels `IDENTICAL_QUERY_PLANS` with `no_comparison_identical_query_plans`, warms up and extracts CLI tokens outside timed regions for `sqliteOnlyQuestionMatchedProbe`, enforces `repeats >= 5` and `errorCount == 0` for comparative verdicts, and removes all `9` narration comment lines across `capture_capacity.py`, `score.py`, `bench.py`, and `test_phase3.py`.
