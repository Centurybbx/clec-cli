# Production integration — source-only handoff

This milestone composes the existing host SessionStore, RunScheduler, HTTP transport and real Pi/QMD QA. All authored implementation is TypeScript. One Pi Agent uses the official DeepSeek API; there is no planner/research agent, second provider runtime, coding-agent shell, copied HTTP transport or parallel queue. Original collection assets are unchanged. `handoff.md` describes an earlier artifact. This document describes newer source; the parent owns the unified build and new acceptance freeze.

Implementation worker ran only TypeScript noEmit compilation and static inspection. No tests, mocks, smoke/product/server executions, builds, QMD operations or model calls were run. No credential file was read. No dependencies, package files, lockfile, node_modules or dist were changed by this worker. Runtime acceptance belongs exclusively to Terra medium with real E2E.

## Shared service and ownership

`qa/service.ts:answerQuestion` returns the single structured result used by stateless `ask` and the durable executor:

```ts
{ validated: true, answerability: 'supported' | 'partial' | 'no_hits' | 'insufficient_evidence',
  blocks, text, citations, metrics }
```

Validation checks current actual-read ranges, exact original quotes, generation/version and strict structured blocks using the pure domain contract. It does not establish entailment. Answer/context blocks require current evidence handles; public normalized blocks use stable reader C IDs. Context plus a gap can produce cited insufficient evidence. Answer blocks with a gap produce partial. `no_hits` is host-only with canonical text, empty blocks/citations, successful compatible empty retrieval and zero reads/model admissions. Setup, storage, search, budget, protocol, provider, cancellation and cleanup failures reject; they never become successful refusal results.

The stateless `ask` function is only an internal NDJSON adapter around this result. Durable runs do not parse NDJSON, booleans or final emitted text. Executor output receives only search/read progress, plus separate generation/Pi association/measurement methods. Scheduler owns durable run ID, request idempotency, authoritative AbortSignal and deadline. Session mode adds no random run ID, execution timer or automatic retry. The stateless adapter creates its own identity and timeout because it has no scheduler.

An executor resolves CURRENT exactly once, validates the completed immutable generation, pins it in the ledger and opens its evidence store. Every initial/supplementary search invokes `qa/qmd-generation.ts:assertQmdGeneration` against that pinned location. The adapter uses public, bounded MCP initialize/status requests, checking exact collection name, Markdown path, section/document count and hybrid vector completeness. No second CURRENT resolution occurs within the turn. Unavailable/malformed metadata fails SEARCH_UNAVAILABLE; a different/missing collection or incompatible metadata fails INDEX_MISMATCH. Therefore a stale server returning an empty search for an unknown collection cannot masquerade as no_hits. Search hit locators remain independently validated by QmdHttpSearch. Metadata is checked before each search; an externally replaced QMD process between metadata response and query is still an operator race, not an atomic upstream transaction.

The evidence store closes only after Pi work and abort/idle cleanup have settled. Immutable directories remain retained; this milestone adds no generation garbage collection or lease registry. Operators must not remove generations while readers are active.

## Pi persistence and crash reconciliation

Configured `CLEC_PI_DIR` contains actual SDK SessionManager JSONL files. New sessions use `SessionManager.create(workspace, directory)`; existing associations use `SessionManager.open(file, directory, workspace)`. Canonical real paths must stay under that configured directory, be files and have the exact associated Pi ID in both manager and header. The genuine user question is appended through SessionManager before agent setup; its real user-message persistence creates the file, after which the host stores file/ID. No placeholder assistant message or fabricated tool history creates the association. Host retrieval context is delivered using the SDK's awaited `sendCustomMessage(..., {triggerTurn:true})`, followed by `waitForIdle`; it is explicitly a host custom message, distinct from the original question. SDK createAgentSession restores provider context itself. No assignment to agent.state.messages and no host-ledger reconstruction of provider history occurs.

Each turn records `clec_run_begin` and, only after Pi settles and citation validation passes, `clec_run_committed`, both carrying the authoritative host run ID. Pi files and host SQLite are separate stores; no atomic cross-store commit is claimed. A Pi committed marker ALONE is insufficient: on the next explicit request, recovery scans the active Pi branch and checks marker pairs against host runs whose state is actually completed. Any uncommitted/non-host-completed suffix is abandoned using SDK `branch(last mutually committed entry)` or `resetLeaf()` before the first successful turn. This covers cancellation/crash between Pi marker writing and scheduler.store.complete, as well as interrupted tools and invalid final answers. Old branches remain in the Pi tree for audit; no paid turn is continued, replayed or resumed automatically. Startup only marks host pending runs interrupted. A new explicit user request is required to create a fresh turn.

The SDK can finish a crash-truncated physical line with a newline and skip malformed lines when opening its own JSONL format. No custom tool-result repair or synthetic continuation is attempted. Missing files, ID/path mismatch or SDK restore failure fail closed; preserve the files and create a new host session if they cannot be safely reopened. Session deletion removes host records; Pi files remain preserved and are not automatically garbage collected. Directory permissions and single-host ownership remain deployment responsibilities.

