# Stage 6B Unit 1 feasibility proof report

Status is `PROOF_ONLY`, `NOT_A_COMPLETE_RUN_CERTIFICATE`. The Stage 6B Unit 1 deadline correction is implemented and author-verified at clean source commit `cae3ac5d8d608909ffb1ef3358bef63d0ea98f1e`. Fresh independent GPT 6.2 Astra review is pending. Units 2 through 4 remain gated.

## Deadline correction

The outer controller now retains the Pi handle and each provisional native lease before it awaits active I/O. Stop closes the admission epoch and arms Pi and all live groups before waiting on observation, reaping, or capture. The owner gives Pi 350 ms and each native group 400 ms of TERM grace, measured from the armed or detected trigger. The timer checks the absolute deadline when it runs. The receipt records actual signal calls separately from OS observation, direct reaping, and drain.

The launch path uses asynchronous exclusive opens and bounded file reads for the Node, helper, and native pin checks. The observer uses asynchronous `/bin/ps` with C locale, bounded output, a deadline, and one in-flight invocation. The raw sinks retain one write payload up to 64 KiB per sink and apply source backpressure. The ordered journal allows four outstanding records, including the active append. It commits the byte range and advances the sequence after the full write and the required `datasync`. The terminal epoch is checked again immediately before ACK, prompt, permit, tool result, or GO. The pre-send `group_go_sent` record denotes authorization intent. [Protocol](../../../evaluation/clec-v1/phase6/proof-startup/PROTOCOL.md)

The active-path inventory leaves synchronous provisioning, settings writes, and the initial full closure hash before spawn. Native sink opens and closes, sentinel metadata, pin reads, process inspection, journal writes and synchronization, and final index publication are asynchronous. Full synchronous final hashing is conditional on positive target closure. When a matrix supplies its precomputed pin set, the matrix independently rehashes the full closure at the end. An attempt with Unknown ownership has no final closure digest. [Controller](../../../evaluation/clec-v1/phase6/proof-startup/controller.ts) · [Process owner](../../../evaluation/clec-v1/phase6/proof-startup/process-group.ts) · [Framing and writers](../../../evaluation/clec-v1/phase6/proof-startup/framing.ts) · [Pins](../../../evaluation/clec-v1/phase6/proof-startup/pins.ts)

## Author verification at the tested commit

The clean run started at `2026-11-18T00:09:08Z` and ended at `2026-11-18T00:10:30Z`. It passed all 45 original controls, six process-observation tests, and 19 deadline controls. A separate `/bin/ps` scan checked 122 recorded PID identities and 39 PGIDs at `2026-11-18T00:09:59.937Z`. It found zero survivors after the explicit cleanup for the deliberately omitted-teardown case.

| Control | Actual SIGKILL after trigger (ms) | Separate observation or drain evidence |
| --- | ---: | --- |
| Old synchronous process list | 2258.581 | A 2.2-second process-list delay blocked the owner. Direct observation found the group empty after reaping. |
| Async process list at cutoff | 401.808 | The observer was pending across escalation. Its child closed after 2005.917 ms. Closure stayed Unknown at the cutoff. Direct post-reap observation found no survivors. |
| Two native groups and one Pi target | 351.966, 401.877, 401.928 | The delayed observer took 2341.043 ms. Its stale snapshot could not close either lease. Both groups closed after fresh observation and reaping. A sink close was pending across escalation. Repeated stop retained the original trigger. |
| Old synchronous raw write | 2317.723 | The full FIFO withheld its reader for 2415.500 ms. The owner timer missed the cutoff. |
| Async raw write | 402.770 | The full FIFO withheld its reader for 2417.526 ms. The owner signaled within the cutoff and reported Incomplete drain. |
| Old synchronous journal write | 2318.384 | The full FIFO withheld its reader for 2417.275 ms. The owner timer missed the cutoff. |
| Async journal write | 402.707 | The full FIFO withheld its reader for 2417.248 ms. The owner signaled within the cutoff and reported Incomplete drain. |

