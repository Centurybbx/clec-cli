# Stage 6B Unit 2 implementation report

Unit 2 checks whether retained bytes support the outcome of every case in an ordered public run. The status-only proof ran at clean source commit `219a08d757889c7dc9cd2135287eb49d594ea1dc` on pinned macOS ARM64. Status is `PROOF_ONLY_NOT_A_COMPLETE_RUN_CERTIFICATE`. Independent review is pending. [Unit 2 protocol](phase6b-unit2-protocol.md)

## Findings

| Control | Closed result |
| --- | --- |
| One case and two serial native calls | One `Answered` attempt |
| Two scheduled cases | Two `Answered` attempts in plan order |
| Pre-work socket reset | `PreWorkInfrastructureFailed`, immediately followed by an `Answered` replacement linked to the same case |
| Content-filter refusal | One `TaskFailed` attempt, no replacement |
| Truncation after a native call | One `TaskFailed` attempt, no replacement |
| Socket reset after a native call | One `TaskFailed` attempt, no replacement |
| Resets on two separate initial cases | One replacement globally. The second case retains its initial failure |
| Budget denial in a ten-call batch | `DeniedAndTerminated`. The first eight calls consume the allowance without native execution. The ninth is denied, and the tenth remains declared |

The eight runs executed 12 attempts. The final Prefix projection equalled the Closed attempt facts for every run. The live Pi projection also agreed with the replay on terminal text, stop reason, work observation and call count. The positive native records included the helper and native identities, raw streams, contiguous chunk ranges, exit, observed group absence and the bytes returned to Pi and sent in the next provider request.

The transport replacement required a server-observed socket reset paired to Pi's `UND_ERR_SOCKET` error. Pi completed the RPC lifecycle and exited cleanly. There was no assistant content, thinking, delta or call declaration in the retained transcript. A reset following native work produced the same class of transport error, but the retained call and result made the attempt ineligible.

The 27 mutations ran in distinct exclusive clones. The driver copied only required artifacts and rebuilt affected byte references and hashes. The case and call checks failed at the intended invariant rather than at a stale digest. Sealing and offline inspection returned identical results for all variants.

| Mutated evidence | Rejection |
| --- | --- |
| Empty schedule result, omitted scheduled case, duplicate attempt, Running, illegal ordinal | `empty_attempts`, `scheduled_case_missing`, `duplicate_attempt`, `attempt_status`, `attempt_ordinal` |
| Missing answer, agent-end marker alone, absent tool results, duplicate or foreign call ID | `missing_answer`, `agent_end_order`, `missing_tool_result`, `duplicate_call`, `unpaired_call` |
| Malformed JSON or UTF-8, independently missing stream, invalid stream or frame offset, symlink | `raw_json`, `raw_utf8`, `missing_artifact`, `artifact_ref`, `pi_frame_range`, `artifact_path` |
| Missing native references, exit record or chunk records | `missing_artifact`, `native_lifecycle`, `native_chunk_coverage` |
| Rehashed summary count and pin changes, altered runtime inventory, changed native count | `derived_summary`, `runtime_witness`, `native_count` |
| Foreign predecessor, ineligible or second global replacement, changed anchor or plan bytes | `replacement_predecessor`, `unexpected_reattempt`, `external_anchor` |

## Implementation decisions and coverage limits

Foundational Thinking and Type System Discipline put the ordered schedule, attempts and predecessor links in the contract. Boundary Discipline keeps byte and lifecycle checks in the validator. The Unit 2 runner is the only scheduler. It uses the accepted attempt controller for Pi and native ownership, with the bounded reader feeding the same Pi projection used during replay. The existing Unit 1 permission checks and its proof index remain in use. Full cross-channel reconciliation runs at attempt boundaries. The outer runner orders those same attempt facts in its run journal.

The corpus commitment covers the deliberate empty offline data directory. The proof commits a fixed synthetic system prompt with an attempt-local working directory. It hashes the installed CLEC Skill while keeping Skill discovery disabled. The boundary retains the actual observed refusal and tool-budget denial shapes for this runtime. Other abnormal endings require sufficient positive evidence before they can receive a closed status. The absolute deadline check is conservative about starting another case near the run cutoff.

