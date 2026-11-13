# Bounded MCP transport fix — 2026-11-10

Implementation and compilation are complete; this artifact is frozen and ready for **Terra medium real E2E**. Runtime success is unverified. This Sol medium implementation worker ran no tests, smoke commands, application/server/QMD execution, retrieval, model or provider calls. No children were started and no credentials or raw diagnostic files were read. After the parent explicitly lifted the freeze, this worker ran no-emit typecheck, build and the existing static artifact-inventory script only.

## Cause and implementation

The actual failure is recorded in `evaluation/backend-e2e/reports/clean-install-20261110.md`: pinned QMD initialize returned HTTP200 `text/event-stream` with `event: message` and a JSON-RPC `data` payload. The old boundedJson parsed the whole SSE body as JSON, failing before status/retrieval/model execution. QMD's logged JSON response preference does not establish the wire response type.

Product edits are restricted to `backend/src/qa/qmd-generation.ts` and new `backend/src/qa/mcp-transport.ts`. The new module owns HTTP, initialization, JSON-RPC correlation and JSON/SSE decoding. The generation assertion owns pinned QMD identity/version, tools availability, generation collection/path/count, required string metadata coverage and hybrid vector-completeness checks. No private QMD patches, dependencies, lock/manifest changes, broad retrieval changes or test edits were needed.

Transport behavior:

- Accepts actual `application/json` or `text/event-stream` response media types, including parameters; other types and non-success HTTP statuses fail closed. Uses fatal UTF-8 decoding.
- SSE is parsed incrementally, including chunk-split UTF-8, LF/CRLF/CR line endings, multiline data, default/message event names, comments and empty priming events. SSE id/retry/unknown fields do not become RPC evidence. A final frame without its terminating blank line is incomplete.
- Requires JSON-RPC2.0, a valid response envelope and an exact matching numeric request ID. Valid unrelated responses and well-formed `notifications/*` messages are ignored while waiting for the matching SSE response. Matching RPC errors reject without exposing server messages. Malformed envelopes, unexpected event types and server requests reject; the client advertises no server-request capabilities.
- Each response has the existing 262,144-byte aggregate cap, which also bounds each frame/line; SSE additionally has a 128-frame cap including empty frames. At most the delivered network chunk exists before its byte size is checked. There is no unbounded buffer or wait for SSE EOF after a matching response. The reader is canceled and its lock released on success, overflow, parse/protocol error and fetch abort.
- The same combined caller signal / 1,500ms absolute deadline covers initialize, initialized notification, status and optional session cleanup. Notifications do not reset the timer. Redirects remain rejected.
- Requests MCP2025-11-25 and requires that exact negotiated revision. Sends `notifications/initialized` and requires HTTP202, then sends the negotiated `MCP-Protocol-Version` header on status. A returned visible-ASCII session ID (bounded to 1,024 characters) is forwarded on subsequent requests and closed with best-effort DELETE within the same deadline. Pinned QMD is sessionless, so its normal path needs no DELETE. Session expiry fails this check; no automatic retries, reconnection, legacy endpoint discovery or stream resumption occur. The next explicit readiness/search check starts a fresh initialization.

The pinned QMD package must report `qmd` version2.8.3; generation build settings must still match commit `86d2365d17fc682e491c2c53d1e4a884aee8682a` and typed metadata revision `qmd-typed-metadata-stable-v2`. The public version string alone is not commit attestation. Existing generation/runtime fingerprint checks retain that responsibility. Protocol/version/malformed-status failures become `SEARCH_UNAVAILABLE`; collection/path/count/typed-coverage/vector mismatches retain `INDEX_MISMATCH`. Caller cancellation retains existing abort handling. Neither category becomes `no_hits`.

## Public reference and architecture decision

