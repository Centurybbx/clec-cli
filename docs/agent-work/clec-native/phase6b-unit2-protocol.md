# Stage 6B Unit 2 proof protocol

Unit 2 runs the ordered public plan against installed Pi and the installed CLEC `status` action on a private synthetic loopback endpoint. It retains evidence under the Unit 1 proof notice. An `Answered` status describes the recorded lifecycle and terminal answer bytes. It carries no quality verdict.

## Plan and anchors

- `contract.ts` parses the version 1 plan. Case IDs are unique and ordered. The schedule contains at least one case. Each case supplies a literal UTF-8 question and its SHA-256.
- The profile binds the source inventory, runtime inventory, Skill, system prompt template, question prefix, schema, settings, synthetic corpus and limits. Pi adds the expected attempt-local working directory to the fixed synthetic system prompt. The installed Skill is pinned, and discovery is disabled for this control.
- The proof uses an empty offline corpus. The preflight and postflight inventory record the absent index, archive, active pointer and database. Successful native status output must agree with that inventory.
- The runner publishes the expected plan and profile digests to an exclusive sibling file before launch. The caller supplies this independent value to `inspectRun`. The original root in the anchor establishes the expected working directory and native data path even when evidence is copied for inspection. A completed run gets an exclusive sibling final entry with the summary digest.

## Recorded facts

- The Unit 1 controller owns permission, epoch checks, process groups and cleanup. Pi RPC stdout is retained byte for byte. Each journal frame reference carries its offset, length including LF, and SHA-256 over the bytes before LF.
- The run journal marks an attempt active before launch. Its completed attempt entry references whole artifacts by role, relative path, range and digest. One required artifact is the controller's exclusive `_index/<attemptId>.json`. The controller records the final journal sequence, byte watermark and close time after capture and journal close. The runner advances only after the controller returns a drained, certified result and publishes that index. A refused or incomplete recording leaves the attempt active and the raw evidence available.
- The validator derives the outcome from the raw evidence. It checks the index against the run and attempt identities, pinned closure, capture paths, terminal journal watermark, process facts, and derived outcome. A terminal journal entry can precede journal close. Its status alone cannot establish completed capture.
- One Pi projection consumes live and retained frames. The validator matches the bootstrap frame to the controller's launch and state handshake, then binds the terminal idle frame to that session and model. The accepted budget termination uses the bootstrap binding and witnessed denial. The loopback listener's local endpoint and receipt time bind each observed request to the launched attempt.
- An attempt journal orders each candidate, durable grant and sent permit inside its Pi turn, after prompt preflight and before the assistant response or attempt termination. One authorization is outstanding at a time. The validator reconciles ordered declarations and results in the actual provider request with prior Pi turns. It compares the server's observed text and finish reason, tool declarations, socket reset, or supported HTTP error with the corresponding Pi response.
- Journal and group observation times are relative to the attempt. Stop timestamps use the controller's `performance.now()` clock. Replay subtracts the origin recorded at launch and checks signal, reap, observation, and drain against the journal and stop cutoff. Pi and native escalation use 350 ms and 400 ms respectively. Both use a 2,000 ms cleanup cutoff. An already reaped Pi can have an explicit no-signal disposition. A native stop can begin at report-channel EOF while the reader drains a buffered exit frame. The exit frame must be retained before native drain and result delivery.
- Native chunk records bind the run, attempt, call and lease to ranges in stdout or stderr. At attempt boundaries `Prefix` validates those records and compares the live Pi facts with replay before selecting the next case or replacement. Seal and inspection both run `Closed`. An existing summary must equal the independently derived summary and digest.

## Failure and replacement

`TaskFailed` retains a fully witnessed failure such as a content filter refusal or an answer truncated by the provider. `DeniedAndTerminated` retains an observed tool-budget denial, signal and closed capture. The final declared batch can include calls that were never released. Incomplete cleanup or an invalid transcript cannot yield a complete summary.

The sole replacement follows its initial attempt immediately. A positive loopback socket reset, a matching Pi transport error, clean exit and a complete transcript with no assistant text, thinking, deltas or tool calls establish eligibility. An observed reset after work yields `TaskFailed`. Content quality has no bearing on eligibility.

The proof assumes a trusted writer and the Unit 1 inherited-process-group model. The external anchor protects against bundle-only plan or pin changes. An actor who can replace the anchor and all trusted evidence can forge a consistent bundle. Evidence collected by the earlier candidate lacks the required post-close facts and requires a fresh capture for this protocol.
