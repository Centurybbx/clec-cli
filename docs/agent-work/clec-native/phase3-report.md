# Phase 3 measurement and default decision

The six-stage CLEC native CLI effort needs an evidence-based default decision. Phase 3 measurement is complete with a failed quality gate. The manual original-question single-query default A remains unchanged. Candidate C is ineligible and is not promoted. Retaining A does not certify complete-answer quality.

This independent audit checked existing receipts only. It performed no retrieval, scoring, replay, tuning, or semantic relabeling. Product, harness, tests, and frozen policy remain unchanged. The authored code head is `70d421dc024d77aa396933ffaa0c25976805a980`. The documentation commit is separate and does not change the measured code identity.

## Decision fixed before evaluation

The original decision rule was frozen at `2026-11-17T16:52:15.092931Z`. Its SHA-256 is `e86ca1c70f86c5fcf941b5f51b9f9b129984e425f924b51cff77ec5bab91a4fd`. It retained A after development rejected C and authorized one A-only evaluation run followed by one saved-outcome replay.

The administrative addendum, frozen at `2026-11-17T17:10:50.444677Z`, changed only the measured head and protocol identity after acceptance of the narrow runtime boundary fix. Its SHA-256 is `44146b85678767bc85d5fce9b68ce936adc149050928756e89fd77e8f3959236`. The original rule bytes are unchanged. The audit compared every unchanged addendum field with that rule. The earlier v1 attempt stopped before retrieval and recorded zero runs and zero replays.

The rule requires zero execution, schema, citation, provenance, and budget failures. Fully passing quality also requires zero missing critical conditions and counterexamples. A report with `verdict: complete` means scoring completed. It does not override a failed quality gate.

The development promotion floor required C to beat both A and B by at least 10 percentage points and two net complete chains, with gains across at least two exact work groups. It also required no lost complete chains, no condition or counterexample regression, no mean coverage regression, and all hard gates. This engineering floor was chosen after development and before evaluation. It is neither a significance test nor proof of sample adequacy. No threshold was relaxed after evaluation.

## Development rejected C

The retained independent development audit reports A at 7 complete chains among 18 answerables, B at 5 among 18, and C at 7 among 18. Each condition scheduled and completed 20 questions, including two unanswerables. A uses the original question, B the first frozen rewrite, and C both frozen rewrites.

Relative to A, C gains two chains and loses two, including one counterexample. All three conditions fail the critical-condition quality gate. A versus C combines rewriting and increased query count. B versus C isolates adding the second frozen rewrite. The four cross-work records contain only two genuine bridge records. All four fail in each condition.

These findings come from the existing independent development audit and safe aggregates. This closure audit did not reopen development gold or repeat its oracle audit. Candidate exclusion versus ranking below the cutoff remains unresolved. The observed development byte trimming does not establish a cause for the target evidence misses.

## Heldout A measurement

The v2 receipts contain exactly one retrieval run and one saved-outcome replay. The run spans `2026-11-17T17:11:41.784587Z` through `17:11:47.060325Z`. The replay spans `17:12:03.980196Z` through `17:12:04.799346Z`. Both exit 1 solely because `zeroCriticalConditionLoss` is false. Every other reported gate is true.

All 12 scheduled questions completed, including 10 answerables and two unanswerables. Six of the 10 answerables have complete chains. Returned evidence covers 14 of 22 obligations and eight of nine conditions. There are zero annotated counterexamples, so the zero-of-zero result provides no counterexample coverage evidence. Mean per-question evidence coverage is 63.33% across all 10 completed answerables. This question-weighted mean differs from the pooled obligation fraction.

The two unanswerable records retain null chain and evidence-coverage values. They remain in the scheduled count but are outside the answerable-chain denominator. Their presence does not establish correct abstention.

There are 12 search steps and no reads. All executions complete without errors or timeouts. The retained validation reports zero citation, provenance, and budget failures. Raw search stdout totals 377,940 UTF-8 bytes, with a maximum of 47,283 bytes against the 65,536-byte per-call cap. The adapter read cap is 65,536 bytes, but no read occurs. Effective read and cumulative byte caps are null. No cumulative-cap guarantee follows from this run.

The fixed configuration is `single_query_product_baseline`, original-question angle, top five, at most two results per work, `any` matching, and a 30-second timeout. The audit compared every recorded command against this configuration and the frozen original question strings. It did not generate query plans or inspect annotations to tune retrieval.

