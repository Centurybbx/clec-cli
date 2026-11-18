# Stage 6B Unit 2 evidence-boundary repair

Unit 2 derives each public case outcome from retained evidence and closes the run only after the attempt owner has finished recording and published its index. The tested source was `4e8d282f62aba7b0285ac593f8d94ecb33942c00`, based on integrated `65a2c580ea1c0d63de213c739ba9c251a304098f` plus the original Unit 2 implementation and report. The proof ran on pinned macOS ARM64. Its status is `PROOF_ONLY_NOT_A_COMPLETE_RUN_CERTIFICATE`. Independent GPT 6.2 Astra acceptance is pending before integration and Units 3–4. [Protocol](phase6b-unit2-protocol.md)

## What the repaired evidence proves

| Fresh standard control | Closed result |
| --- | --- |
| One case and two serial native calls | One `Answered` attempt |
| Two scheduled cases | Two `Answered` attempts in plan order |
| Pre-work socket reset | `PreWorkInfrastructureFailed`, then an immediate linked `Answered` replacement |
| Content-filter refusal | `TaskFailed` |
| Truncation after a native call | `TaskFailed` |
| Socket reset after a native call | `TaskFailed` |
| Resets on two separate initial cases | One global replacement. The second initial failure is retained |
| Ten-call budget denial | `DeniedAndTerminated`. Eight attempts consume the allowance without native execution. The ninth is denied and the tenth remains declared |

The eight runs executed 12 attempts. The same Pi projection consumed live and retained frames. Its session, turn, work, result and terminal facts agreed before progression. The final `Prefix` attempt facts agreed with `Closed`. A ninth run exercised the supported HTTP 400 response and produced a fully evidenced `TaskFailed`.

All 27 original mutations rejected at their original invariants. The 26 added mutations covered post-exit and pre-prompt authorization, provider declaration IDs and args, batch ordering, contradictory loopback outcomes, foreign bootstrap and loopback endpoints, stop chronology and missing or contradictory final owner evidence. Affected bundle hashes, frame ranges, authorization payload digests, and final journal watermarks were rebuilt as applicable. Seal and offline inspection returned identical results for all 53 mutations. The receipt names each invariant and its exclusive clone.

The reviewer's original journal-file-close script still produced a raw `attempt_closed` with `Answered`. The detached Unit 1 owner published `InvalidEvidence`, with `uncertified: true` and `Journal drain deadline`. Unit 2 collection and offline inspection both returned `Incomplete` with no next attempt, summary or final entry. A delayed close on an eligible reset also prevented a replacement. A separate successful Pi capture with the exclusive index link refused produced no next attempt or final entry.

## Evidence ownership and scope

Root-cause tracing put the progression gate after final capture and exclusive publication. The run journal records the active attempt before launching it. The validator requires the published Unit 1 index and checks its identity, closure, terminal journal position, process facts and outcome against independent raw records. It derives pre-work replacement from a server-observed reset, the corresponding Pi error and the absence of work. The owner's `TaskFailed` status is consistent with this specific Unit 2 translation.

Boundary Discipline and Model the Domain kept authorization, turn, session and process validation in one reconciliation. Pi bootstrap and terminal idle agree with the launched session and the server's local endpoint. Budget denial may end without terminal idle when the bootstrap, denial, signal and drain are complete. Authorization spans a journal interval tied to one Pi turn, with a candidate, durable grant and actual permit. Each prior declaration and model-facing result is reconciled with the provider payload. Response validation uses server observations at the socket or HTTP response boundary. The HTTP error control covers a JSON error with an observed status and message.

The first clean-source run exposed a real Darwin `kill EPERM` while a normally completed native helper exited. Replay rejected it. The owner now keeps the helper alive after its native exit report. The controller starts cleanup before awaiting the report's journal commit. Report-channel EOF and the existing deadline remain independent stop triggers. Replay subtracts the attempt origin from stop timestamps and checks their relation to observed process and journal events. A legitimate already-reaped Pi has an explicit no-TERM disposition. Signal errors and unknown group observations remain invalid evidence. [First clean run failure](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/clean.8Px1PK/unit2.log)