The FIFO controls filled a private POSIX pipe to `EAGAIN` and sent real blocking writes to its descriptor. A separate reader logged when it started draining and how many bytes it read. The asynchronous controls retained a pending write beyond the two-second drain deadline. The fault driver also checked partial progress, actual write failure, journal queue saturation, retained backing bytes, and the committed watermark. The observer tests covered malformed, partial, empty, and unsafe rows, C locale, injected permission failure, own-PID visibility, and reused identity. The ownership controls rejected a reporter claiming another owned group's identity and showed that a retired lease's timer left a later lease alone.

The real Pi loopback controls held or failed the provider grant, GroupRegistered, and GO authorization writes. When the driver killed Pi before releasing a held write, the provider control produced zero HTTP requests. The two native controls recorded only the already-permitted initial request, sent no GO, and created no native sentinel. Positive controls waited for actual data synchronization, then observed one provider request or one native start with byte-exact stdout and two requests. The original deliberately unprotected guard still reached loopback.

- Matrix receipt, including actual requests and direct ownership scan. SHA-256 `8ca0b1184a14d3eee4b793a1748f7ddb4f555dcd60d2ea25ef5af4a99f3b3c4e`. [Matrix receipt](/tmp/clec-unit1-exact.YnKfuE/matrix-1794960548457-d7fd04d1/matrix-receipt.json)
- Deadline receipt, including per-control UTC times, external write release, actual wire sends, and separate survivor observations. SHA-256 `3f48145449f9ad9be10c0102b3f81d336c380b68fa12c201c97565db8d5d7768`. [Deadline receipt](/tmp/clec-unit1-exact.YnKfuE/clec-deadline-controls-zqgkVw/receipt.json)
- Parser test log. SHA-256 `7d9324b22586b60a2fae03ab0ca9f5c000e57173d2c2635273e4cb3b66eeec52`. [Parser log](/tmp/clec-unit1-exact.YnKfuE/parser.log)
- The independent review's original signal miss was 2,287.166 ms. The first local reproduction on integrated base `9a0124487f3fca68e99376646c28ed47874d0c13` measured 2,284.576 ms. After explicit reaping, each direct final process scan was empty. [Independent receipt](/tmp/clec-review-910e-probes/run-K0WSrt/receipt.json) · [First local receipt](/tmp/clec-deadline-old.vKKglx/run-0d3yLO/receipt.json)

The tested execution closure digest was `7b258050707372cdebaa1db5fc69aac060a92ec7beff6637a3c1e1a55623365a` before and after the matrix. The installed Node, Pi release tree, native executable, and Skill matched the exact runtime pins in the historical section below. The observer `/bin/ps` hashed to `1e46cdb824858eb32e4c85ca920ba31b4541a814a133980d8b3484f39942276c`. The current proof-source pins are:

| File | SHA-256 |
| --- | --- |
| `PROTOCOL.md` | `80383a54a87ed31e457f87d9a569c2ae8511856d33939534eec417360f091a3f` |
| `tsconfig.json` | `3911429e4968c1c0e91561bce48ba72ebbe392de9a7f3627d4ec681f2056d1db` |
| `types.ts` | `c396467a76eaee5c942d6ae1797f53d69a99b98eaf7c796bb609593c82a09522` |
| `pins.ts` | `446cf7b5a6968942208f156105d840ca483dcc9269adaeae359cabdcad7bf1ee` |
| `framing.ts` | `d8da91d4fae2e4806fdd0569ae229f5f5c2192c0e36a6869748a90c900f110f7` |
| `process-group.ts` | `68b066049f3b359e311d473ff8b6debd0c3ba5d9e20df2808f5b0cb355096025` |
| `group-helper.mjs` | `8c45d3a934012b1b90f3f084bacfe1fe50461237db4578efbd8644387f32189e` |
| `clec-adapter.ts` | `210f2c22c3648a0d5f4fe28c32005626bc607c278f0e05eb44428ed4cec42522` |
| `controller.ts` | `c99b0ff88d7ae17fe62b0fcd46536d238a570c289fb480bb716d43cbb20288a3` |
| `fixtures.ts` | `8982085157cf440d22d3010e0bb57819280052ebea437a136a05a24491337a04` |
| `run-matrix.ts` | `b11c5be6b51fe3b02f20b09b8775a33677f28f0a7fc40d85c950306264a8f675` |
| `process-observation.test.mjs` | `78c6e319452c42326c34699f42e9e528223f5f1871cb1b0a29de3b25dec3b6ac` |
| `deadline-controls.mjs` | `1c79d0da8e98741a5c3b7aad98c103e640f0ec5ac3031172b857392d3596b48e` |

