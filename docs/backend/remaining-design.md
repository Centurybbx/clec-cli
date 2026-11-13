# Remaining backend design and acceptance gates

This is a design/review record, not implementation or runtime evidence. The frozen first milestone is described in `handoff.md`. All product implementation and fixes belong to Sol medium; all tests belong to Terra medium, real E2E only. Original collection assets remain unchanged. No Web UI is in scope.

## Shared service and conversation

One structured QA service must serve CLI and the durable session executor. The host scheduler owns run identity, deadline and serialization; Pi SessionManager owns provider history. Persisting host messages alone is not conversation integration. Restore actual Pi sessions through supported SDK APIs, and never reconstruct synthetic tool history or assign agent state messages.

Every turn retrieves and reads fresh evidence. Follow-up retrieval must use bounded genuine conversation context while keeping the current question separate. Prior assistant claims and citations are not new evidence. Current run/generation/citation scope must be explicit. Cancellation retains the session lease until actual model execution settles; restart must not automatically replay paid work.

## Corpus and incremental processing

Reuse unchanged source versions, segmentation and normalized search artifacts. Record added, changed, removed and reused counts. Include segmentation, normalization, embedding model and index version in cache identity. Old generations remain readable and immutable. Publish only after evidence and QMD completion validation succeeds.

Persist resolved model identities in the generated QMD configuration as well as generation metadata. A serving shell must not silently select another embedding model. CLEC's chosen Chinese default is Qwen3-Embedding-0.6B; overrides create a distinct compatible index identity. Verify actual model configuration during runtime acceptance rather than inferring it from environment variables alone.

Batch SQLite transactions and reuse prepared statements. Do not describe unchanged-generation reuse alone as per-source incrementality. Reusing vectors must use public QMD interfaces and must be measured; copying bytes does not itself prove skipped embedding work. Never hardlink mutable databases between generations.

Long QA sources need bounded contiguous sections with real visible question/answer boundaries where available. Preserve exact original offsets. An oversized expansion may permit a smaller complete read within a bounded attempt budget. Exhaustion, corruption and cancellation remain distinct failures. Never silently truncate requested evidence.

## Scoped retrieval decision still required

Installed QMD 2.8.3 public SearchOptions and HTTP query support collection selection; they do not expose source/date/type metadata predicates. Current post-top40 filtering can lose all relevant scoped results. Raising that limit is not a general fix.

Before implementing scope, choose and document one public-interface strategy that restricts candidates before truncation. Collection partitioning is a candidate, not an approved performance conclusion: determine collection cardinality, whole-corpus query cost, source/date/type mapping and generation routing first. Do not silently introduce private QMD SQL coupling, a second vector database or per-question full index builds. If a different adapter is materially simpler, present the measured constraint and resulting architecture before substitution.

Installed-code inspection adds a constraint: QMD `searchFTS` handles multiple collections by searching each separately and merging. For one collection it first caps global FTS matches at `limit * 10`, then applies the collection predicate. Thus collection partitioning alone does not guarantee scoped lexical recall. `searchVec` also fans out per collection; it exact-scans small selected collections but uses capped global ANN plus filtering for large ones. These are static observations of the installed package, not benchmark results. Do not describe collection selection as universally filter-before-top-k. A scoped retrieval solution must address both branches explicitly; acceptable implementation evidence cannot consist only of sending `collections` in the HTTP request.