The proof uses the installed `status` action against the synthetic empty offline corpus and loopback endpoint. It relies on the trusted recorder and inherited process groups described in the protocol. Evidence from the earlier candidate requires fresh capture. Actual provider and host quality remain outside this proof.

## Clean-source verification

The run started at `2026-11-18T01:36:35Z` and ended at `2026-11-18T01:38:59Z`. TypeScript 5.9.3 checked the strict scoped project with the pinned Pi Node types and emitted zero diagnostics. The 16 framing and process-observation tests, 45 Unit 1 matrix cases, and 24 Unit 1 deadline controls passed. A buffered control-pipe EOF during grant commit produced zero requests and no permit. Three separate `datasync` failures blocked the relevant permit or GO and produced zero native starts.

The asynchronous raw and journal FIFO controls retained real pending writes for 2,419.178 ms and 2,417.309 ms until the external releaser drained them. The owner called SIGKILL at 402.618 ms and 402.793 ms from the trigger, with incomplete drain in both controls. The synchronous sensitivities crossed 2,000 ms. The direct `/bin/ps` scan at `2026-11-18T01:38:59.348240+00:00` found zero survivors across 184 recorded PIDs and 67 PGIDs.

The runtime closure was `9351bffca1411c9906a129a235c65a8d7d0278224c2599dd29ddfe874cb8fa76` across the Unit 2 run, matrix before and after, and deadline controls. The source inventory was `8704db45330a7fd5f4009c9605925907ec00ace1a2c3edc5db7d01ad69771f6d`. The closure receipt records Node 25.7.0, the Pi 1.5.2 release tree, installed native and Skill hashes. The six independent probe files matched their retained SHA-256 values before and after the work. [Original probe hashes](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/before.sha256) · [UTC decision trail](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/decisions.tsv)

| Retained evidence | SHA-256 |
| --- | --- |
| [Unit 2 runs, mutations and closure](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/unit2-controls-PQrwN4/receipt.json) | `1613a1b558ae41ff7c624a66c11d274cf5727d69d9fde3e79e83656aadfe5629` |
| [Unit 1 matrix](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/matrix-1794965847750-eba59be8/matrix-receipt.json) | `efe23c5a54864ab29d6b05bebe6ff1215ed2bb7452b58a5331a7507e8f9f872f` |
| [Unit 1 deadline and FIFO controls](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/clec-deadline-controls-kIoZED/receipt.json) | `15c8f73449b409090b582a2b6cd44d7fa97eca0f84c3620145f7c16766f8e058` |
| [Exact late-close rerun](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/exact-late-close.log) | `0c6e38fb0acbbdd8c84c3957295aad72625608c9c69574b3fd644827a794cc58` |
| [Live adapter EOF during grant](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/active-eof.log) | `108fbc00119a44fa1dd430e8b1f7f9af80a0e5cfccf144ff73e31b7557f14f63` |
| [Three datasync failures](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/extra-authority.log) | `b539968096ae8fe402dc6542ad1fa8f2c73c697b597067f9388d46e8db323334` |
| [Direct process scan](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/process-scan.log) | `4364492a59a3fb2f4ad1e984e9636fafec6050b8f80791e5eeb1e04c61ee0d43` |
| [Compiler version](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/ts-version.log) | `4985b444236c5acdb5b850e5d754975e130eed5b033c53f201cdf471e83d7f13` |
| [Strict compiler diagnostics](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/tsc.log) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| [Framing and process observation](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/framing-process.log) | `1ad150c980635900faec7f457d2126cc9d4bcabb8448e59f5a2d1abf1c46e3a5` |
| [Receipt index and runtime pins](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/verified-receipts.json) | `9ec1d0ef40d68dff3d3b2b7dd4c59dd6b26b7f0cdfd80de0aabaf5d5a0830194` |

Use a new private output directory for each run. The command record lists the pinned compiler, runtime and type paths and the exact test commands. Each test wrote its own exclusive evidence directory. [Command record](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/commands.sh) · [Receipt checks](/Users/century/.t3/worktrees/clec/t3-bc3d55b2-d88cf71354c4df42/.cache/phase6b-unit2-repair/retained.E7Dw99/verified.PLVMBo/check-receipts.py)
