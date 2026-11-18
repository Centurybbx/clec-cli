# Stage 6B Unit 4 host preparation

The verified source is `a4a7118f29081a1f344291389ec2d3053bfb5203` on integrated base `6dc8cff626cc8590321265fc4018d49f132013c0`. The migrated macOS arm64 host used the installed native CLI and Skill, Node v25.7.0, and Pi 1.5.2 against scripted IPv4 loopback. This evidence covers synthetic execution and closure. Actual-host evaluation and quality remain open.

## Independent acceptance

GPT 6.2 Astra accepted `d207a2929d1b471d090dc4e72cc2298f0d8bac63` for synthetic host preparation on pinned macOS arm64. The reviewer reproduced no P0 or P1. Focused tests confirmed the action boundary, exact tool results, drift rejection, and ninth-call denial. The independent cleanup scan found no survivors among 74 recorded PIDs and 32 PGIDs. The coordinator fast-forwarded to the accepted commit. [Independent replay](/private/tmp/clec-6b4-review.SZUYMr/replay.sh) · [Process scan](/private/tmp/clec-6b4-review.SZUYMr/process-scan.json)

The reviewer recorded the `schema` limit as P2. Its full response requires 37,408 bytes. At the frozen 32,768-byte cap it returns `OUTPUT_BUDGET_TOO_SMALL` and consumes one attempt. All six help targets succeeded at the cap. An independent mixed run reached filtered search, sources, passage read, and original read within eight calls. Actual provider smoke and host-answer quality remain open. [Direct sizes](/private/tmp/clec-6b4-review.SZUYMr/direct.json) · [Mixed run](/private/tmp/clec-6b4-review.SZUYMr/mixed.json)

## Migration

Collection, sealing, and offline inspection moved into `evaluation/clec-v1/phase6/host/`. The runtime keeps the contract, runner, CLEC tool, capture, and validation boundaries. The runner remains the sole process and permission owner. The same Prefix and Closed reducer checks the schedule, prompt and request history, native invocations and results, raw streams, and closure. The public collector requires the anchored plan and a local public corpus. It accepts a synthetic response fixture. Fault execution goes through the separate entrypoint under `test/`.

The plan commits the corpus manifest, archive, active pointer, SQLite database, and public ID index derived from that database. It also binds the installed Skill, prompt, tool schema, settings, and execution closure. The live owner rechecks the attempt corpus at provider permit, helper launch, GO, and after native exit. Results reach Pi after evidence commits. Replay checks both the corpus bytes and the admission and postcheck records.

The accepted Unit 1 through 3 implementation supplied the runtime and the original controls. The request mapping and inert fixture content derive from Shiyuan Ji's earlier work at `5609badd2c50a96a8d259e48fcceeb5d95dd256e` and `8812759`. The rejected runtime paths never entered the integrated branch. Prior Unit 1 through 3 reports and their retained evidence keep their recorded provenance.

## Real native and Pi controls

| Scenario | Observed native starts | Loopback requests | Result |
| --- | ---: | ---: | --- |
| All six actions, both read variants, and a tiny status budget | 8 | 2 | Answered |
| Seven typed input rejections and one unknown tool | 0 | 2 | Answered |
| Eight invalid or unknown, then a valid ninth | 0 | 1 | Ninth denied |
| Eight valid, then an unknown ninth | 8 | 1 | Ninth denied |
| Eight unknown tools in one batch | 0 | 2 | Answered |
| Nine unknown tools and a declared tenth | 0 | 1 | Ninth denied. The tenth stayed unvisited. |
| Eight long original reads in one batch | 8 | 2 | Answered. The final provider payload was 154,584 bytes. |

Help, status, search, both reads, and sources returned exact native stdout through Pi and the next loopback request. The original read also reproduced the fixture file byte-for-byte, including CRLF and multibyte text. The installed native `schema` response requires 37,408 bytes. With the frozen 32,768-byte host cap, the invocation exited 2 with `OUTPUT_BUDGET_TOO_SMALL`, zero stdout, and retained raw stderr. A one-byte status budget produced the same typed error. [Action and budget receipt](/private/tmp/clec-unit4-verified.mHjWWX/clec-unit4-contract-kd7f5f/receipt.json) · [Direct schema size and hashes](/private/tmp/clec-unit4-verified.mHjWWX/schema-size.GLldpf/hashes.sha256)