## Scope and narrow tool profile

Unit 1 delivers only the minimum feasibility artifact in `evaluation/clec-v1/phase6/proof-startup/` and this report:

- `evaluation/clec-v1/phase6/proof-startup/PROTOCOL.md` defines the Unit 1 RPC, private pipe, and group-helper protocol.
- `evaluation/clec-v1/phase6/proof-startup/types.ts` defines branded identifiers, frozen limits, process-observation states, and journal records.
- `evaluation/clec-v1/phase6/proof-startup/pins.ts` hashes the Pi 1.5.2 release tree, Node binary, native binary, skill, dynamic library dependencies, and Unit 1 files without copying Pi auth or mutable state.
- `evaluation/clec-v1/phase6/proof-startup/framing.ts` implements LF-only bounded JSONL framing, byte-counting JSON serialization, 64 KiB bounded raw sinks, exclusive directory/file creation, and the 64 MiB journal writer with a 1 MiB emergency reserve.
- `evaluation/clec-v1/phase6/proof-startup/group-helper.mjs` and `evaluation/clec-v1/phase6/proof-startup/process-group.ts` implement the detached Node group helper, pre-GO registration, `SIGTERM` to `SIGKILL` escalation within 2 seconds, and OS `ps` closure observation.
- `evaluation/clec-v1/phase6/proof-startup/clec-adapter.ts` implements the SDK-typed Pi extension with the narrow Unit 1 status-only `clec` tool, `BoundReady` handshake, `tool_execution_start` outer admission latch, and nonrejecting `before_provider_request` latch.
- `evaluation/clec-v1/phase6/proof-startup/controller.ts` implements the outer supervisor `runUnit1Proof` and immutable per-run index entries.
- `evaluation/clec-v1/phase6/proof-startup/fixtures.ts` and `evaluation/clec-v1/phase6/proof-startup/run-matrix.ts` run the loopback OpenAI mock server and the 45-case verification matrix. The focused parser tests and `deadline-controls.mjs` cover the deadline correction.

Unit 1 restricts `clec` to `{ action: "status" }` with `additionalProperties: false`. It does not claim acceptance of the six-action closed `ClecRequest` contract (`schema`, `help`, `status`, `search`, `read`, `sources`), which Unit 4 integrates after Units 2 and 3.

## Runtime findings verified during Unit 1

