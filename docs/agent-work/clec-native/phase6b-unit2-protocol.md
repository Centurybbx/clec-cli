# Stage 6B Unit 2 proof protocol

Unit 2 runs the ordered public plan against installed Pi and the installed CLEC `status` action on a private synthetic loopback endpoint. It retains evidence under the Unit 1 proof notice. An `Answered` status describes the recorded lifecycle and terminal answer bytes. It carries no quality verdict.

## Plan and anchors

- `contract.ts` parses the version 1 plan. Case IDs are unique and ordered. The schedule contains at least one case. Each case supplies a literal UTF-8 question and its SHA-256.
- The profile binds the source inventory, runtime inventory, Skill, system prompt template, question prefix, schema, settings, synthetic corpus and limits. Pi adds the expected attempt-local working directory to the fixed synthetic system prompt. The installed Skill is pinned, and discovery is disabled for this control.
- The proof uses an empty offline corpus. The preflight and postflight inventory record the absent index, archive, active pointer and database. Successful native status output must agree with that inventory.
- The runner publishes the expected plan and profile digests to an exclusive sibling file before launch. The caller supplies this independent value to `inspectRun`. The original root in the anchor establishes the expected working directory and native data path even when evidence is copied for inspection. A completed run gets an exclusive sibling final entry with the summary digest.

## Recorded facts

- The Unit 1 controller still owns permission, epoch checks, process groups and cleanup. Pi RPC stdout is retained byte for byte. The attempt journal references each parsed frame with a byte offset, length including LF, and digest over the bytes before LF.
- The run journal orders attempt identities and references whole artifacts by role, relative path, range and digest. The validator derives required streams from the recorded attempt and its native leases. Native chunk records bind the run, attempt, call and lease to ranges in stdout or stderr.
- The parser checks UTF-8, JSON and event order. The same Pi projection consumes live and retained frames. At attempt boundaries the runner uses `Prefix` to select the next case or replacement. Both seal and inspection run `Closed` over the raw evidence. An existing summary must equal the independently derived summary and digest.
- The reducer compares actual assistant call IDs with reservations, native leases, tool results and the model-facing payload history. It verifies that process and drain observations meet the existing cutoff. Completion requires the scheduled cases and a terminal run record.

## Failure and replacement

`TaskFailed` retains a fully witnessed failure such as a content filter refusal or an answer truncated by the provider. `DeniedAndTerminated` retains an observed tool-budget denial, signal and closed capture. The final declared batch can include calls that were never released. Incomplete cleanup or an invalid transcript cannot yield a complete summary.

The sole replacement follows its initial attempt immediately. A positive loopback socket reset, a matching Pi transport error, clean exit and a complete transcript with no assistant text, thinking, deltas or tool calls establish eligibility. An observed reset after work yields `TaskFailed`. Content quality has no bearing on eligibility.

The proof assumes a trusted writer and the Unit 1 inherited-process-group model. The external anchor protects against bundle-only plan or pin changes. An actor who can replace the anchor and all trusted evidence can forge a consistent bundle.
