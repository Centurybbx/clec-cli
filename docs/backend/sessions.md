# Host sessions and run scheduling

`backend/src/sessions/index.ts` exports a transport-independent host store and scheduler. All implementation is TypeScript, using `node:sqlite` and Node builtins. This module does not invoke Pi, DeepSeek, QMD, search, HTTP, or a replacement model runtime. Runtime validation is pending Terra E2E; only compiler checks are permitted for this implementation slice.

## Ownership and storage

Use a dedicated local `sessions.sqlite`, separate from every immutable generation's `evidence.sqlite` and QMD database. The constructor rejects foreign application tables and unsupported schema versions without migrating them. The session database contains:

- `sessions`: title, timestamps, associated Pi session ID and canonical file path.
- `runs`: globally unique request ID, generated UUID run ID, exact user question, lifecycle timestamps, timeout, pinned generation, sanitized failure and validated final result including metrics and answerability.
- `messages`: exact user input and at most one assistant message per run. New assistant messages are written only as final in the successful completion transaction. Failed, interrupted, cancelled and timed-out runs retain user/search/read records without final answer output. The legacy partial enum remains representable but no partial-answer mechanism is used.
- `session_events`: durable additive envelopes, with monotonically increasing database-wide integer cursors. Cursors can have gaps when reading one session or following deletions.
- `session_owner` and `session_schema`: single local process ownership and schema version 3. Old schemas are rejected before owner recovery; preserve old state and use isolated fresh state and Pi directories.

Foreign keys and cascading deletes are enabled; WAL and FULL synchronous writes are selected. Multi-row operations and their corresponding events commit in a single `BEGIN IMMEDIATE` transaction before subscriber notification. Final rendered text/citation events, result, assistant message and completed terminal state commit atomically; only then are committed events published. The completed terminal envelope includes the validated `result` (text, citations, answerability and metrics); other terminal envelopes have `result: null`. No raw provider exception or arbitrary `ClecError` message is persisted as a run failure. Public failures use fixed `RUN_FAILED`, `INVALID_RESULT`, `CANCELLED`, `TIMED_OUT`, or `INTERRUPTED` messages.

The database is single-owner, local-disk storage. Opening a second store while its recorded PID is alive fails with `STORE_BUSY`; another hostname also fails closed. A dead same-host owner is replaced in the ownership transaction. PID reuse can conservatively prevent restart until the unrelated PID exits; container PID namespaces and network/shared filesystems are not supported. Do not manually clear ownership while a process is alive. `close()` releases ownership and closes the SQLite connection; it rejects while queued or unsettled work exists. No database, evidence generation, or Pi file is automatically removed during startup.

Paths come from trusted application configuration, never request parameters. Host IDs and request IDs must match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. Session and run IDs are generated UUIDs. Pi association requires an existing real path beneath the configured Pi directory; symlink escapes are rejected at association time. The adapter must create a Pi file before associating it and verify that the file/ID pair belongs to that Pi session. Canonical path checks are not a filesystem sandbox: keep the directory application-controlled and recheck files when opening them through Pi. Protect this local directory because questions, original evidence excerpts and answers are intentionally durable user data.

## Public interface

The supported application-facing signatures are:

```ts
new SessionStore({ databasePath: string, piSessionDirectory: string })
store.createSession(input?: { title?: string }): HostSession
store.listSessions(options?: { limit?: number, offset?: number }): HostSession[]
store.getSession(id: string): HostSession
store.deleteSession(id: string): void
store.getRun(id: string): HostRun
store.listRuns(sessionId: string): HostRun[]
store.listMessages(sessionId: string): HostMessage[]
store.readEvents(sessionId: string, options?: {
  after?: number, limit?: number, runId?: string
}): SessionEvent[]
store.isBusy(sessionId?: string): boolean
store.close(): void

new RunScheduler(store: SessionStore, executor: RunExecutor, options?: {
  concurrency?: number, defaultTimeoutMs?: number, diagnostics?: DiagnosticSink
})
scheduler.enqueueRun(input: {
  sessionId: string, requestId: string, question: string, timeoutMs?: number, filter?: SearchFilter
}): HostRun
scheduler.cancelRun(runId: string): HostRun
scheduler.waitForRun(runId: string): Promise<HostRun>
scheduler.subscribe(listener: (event: Readonly<SessionEvent>) => void): () => void
scheduler.shutdown(): Promise<void>
```

`SessionError` exposes a stable code and fixed operation message for invalid arguments, missing resources, conflicts and busy/closed conditions. Database/OS exceptions can still escape management operations: transports must apply a fixed public error mapping rather than serialize arbitrary exceptions. Store mutation methods marked “Scheduler integration methods” are internal wiring for the scheduler, not transport APIs. Attach only one scheduler per store; construct another store after a completed shutdown/close if needed.

