# Stage 6B Unit 3 capture and closure

The tested source is `486af88f6c31bead62b1d0187451def6cda7f2d3` on integrated `f26d950af05abc91f91491bf0d5cc5257b2fec45`. This is the `PROOF_ONLY_NOT_A_COMPLETE_RUN_CERTIFICATE` status-only profile using synthetic questions and IPv4 loopback. The macOS arm64 proof uses one outer owner and the existing Prefix and Closed reducer.

## Capture and process evidence

| Control | Observed result |
| --- | --- |
| Native stdout and stderr | The 32,768-byte stdout, including a BOM and a UTF-8 character split across two native chunks, matched the Pi tool result and the next loopback request byte for byte. The 8,192-byte stderr matched its binary fixture. |
| Native overflow and timeout | Each overflow kept the exact cap prefix and chunk digests. Invalid successful stdout stayed on disk and never reached tool result delivery. The timeout preserved its prefix and the shared trigger. The owner sent native SIGKILL after 403 ms and reaped the helper after 405 ms. The OS scan found the group gone. |
| Pi stdout and stderr | Real Pi overflow retained exactly 16,777,216 stdout bytes and 65,536 stderr bytes. Both outcomes were uncertified with direct reaping and zero provider requests. |
| Pi stdout stalled write | The OS FIFO held one 65,536-byte backing for 4.52 seconds. The owner admitted no further chunks through reaping. The sampled readable backlog peaked at 65,536 bytes. The bytes received by the FIFO reader, the pending payload, and the late file write had the same SHA-256. |
| Pi deadlines and publication | The independent 1,800 ms case arm triggered SIGKILL after 352 ms and reaped Pi after 370 ms. Drain expired at the 2-second cutoff. The published attempt remained uncertified and its index stayed byte-identical after the late file write. |
| Pi stderr write failure | The owner retained the first seven bytes, hit kernel `EBADF` on the next write, stopped and reaped Pi, and published incomplete, uncertified capture. |
| Configured framing and answer caps | The control reader accepted a 16,777,216-byte frame and a cumulative 67,108,864 bytes, then rejected further input at each cap. Real Pi returned exactly 65,536 UTF-8 answer bytes. A 65,537-byte answer was uncertified. |

The capture backlog fix uses pull mode for Pi stdout. The stalled-write control exposed an extra data event when Node resumed stdio during reaping with the earlier pause-based implementation. The pull-mode run kept the active bytes under the sink's sole ownership. The Unit 1 retained-buffer and real FIFO controls exercise detached backing, partial writes, journal failure and saturation, two-second escalation, and the old synchronous-path sensitivity. [Capture receipt](/private/tmp/clec-unit3-verified.avgs8B/clec-unit3-capture-1kG4ln/receipt.json)

## Closure and retention

The launcher recaptures the default closure before resource allocation and compares it to the collector's commitment. The pinned TypeScript parser walks the executed host entrypoints and transitive imports. The exact Pi release tree binds its executable chunks, package resolution metadata, and resources. The collector rechecks the closure after attempt publication before sealing the run.

Thirteen copied-fixture controls rejected changes to the adapter, helper, host imports, framing, validator and reducer, Node, and the loaded Pi chunk `chunk-VEJDBY3O.js`. They also rejected invalid symlinks and escaping, unresolved, external, and dynamic imports. The same verifier accepted the original pins before and after these mutations. The launcher's gate refused the copied commitment before creating its attempt directory. The controls used a single copy-on-write Node and Pi fixture tree and kept the mutated copies as inert evidence.

Four real collector invocations used independent roots, including two concurrent workers. The 19 earlier files stayed byte-identical after the concurrent runs, and all 57 then-existing files stayed byte-identical after the rerun. Those files included plan anchors, per-attempt indexes, summaries, and terminal indexes. Offline inspection completed all four runs. [Closure and retention receipt](/private/tmp/clec-unit3-verified.avgs8B/clec-unit3-closure-M0DRPz/receipt.json)