Applied `/Users/century/.codex/skills/get-api-docs/SKILL.md`: ran `chub --help`, searched QMD, Model Context Protocol and TypeScript SDK. There was no QMD or matching TypeScript SDK entry; the MCP result was a Python guide. Fallback references were the official [MCP2025-11-25 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [pinned QMD server source](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/mcp/server.ts), and installed public `@modelcontextprotocol/server`2.0.0 / `core`2.0.0 declarations and shipped implementation.

The installed dependency tree has MCP server/core packages, with no supported client package to import. A client dependency would change the frozen dependency contract and still need explicit response byte bounds. A small request-only adapter therefore fits this metadata probe. No transitive/private SDK imports were added.

The pinned server uses createMcpHandler with a stateless legacy fallback. Its shipped fallback constructs a fresh WebStandardStreamableHTTPServerTransport without enableJsonResponse, explaining why legacy initialize can return SSE despite the outer JSON setting. Static inspection also shows the legacy transport bypasses session-initialization validation when sessionIdGenerator is absent, and the server's unset-era codec defaults to2025. Consequently this fix retains public2025 initialize/status requests rather than introducing an undocumented switch or a speculative modern-envelope migration. **Terra must establish that the subsequent real status call succeeds**; source inspection is not execution evidence.

## Executed compilation and new freeze

All commands below exited0 under Node25.7.0/npm11.10.1 on macOS arm64:

```sh
PATH=/Users/century/.nvm/versions/node/v25.7.0/bin:$PATH npm --prefix backend run typecheck
PATH=/Users/century/.nvm/versions/node/v25.7.0/bin:$PATH npm --prefix backend run build
/Users/century/.nvm/versions/node/v25.7.0/bin/node backend/scripts/artifact-manifest.ts docs/backend/mcp-transport-artifacts-20261110.json
```

New inventory: `docs/backend/mcp-transport-artifacts-20261110.json`, 240 files. Relative to all236 baseline records, only `src/qa/qmd-generation.ts`, `dist/qa/qmd-generation.js` and its map changed; four files were added: new transport source plus its generated JS/map/declaration. All other233 baseline records match, including package/lock, installed QMD and CLI. The original corpus and existing runtime evidence were not modified. The original inventory file is preserved unchanged.

| Artifact | SHA-256 |
| --- | --- |
| New inventory record set | `139104ce11e771ad09bebd3433fd798fd3a65587fa657ef20e54b70842c47148` |
| mcp-transport-artifacts-20261110.json file | `33fb713930380cd11bbc44522f510bc3db155eba60d990c2d66c0595d9484168` |
| src/qa/mcp-transport.ts | `006064930534da965392cca5451391121394e45791d9384598ba3577db44d37d` |
| src/qa/qmd-generation.ts | `2a29eebf08724cf8b0885b041e3be289b5f7c9f37d73597582e87bc48ad55b35` |
| dist/qa/mcp-transport.js | `8a7b1c20b0822877cc2d5c4fcd5ab4d548da65f0b23745a04df0815ad87ef7da` |
| dist/qa/qmd-generation.js | `4a5a0a3d79389e2560c782fef4a2c242284556c46022ddf19d8fdfb3b63a1e9f` |
| dist/cli.js (unchanged entry point) | `b6a30a3f50645151455a8a007a933e71668ef680a90f706f0478782c246f2a0d` |
| package.json (unchanged) | `4f86534be5f8014c89d131645c40c9ccac734ee420352eadb6102d5cb28ca6bf` |
| package-lock.json (unchanged) | `6527d08af337325369773fe992c28d1cacd5d845fd01d1bea390560c031ce318` |
| Baseline inventory record set (preserved) | `2c7d9f70cb5f0d110ef69ffcd40c8c00f1fb40f95a272602b2fe8114d4a9324e` |
| Baseline retrieval-artifacts-20261110.json file (preserved) | `5ff2344baf25c160f445742b1e5cc349b8e7daeacdaa408f7fa7b572186ddd87` |

No further source/dependency/build edits are pending from this worker. Documentation is outside the static script's inventory. Compilation and hashes are not runtime acceptance.

## Exact Terra medium real-E2E handoff

Parent may dispatch Terra immediately against the new frozen dist. No dependency install or TypeScript build is needed. Preserve `/tmp/clec-clean-install-T6uI1J` as original evidence. Terra should create a separate lexical generation from a copy of its genuine source; do not copy its QMD database/config into another state path, because collection paths bind the generation directory. Write retest stdout/stderr and raw HTTP headers/body to a NEW evidence directory chosen by Terra. Supply the existing private key through process environment only; do not print it or source secrets into command arguments.

From project root, in each terminal:

```sh
export PATH=/Users/century/.nvm/versions/node/v25.7.0/bin:$PATH
export CLI=/Users/century/vibing/clec/backend/dist/cli.js
export CLEC_WORKSPACE=/tmp/clec-mcp-transport-retest-20261110/workspace
export CLEC_STATE_DIR=/tmp/clec-mcp-transport-retest-20261110/state
export CLEC_QMD_URL=http://localhost:52473
export CLEC_PORT=52474
```

One-time Terra preparation (mkdir deliberately fails if this retest directory already exists; choose a new name consistently in that case):

```sh
mkdir /tmp/clec-mcp-transport-retest-20261110
cp -R /tmp/clec-clean-install-T6uI1J/workspace "$CLEC_WORKSPACE"
mkdir "$CLEC_STATE_DIR"
cp /tmp/clec-clean-install-T6uI1J/state/selected-intake.json "$CLEC_STATE_DIR/selected-intake.json"
node "$CLI" build "$CLEC_STATE_DIR/selected-intake.json" --lexical
```

This is real isolated corpus preparation by Terra, not a rebuild of shared dist. Terminal1, QMD (the CLI strips the provider key from its child environment):

```sh
node "$CLI" qmd-serve 52473
```

Terminal2, real API with the privately supplied key in its environment:

```sh
node "$CLI" serve
```

Terminal3, real wire/readiness/CLI/session regression:

```sh
curl --fail-with-body -i -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"terra-wire-check","version":"1"}}}' \
  "$CLEC_QMD_URL/mcp"
curl --fail-with-body -i "http://127.0.0.1:$CLEC_PORT/health?check=ready"
node "$CLI" ask '00400 如何调整 2013 年的价格以比较拆股后的图？'
node "$CLI" session create 'Terra MCP transport regression'
# Use the actual returned session ID:
node "$CLI" session ask <actual-session-id> '00400 如何调整 2013 年的价格以比较拆股后的图？'
node "$CLI" session history <actual-session-id>
```

Required real observations and scenarios:

1. Preserve actual response content type and SSE envelope; show readiness succeeds and QMD logs include initialize, initialized and tools/call status. Record probe cold/warm latency against1500ms. Do not equate initialize-only success with a fixed QA chain.
2. Both stateless and durable asks must reach actual retrieval, evidence reads and provider execution, with any answerability/citations assessed honestly. Reconcile each emitted quote/version/UTF-16 range against the real original through `node "$CLI" source 6be096e5ef41b241c6345fd5c784a4291fc3964f40997388a19e0cb804173a77`. The original failed report's offsets are diagnostic context, never an answer/citation oracle. No model call is required for readiness.
3. Run readiness with the actual key absent:503. Stop real QMD: readiness503 and an actual ask must fail SEARCH_UNAVAILABLE, never no_hits. Restart matching QMD and repeat. Preserve terminal errors, retrieval/model metrics and actual settlement.
4. Use Terra's existing separate compatible generation/stale-QMD scenario: leave the old real QMD running against a newly published isolated generation. Readiness and asks must reject INDEX_MISMATCH; restart the matching QMD and verify recovery. Retain metadata string-coverage/vector requirements. Do not alter original corpora/generations to fabricate malformed metadata.
5. Exercise real caller cancellation and short run deadlines during an actual request through the existing HTTP cancellation/run-timeout flow in `docs/backend/http.md`; confirm failed/cancelled/timed-out settlement and later recovery without a stuck stream/session. Run repeated real readiness probes and inspect actual QMD process connections/resources for lingering SSE readers.
6. Parent's broader API/CLI and full development regressions in integration.md/retrieval.md remain necessary. A fixed metadata probe establishes neither semantic retrieval quality nor complete API acceptance.

Only real E2E is authorized, all under Terra medium. No unit/mocked/fixture/proxy transport tests are proposed. The pinned real server may expose only its SSE legacy branch; JSON decoding, arbitrary chunk boundaries, unrelated IDs, error envelopes, malformed bytes, frame/byte overflow, stateful session forwarding and unsupported protocol revisions remain statically reviewed rather than runtime-proven unless a real authorized public endpoint naturally exercises them. Report these limits; do not claim coverage by synthetic replies. No timeout increase is justified without actual measured evidence. Client stream cancellation does not prove upstream computation cancellation, and metadata/status followed by search remains a non-atomic external process race.