1. **CLI `--no-tools` disables extension tools in Pi 1.5.2.** Passing `--no-tools` sets `allowedToolNames` to `[]` in `dist/core/sdk.js`, which hides extension tools so `pi.getActiveTools()` returns `[]`. Passing `--no-builtin-tools` disables all built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`) while keeping extension tools active and letting `session_start` detect unauthorized extension tool drift such as `bash`.
2. **Blocking `fs.createReadStream` on an inherited pipe blocks Pi EOF exit.** When the adapter opened inherited FD 3 with `fs.createReadStream(null, { fd: 3 })`, libuv's threadpool `uv_fs_read` kept `process.exit(0)` blocked after `rpcIn.end()` triggered `session_shutdown`. Switching FD 3 and FD 4 in `clec-adapter.ts` and `group-helper.mjs` to non-blocking `net.Socket({ fd })` with `session_shutdown` cleanup restored clean exit (`code: 0`) within milliseconds of RPC stdin EOF.
3. **User prompts normalize to a single text content block in OpenAI payloads.** Pi's `openai-completions` adapter sends user prompt text as `[{ type: "text", text: "CLEC public question follows.\n..." }]` (or a plain string). The outer payload validator accepts only an exact string or a single-element `{ type: "text", text }` array matching the committed literal prompt bytes.
4. **Loopback `openai-completions` SSE merges duplicate tool call IDs within one chunk.** Within a single streamed completion, Pi's `ensureToolCallBlock` indexes blocks by `toolCall.id`, so a reused `id` inside the same response collapses into the earlier block or produces an empty ID. The outer supervisor now rejects both empty `toolCall.id` values and duplicate `toolCall.id` values across turns.

## Historical source, runtime, and binary pins

- **Prepared base commit.** `3999d3ef4cd96ddbf03b39aaba0395dccb3996d8` (incorporating Stage 6A acceptance `110c5eb4a06d04c6556fdd675dcfc291a10f22d3`).
- **Tested Unit 1 source commit.** `e393d226c8cd18ca240306878ed51fdfc38ed211` (`gitDirtyPathsCount: 0` during final matrix run).
- **Native binary (`installed_temp_package`).** `/tmp/clec-coordinator-install.Y1F9gC/prefix 空 格/lib/node_modules/@clec/cli/bin/clec.exe`, SHA-256 `083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7`. Note that the upstream native build source provenance of this local binary remains `not_verified_unknown` per the Stage 6A receipt separation.
- **CLEC skill (`installed_temp_package`).** `/tmp/clec-coordinator-install.Y1F9gC/prefix 空 格/lib/node_modules/@clec/cli/skills/clec/SKILL.md`, SHA-256 `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b`.
- **Pi 1.5.2 entry and bounded tree.** `/Users/century/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`, SHA-256 `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`. Full bounded release tree `/Users/century/.pi/agent/install/releases/1.5.2` hashed 15,319 regular files (113,982,503 bytes) with tree SHA-256 `8f37ccfd783605fb5390d8c17d861fe28657ccfd5899a6938e685131f4095baf` and all 8 `.bin` symlinks verified inside root.
- **Node runtime.** `/Users/century/.nvm/versions/node/v25.7.0/bin/node` (`v25.7.0`, `darwin` `arm64`), SHA-256 `67252740eb6dadeff855b991ec85d7a7cf1d5d70ba7e68adf8d73b17df8a4b95`, run with `NODE_DISABLE_COMPILE_CACHE=1`.
- **Closure digest invariance.** `closureBefore.closureDigest` equalled `closureAfter.closureDigest` (`aebaca232969345e265148faa29bb3147e89c66e992af5e49a470e9bfd6cf976`).
- **Retained matrix receipt.** `/Users/century/.t3/worktrees/clec/t3-29745844-9b87d0908f446090/.cache/phase6b-unit1/matrix-1794957381967-cc0eb0b1/matrix-receipt.json`, SHA-256 `1c5384714efbf44b5435eaef5c7725e635c70556db69a0fd9b155a2395038f71`.

Unit 1 file SHA-256 pins at `e393d226c8cd18ca240306878ed51fdfc38ed211`:

| File | SHA-256 |
| --- | --- |
| `PROTOCOL.md` | `cd4fe6b67ac906cefea12c276d4a76702c380b1d2796d2cd0b37402390239f75` |
| `tsconfig.json` | `3911429e4968c1c0e91561bce48ba72ebbe392de9a7f3627d4ec681f2056d1db` |
| `types.ts` | `a70d7c475740747125d1a1a4f5a3ee5ba8c003f9ed4b5fe2429f7a33510d33df` |
| `pins.ts` | `c29d685a1681b96a126531c5a0057c3f8c3a016c37af8a75af8a36dc2e246693` |
| `framing.ts` | `751aa9577d0da89f6599e72ee38b59c0539b057cfe2206a24d71ac9442f09059` |
| `process-group.ts` | `885a3910e68922d848ff491fd4ded78ec6bcc59009531577c7f27fd6929f753d` |
| `group-helper.mjs` | `8c45d3a934012b1b90f3f084bacfe1fe50461237db4578efbd8644387f32189e` |
| `clec-adapter.ts` | `210f2c22c3648a0d5f4fe28c32005626bc607c278f0e05eb44428ed4cec42522` |
| `controller.ts` | `b3ce7c516e3abbceb60508939174634d5d1dff5a8e04910d78257f939b389927` |
| `fixtures.ts` | `8982085157cf440d22d3010e0bb57819280052ebea437a136a05a24491337a04` |
| `run-matrix.ts` | `5308e0a84a445a6cffb8da26d67306afba8bb0f99e05a1d900ea74fde6fa9e4b` |

## Historical Unit 1 matrix

All 45 checks in `run-matrix.ts` passed (`45/45`) and left zero surviving child processes (`ps` verified empty):

- **Startup (9/9 passed).** `startup_positive` verified exact sequence `bound_ready` -> `bound_ready_ack` -> `get_state_ok` -> `prompt_encoded` -> `prompt_sent` -> `prompt_preflight` -> `provider_candidate` -> `provider_grant` -> `provider_permit_sent` -> `agent_settled` -> `pi_exited` (`code: 0`, 1 loopback request). All 7 negative startup faults (`startup_missing_extension`, `startup_import_failure`, `startup_setup_throw`, `startup_session_start_throw`, `startup_no_ready`, `startup_early_eof`, `startup_broken_channel`) produced 0 prompts and 0 loopback requests. Control sensitivity `startup_bypass_ready_sensitivity` proved missing `bound_ready` is recorded and marks the run `uncertified`.
- **Literal input (5/5 passed).** Leading slash (`/help /skill:clec /unknown-cmd`), JSON-looking (`{"id":"fake-rpc","type":"abort","command":"bash"}`), multiline (`first line\nsecond line\n/third-line`), and `@file`-like (`@README.md @/etc/passwd`) questions arrived at loopback as the exact suffix of `"CLEC public question follows.\n"` with matching SHA-256 digests. `literal_altered_encoder_sensitivity` proved an altered encoder triggers the expected byte mismatch.
- **Admission (11/11 passed).** `admission_valid` passed 2 provider requests committed before permit ACK with 1 real `clec.exe status` run. `admission_bash_drift`, `admission_schema_drift`, `admission_sync_serialization_err`, `admission_async_channel_reject`, `admission_eof_during_latch`, `admission_record_fail_before_grant`, and `admission_malformed_ack` all produced 0 loopback requests. `admission_replayed_ack` executed turn 1 and rejected turn 2 replay (0 turn-2 requests). `admission_record_fail_after_grant` observed 1 already-granted request, closed further admission, and marked `InvalidEvidence`. `admission_unprotected_guard_sensitivity` proved disabling denial blocking allows 1 forbidden request to reach loopback.
- **Budget (5/5 passed).** `budget_8_valid_plus_answer` executed 8 serial real `clec.exe status` calls (`nativeStarts: 8`, 9 provider requests) and answered. `budget_8_invalid_then_9th_valid` consumed 8 attempts on schema-invalid calls and denied call 9 with `nativeStarts: 0` and 1 provider request. `budget_8_valid_then_9th_unknown` executed 8 native calls and denied the 9th unknown call at `tool_execution_start` with 0 extra HTTP requests. `budget_duplicate_call_ids` rejected reused `dup_call_1` explicitly (`nativeStarts: 1`). `budget_batch_terminated_early` recorded all 10 declared calls when call 9 terminated the batch.
- **Before GO (6/6 passed).** `before_go_registered_then_go` committed `group_registered` while the native sentinel was absent, then created the sentinel after `GO`. `before_go_reg_write_fail`, `before_go_eof`, `before_go_pi_death_before_ready`, and `before_go_pi_death_between_reg_and_go` all left the sentinel absent and closed waiting helpers. `before_go_bypass_gate_sensitivity` detected pre-registration sentinel execution.
- **After GO (4/4 passed).** `after_go_native_kills_pi_ignores_term` (historical cleanup elapsed 778 ms), `after_go_leader_exit_surviving_child` (historical cleanup elapsed 754 ms), and `after_go_pi_death_during_output` (historical cleanup elapsed 904 ms) killed owned PGIDs and confirmed `closure.kind === "gone"` via `ps`. Those elapsed samples include observation. `after_go_omit_cleanup_sensitivity` observed 2 surviving native processes in PGID 22791 before explicit test cleanup.
- **Observation (2/2 passed).** `obs_agrees_with_ps` confirmed `ps` agreement (`gone`) and `obs_ps_failure_unknown` recorded `Unknown` and `uncertified: true` on injected `ps` failure.
- **Basic ownership and bounds (3/3 passed).** `ownership_exclusive_retained` kept prior run artifacts and index entries byte-identical (including 0-byte `pi.stderr.bin`). `ownership_precreated_paths_and_dup_id` rejected pre-existing `APPEND_SYSTEM.md`, `SYSTEM.md`, `settings.json`, `models.json`, and duplicate `AttemptId` without overwriting bytes or calling the provider. `bounds_caps_and_stalled_sink` verified the 32,768 native stdout prefix cap, 65,536 Pi stderr prefix cap, 63 MiB normal journal cap with 1 MiB emergency reserve, and deadline enforcement under a stalled sink.

## Pending work and open gates

The independent review at `910e812353e9e43ed51aad5ecffdbc21331c5c7c` found two blockers. The integrated base corrected malformed process output and future-action guidance. This correction addresses the cleanup deadline and awaits an independent rerun. Node syntax checks and runtime suites ran. A separate TypeScript semantic check remains unverified because the available local toolchain had no `tsc`.

The proof observes the tested macOS arm64 runtime and owned inherited groups. An OS scheduling delay or uninterruptible syscall can defeat timing or closure. PID/PGID reuse and second-resolution start times limit identification. An incomplete write, unknown observation, or missing artifact leaves the proof uncertified.

- **Pending Unit 1 gate.** Independent fresh review and rerun of Unit 1.
- **Pending implementation units.** Unit 2 (canonical `PublicRunPlan`, external commitments, and unified `Prefix`/`Closed` parser/reducer in `validate`, plus mutation replay), Unit 3 (full bounded capture, split UTF-8 and binary stderr retention, and closure tamper checks), and Unit 4 (one-wave host migration and six-action `ClecRequest` integration).
- **Unchanged open product and evaluation gates.** Real external provider profiles and entitlements, Google Vertex wire behavior, production bootstrap, package/rights, cross-OS support, live Jev behavior, actual-host quality, Stage 3 (`FAILED`, consumed holdout `CLOSED`), Stage 5 (`mock accepted` unchanged), default manifest `None`, `providerVerified: false`, and the 24 `DRAFT` fresh cases.

## Reproduce the current proof

Run from the repository root at the tested source commit. Each invocation allocates a fresh private evidence root.

```sh
proof=evaluation/clec-v1/phase6/proof-startup
node=/Users/century/.nvm/versions/node/v25.7.0/bin/node
out=$(mktemp -d /tmp/clec-unit1.XXXXXX)
export NODE_DISABLE_COMPILE_CACHE=1
"$node" --test "$proof/process-observation.test.mjs"
"$node" "$proof/run-matrix.ts" --out-parent "$out"
"$node" "$proof/deadline-controls.mjs" "$out"
```

Pass `--case startup_positive` to the matrix to run a single control.
