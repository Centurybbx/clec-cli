# Native HTTP and durable SSE transport

`backend/src/http/index.ts` exports `createHttpTransport(options): HttpTransport`. It uses `node:http`, the injected production `SessionStore` and its actual `RunScheduler`. Importing or constructing the transport never listens, opens another database, creates a queue, starts Pi/QMD, or calls a model. Core composition owns those dependencies. This slice changes no collection assets.

## Integration and ownership

```ts
import { createHttpTransport } from './http/index.js';

// store and scheduler are the real, shared production instances composed by core.
const transport = createHttpTransport({
  store,
  scheduler,
  // Supply the application's actual readiness check, not a hardcoded success.
  readiness: checkProductionReadiness,
});
transport.server.listen(3000, '127.0.0.1');

// Host shutdown order, after marking application readiness false:
await scheduler.shutdown();
await transport.close();
store.close();
```

The example names refer to host-owned objects/functions; this module supplies no placeholder production executor or readiness implementation. The host handles the native server's `error`/`listening` events and startup failure cleanup. Always specify `127.0.0.1` explicitly: native `listen(port)` defaults to broader interfaces. Main/CLI composition is outside this slice. Do not expose this unauthenticated local API to a network without a separately designed access boundary. No frontend, CORS headers, filesystem/model configuration routes or authentication framework are included.

Return value: `{ server: node:http.Server, close(): Promise<void> }`. Use `transport.close()` for shutdown rather than calling native `server.close()` directly: it ends all SSE streams, detaches their subscriptions/timers, stops accepting requests, closes idle sockets and allows existing HTTP responses up to ten seconds before destroying remaining connections. `close()` is idempotent, including before listen, and never cancels/closes the shared scheduler/store. Treat a closed transport as one-use; construct another to restart. Application shutdown must first disable acceptance/readiness and await `scheduler.shutdown()`, which cancels and awaits actual executor settlement. A non-cooperative executor can delay that phase indefinitely; transport shutdown cannot make it settled.

Options, validated at construction:

| Option | Default | Allowed |
| --- | --- | --- |
| `store`, `scheduler` | required | Real production instances; scheduler must own this same store |
| `diagnostics` | silent | Injected bounded content-free sink shared with QA/admission/scheduler |
| `readiness` | absent | `() => boolean \| Promise<boolean>` |
| `maxJsonBytes` | 65,536 | Integer 1,024–1,048,576 |
| `maxQuestionChars` | 2,000 | Integer 1–32,768; must match production QA/search ceiling |
| `maxRunTimeoutMs` | 600,000 | Integer 1–2,147,483,647; must match production service ceiling |
| `maxSseBufferedBytes` | 1,048,576 | Integer 1,024–16,777,216 |
| `maxEventStreams` | 256 | Integer 1–4,096 per transport |

Readiness must be cheap, bounded, side-effect-free and reflect production acceptance, active generation, Pi/DeepSeek configuration and QMD availability. It must not invoke a model. The transport waits at most two seconds; missing callback, false, exception or timeout means not ready. A timed-out callback is not forcibly aborted, so the host should cache and bound dependency probes. Readiness is a probe, not a request admission policy. Core owns disabling production work during lifecycle transitions.

Native limits: 16 KiB request headers, 100 header entries, ten-second header timeout, thirty-second incoming-request timeout, five-second keep-alive timeout. Request timeout does not impose a response deadline on SSE or cancel a run.

## Routes and request schemas

All routes are exact, with no trailing slash. Unknown query/body fields and duplicate query keys fail with 400. GET and DELETE accept no body; nonzero Content-Length or Transfer-Encoding is rejected. POST requires a UTF-8 `application/json` object (optional UTF-8 charset), including `{}` for cancellation. Compressed bodies are unsupported. JSON is byte-bounded before parsing; invalid UTF-8/JSON fails with 400. No input is coerced or trimmed before storage. Identifiers match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. URLs use a fixed parsing base rather than the untrusted Host header; malformed escapes, dot segments, encoded slashes, backslashes and control characters in path segments fail validation.

| Method/path | Body/query | Success |
| --- | --- | --- |
| `GET /health` | optional `check=live` | 200 `{status:"live"}`; process HTTP liveness only |
| `GET /health?check=ready` | none | 200 `{status:"ready"}` or 503 `{status:"not_ready"}` |
| `POST /v1/sessions` | `{title?: string}`; title at most 500 UTF-16 units, empty allowed | 201 session; Location header |
| `GET /v1/sessions` | `limit=1..1000` (default 100), `offset=0..MAX_SAFE_INTEGER` (default 0) | 200 `{sessions:[...]}` |
| `GET /v1/sessions/:id` | none | 200 session |
| `DELETE /v1/sessions/:id` | none | 204; busy/unsettled sessions reject deletion |
| `GET /v1/sessions/:id/messages` | none | 200 `{messages:[...]}` in durable order |
| `GET /v1/sessions/:id/runs` | none | 200 `{runs:[...]}` in durable order |
| `POST /v1/sessions/:id/runs` | `{question:string,requestId:string,timeoutMs?:number,filter?:SearchFilter}` | 202 run; Location header, including idempotent replay |
| `GET /v1/sessions/:id/runs/:runId` | none | 200 run, with path ownership verified |
| `POST /v1/sessions/:id/runs/:runId/cancel` | `{}` | 200 current run; path ownership checked before cancellation |
| `GET /v1/sessions/:id/events` | optional `after`, `runId`; optional Last-Event-ID header | 200 SSE; session/run ownership verified before headers |

