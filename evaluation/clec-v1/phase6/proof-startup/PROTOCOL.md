# Stage 6B Unit 1 Startup, Admission, and Lifetime Proof Protocol

Status is `PROOF_ONLY`, `NOT_A_COMPLETE_RUN_CERTIFICATE`.

This protocol governs only the Unit 1 feasibility proof in `evaluation/clec-v1/phase6/proof-startup/`. It proves startup ordering, nonrejecting provider admission, tool-budget enforcement, pre-GO native group ownership, and bounded raw capture against real installed Pi 1.5.2 and pinned `clec.exe`. It does not emit production run certificates, implement the full six-action CLEC boundary, or open any host-quality, Google-wire, or cross-OS gate.

## Narrow Unit 1 Tool Profile

Unit 1 registers one narrow development tool named `clec` with a strict status-only schema:

- `action`: literal `"status"`
- `additionalProperties`: `false`

Unit 4 restores the closed six-action `ClecRequest` contract (`schema`, `help`, `status`, `search`, `read`, `sources`).

## Pinned Inputs and Runtime Environment

Every proof run resolves and hashes its closure before launching Pi:

- Pinned native CLI binary (`clec.exe`, SHA-256 `083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7`).
- Pinned CLEC skill (`SKILL.md`, SHA-256 `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b`).
- Pinned Pi 1.5.2 release closure (`dist/bundle/cli.js` SHA-256 `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`, bundle chunks, runtime dependencies, and Node executable), excluding user auth and mutable state.
- Explicit proof source inventory. The pinned TypeScript 5.9.3 parser checks the transitive imports of the runner, controller, Pi adapter, and native helper. Relative imports must resolve to inventoried regular files inside the proof root. Builtins and the adapter's typebox dependency in the pinned Pi tree are allowed. Fixture drivers and their explicitly injected fault adapters exercise the proof under separate control labels.

The launcher rehashes the current closure against any supplied commitment before allocating an attempt. The collector anchors its plan to the original closure and rehashes again after definitive attempt publication. The closure identifies the installed executables and proof source. System libraries and OS behavior are part of the recorded environment.

Each attempt runs in a freshly created exclusive directory tree (`cwd`, `home`, `agentDir`, `dataDir`, `tmpDir`, `captureDir`) with `NODE_DISABLE_COMPILE_CACHE=1`, scrubbed `NODE_OPTIONS`/`NODE_PATH`/proxy/preload variables, an offline `models.json` pointing only at the loopback OpenAI mock with an inert sentinel `--api-key`, and `settings.json` disabling retries (`retry.enabled: false`, `retry.provider.maxRetries: 0`), auto-compaction (`compaction.enabled: false`), cache warming (`cacheWarming: "off"`), telemetry (`enableInstallTelemetry: false`), and analytics (`enableAnalytics: false`). Pre-existing `APPEND_SYSTEM.md`, `SYSTEM.md`, `settings.json`, or `models.json` paths reject before launch without overwriting.

## Startup Sequence

1. Outer controller spawns Pi with `--mode rpc --no-session --no-extensions -e <adapter> --no-builtin-tools --no-skills --no-prompt-templates --no-themes --no-context-files --offline --provider <provider> --model <model> --thinking <level> --api-key <sentinel>` and inherited private pipes on FD 3 (outer to adapter) and FD 4 (adapter to outer).
2. Inside `session_start`, `clec-adapter.ts` verifies that active tools equal `["clec"]` and all tools match the expected direct `clec` definition with zero deferred or extra tools. It sends `bound_ready` on FD 4 and waits for a matching `bound_ready_ack` on FD 3 before returning from `session_start`. It never calls or awaits `get_state` inside `session_start`.
3. Outer commits `bound_ready` and synchronizes through `bound_ready_ack` before sending the ACK. It then sends one correlated RPC `get_state` command on Pi stdin. Outer requires `success: true`, matching `model` and `thinkingLevel`, `isStreaming === false`, `isCompacting === false`, `messageCount === 0`, `pendingMessageCount === 0`, `sessionFile === undefined`, and `autoCompactionEnabled === false`.
4. After `get_state` succeeds, outer commits `prompt_encoded` and synchronizes through `prompt_sent`. It then sends one correlated RPC `prompt` command whose `message` is `"CLEC public question follows.\n" + literalQuestion`, serialized with `JSON.stringify`.
5. After observing `prompt` preflight `disposition: "started"`, streaming events, terminal assistant answer, `agent_settled`, and idle `get_state`, outer closes Pi stdin (EOF) and waits for clean process exit and group closure.

## Provider and Tool Admission

- Every `before_provider_request` invocation returns a Promise that never rejects and resolves only upon receiving a valid `provider_permit` matching the active attempt, monotonic request sequence, observation watermark, and payload SHA-256 digest. Sync and async errors stay pending inside the promise; outer kills Pi (`SIGTERM` then `SIGKILL` within 2 seconds) on denial, EOF, malformed or replayed ACK, record failure, or deadline.
- Outer validates the provider payload's model, prompt, tool inventory, and tool JSON schema, commits `provider_candidate` and synchronizes through `provider_grant` before sending `provider_permit`. A journal failure before grant prevents dispatch; a failure after grant closes further admission, kills Pi, and marks the run invalid.
- `clec-adapter.ts` hooks `tool_execution_start` (which Pi emits before tool lookup and schema validation) and awaits an outer `tool_start_ack` latch on FD 3/4. Outer assigns authoritative ordinals 1..8, rejects duplicate call IDs, enforces serial execution, and denies call 9 without spawning native or granting further provider requests. Outer also reconciles complete declared tool batches from assistant `message_end` events.

