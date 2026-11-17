# Stage 6B Unit 1 Startup, Admission, and Lifetime Proof Protocol

Status is `PROOF_ONLY`, `NOT_A_COMPLETE_RUN_CERTIFICATE`.

This protocol governs only the Unit 1 feasibility proof in `evaluation/clec-v1/phase6/proof-startup/`. It proves startup ordering, nonrejecting provider admission, tool-budget enforcement, pre-GO native group ownership, and bounded raw capture against real installed Pi 1.5.2 and pinned `clec.exe`. It does not emit production run certificates, implement the full six-action CLEC boundary, or open any host-quality, Google-wire, or cross-OS gate.

## Narrow Unit 1 Tool Profile

Unit 1 registers one narrow development tool named `clec` with a strict status-only schema:

- `action`: literal `"status"`
- `additionalProperties`: `false`

Unit 4 restores the closed six-action `ClecRequest` contract (`schema`, `status`, `search`, `read`, `sources`, `sync`).

## Pinned Inputs and Runtime Environment

Every proof run resolves and hashes its closure before launching Pi:

- Pinned native CLI binary (`clec.exe`, SHA-256 `083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7`).
- Pinned CLEC skill (`SKILL.md`, SHA-256 `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b`).
- Pinned Pi 1.5.2 release closure (`dist/bundle/cli.js` SHA-256 `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`, bundle chunks, runtime dependencies, and Node executable), excluding user auth and mutable state.
- Pinned Unit 1 TypeScript and helper sources.

Each attempt runs in a freshly created exclusive directory tree (`cwd`, `home`, `agentDir`, `dataDir`, `tmpDir`, `captureDir`) with `NODE_DISABLE_COMPILE_CACHE=1`, scrubbed `NODE_OPTIONS`/`NODE_PATH`/proxy/preload variables, an offline `models.json` pointing only at the loopback OpenAI mock with an inert sentinel `--api-key`, and `settings.json` disabling retries (`retry.enabled: false`, `retry.provider.maxRetries: 0`), auto-compaction (`compaction.enabled: false`), cache warming (`cacheWarming: "off"`), telemetry (`enableInstallTelemetry: false`), and analytics (`enableAnalytics: false`). Pre-existing `APPEND_SYSTEM.md`, `SYSTEM.md`, `settings.json`, or `models.json` paths reject before launch without overwriting.

## Startup Sequence

1. Outer controller spawns Pi with `--mode rpc --no-session --no-extensions -e <adapter> --no-builtin-tools --no-skills --no-prompt-templates --no-themes --no-context-files --offline --provider <provider> --model <model> --thinking <level> --api-key <sentinel>` and inherited private pipes on FD 3 (outer to adapter) and FD 4 (adapter to outer).
2. Inside `session_start`, `clec-adapter.ts` verifies that active tools equal `["clec"]` and all tools match the expected direct `clec` definition with zero deferred or extra tools. It sends `bound_ready` on FD 4 and waits for a matching `bound_ready_ack` on FD 3 before returning from `session_start`. It never calls or awaits `get_state` inside `session_start`.
3. Outer records `BoundReady`, verifies `BoundReadyAck`, and sends one correlated RPC `get_state` command on Pi stdin. Outer requires `success: true`, matching `model` and `thinkingLevel`, `isStreaming === false`, `isCompacting === false`, `messageCount === 0`, `pendingMessageCount === 0`, `sessionFile === undefined`, and `autoCompactionEnabled === false`.
4. Only after `get_state` succeeds does outer send one correlated RPC `prompt` command whose `message` is `"CLEC public question follows.\n" + literalQuestion`, serialized with `JSON.stringify`.
5. After observing `prompt` preflight `disposition: "started"`, streaming events, terminal assistant answer, `agent_settled`, and idle `get_state`, outer closes Pi stdin (EOF) and waits for clean process exit and group closure.

## Provider and Tool Admission

- Every `before_provider_request` invocation returns a Promise that never rejects and resolves only upon receiving a valid `provider_permit` matching the active attempt, monotonic request sequence, observation watermark, and payload SHA-256 digest. Sync and async errors stay pending inside the promise; outer kills Pi (`SIGTERM` then `SIGKILL` within 2 seconds) on denial, EOF, malformed or replayed ACK, record failure, or deadline.
- Outer validates the provider payload's model, prompt, tool inventory, and tool JSON schema, commits `ProviderCandidate` and `ProviderGrant` to the bounded journal before sending `provider_permit`. A journal failure before grant prevents dispatch; a failure after grant closes further admission, kills Pi, and marks the run invalid.
- `clec-adapter.ts` hooks `tool_execution_start` (which Pi emits before tool lookup and schema validation) and awaits an outer `tool_start_ack` latch on FD 3/4. Outer assigns authoritative ordinals 1..8, rejects duplicate call IDs, enforces serial execution, and denies call 9 without spawning native or granting further provider requests. Outer also reconciles complete declared tool batches from assistant `message_end` events.

## Native Group Helper and Ownership

1. Outer allocates a registry entry and bounded capture sinks before spawning `group-helper.mjs` with `detached: true`, scrubbed environment, and private GO pipe (FD 3/4).
2. `group-helper.mjs` does zero native work before `GO`. It sends `helper_ready` with its PID and PGID. Outer verifies PID/PGID via `ps`, commits `GroupRegistered`, and sends `go` carrying the fixed supervisor-built invocation.
3. `group-helper.mjs` spawns the native process with `shell: false`, `detached: false`, `stdin: "ignore"`, and no control file descriptors, then reports `native_pid` and streams bounded stdout/stderr chunks back to outer.
4. On Pi death, EOF, denial, journal failure, or deadline, outer closes admissions and signals `SIGTERM` then `SIGKILL` within 2 seconds to Pi and every registered native PGID (including waiting helpers), reaps direct children, and inspects survivors via `ps` with start-time identity. Any OS inspection failure records `Unknown` and marks closure uncertified.

## Frozen Unit 1 Caps

- Max attempts per attempt run: `8`
- Native stdout cap: `32768` bytes
- Native stderr cap: `8192` bytes
- Native command deadline: `30` seconds
- Case deadline: `180` seconds
- Answer text cap: `65536` bytes
- Pi stdout raw events cap: `16777216` bytes (16 MiB)
- Pi stderr cap: `65536` bytes
- Control frame cap: `16777216` bytes (16 MiB)
- Aggregate control payload cap per attempt: `67108864` bytes (64 MiB)
- Journal cap: `67108864` bytes (64 MiB), including a `1048576`-byte (1 MiB) emergency reserve unavailable to ordinary records
- Kill escalation grace: `2000` ms
- Bounded pending sink write buffer: `65536` bytes (64 KiB) with source pause until drain