Questions must contain non-whitespace and be at most `maxQuestionChars` UTF-16 units (default 2,000, matching current production QA/QMD admission); requestId is required and follows the identifier grammar. `timeoutMs` is an integer 1–`maxRunTimeoutMs` (default 600,000, matching current production service configuration). Values above either configured ceiling fail with 400 before enqueue. Low positive timeouts remain available for real deadline E2E. Omission delegates to the production scheduler's configured default (normally 90,000), which core must configure within the same production ceiling. These options are admission limits, not additional model budgets or timers; never raise them beyond the actual QA/search service contract. Their broader constructor ranges permit future host contract changes, not per-request overrides. There is no transport queue or alternate timeout scheduler. Request IDs are globally unique among retained runs; same session/question/effective timeout returns the existing run. Conflicting reuse returns 409. Deletion removes the store's deduplication record; never reuse request IDs across deleted sessions. Cancel/disconnect semantics are separate: only the explicit cancel endpoint requests model cancellation.

Session DTO: `id,title,createdAt,updatedAt`; Pi association is internal. Run DTO: `id,requestId,sessionId,question,state,createdAt,startedAt,finishedAt,settledAt,timeoutMs,generation,error,result`. A successful `result` contains `validated:true,answerability,blocks,text,citations,metrics`. `answerability` is the answer status (`supported`, `partial`, `no_hits`, `insufficient_evidence`); `state` is the execution status. `generation` identifies the pinned evidence snapshot. Citations retain validated original quotes, UTF-16 ranges, provenance and collection-relative source paths. Messages preserve `role,status,text,citations` and identity/timestamps. Normalized blocks expose host C IDs, and insufficient evidence may include cited context. `validated` means structural/source integrity, not semantic truth. History messages contain the same rendered text/citations, without a second block authority. Source navigation exposes explicit evidence metadata, never arbitrary SDK objects or source `origin` properties.

Errors are small `{error:{code,message}}` objects with fixed text. `INVALID_ARGUMENT` becomes 400 `INVALID_REQUEST`; missing sessions/runs become 404; request conflict, busy sessions/stores, closed scheduler/store and incompatible run state become 409. Body excess is 413; unsupported type/encoding is 415. Unexpected errors and other internal SessionError codes become 500 `INTERNAL_ERROR`, with no exception text, stack, provider response, API key or Pi path. Unknown routes/methods return 404. Shutdown and exhausted SSE capacity return 503 `UNAVAILABLE`. Existing public run failures are projected through a fixed allowlist, never arbitrary stored error messages.

## Replay, progress and settlement

Each SSE message is `id: <cursor>`, `event: <data.type>`, `data: <JSON envelope>`, followed by a blank line. The envelope is `{cursor,sessionId,runId,createdAt,data}`. Public types are `queued`, `running`, `generation`, `pi_session`, `progress`, `terminal`, `settled`. A `pi_session` event becomes only `{type:"pi_session"}`: its original durable cursor is retained without exposing a Pi ID/file. A terminal event includes `state,error,result`; a completed result uses the same safe answer projection as GET run. It is still **not settlement**.

Progress forwards actual durable `search/read/text/citation` events. Executors emit only search/read. After cleanup, validation and the active-run check, final text/citation events commit atomically with the final assistant message, result and completed terminal event; notification follows commit. Rejected/cancelled runs may retain search/read but no final answer events or assistant message. The production answer text is buffered; SSE does not claim token streaming, split buffered answers into simulated tokens, synthesize progress or finalize messages itself. GET run remains the durable answer/status source, including generation and metrics.

`after`/Last-Event-ID must be a nonnegative safe decimal integer. If both are supplied, they must agree. Replay is strictly after that cursor; zero means beginning. Global cursors can have gaps, and no cursor+1 assumption is made. A supplied future cursor means wait for later events rather than rewind. Clients must persist the last fully processed event ID and reconnect with it. No retention or cursor expiry policy is added.

The transport subscribes before replay, then reads durable pages of at most 64 envelopes in cursor order, yielding between pages. Notifications only wake reads; there is no in-memory live event queue. A five-second periodic durable recheck also covers missed notifications. Cursors advance only after a frame is accepted by Node. Backpressure pauses reading until drain; no additional pages are queued. Node writable bytes plus the next frame must fit the configured byte cap. A frame larger than the cap or a thirty-second blocked writer disconnects the client, which can reconnect from its last processed cursor. A single oversized durable event needs a higher host-configured cap or retrieval via GET run; reconnect alone cannot shrink it. A page is count-bounded rather than byte-bounded because `readEvents` exposes no byte-limit capability; actual production evidence/output budgets must remain bounded. Individual DTO serialization occurs before checking its encoded byte size.