## Source and runtime pins

The source inventory SHA-256 is `5ab157aa6b2c600f80c5c94d70f535aba8b6b67df6da5abb561e4b86c5639d3d`. The execution closure SHA-256 is `db7c46441c1c247dd5c79210aa00658472a2816046b2a6d540320dbc409b4da6`.

| Installed input | SHA-256 |
| --- | --- |
| Node v25.7.0 | `67252740eb6dadeff855b991ec85d7a7cf1d5d70ba7e68adf8d73b17df8a4b95` |
| Pi 1.5.2 entry | `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774` |
| Pi 1.5.2 release tree, 15,319 files and 113,982,503 bytes | `8f37ccfd783605fb5390d8c17d861fe28657ccfd5899a6938e685131f4095baf` |
| Installed native CLI | `083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7` |
| Installed CLEC Skill | `66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b` |
| TypeScript 5.9.3 parser and package metadata | `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`, `822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6` |
| `/bin/ps` observer | `1e46cdb824858eb32e4c85ca920ba31b4541a814a133980d8b3484f39942276c` |

## Verification record

From the clean worktree, the command record ran both Unit 3 control drivers with the pinned Node, then invoked the full Unit 1 and 2 regression command record. The regression record includes the exact TypeScript compiler and type roots, independent probes, and retained input checks. The receipt checker verifies the journal reserve, closure agreement and owned process identities.

```sh
out=$(mktemp -d /private/tmp/clec-unit3-reproduce.XXXXXX)
/bin/bash /private/tmp/clec-unit3-verified.avgs8B/commands.sh "$out"
python3 /private/tmp/clec-unit3-verified.avgs8B/check-receipts.py "$out"
```

[Exact commands](/private/tmp/clec-unit3-verified.avgs8B/commands.sh) · [Regression commands](/private/tmp/clec-unit2-repair.ntTdr3/after/commands.sh) · [Receipt checker](/private/tmp/clec-unit3-verified.avgs8B/check-receipts.py)

Strict scoped TypeScript passed. The Unit 1 matrix passed 45 of 45 cases, all 25 deadline controls passed, and all 16 framing and process tests passed. Unit 2 passed 12 real-run controls and 68 isolated bundle controls. The independent timing, late-close, empty HTTP, active EOF, and authority probes passed.

The matrix journal retained 65,553,407 normal bytes under the 66,060,288-byte normal ceiling. Its 153-byte terminal record committed after normal capacity rejected the next record. The final file held 65,553,560 bytes under the 67,108,864-byte total cap. A direct final `/bin/ps` check found zero survivors across 229 recorded PIDs and 77 PGIDs. [Journal evidence](/private/tmp/clec-unit3-verified.avgs8B/journal-limit.json) · [Process scan](/private/tmp/clec-unit3-verified.avgs8B/process-scan.json)

The capture receipt SHA-256 is `9fa3c93e13efed1c7dc477af3917fe81755ab2d392176111673eac7c2ae68d7f`. The closure and retention receipt SHA-256 is `e8ebe9b41a2bf7c7e7e46b7aa2a90c5d5dd808da1eef3196266ea7350383522a`. The matrix, deadline controls, and Unit 2 receipts share the same execution closure digest. [Receipt hashes](/private/tmp/clec-unit3-verified.avgs8B/sha256s.txt) · [Regression results](/private/tmp/clec-unit3-verified.avgs8B/regression.log)

## Open findings and evidence provenance

The scoped Unit 2 P2 reservation-timing gap is still open. Replay accepts moving call two's reservation ahead of call one's group and result records within a batch, while actual executions stay serial and within budget. The prior parent-rerun artifacts retain that label. Author-original evidence that was lost remains unverified. [Unit 2 acceptance and P2 finding](/Users/century/.t3/worktrees/clec/t3-76daab37-99c823312df08498/docs/agent-work/clec-native/phase6b-unit2-report.md)