Request IDs are globally unique within retained database data. Re-enqueue with the same session, question and effective timeout returns the existing run without emitting events, executing again or adding another user message. Different input with the same request ID raises `REQUEST_CONFLICT`. Run IDs are unique generated UUIDs. Deletion removes the corresponding request deduplication records too; clients must not reuse request IDs across deleted sessions. No queue deadline is implemented. Default execution timeout is 90 seconds; default global concurrency is four.

## Executor contract and Pi integration

```ts
type RunExecutor = (
  context: Readonly<RunContext>,
  signal: AbortSignal,
  output: Readonly<RunOutput>,
) => Promise<ValidatedAnswer>;
```

The deeply frozen context contains `runId`, `requestId`, `sessionId`, the exact `question`, canonical `filter`, `startedAt`, informational wall-clock `deadlineAt`, and the last associated `piSession: { id, file } | null`. It deliberately contains no synthetic provider messages. The adapter receives these synchronous output methods:

```ts
output.pinGeneration(generation: string): void
output.associatePiSession(reference: { id: string, file: string }): void
output.emit(event: ExecutionProgressEvent): void // search/read only
output.recordMetrics(metrics: Record<string, number>): void
```

The production evidence layer must resolve and open an immutable generation at actual run start, then call `pinGeneration` before any progress event, including empty retrieval search events. A run may repeat the same pin but cannot switch generations. Pinning is persisted immediately. The adapter owns releasing generation resources after its actual work settles. Per-run original reads must be refreshed; prior assistant answers and prior host messages are not evidence.

Actual **Pi SessionManager remains authoritative for provider context**. On first use, create a real durable Pi session using the pinned SDK API, then persist its file/ID reference through `associatePiSession`. On later runs, open that file through the actual SDK SessionManager. Never restore by assigning `agent.state.messages`; never reconstruct provider context from the host `messages` table. Session history displayed to users and provider conversation state serve different purposes. The Pi service must await prompt completion, abort cleanup, and the SDK's settled lifecycle before resolving or rejecting its executor promise. It must not spawn model work and return early. Associated files may contain Pi's interrupted turn state; recovery of that provider state belongs to the actual Pi API/service.

The executor returns this concrete result only after the production evidence layer validates the answer against actual reads and Pi has settled:

```ts
interface ValidatedAnswer {
  validated: true;
  answerability: 'supported' | 'partial' | 'no_hits' | 'insufficient_evidence';
  text: string;
  citations: Citation[];
  blocks: AnswerBlock[]; // public stable C IDs in evidenceIds
  metrics: Record<string, number>;
}
```

`validated:true` attests to structural and original-source integrity, not semantic entailment. The dependency-neutral domain contract validates exact block fields, text/reference bounds and ordered used C IDs. The scheduler compares every citation with this run's recorded read event (including ID, generation/version, section, offsets, quote and provenance) and requires the exact deterministic render of normalized blocks plus recognized source-quality notes.

- `supported` requires answer blocks without gaps.
- `partial` requires an answer block and a gap.
- `insufficient_evidence` requires a gap and no answer blocks; relevant context may have valid citations.
- `no_hits` is host-only: canonical text, `blocks:[]`, zero reads/citations/model calls or attempts, one successful empty search, no nonempty search events. Oversized unread sections are not no_hits.

The host does not prove whether a block's evidence entails its claims, whether a gap hides a fact, or whether all requested conditions were answered. Terra real grading owns that boundary. Model evidence handles have a fresh run namespace and map to the reader's original C IDs; C3 remains C3 even if earlier reads are unused. Full completed Pi history remains intact.

## QA composition and final publication

`app/index.ts` composes the real `qa/service.ts:answerQuestion` executor with shared diagnostics; no fabricated executor or NDJSON parser is involved. The service emits only `ExecutionProgressEvent` search/read and returns the validated result after Pi and evidence cleanup. `RunOutput.emit` rejects other event kinds. The broader stored/transport `ProgressEvent` retains text/citation event shapes for replay.

After the result resolves, the scheduler validates it against recorded reads and rechecks the active/deadline state. `store.complete` writes final assistant history, result, one text event, ordered citation events and completed terminal event inside one transaction. It returns all committed envelopes; scheduler publishes them only afterwards. A failed/cancelled run can retain search/read but cannot gain final answer output. Stateless CLI similarly publishes text/citations/complete only after successful service return and cleanup. No partial token buffer or second publication authority is introduced.

Host history messages contain rendered text and citations derived from the same result; normalized blocks persist in result and completed terminal snapshots. GET, durable SSE replay and restart round-trip this data; startup does not run a new whole-database source/semantic validation scan.

## Lifecycle, cancellation and recovery

Queue order is FIFO within a session. Independent sessions can overlap up to the configured concurrency limit; a busy session does not block selecting another session. Execution deadlines use a monotonic clock and begin when the scheduler transitions to running, not on enqueue. The supplied AbortSignal aborts on cancellation or expiry. Output and finalization recheck the monotonic deadline even if an event-loop stall delayed the timer.