## Receipt verification and identities

The independent receipt checks verified all 18 entries in the operator artifact-hash list. All 12 raw log records agree with the saved outcomes on argv, exit status, timeout state, elapsed diagnostic values, stdout, stderr, and UTF-8 byte lengths. All replay fields equal the corresponding report fields, including every per-question score, aggregate, and gate. Only run-specific timestamp, configuration, and artifact-path metadata are absent from replay.

The audit separately totaled the retained per-question chain, obligation, condition, and counterexample counts and checked the mean coverage denominator. It did not recompute evidence scores. Citation and provenance validity rely on the accepted oracle and its retained validation results. This is receipt verification, not another semantic annotation audit.

Before and after pin files are byte-identical and include the actual SQLite file, active binding, release manifest, executable, dataset, protocol, and policy files. Their filesystem modification times are `2026-11-17T17:11:22.083910Z` and `2026-11-17T17:12:32.607375Z`, bracketing the run and replay. Those times are filesystem metadata, not embedded signed timestamps. The audit independently rehashed the pinned files at `2026-11-17T17:18:10Z` through `17:18:11Z`, checked byte sizes and stable modification times during reads, and checked the active release binding. This includes the 1,058,467,840-byte SQLite file, rather than trusting its manifest alone.

The measured identities are as follows.

| Artifact | SHA-256 |
| --- | --- |
| Native executable | `a2a97df6089440f47b5fa8c21911d7067e441d90720e4fbad7f36ff558a1434a` |
| Preserved corpus SQLite | `5b14d29d703806cf9710b527425afdb43e833f33f8f30ab3c28b70f835114cb5` |
| Frozen evaluation dataset | `15a29af69f6fd3fc69b74c9409490cb96f2298f090266ac7952047b1cae66a90` |
| Accepted protocol | `668f9ee0c4ce187e454ab5bbe9f0fb6447c120d57eb54c026d0447c4e966a21f` |
| Heldout report | `7c3f4263fc9d7bd85889fb60f525290b11fa371638af44a1683735345600cc98` |
| Saved outcomes | `8797e20e94121208dc5e1e606b91a1f5a6b7d9663834a617ae9f3092f7f379fd` |
| Saved replay | `db4279e5666eb96d1a8b83d28bdd9428c59d6e51160249be1764389db86d7eb2` |

Private receipts are retained under repository-relative `.audit/phase3-heldout-A-v2/`. The rule and development audit are under `.audit/phase3-dev-measurement-review-v1/`. Runtime acceptance and the addendum are under `.audit/phase3-narrow-runtime-review-v1/`. This audit's checks and decision trail are under `.audit/phase3-final-measurement-audit-v1/`. These ignored local artifacts are not a public dataset and need not exist in another checkout. The tracked report intentionally excludes heldout questions, identifiers, source paths, keywords, and quotations.

## Quality remains open

Valid citations establish that returned evidence is tied to source material. They do not establish that the returned top five contain everything needed to answer. The missing critical condition and incomplete exact evidence chains remain open in the [quality ledger](phase3-quality-issues.md). Closing measurement does not close those issues.

Both splits are small, dependent, agent-authored samples. Machine-source provenance does not verify the underlying audio facts or semantic annotation adequacy. These results establish no population or category generalization, statistical significance, controlled development-to-evaluation gain, comparative timing advantage, host-model answer quality, or unsupported-question abstention quality. The replay is a consistency check, not an independent trial.

The evaluation has been consumed. Future tuning cannot describe it as unseen. Any new promotion decision requires new independently heldout data and preregistration. No further run, replay, threshold relaxation, or gold-driven tuning belongs to this completed measurement round.

Stage 4 HTTP and distribution work is orthogonal to this retrieval-quality failure and can proceed under user authorization while the quality issues remain open. It must preserve the failed gate and avoid complete-answer claims. Stage 5 optional SAG2 and Stage 6 host-model answer assessment remain open. Neither is a promised fix for the observed misses.

Prove It Works drove direct artifact and identity checks. Explain the Number drove explicit denominators and the distinction between technical completion and quality failure. Show Me Your Work kept the receipt findings in a private decision trail. No additional agent or cross-model trail review was run under the explicit no-subagents instruction. A separate persisted-conversation transcript audit was not performed.
