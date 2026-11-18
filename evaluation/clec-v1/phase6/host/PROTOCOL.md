# Stage 6B public CLEC host protocol

The host runs synthetic public controls on macOS arm64 with the installed native CLI, its installed Skill, and Pi 1.5.2 over IPv4 loopback. A complete bundle establishes the recorded execution and closure for this profile. Unit 4 preparation is pending independent review. Actual-host evaluation, quality, external provider behavior, and cross-platform support remain separate gates.

## Collection and inspection

`runner.ts` exposes `collectRun(plan, evidenceParent, publicCorpusDir, fixture)`. It owns the ordered schedule, an exclusive evidence root, an independent plan anchor, attempt execution, and seal publication. The trusted fixture scripts the synthetic HTTP response for each admitted request. Model messages cannot change the schedule, evidence locations, fixture, invocation environment, or attempt identities.

`inspectRun(root, expected)` requires commitments from the independent anchor. Both sealing and inspection run the same Closed verifier over retained bytes. Prefix uses the same reducer and permits outstanding obligations while collection progresses. An attempt with pending or unknown capture or closure cannot seal. The summary is a checked projection of raw records. Supplying a new summary digest cannot fix incomplete or contradictory evidence.

## CLEC request contract

The sole direct tool is `clec`. The runner validates the original tool-start arguments against the committed public IDs and the fields for each action. Pi's own argument coercion grants no permission. The runner builds fixed offline argv and the helper starts the pinned CLI with empty stdin. The request supports these fields.

| Action | Fields |
| --- | --- |
| `schema`, `status` | Optional `maxBytes` |
| `help` | Required `command` of `top`, `search`, `read`, `sources`, `status`, or `schema` |
| `search` | One to four `queries`, optional `matchMode`, `limit`, `perWork`, `workId`, `sourceId`, `role`, `dateFrom`, and `dateTo` |
| `read` passages | One to 50 passage `ids`, optional `context` and `find`. Omit `original` or set it to `false`. |
| `read` originals | One to 50 source `ids`, required `original: true`, optional `find` |
| `sources` | Optional `query`, `workId`, `role`, `canonicalOnly`, `limit`, and `offset` |

Every action accepts `maxBytes` from 1 to 32,768. Search limits and per-work caps are 1 to 5. Passage context is 0 to 2. Sources limit is 1 to 100 and offset is 0 to 1,000,000. Query and find values occupy at most 2,048 UTF-8 bytes. They must contain nonblank, well-formed text without NUL or a leading dash after whitespace. Dates use calendar days in `YYYY-MM-DD` form.

Successful output reaches Pi and the next provider request as the exact UTF-8 stdout text. Native errors use a bounded exit and error-code result. Raw stderr is retained separately. The installed CLI's full schema exceeds the 32,768-byte host budget and returns `OUTPUT_BUDGET_TOO_SMALL` at that cap.

## Pinned inputs and runtime environment

Every run resolves and hashes its closure before launching Pi:

- Pinned native CLI binary (`clec.exe`, SHA-256 `083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7`).
- Pinned CLEC skill (`SKILL.md`, SHA-256 `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b`).
- Pinned Pi 1.5.2 release closure (`dist/bundle/cli.js` SHA-256 `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`, bundle chunks, runtime dependencies, and Node executable), excluding user auth and mutable state.
- Explicit host source inventory. The pinned TypeScript 5.9.3 parser checks the transitive imports of the runner, Pi adapter, native helper, and offline verifier. Relative imports must resolve to inventoried regular files inside the host root. Builtins and the adapter's typebox dependency in the pinned Pi tree are allowed. Fault drivers and alternate executables run through the isolated entrypoint under `test/`.

The launcher rehashes the current closure against any supplied commitment before allocating an attempt. The collector anchors its plan to the original closure and rehashes again after definitive attempt publication. The closure identifies the installed executables and host source. System libraries and OS behavior are part of the recorded environment.

Each attempt runs in a freshly created exclusive directory tree (`cwd`, `home`, `agentDir`, `dataDir`, `tmpDir`, `captureDir`) with `NODE_DISABLE_COMPILE_CACHE=1`, scrubbed `NODE_OPTIONS`/`NODE_PATH`/proxy/preload variables, an offline `models.json` pointing only at the loopback OpenAI mock with an inert sentinel `--api-key`, and `settings.json` disabling retries (`retry.enabled: false`, `retry.provider.maxRetries: 0`), auto-compaction (`compaction.enabled: false`), cache warming (`cacheWarming: "off"`), telemetry (`enableInstallTelemetry: false`), and analytics (`enableAnalytics: false`). Pre-existing `APPEND_SYSTEM.md`, `SYSTEM.md`, `settings.json`, or `models.json` paths reject before launch without overwriting.