## Follow-up retrieval policy

Every turn performs fresh search and original reads. Prior excerpts, assistant answers and citations are never current evidence, through fresh per-run namespaced read/evidence handles. Public C IDs may reset but never authorize model actions. Current run ID, generation and evidence scope are explicit in the host custom message and system rules. All source excerpts, titles, metadata and tool-returned content are untrusted data, never instructions.

Initial retrieval uses prior ORIGINAL user questions only when the current question is at most 300 UTF-16 units and begins with an explicit supported reference/follow-up prefix (for example 那/它/上述/刚才/还有, or “what about”, “that”, “then”). Independent questions search their exact original question without history. The heuristic is transparent and intentionally limited; users can restate the subject for other forms. From earlier HOST-completed runs only, take the latest three questions, newest last, with at most 600 UTF-16 units total, tail-preserving if necessary. Future queued turns, failed turns and assistant answers are excluded. Append the entire current question separately; total retrieval query stays within 2000 units. This is reference disambiguation, not evidence or a hidden model rewrite. The original question remains unchanged in the ledger, Pi user message and answer instruction. No additional model call is spent resolving it. A short follow-up may still inherit several prior topics; real E2E must assess recall, and explicit restatement remains supported.

## Budgets and measured usage

Defaults: execution timeout 600000 ms (configurable 1000–600000), question cap 2000 UTF-16 units, at most two searches (one host plus one directed supplementary), eight total original-read attempts including host prefetch/refusals, 40000 original UTF-16 units, four admitted model requests and 2048 output tokens per request. Pi retry, compaction, cache warming, extensions, skill commands, telemetry and analytics are disabled; only search_evidence/read_evidence are allowed. Host attempts neighbours for the top two candidates, retrying section scope only for READ_TOO_LARGE. The same total eight attempts covers host and model reads. Oversized recoverable refusals do not set the global fatal flag; smaller reads can proceed. True READ_BUDGET, scope violations, corruption, cancellation and search exhaustion remain fatal. The model tool boundary independently caps nine tool attempts. Existing evidence-layer budgets remain authoritative too.

The old 60000 previously-reported-token guard and 100000-character context check are replaced with configurable conservative admission accounting. `CLEC_MODEL_ADMISSION_UNITS` defaults to 240000. Before EVERY request, reserve `serialized context UTF-8 bytes + 2048 output allowance`; accumulated reservations must fit the configured total and request count <=4. Serializing the complete Pi request context includes prior provider history, system instructions, tool definitions and evidence. All context passed at this boundary is text/JSON. This is a deliberately conservative byte-based accounting policy, NOT an exact tokenizer token cap or provider billing guarantee. No tokenizer is available from the pinned API, and no dependency was added. Reserves are never refunded from returned usage. A growing durable history will eventually refuse admission; no unbudgeted compaction is performed. Start a new session when necessary.

Metrics distinguish admitted modelCalls, modelRequestAttempts, serialized contextAdmissionUnits, usageReports, toolCalls, search attempts/results, readAttempts, evidence-layer readCalls/readCharacters and elapsed time. Returned Pi usage supplies token/cache metrics only where measured. Empty/zero-usage failed assistant messages are not treated as proof of zero billed usage; usageComplete is false when reports are missing. A known catalog price permits estimatedCostUsd only with complete usage; knownEstimatedCostUsd represents a partial known subtotal. An unknown custom model has costEstimateAvailable:0 and omits cost fields; SDK-required zero registration rates are never presented as measured free usage. Pricing remains an SDK catalog estimate, not an invoice.

Cleanup records known metrics as a separate durable session event even after a cancellation/timeout terminal event, before actual settlement. HostRun.metrics and HTTP GET expose that measurement; failed runs retain result:null. No successful answer or fake complete event is created to carry usage. The incompatible block-result contract uses session schema 3. Old schemas are rejected before owner recovery, with no migration. Preserve prior databases and Pi directories; use isolated new state and Pi paths. GET/replay faithfully round-trip precommit-validated results without a new whole-database source or semantic validation scan. Final result elapsed time ends at validation; cleanup measurement elapsed time may be slightly later.

## Composition, readiness and shutdown

`app/index.ts:createApplication` composes SessionStore + RunScheduler with the real executor + the existing createHttpTransport. `serve` binds only 127.0.0.1, port from CLEC_PORT (3000 default). Durable CLI session commands are thin clients of that server; they do not open another store owner. Different sessions may overlap (scheduler default concurrency four); a session's lease lasts through prompt/custom-trigger completion, abort and waitForIdle, provider usage capture and evidence cleanup.

GET /health is liveness only. GET /health?check=ready requires a nonempty process.env.DEEPSEEK_API_KEY, a completed generation and reachable matching public QMD metadata, bounded to 1500 ms of HTTP work with a 256 KiB metadata limit. It makes no remote provider call and does not prove key validity, quota or DeepSeek availability. The same metadata invariant is enforced during QA, regardless of whether readiness was requested. HTTP may accept202 and later report a sanitized failed run if dependencies are unhealthy. Credentials come only from process.env through an in-memory credential store; no auth file, key printing or model-network discovery.

