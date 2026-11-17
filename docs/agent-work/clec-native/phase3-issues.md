# CLEC Phase 3 evaluation harness corrective issues

This ledger records confirmed Unit B defects found during independent review of head `f4d04a7` (reproduced in `.cache/before-repro/before_repro.json`) and tracks each verified fix.

## Unit B findings (at `f4d04a7`)

1. **`P3-ALIAS-WORD-OVERLAP`: Canonical alias matching credits partial/disjoint character slices as full coverage.**
   At `f4d04a7`, `evaluation/clec-v1/phase3/score.py` converts byte spans to whitespace-delimited word index intervals. On unspaced Chinese text (`"甲"*100 + "乙"*900`, `100/1000` chars) and single-token English (`"abcdefghij"`, `1/10` chars or disjoint `"fghij"` vs `"a"`), partial or disjoint hits scored `evidenceCoverage: 1.0`, `completeChain: true`, and `conditionLoss: 0`.
   **Status.** OPEN (fix planned: extract `evaluation/clec-v1/phase3/projection.py` to project raw UTF-8 validated byte spans into exact canonical non-whitespace character-range coordinates under `equiv-v1` Unicode whitespace folding, preserving partial token boundaries and exact occurrence positions).

2. **`P3-CORPUS-SHA-UNVERIFIED`: `CorpusIndexView` stores `expected_sha256` without hashing the SQLite file.**
   At `f4d04a7`, `CorpusIndexView.__init__` never reads or hashes `db_path` bytes, and `validate_dataset_against_db` accepted `"0"*64` when the dataset declared `"0"*64` against a SQLite file whose actual SHA-256 was `b0b48051...`.
   **Status.** OPEN (fix planned: stream-hash SQLite bytes in `CorpusIndexView` before loading or scoring across `validate-dataset`, `run`, and `score-outcomes`, cache one verified view per run, detect stale/swapped files, and log `actualCorpusSha256` and `corpusFormat`).

3. **`P3-PROVENANCE-SPOOF`: `verify_returned_citation_spans` reads `blobs` by `sourceId` without checking DB metadata or `passageId`.**
   At `f4d04a7`, a hit with spoofed `source.path`, `source.role`, `source.workId`, `source.contentHash`, `work.workId`, and fabricated `passageId` scored `citationRawSpanValid: true` and `completeChain: true`.
   **Status.** OPEN (fix planned: validate every returned hit, `context` item, `sourceOriginal` item, and `sourceOverview` item against authoritative DB `works`, `sources`, `source_canonical_map`, `passages`, `passage_spans`, and `blobs.raw_bytes`).

4. **`P3-INVALID-CITATION-INFLATES-COVERAGE`: Invalid citations still award coverage and zero condition loss.**
   At `f4d04a7`, `score_question` runs `_item_covers_evidence` on unvalidated `selected_all`. A fabricated quote scored `citationRawSpanValid: false` and `completeChain: false`, while still reporting `evidenceCoverage: 1.0` and `conditionLoss: 0`.
   **Status.** OPEN (fix planned: separate `ValidatedEvidenceItem` from raw outputs so invalid items fail the citation gate and contribute zero to coverage, conditions, and counterexamples, while preserving `null` error denominators and unanswerable handling).

5. **`P3-BUDGET-BYPASS-AND-UNVERIFIED-OUTCOMES`: Scorer checks compact item JSON instead of raw CLI stdout UTF-8 bytes.**
   At `f4d04a7`, `select_items_within_utf8_budget` measured compact single-item JSON (`377` bytes) and passed a `377`-byte budget even when the response envelope measured `1,424` bytes. Saved outcomes lacked raw CLI stdout/stderr provenance.
   **Status.** OPEN (fix planned: version outcomes as `outcomeSchemaVersion: 2` with raw `stdoutUtf8` and `stderrUtf8` per step, validate all citations before budget checks, enforce per-call full-response and cumulative evidence stdout caps on actual raw UTF-8 bytes, keep stderr errors outside stdout caps, and reject legacy pre-parsed outcomes as `inconclusive`).

6. **`P3-BENCH-MISLABELED-AND-UNRELATED-PROBE`: `bench.py` runs identical commands under `default_bm25` vs `rrf_multiquery` and probes the first vocab word.**
   At `f4d04a7`, when `--blind-queries` is omitted `bench.py` executes identical single-query commands under both labels, and `sqliteOnlyProbe` queries the first `fts5vocab` term rather than the question's tokens.
   **Status.** OPEN (fix planned: rename single-query arm to `single_query_product_baseline`, require genuinely distinct query plans or label `IDENTICAL_QUERY_PLANS` with no comparison verdict, replace the first-vocab probe with a question-matched SQLite FTS5 + `per_work` probe using pre-extracted CLI tokens outside timed regions, enforce warmup outside timing and error-free comparative verdicts, and remove the 9 narration comments across `score.py`, `bench.py`, and `test_phase3.py`).