The validated behavior is the macOS ARM64 status-only proof. Linux x64 review proceeds separately. The broader closure-tamper, capture and flood work belongs to Unit 3. The production six-action migration and removal of the historical implementation belong to Unit 4. The run yields no actual-provider or host-quality result.

## Reproduce the final evidence

Run these commands from the repository root at the tested source. Use a new output directory for each run. The checked-in controls write their own exclusive subdirectories.

```sh
p=evaluation/clec-v1/phase6/proof-startup
mkdir -p "$PWD/.cache/phase6b-unit2"
out=$(mktemp -d "$PWD/.cache/phase6b-unit2/review.XXXXXX")
export NODE_DISABLE_COMPILE_CACHE=1
n=/Users/century/.nvm/versions/node/v25.7.0/bin/node
tsc=/Users/century/vibing/clec/cli/node_modules/typescript/lib/tsc.js
types=/Users/century/.pi/agent/install/releases/1.5.2/node_modules/@types
"$n" "$tsc" --version
"$n" "$tsc" -p "$p/tsconfig.json" --typeRoots "$types"
"$n" --expose-gc --test "$p/framing.test.mjs" "$p/process-observation.test.mjs"
"$n" "$p/unit2-controls.mjs" "$out"
"$n" "$p/run-matrix.ts" --out-parent "$out"
"$n" "$p/deadline-controls.mjs" "$out"
```

Prove It Works drove the real loopback traffic, byte comparisons, mutation assertions and process scans. All code and checks used the existing Node and trusted Node types. The clean source produced zero TypeScript 5.9.3 diagnostics. The 16 framing and process-observation tests and all 45 Unit 1 matrix cases passed.

The runtime closure digest was `6f354503509c8c29d87211d9d97d775995235061884d99e1ce2c0c52fd0b76dc` before and after the Unit 1 matrix and all Unit 2 attempts. The Unit 2 source inventory digest was `ee2f3bde03d7b15fcefa3b009ff68aa0b86f2e59f39a618ea1679644aef0ac6f`. The receipt includes the source file digests and the installed native, Skill, Node and Pi pins. The Pi tree covered 15,319 regular files and 113,982,503 bytes.

All 24 Unit 1 deadline controls passed, including blocked writer and observer sensitivities, late publication, and commit-before-permit and commit-before-GO controls. A final direct `/bin/ps` scan found zero survivors across 174 recorded PIDs and 65 PGIDs.

| Retained evidence | SHA-256 |
| --- | --- |
| [Unit 2 cases, mutations and closure](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/unit2-controls-0MmAYD/receipt.json) | `576dce401e3bef456b225dc72b75e6c9788b8d779b8937e65700bad071b0c7f1` |
| [Unit 1 matrix](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/matrix-1794963839612-51146c20/matrix-receipt.json) | `953bdc4699f79d522552b9fc7e2346383cc46607ae4c03c7273c5802d38c9499` |
| [Unit 1 deadlines](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/clec-deadline-controls-xxyvtv/receipt.json) | `cafe2615630eb0d9ff3b703e2b4229807bf7ff1951fa610d58d2d35bbe36b3b4` |
| [Direct process scan](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/process-scan.json) | `f5c138d1a32222519f4e4a4bb0cb9b236f73086214473ddc572e05827f443712` |

Compiler, framing, matrix, deadline and Unit 2 commands exited zero. The ignored evidence root retains the exact commands, exit files, raw bundles. [Command record](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/commands.sh) · [Unit 2 log](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/unit2.log) · [Compiler](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/tsc.log) · [Framing and observation](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/framing-process.log) · [Matrix log](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/matrix.log) · [Deadline log](/Users/century/.t3/worktrees/clec/t3-6b38fdca-6ea07a1386593f47/.cache/phase6b-unit2/final.Y5M4Qe/deadline.log)

Independent review is requested at the implementation commit. Re-run the proof with a fresh output parent, check the external anchor and rejection invariants, and inspect the Unit 1 cleanup ordering before accepting Unit 2.