Idle comments are sent approximately every fifteen seconds. A session-wide stream remains open until disconnect, shutdown, or a resource/storage error (including session deletion). A `runId` stream drains all available pages, then checks durable `getRun(runId).settledAt` and closes only when settled. This handles queued cancellation with immediate settlement and no separate settled event, as well as active cancelled/timed-out runs still cleaning up. The ownership check applies to this GET too. Already-settled reconnects replay remaining events and close; cursors at/after the final event close without inventing an event.

Disconnect, slow-reader drop and transport shutdown detach subscriptions, drain handlers, immediates and timers; none calls cancelRun. After SSE headers, resource/storage failures close the stream without serializing an exception or inventing a cursor. Clients can query GET run/session to distinguish deletion/errors from a reconnectable interruption. A network close does not prove the client's last accepted frame was processed; replay can legitimately repeat a frame across connections if the client did not persist its ID.

## Curl handoff for Terra real E2E

The implementation agent did not execute these commands, start a server, run tests or make provider requests. Run against the core-composed real Pi/DeepSeek/QMD application, with an actual generation and credentials. `jq` is used only to extract real IDs. Replace the evidence question with a corpus-specific question where necessary.

```sh
BASE=http://127.0.0.1:3000
curl --fail-with-body "$BASE/health"
curl --fail-with-body "$BASE/health?check=ready"
SESSION_ID=$(curl --fail-with-body -sS -H 'Content-Type: application/json' \
  -d '{"title":"Terra HTTP E2E"}' "$BASE/v1/sessions" | jq -er .id)
curl --fail-with-body "$BASE/v1/sessions?limit=10&offset=0"
curl --fail-with-body "$BASE/v1/sessions/$SESSION_ID"
REQUEST_ID=$(uuidgen)
RUN_BODY=$(jq -n --arg rid "$REQUEST_ID" \
  '{question:"請引用原文說明這份資料的核心觀點。",requestId:$rid,timeoutMs:90000}')
RUN_ID=$(curl --fail-with-body -sS -H 'Content-Type: application/json' \
  -d "$RUN_BODY" "$BASE/v1/sessions/$SESSION_ID/runs" | jq -er .id)
# Exact retry must return 202 and the same run ID, without a second model execution.
curl --fail-with-body -i -H 'Content-Type: application/json' \
  -d "$RUN_BODY" "$BASE/v1/sessions/$SESSION_ID/runs"
# Single-run stream returns only after actual settlement, including cancellation cleanup.
curl --fail-with-body -N "$BASE/v1/sessions/$SESSION_ID/events?runId=$RUN_ID&after=0"
curl --fail-with-body "$BASE/v1/sessions/$SESSION_ID/runs/$RUN_ID"
curl --fail-with-body "$BASE/v1/sessions/$SESSION_ID/messages"
curl --fail-with-body "$BASE/v1/sessions/$SESSION_ID/runs"
# Session-wide stream: interrupt manually; this must not cancel any run.
curl --fail-with-body -N "$BASE/v1/sessions/$SESSION_ID/events?after=0"
# Set CURSOR to an actual last processed event ID printed above.
CURSOR=0
curl --fail-with-body -N -H "Last-Event-ID: $CURSOR" \
  "$BASE/v1/sessions/$SESSION_ID/events?runId=$RUN_ID"
# For active-cancel coverage submit another real run first and use its ID here.
curl --fail-with-body -H 'Content-Type: application/json' -d '{}' \
  "$BASE/v1/sessions/$SESSION_ID/runs/$RUN_ID/cancel"
# Delete only after GET run confirms settledAt is non-null for every run.
curl --fail-with-body -i -X DELETE "$BASE/v1/sessions/$SESSION_ID"
```

Terra should exercise real supported/partial/no-hit/insufficient answers and verify citation fidelity, generation, final metrics, sanitized terminal result and GET parity; active cancel and timeout before settlement; queued cancellation with no settled event; idempotency conflicts; cross-session run GET/cancel/SSE all 404; replay beyond one page, duplicate wakeups, disconnect/reconnect ordering and future cursors; slow readers/byte-cap drops; stream capacity; missing/false/throwing readiness; invalid JSON/type/encoding, unknown fields, duplicate queries, numeric bounds, malformed paths and oversized bodies; session deletion during an open stream; and host shutdown order with active SSE and real execution. Verify continued execution after client disconnect and preservation of every original collection asset. No mocks/unit/component/smoke runs are part of this handoff.

Known integration limits: no message/run pagination capability exists in the store, so these listing responses are whole-session snapshots; event pages are count-bounded as described above. No source-content route, TLS termination, network authorization or retention policy is added. Core must supply actual production composition/readiness and align admission options with the service's input limits; a shared cross-layer input-contract module is future work rather than a parallel transport implementation. Terra medium owns all real E2E acceptance. Compilation checks types, not runtime behavior or semantic evidence fidelity.

Slice compile (no emitted files, server, or tests):

```sh
backend/node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --types node --typeRoots backend/node_modules/@types backend/src/http/index.ts
```
