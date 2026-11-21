# Stage 0 evaluation freeze for Agent-native search and read

The development baseline and comparison rules are pinned as of 2026-11-20. The independent holdout is still open. Deterministic Stage 1 delivery work and development regressions can proceed on the existing index. Seal and validate the independent holdout before ranking tuning or independent quality acceptance. Use the preserved original CLI to capture its pre-change baseline on the sealed cases. See the [local baseline](BASELINE.md) for the completed runs and the remaining corpus checks.

## Split by work family

Use the same full searchable snapshot for development and holdout runs. Keep questions, evidence labels, and tuning exposure separate. Removing the held-out sources from the index would prevent the Agent from finding their evidence.

- Treat the Phase 3 development set, six adjudicated route cases, and earlier Agent pilots as regression material. Keep the existing Backend E2E holdout reserved for its own evaluator. Keep the earlier Phase 3 evaluation and run artifacts under their original protocol.
- Allocate related questions and every accepted evidence route by work family. Group editions, translations, volumes or chapters of the same work, transcripts and subtitles of the same episode, extracts, slides, summaries, and retellings. Use provenance, episode or edition identifiers, exact content hashes, and proven equivalent text. Trace these links across systems and use the resulting connected groups. A native `work_key` or a filename is an input to the grouping, and ambiguous relationships stay out of the holdout until reviewed.
- Compare the groups against development labels, tuning and adjudication logs, and prior evaluated cases. Have the custodian of any sealed set check overlap without releasing its questions or labels. Record the inputs and exclusions and quarantine overlapping or unresolved groups. When an acceptable route crosses the split, resolve that overlap before freezing the case.
- Give a separate evaluator the candidate inventory, originals, and snapshot. The annotator and evidence reviewer work without target ranking or answer output. The implementation and runtime receive no holdout labels or prior answers. The runtime receives the question when the sealed run begins. Keep questions, labels, and private traces outside Git and out of external services.

## Seal the questions and evidence

Choose natural questions with two or more required facts where appropriate. Cover cross-work comparisons, a condition separated from the main claim, conflicting editions, dense subtitles, and scoped insufficient evidence. Record the number of questions and distinct work families by category. Set the final sample and coverage quotas before running the holdout. The current candidate inventory supports document curation. Subtitle cases still need isolated episode families with evidence checked at the quality level the question requires.

Use the [route benchmark](../../phase3/ROUTE-BENCHMARK.md) for necessary obligations, alternative evidence routes, and exact anchors. For each anchor, store the original asset hash and page, slide, cell, or cue locator when available, plus the snapshot hash, source ID, path, extract hash, and half-open UTF-8 byte spans and quote. For subtitle spans, verify each span and record any omitted interval. If the label requires exact wording or speaker attribution, check the recording. For an extracted document, check that the original layout supports the labeled relationship. Record explicit scope and inspected sources for insufficient-evidence cases.

Have an independent reviewer confirm necessity, conditions, acceptable alternatives, scoped omissions, and attribution. Validate every anchor using the Phase 3 source checks before running retrieval. Freeze the family map, split, questions, labels, rubric, quotas, runtime settings, tool contracts, and artifact hashes in a private receipt. Keep rejected candidates and exclusions in the audit log. Seal the holdout before observing its output. If adjudication changes after the run, version the labels, rescore both sides, and disclose the change. A holdout used to tune behavior becomes development material.

If the index is rebuilt, carry labels via original asset and extract hashes and exact byte coordinates. Resolve new native source IDs and verify the quotes again. Keep the old snapshot and the migration receipt, with any ambiguous or missing mappings reported.

## Run paired comparisons

| Comparison | Fixed settings |
| --- | --- |
| Legacy delivery control | Same corpus, original question, local lexical search, `--limit 5 --per-work 2 --match-mode any`, 32 KiB per call. Compare search alone with the same first search followed by one `read --context 1` on up to three returned IDs. Keep the 64 KiB per-call companion as a diagnostic. |
| Stage 1 delivery | Run the preserved original CLI and candidate builds on the same development cases and index. Repeat on the holdout after it is sealed. At limit 5, hold the ranker and pre-serialization result IDs and order constant. Also test requests for 10 and 20 and both budget sizes. Use a 32 KiB per-call and 64 KiB cumulative stdout budget for the primary two-call comparison. Match the read selection rule and requested context. |
| Agent answer comparison | Use a fresh session per case and build, with the same model revision, runner, instructions, tool access, total call and byte budgets, and retry policy. Pin the actual values before the sealed run. Collect the final answer, actual tool outputs delivered to the Agent, and errors. The deterministic CLI baseline measures retrieval and delivery. A paired Agent answer baseline remains pending. |

Use only offline local execution for Stage 0. Later arm changes, such as ranking, work-family caps, and Jev, get separate comparisons on matched inputs. Report timeouts and failures in the scheduled denominator. Record runtime and usage if measured. Use repeated, controlled runs for any latency or cost claim.

## Metrics and acceptance rules

| Checkpoint | Record |
| --- | --- |
| Retrieval candidates | Candidate and pre-serialization result IDs and ranks where observable, plus route recall and complete evidence at k = 5, 10, and 20. When candidate IDs are unavailable, mark candidate coverage unavailable. A candidate count alone cannot show which stage lost evidence. |
| Search delivery | Requested, selected, delivered, and omitted IDs and counts, actual UTF-8 stdout bytes including the envelope, failures, and whether snippets preserve valid source coordinates. Report whether the delivered IDs locate the necessary evidence and whether the snippets actually show it. |
| Read delivery | Requested IDs, returned complete IDs, skipped IDs, continuation and neighboring IDs, errors, source spans, and actual bytes. Count completed calls and requested IDs delivered. Score the union of evidence the reader can cite after verified reads. Keep the comparable legacy union of search and read output separately. |
| Evidence and answers | An obligation passes when all anchors of at least one accepted route are covered. Report mean obligation recall and the fraction of all scheduled answerable questions with every required obligation covered. Report required conditions and counterexamples separately. For answers, judge each necessary claim, condition, attribution, actual citation and appropriate abstention. Keep insufficient-evidence cases out of retrieval recall and in the answer rubric. Classify failures by the first observed loss in candidates, delivery, selection, read, or answer. |

Use a zero-loss allowance for previously covered critical conditions and counterexamples in the matched Stage 1 development comparison. Preserve previously complete read evidence routes under the matched read selection rule and budget. Compare lead location and read evidence separately. Record any legacy search-and-read route that now needs another read, even if the aggregate lead coverage rises. Phase 3's current condition failures remain deficits in the absolute scores.

Stage 1's contract checks allow zero wrong source or byte coordinates, fabricated quotes, responses over the requested budget, and unreported omissions. If 20 results are eligible and requested, the complete success envelope must deliver 20 within 32,768 bytes. For a smaller cap, check an explicit size error and usable retry. For batch read, verify whole-item delivery, the skipped IDs and minimum bytes for the next item, and the first-item-too-large error. Test long headings, JSON escaping and dense subtitles. These rules do not grant a holdout quality score. Record the signed-off holdout rubric, sample, and runtime pins before promotion.