Upstream investigation found an actionable alternative: the official main-branch CHANGELOG lists metadata filters and the scoped BM25 materialization fix (#953) under Unreleased. The main package still identifies itself as 2.8.3, so that version string alone cannot distinguish the installed release from these changes. Evaluate a reproducibly pinned upstream commit/build after the frozen E2E run finishes, before inventing a CLEC-specific search engine. Verify its public SDK/HTTP contracts and real scoped retrieval. Do not mutate the dependency being used by the current test. Source: https://github.com/tobi/qmd/blob/main/CHANGELOG.md .

Required behavior: explicit source IDs, source type and date bounds select the eligible corpus before ranked candidate limits. Unknown dates stay unknown; title dates retain their basis. Empty eligible scope differs from retrieval failure. Natural episode identifiers must resolve to source metadata without treating retrieved titles as factual answer evidence. Cross-source questions must retain several independent sources and distinct relevant passages.

## Budgets and costs

At most one directed supplementary search. Model requests, output length, context and read attempts must be enforced in code. The first milestone's prior-usage token check is an admission threshold, not a guaranteed total cap. Any stronger accounting must state whether it uses exact tokenization or a conservative bound. Preserve known usage on failed calls where available; missing usage is unknown, never zero. SDK catalogue pricing is an estimate, not a provider bill.

## Acceptance evidence

First prove the real CLI chain on an isolated copy of real sources, including hybrid retrieval and actual DeepSeek answers. A lexical-only result does not establish hybrid behavior. Keep the executable build and dependency identity fixed during each run.

The first real run is recorded in `evaluation/backend-e2e/reports/vertical-runtime-20261110.md`: four complete development questions returned no lexical candidates despite indexed supporting documents; a short diagnostic query reached DeepSeek with mechanically correct citations; hybrid model download timed out. Overall FAIL/BLOCKED remains the baseline until regression evidence replaces it. Parent review also identified an unsupported recording-provenance inference in that diagnostic's caveat, although its main numerical/source-attribution claims were supported.

The current E2E recorder is partial. Its existence and syntax checks do not prove lifecycle coverage or runtime validity. Subsequent Terra runs may execute the remaining scenarios directly through production CLI/HTTP while recording commands, events and outcomes; a fully automated framework is not a prerequisite for honest real E2E evidence. Missing SSE reconnect, crash recovery, incremental update and stale-server scenarios remain open until actually exercised. Never omit them because the recorder lacks a command.

Parent static review of the partial recorder identified execution hazards for the next Terra run:

- `OwnedProcess` combines stdout and stderr in one log, while citation reconciliation parses that entire log as JSON. Capture machine-readable CLI stdout separately from diagnostic stderr, or use a direct real-process invocation with separate streams. A runtime warning must not masquerade as malformed product output.
- Lifecycle cancellation and timeout checks currently collapse unsuccessful assertions into `NOT_EXERCISED`. First record the required queued/running precondition; once observed, a violated postcondition is `FAIL`. For cancellation also verify the final active state, actual settlement and execution of an unrelated session; merely receiving a cancelled response is insufficient.
- A one-millisecond timeout can exercise pre-provider expiry only. Distinguish that result from cancellation of an observed in-flight model request and verify eventual release of the session/global slot.
- FIFO timestamps alone do not prove successful answers, and the concurrency scenario always emits `NOT_EXERCISED`. Evaluate terminal outcomes and inspect real overlapping sessions for context isolation.
- Dataset recording correctly leaves semantic judgment manual. Reconcile expected case count, budget stops, missing cases, mechanical citation failures and manually graded support before declaring acceptance; a zero recorder exit code is not a pass.

These are review findings, not newly observed runtime failures. They can be addressed in Terra's direct E2E procedure without another general-purpose harness expansion.

Then validate the integrated backend against the full supported corpus with distractors: 45 development cases and 12 held-out cases, with ordered conversations preserved. Do not open or tune against held-out cases during development. Report excluded corpus families, ingestion gaps and failures separately; do not equate a subset with full-corpus coverage.

For each answer inspect conditions, attribution, missing support and citation entailment, not just marker syntax. Check exact original spans, source version and generation. Report natural-query and source-directed cases separately so source hints cannot conceal weak retrieval.

Lifecycle E2E must cover real update/delete/reuse, old/new generation isolation, queued and active cancellation, timeout, process restart without replay, same-session order, cross-session isolation, idempotent requests, SSE replay and slow/disconnected clients. Controlled mutations are confined to test copies. Record cold/warm latency, actual calls, usage, cost availability and cleanup.

Two specific recovery boundaries must be exercised: an old QMD server queried after publishing a new generation must yield a version/service failure, not a no-evidence answer; a Pi reply saved before the host's completed transaction must not become completed conversation history after crash or cancellation. Reconcile Pi run markers against the host's committed run identities.

### Scope contract acceptance handoff

These are unexecuted design acceptance criteria for Terra, not test results. Select real indexed sources with verifiable distinct passages; use actual IDs and dates from the catalogue rather than invented IDs or facts.

| Scenario | Required evidence and outcome |
| --- | --- |
| Explicit episode switch | Complete a question about episode A, then ask “那第 B 集怎么说？” about a different real episode. Current explicit B controls natural scope. Search events and citations must not admit A merely because it appears in prior questions. |
| Genuine anaphora | Follow a completed episode-specific question with a question using “它” or “那这个条件呢”. Record the prior answer and current retrieval query; judge whether the actual antecedent and required conditions were recovered. Do not pass solely because the same session was reused. |
| Canonical request identity | Submit a real scoped request, then reuse its request ID with identical source/type sets reordered and duplicated. Expect the same run and no extra model execution. Reuse that ID with a genuinely different scope: expect conflict and no new run. |
| Scope intersection | Use a caller source filter excluding the episode explicitly requested in the question. Expect empty eligible scope and no citations from either a broader corpus or prior conversation. |
| Type and date bounds | Select real sources with known dates and at least one unknown date. Inspect all search candidates, not just final citations. Bounded queries exclude unknown dates; retained dates preserve their documented basis. |
| Supplementary scope | If a genuine question triggers the one allowed supplement, compare both search events against the same resolved scope. A narrower rewritten query must not remove caller restrictions. If no supplement occurs, record this scenario as unexercised, not passed. |
| Stale QMD | Publish a new isolated generation while retaining the owned old QMD server, then query the new backend generation. Expect a service/version failure, no completed no-evidence answer, and no citation mixing. Restart QMD for the new generation and verify recovery. |

Capture CLI and HTTP parity for at least one explicit scoped request. Include scope-switch and scope-conflict results in the final requirement audit separately from overall question-answer accuracy.

Completion requires reproducible runtime evidence for every requirement. Compilation, modules existing, a plausible answer, or a successful small sample are insufficient.