Shutdown first stops HTTP and scheduler admission, aborts readiness checks, cancels queued/active runs and awaits scheduler settlement, then closes SSE/server connections and the store. Runtime API-key removal is in the outer cleanup chain, including model lookup, registration, set-key and createAgentSession setup failures. Abort rejects only after underlying session abort/trigger and idle settle; there is no unawaited model work. A crashed process cannot execute graceful shutdown; restart reconciliation handles that case. QMD fetch cancellation cannot promise that upstream already-running GPU work stops.

SSE is a durable event stream: queued/running/generation/search/read remain live. After service cleanup, scheduler validation and a final active-run check, one store transaction commits the assistant message, normalized result, buffered text event, ordered citation events and completed terminal event. Only committed events are published. Failed/cancelled runs may retain search/read events but gain no final answer events or assistant message. Text is not token-by-token streaming or an invented sequence of chunks. Failures may be terminal before cleanup metrics and settled; run-specific streams stay open until actual settlement. Existing replay, cursor, disconnect and backpressure semantics remain in http.md. The CLI session ask prints acceptance, decoded durable SSE envelopes and final GET run JSON as NDJSON; Ctrl-C detaches this observer, not the durable run. Use the existing HTTP cancellation endpoint to cancel execution.

## Parent-coordinated build and real Terra E2E

The prior validators have stopped; source freeze is lifted. Once the parent combines concurrent source owners, the exact deferred commands from the project root are:

```sh
backend/node_modules/.bin/tsc -p backend/tsconfig.json --noEmit
npm --prefix backend run build
```

No installation or package update is needed for this integration. The successful noEmit check is compilation evidence only. Parent should record a new dist/source handoff before a NEW Terra medium real-E2E run. Do not reuse the first milestone's frozen hash as the new artifact's hash.

After that build, from backend/ with an actual compatible completed generation and privately supplied process environment:

```sh
node dist/cli.js qmd-serve 8181
# Another terminal, same state/QMD/model configuration:
node dist/cli.js serve
# A third terminal, same CLEC_PORT:
node dist/cli.js session create 'Terra integration'
node dist/cli.js session list
node dist/cli.js session ask <actual-session-id> '資料中如何描述退休所需的年開銷倍數？'
node dist/cli.js session ask <actual-session-id> '那如果開銷增加，原文還有哪些條件？'
node dist/cli.js session history <actual-session-id>
node dist/cli.js ask '資料中如何描述退休所需的年開銷倍數？'
```

These commands are documentation, not executed acceptance. Terra must use actual corpus facts and inspect actual originals, not synthetic answers. Extend the real HTTP commands in http.md with this checklist:

- Compare stateless/durable supported, partial, truly no-hit and related-but-insufficient answers; validate each quote/version/range and missing-support honesty. Exercise source prompt injection as untrusted content and stale namespaced handles versus current fresh reads.
- Ask genuine anaphoric follow-ups, topic changes, English/Chinese references, long original questions and queued future questions; inspect initial search query and verify no assistant text becomes retrieval evidence. No extra planner call.
- Restart after completed runs and verify same Pi ID/file/context; verify configured-dir escapes, wrong IDs and missing files fail closed. Crash/cancel between Pi committed marker and host completed transaction, then submit a NEW request: orphan provider answer must be outside the active branch, old branch retained, no automatic replay. Interrupt pending tools/provider stream and restore via the same supported branch behavior.
- Cancel and timeout during real QMD and Pi requests; inspect terminal, later usage metrics and settled times. Queue another turn in the same session: it must start only after previous actual settlement. Start another session concurrently and verify real overlap without context/citation cross-contamination. Shut down with active work and SSE; verify local SDK work has settled when shutdown resolves, without inferring remote cancellation or billing completeness.
- Exercise 2000-character cap, default600000/explicit bounded timeout, <=one supplementary search, <=four admitted model requests, output caps, context admission refusal with accumulated prior history and configured lower accounting budget. Distinguish missing usage and unknown catalog prices from zero cost. READ_TOO_LARGE followed by smaller read must work within eight total attempts; exhaustion/corruption must fail.
- Verify real requestId exact retries return the same run without another user message/model execution; conflicting input conflicts. Verify durable SSE Last-Event-ID replay, run-specific stream closure only after settlement, reconnect after disconnect, absence of final answer records after cancellation and no fabricated delta chunks.
- With actual rebuilt CURRENT, leave the OLD QMD server running: readiness must fail AND an accepted QA run must fail rather than report no_hits. Restart correct QMD and verify readiness and actual retrieval. Exercise missing key, unavailable/malformed QMD metadata and mismatched collection/count/path. No paid readiness probe.

Scoped-filter recall, long QA segmentation and efficient incremental corpus remain independently owned milestones. This implementation makes no semantic-recall, entailment or runtime-success claim. It consumes READ_TOO_LARGE and existing evidence interfaces; the reader change exposes explicit citation-ID revalidation without changing authority or budgets. The separate ingestion owner handles full-build session expiry. See qa-contract-handoff.md for current diagnostics and acceptance gates.