A run makes exactly one transition from queued/running to `completed`, `failed`, `cancelled`, or `timed_out`. Cancellation and timeout are durable terminal outcomes immediately; they do not imply underlying work has stopped. Late progress is rejected and late success/failure cannot overwrite a terminal state. The active session lease and global slot remain occupied until the executor promise settles. `settledAt` and a `settled` event record that later boundary for started runs. Queued cancellations have `settledAt` immediately, remove their queue ID synchronously before notification, and never invoke the executor. The wait helper observes settlement, including queued cancellation.

An executor that ignores abort can occupy its session/global slot indefinitely; `waitForRun` and `shutdown` then remain pending. There is deliberately no `Promise.race` that hides background execution. A synchronous CPU loop can also block Node's timers; cooperative SDK/network cancellation and a responsive event loop are production requirements. Hard isolation/termination would need a separate worker/process design outside this module. Fatal storage I/O failures are application-fatal: stop serving requests and terminate the owner so the next start can perform interruption recovery; this module cannot promise durable outcomes when SQLite cannot commit.

Deletion rejects `SESSION_BUSY` for queued, running, or terminal-but-unsettled work. To delete an active session, cancel every queued/active run, await every `waitForRun`, then call `deleteSession`. Cancellation alone does not authorize deleting an unsettled active executor. Deletion cascades only host rows; it leaves the Pi session file and all evidence generations intact. Pi retention/removal requires an explicit application policy after no references or work remain.

On process restart, the new store owner atomically marks all formerly queued/running runs `failed` with `INTERRUPTED`, appends their terminal events, and settles abandoned active leases. Already cancelled/timed-out outcomes remain unchanged and receive settlement if needed. Existing user inputs, read citations, completed answers and Pi associations remain intact. There is **no automatic replay**, model call, retry, host assistant completion inferred from Pi files, or queued billable execution. A user must explicitly submit a new request ID to try again. A process crash after Pi writes a reply but before host final commit produces interrupted host work, never inferred success.

## HTTP integration and replay

The native transport supplies session CRUD, messages/runs, enqueue/get/cancel and durable SSE with Last-Event-ID; see http.md. Authenticate/authorize session access at the transport boundary; opaque IDs alone are not authorization.

Subscribe first, then page `readEvents` from the client's last persisted cursor; callbacks are synchronous wake-up hints and should remain fast. Drain durable pages in cursor order, deduplicate by cursor, and periodically recheck the database for reconnect/transport failures. Never send raw in-memory QA events ahead of the durable envelopes. No event retention/truncation or automatic pruning is implemented. Event cursors are global, so the next event for a session need not be cursor+1. Deleted sessions return `SESSION_NOT_FOUND`; they have no retained replay log.

## Unexecuted Terra E2E handoff

No tests, mocks, smoke runs, provider calls or runtime scenarios were run by this implementation agent. Required real production E2E coverage remains:

1. Create/list/get/reopen durable sessions, exact multilingual user inputs, associated Pi files, validated final messages, metrics and citations; real Pi continuation through SessionManager without message-array restoration.
2. Same-session FIFO, overlapping independent sessions, global concurrency bound, no starvation caused by the head of a busy session, duplicate request idempotence and conflicting duplicate rejection.
3. Cancel queued → immediately delete that session → enqueue/run an unrelated session, including full concurrency and application shutdown before the next pump. No stale-ID microtask failure or orphaned work.
4. Active cancel and timeout around final resolution, read/text/citation emission, and failure; exactly one terminal state, no late final assistant message or late completion, queue and global slot release only after actual Pi abort settlement.
5. Queue wait longer than execution budget without premature timeout; elapsed deadline after an event-loop delay; non-cooperative work remains visibly unsettled and blocks same-session continuation/deletion/shutdown until real settlement.
6. Busy deletion rejection; cancel-all/await/delete; idle deletion cascades host rows while Pi files and evidence assets remain. Clean shutdown closes ownership and the SQLite connection.
7. Kill/restart during queued/running/cancelled/timed-out states and between Pi reply and host commit; interrupted recovery without any automatic billable replay, fabricated completion, lost inputs or altered terminal outcomes.
8. Successful supported and partial answers; no-hit refusal; read-related-but-insufficient result with valid contextual citations; semantic gap honesty, original-read fidelity and no irrelevant citation forced onto refusal.
9. Unknown/rebound/mismatched generation citations, invalid UTF-16 ranges/quotes, unused/missing markers, invalid results/events and provider failures containing sensitive strings; sanitized public failures and no final answer output on failure/cancellation.
10. SSE disconnect/reconnect replay from a cursor, pagination, duplicate notifications, throwing/disconnected subscribers and crash immediately after commit before notification; emitted state always readable durably.
11. Live duplicate store ownership rejection, dead-owner takeover, unknown-schema/foreign-database preservation, Pi symlink/path escape rejection, unavailable Pi file and disk/commit failure handling.

The expanded source-only acceptance checklist and finite diagnostic semantics are in [qa-contract-handoff.md](qa-contract-handoff.md). All listed E2E cases remain unexecuted by this owner.