The plan binds the installed Skill bytes, prompt profile, tool schema, settings, case schedule, and executable inventory. The system preamble is the UTF-8 installed Skill with trailing whitespace removed, two line feeds, the fixed tool mapping addendum, and a final line feed. Pi appends its pinned cwd section. It runs with Skill discovery disabled.

The corpus directory contains the local manifest, compressed database archive, active pointer, and the release-named SQLite database. The host verifies the manifest's hashes and sizes, derives the public index from immutable read-only SQLite, and binds all five commitments to the plan. Evidence retains the corpus and Skill. Each attempt gets its own active pointer and database. The runner checks those bytes before provider admission, before helper launch and GO, and after invocation. Replay checks the retained bytes, admission and postcheck records, fixed invocation, and result pairing. These checks cover the trusted local fixture under the stated ownership model. They provide no guarantee against byte changes restored between observations.

## RPC startup and shutdown

1. Outer controller spawns Pi with `--mode rpc --no-session --no-extensions -e <adapter> --no-builtin-tools --no-skills --no-prompt-templates --no-themes --no-context-files --system-prompt <preamble> --offline --provider <provider> --model <model> --thinking <level> --api-key <sentinel>` and inherited private pipes on FD 3 (outer to adapter) and FD 4 (adapter to outer).
2. Inside `session_start`, `clec-tool.ts` verifies that active tools equal `["clec"]` and all tools match the expected direct `clec` definition with zero deferred or extra tools. It sends `bound_ready` on FD 4 and waits for a matching `bound_ready_ack` on FD 3 before returning from `session_start`. It never calls or awaits `get_state` inside `session_start`.
3. Outer commits `bound_ready` and synchronizes through `bound_ready_ack` before sending the ACK. It then sends one correlated RPC `get_state` command on Pi stdin. Outer requires `success: true`, matching `model` and `thinkingLevel`, `isStreaming === false`, `isCompacting === false`, `messageCount === 0`, `pendingMessageCount === 0`, `sessionFile === undefined`, and `autoCompactionEnabled === false`.
4. After `get_state` succeeds, outer commits `prompt_encoded` and synchronizes through `prompt_sent`. It then sends one correlated RPC `prompt` command whose `message` is `"CLEC public question follows.\n" + literalQuestion`, serialized with `JSON.stringify`.
5. After observing `prompt` preflight `disposition: "started"`, streaming events, terminal assistant answer, `agent_settled`, and idle `get_state`, outer closes Pi stdin (EOF) and waits for clean process exit and group closure.

## Provider and tool admission

- The nonrejecting `before_provider_request` latch resolves only on a permit matching attempt identity, bridge sequence, observation watermark, and payload digest. Serialization and channel failures leave it pending. The owner stops Pi on denial, EOF, or deadline.
- The runner verifies the exact loopback request profile and waits for committed preceding turn evidence before admitting the next request. It matches the prompt, sole tool definition, schema, options, and prior tool history. Candidate and grant commit before permit. A case deadline, Pi exit, or bridge failure fences late commits.
- The runner waits for the raw declaration and reserves a unique call ID before allowing Pi to proceed past `tool_execution_start`. Invalid CLEC requests return a bounded typed rejection. Unknown tool results must match Pi's pinned lookup error. Both consume an attempt and neither launches native.
- Eight attempts leave the answer request available. An observed ninth start closes provider and native admission. Raw evidence retains the complete declared batch, including unvisited calls. Pi records lookup errors before it publishes result messages for an unknown-only batch. A witnessed ninth denial can stop publication after those lookup errors are captured. Replay pairs reservations, fixed argv, group records, native chunks and exit, result bytes, Pi result messages, and admitted HTTP requests.
- A replacement requires one observed transport reset before any assistant content or tool request and complete predecessor evidence. It is immediate, for the same case, and subject to one replacement per run.

## Native group helper and ownership

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

## Frozen limits

- Max tool attempts per case: `8`
- Native stdout cap: `32768` bytes
- Native stderr cap: `8192` bytes
- Native command deadline: `30` seconds
- Case deadline: `180` seconds
- Run deadline: `5400` seconds
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

## Evidence limits

Execution closure identifies the pinned Node, native binary, installed Skill, Pi release tree, observer, source parser, and inventoried host files. The receipt records native and Node linkage on the tested OS. Runtime and corpus hashes attest to observed bytes. The host does not provide an OS sandbox, publisher authentication, or hermetic system-library coverage. Offline inspection assumes the independently retained anchor is trustworthy and cannot detect a trusted writer replacing the complete record and anchor together.

Earlier Unit 1 through 3 reports describe their historical artifacts and source revisions. The migrated controls retain their fault sensitivities and use new exclusive roots. The open Unit 2 P2 replay observation remains recorded in its acceptance report.