## Native Group Helper and Ownership

1. Outer arms the case deadline before spawning Pi. It retains the child handle and verifies Pi's identity with an asynchronous process-table sample. A native call arms its own deadline before pin verification, resource allocation, and helper registration.
2. Outer allocates the native registry entry and exclusively opens capture sinks before spawning the detached helper. The spawn handle supplies provisional PID and PGID ownership. Outer compares `helper_ready` with that handle and verifies the expected PID, PPID, PGID, and start identity in the OS table.
3. The helper waits for GO. Outer commits and synchronizes `group_registered` and `group_go_sent` before sending GO. The latter record denotes authorization intent. The wire send and native PID report establish subsequent events.
4. The helper launches the fixed invocation with `shell: false`, `detached: false`, empty stdin, and no inherited control descriptors. The native child inherits the owned group. Its PID report adds an observation obligation. Only the group derived from the original spawn handle grants signal authority.
5. Outer reconciles each native group and its capture before returning a result and admitting another native call. A helper leader exit or report EOF can arm a local stop while capture drains. A reaped direct child and corroborated group absence retire the lease and cancel its pending escalation.

## Commit and capture

Private control pipes keep reading while their ordered consumers await I/O. Ingestion counts wire bytes and frame boundaries and queues at most one frame's worth of bytes and 1,024 chunks. RPC stdout and Pi stderr pull one read at a time, including during child exit. Each accepted JSONL chunk has independently backed storage. The consumer holds one active chunk, one partial frame bounded by the frame cap, and one decoded record bounded by the wire frame. During frame growth both the old and new bounded backing can be live. The 128 KiB input backing cap covers one native read plus Node's 64 KiB pipe high water mark on the pinned runtime.

Pi exit, private control EOF, channel error, overflow, and deadlines signal outside policy handling. Expected EOF after clean shutdown still drains queued records in order. Private control EOF closes admission even with a pending commit and unread trailing bytes. The direct Pi exit observer and deadline arms remain active while the RPC capture streams are paused. Every ACK, prompt, permit, tool result, and GO rechecks the epoch before writing to the pipe.

One journal writer accepts at most four outstanding appends, including the active append. It writes each record in order and advances the committed sequence and byte range only after the full write and the required `datasync` succeed. A partial write loops until complete or fails the journal. The emergency reserve cannot repair a partial record.

Raw sinks use asynchronous exclusive open, one pending write, and asynchronous close. The sink copies the bounded prefix into its own backing before returning a promise. Readers split admitted input into pieces of at most 64 KiB. Native capture keeps fixed stdout and stderr buffers under their individual byte caps. Successful native stdout is decoded once after byte assembly with strict UTF-8, preserving an initial BOM and split characters. Stderr is retained as bytes. Capture writes the exact prefix up to each byte cap. When ingestion or drain fails it keeps the prefix already written and reports incomplete evidence. Native launch pin checks use bounded asynchronous reads. Final synchronous hashing is allowed after positive target closure.

Index publication follows cleanup and has a separate asynchronous completion. The controller fully writes and syncs an exclusive staging file, then creates the final name with an exclusive POSIX hard link. A failed write cannot expose a partial final entry. A successful link fixes the retained and returned verdict. The signal, observation, and drain cutoffs do not limit post-cleanup publication.

## Stop, observation, and drain

A case deadline, native deadline, Pi exit, denial, bridge EOF, or I/O failure closes releases. The owner arms the Pi child and every live native group in the same turn, before any observation or drain wait. Pi gets 350 ms of TERM grace and native groups get 400 ms. Native signals use negative PGIDs from the owned leases. Repeated stops retain their earliest ticket and deadlines.

The shared trigger is the armed monotonic deadline for timer expiry and the detection time for events. The receipt includes the detection time, actual TERM and SIGKILL call times, scheduled escalation time, signal errors, any justified cancellation, direct-child reaping, observation completion, and drain disposition. `killEscalationMs` is the actual SIGKILL call time minus the trigger time. A canceled escalation has a null value.

A bounded asynchronous `/bin/ps` observer runs at most one invocation at a time with C locale and capped stdout and stderr. A timed-out observer is killed and reaped. Group closure requires a fresh validated sample, consistent known identities, direct-child reaping, and an `ESRCH` result from signal 0 to the owned negative PGID. Kernel presence or a probe error such as `EPERM` leaves observation Unknown and keeps escalation armed. Rows can add observation obligations without granting a signaling identity. Signal initiation, observation, and drain each have the original two-second cutoff. Missing process evidence produces Unknown. Missing capture or journal evidence produces Incomplete. Either makes the proof uncertified even if all required signals were timely.

The contract covers trusted inherited POSIX groups on the tested runtime. Retired leases cannot act through stale callbacks. A POSIX PGID is numeric and can be reused between observations and signals. Process start times from `ps` have one-second granularity. OS scheduling and uninterruptible kernel work can prevent timely signals or closure. Supervisor SIGKILL, host death, malicious group escape, and hostile same-account interference are outside the proof.

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
- TERM grace: `350` ms for Pi and `400` ms for native groups
- Signal initiation, observation, and drain cutoff: `2000` ms from trigger
- Pending raw sink backing: `65536` bytes (64 KiB)
- Queued private control input per JSONL pipe: at most `16777216` bytes (16 MiB) and `1024` chunks