Before the pipe fix, the outer owner granted a 154,502-byte request and the loopback server saw no second request. The test stopped its own Pi child after observing the stalled admission. The direct process scan found the child and all eight native groups gone. After the fix, the adapter kept its latch when the stream accepted the frame into its buffer and the full request reached loopback. The unknown-only controls cover Pi's ordering when lookup errors precede publication of tool result messages. [Before-fix probe](/private/tmp/clec-unit4-pipe-sensitivity.RVedqR/result.json) · [Before-fix process scan](/private/tmp/clec-unit4-pipe-sensitivity.RVedqR/process-scan.json)

A private active pointer changed after a committed provider grant, after a committed GO intent, and after native exit. The three controls respectively observed zero HTTP requests, zero native starts, and zero delivered results after the change. Each run remained uncertified, and inspection agreed with collection. Seal and inspect also agreed on copied archive, active pointer, and Skill drift, plus a false summary with a recomputed digest. [Drift and mutation receipt](/private/tmp/clec-unit4-verified.mHjWWX/clec-unit4-contract-kd7f5f/receipt.json)

## Migrated controls

- Strict scoped TypeScript 5.9.3 passed. The Unit 1 matrix passed all 45 cases. All 16 framing and process tests and all 24 deadline controls passed. With delayed process enumeration, the old path sent its kill at 2,279 ms and the migrated path at 403 ms. With blocking raw and journal FIFO writes, the old paths exceeded 2,300 ms and the migrated paths sent their kills within 403 ms. The test distinguishes timely signaling from unknown observation or incomplete drain.
- Unit 2 passed 12 real runs and 68 isolated bundle controls with seal and inspect parity. The adapted timing, late-close, empty HTTP, active EOF, authority, and partial stdout write probes completed. The real partial-write probe retained its first seven stdout bytes, observed kernel `EBADF`, and reaped Pi with zero provider requests.
- Unit 3 passed 13 capture cases and 13 closure mutations. Native capture preserved the split UTF-8 and binary stderr fixtures, bounded overflow prefixes, and rejected invalid successful stdout. Real Pi overflow and the stalled FIFO and failed-write controls preserved the capture and cleanup limits. Four real collections sealed and inspected, including two concurrent workers. The 28 earlier files survived the concurrent run byte for byte, and all 84 then-existing files survived the rerun.
- The final direct `/bin/ps` scan found zero survivors across 291 recorded PIDs and 103 PGIDs. The journal reserve test retained 65,553,407 normal bytes and a 153-byte terminal record for a total of 65,553,560 bytes. [Process scan](/private/tmp/clec-unit4-verified.mHjWWX/process-scan.json) · [Journal limit](/private/tmp/clec-unit4-verified.mHjWWX/journal-limit.json) · [Partial stdout failure](/private/tmp/clec-unit4-verified.mHjWWX/stdout-failure.log)

The 30-file host inventory SHA-256 is `4dc28bb0e160ed91d898abb358ce185dc438f91aee1defd4706a37bfc8519777`. The shared execution closure SHA-256 is `47aa8b2cbe5a074eba3ab821ed08640a34026b23662cfe3480cb8059fd085ed9`. The capture and closure receipts retain the individual installed runtime pins and linkage. The public fixture was prepared by the existing publisher with SHA-256 `ac6477f7501deb13fd6b15ef5f76107511152ee225da3f2923d2efa95a01fbc6`. The corpus database release is `ece989f5eb7edf8df0328f23612792e54a980cf268bfc97c7da8f81c0d1812a1`.

The previous Unit 2 P2 remains open. Moving the second reservation before the first group's records within an otherwise complete batch still passed seal and inspect. The original 24-versus-25 count and missing reproduction-file copies remain recorded in the Unit 3 report. The migrated deadline receipt contains 24 controls. All nine prior Unit 3 receipt and command hashes matched. [P2 replay](/private/tmp/clec-unit4-verified.mHjWWX/p2-timing.Hb390I/receipt.json) · [Prior hash check](/private/tmp/clec-unit4-verified.mHjWWX/prior-hashes.log)

An earlier run stopped after an `ENOSPC` chunk write. It retained an uncertified attempt and its original evidence. The successful final commands used a fresh output root. [Retained failure](/private/tmp/clec-unit4-verified.aIjoTs/contract.log)

## Exact commands

Run from a clean checkout of the source commit using the same installed pins. The command record includes the TypeScript 5.9.3 compiler path and type roots. It adapts copies of the historical independent probes to the migrated paths and required corpus artifacts, then rechecks the original probe hashes.

```sh
recipe=/private/tmp/clec-unit4-verified.mHjWWX
out=$(mktemp -d /private/tmp/clec-unit4-reproduce.XXXXXX)
cp -n "$recipe/commands.sh" "$recipe/adapt-probes.py" "$recipe/check-receipts.py" "$out/"
/bin/bash "$out/commands.sh" "$out"
python3 "$out/check-receipts.py" "$out"
```

The supplementary schema probe used the installed `clec.exe` with a scrubbed environment, `--offline --json --max-bytes 131072 schema` for the natural response size, and the same command with `32768` for the bounded error. The timing replay probe takes the host directory, the retained `actions` bundle, and a fresh copy location. [Command record](/private/tmp/clec-unit4-verified.mHjWWX/commands.sh) · [Probe adaptation](/private/tmp/clec-unit4-verified.mHjWWX/adapt-probes.py) · [Receipt checker](/private/tmp/clec-unit4-verified.mHjWWX/check-receipts.py) · [P2 reproduction probe](/private/tmp/clec-unit4-verified.mHjWWX/p2-timing.Hb390I/check.mjs)

## Receipt hashes

| Evidence | SHA-256 |
| --- | --- |
| [Six-action contract](/private/tmp/clec-unit4-verified.mHjWWX/clec-unit4-contract-kd7f5f/receipt.json) | `05a34ac54192ade4e4590461e8e1afa7fa330bda873b9f3d6bd6a687a427c039` |
| [Unit 1 matrix](/private/tmp/clec-unit4-verified.mHjWWX/regression/matrix-1794971244608-49d97911/matrix-receipt.json) | `30d91343a537ae9ae7fa8d24e99421c1335bd69466db3e3faea43a12ddfe3549` |
| [Unit 1 deadlines](/private/tmp/clec-unit4-verified.mHjWWX/regression/clec-deadline-controls-utc7aG/receipt.json) | `e9b3951ca61dc5d6849e1318d88f93c2ba0e6898fa44039f06f527f43829dab7` |
| [Unit 2 replay](/private/tmp/clec-unit4-verified.mHjWWX/regression/unit2-controls-baKUUs/receipt.json) | `c9a9e8435e06c20c22295b2a18498203d775957fa62004f1a8f18c2417f2e078` |
| [Unit 3 capture](/private/tmp/clec-unit4-verified.mHjWWX/clec-unit3-capture-iK4fH5/receipt.json) | `a2d0cbe936efe93d3db759ea558c2ec5be4b563983f54e44bc4699c04c7b0a5c` |
| [Unit 3 closure and retention](/private/tmp/clec-unit4-verified.mHjWWX/clec-unit3-closure-6Wa4FQ/receipt.json) | `f91762b5692653475064895c50611f8c394eb5b462b52f84a224497bf49de4f0` |
| [Final process scan](/private/tmp/clec-unit4-verified.mHjWWX/process-scan.json) | `bf703d58c2d91d78cc37b477a662ffce8be4f997a56d106b3824f25f9565b3c5` |
| [Journal limit](/private/tmp/clec-unit4-verified.mHjWWX/journal-limit.json) | `7707e35430cf031b1749cb1a1e1d1b31d3191fb34a08eaeb9bbbde21390ddee2` |
| [Open P2 replay](/private/tmp/clec-unit4-verified.mHjWWX/p2-timing.Hb390I/receipt.json) | `61c0c16b25c7d289b871c3b51eecc1998607ecb79532c304074f9d2ee0923d8a` |
| [Partial stdout failure](/private/tmp/clec-unit4-verified.mHjWWX/stdout-failure.log) | `7e1540e9d770e7a6353988b89632d68c197b92a0d0e5934bf9c1532f33349728` |

[Full receipt and command hash list](/private/tmp/clec-unit4-verified.mHjWWX/sha256s.txt)
