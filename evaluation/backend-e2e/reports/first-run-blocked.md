# First CLI vertical E2E — blocked before runtime

Observed 2026-11-10, Asia/Shanghai, workspace `/Users/century/vibing/clec`. No test, build, catalogue, QMD server, or paid API request was run. Node v25.7.0, npm 9.5.0. `backend/node_modules` exists, but the installed dependency tree was not validated. `backend/src/cli.ts` was modified at 22:32:55 and includes catalogue; `backend/dist/cli.js` was modified at 22:29:29 and does not. `backend/src/io/catalogue-output.ts` exists but its compiled output does not. `backend/package.json` was modified at 22:36:08. This is not a complete current build; the core owner may be working on it. Do not rebuild or install concurrently. The runtime runner was prepared but deliberately not executed. No result is a pass.

## Preconditions and preparation

The owner must confirm dependency installation and build are complete and stable, including compiled catalogue and `dist/io/catalogue-output.js`. Record a hash inventory of `backend/dist`, package.json, package-lock.json and relevant installed package versions before and after each run; a changed artifact invalidates affected evidence. Use a fresh directory under the system temporary directory. The preparation runner below invokes the production catalogue against the original root, saves its outputs in isolated state, checks development evidence hashes, copies four selected actual sources and a fifth real distractor, and creates a small intake using the actual catalogue entries. It does not build, serve, ask, verify, adjudicate, or read the key.

```sh
cd /Users/century/vibing/clec
RUN_DIR="$(node -p "require('node:os').tmpdir()")/clec-e2e-first-$(date +%Y%m%d-%H%M%S)"
node --experimental-strip-types evaluation/backend-e2e/runtime/prepare.ts "$RUN_DIR"
```

Inspect the resulting catalogue report for family and readiness/quarantine counts, dates and date bases, provenance and issues; compare manifest hash with report. Verify original source hashes again at end. Selected standalone cases: CLEC-002, CLEC-011 (missing evidence, only within the subset), CLEC-031 and CLEC-038; `short-00575.txt` is a real distractor. Copying fails if a selected catalogue source is not ready or a development hash differs. The selected corpus is only a lifecycle sample, not evidence of full-corpus quality. Source text and answers may contain private material; protect logs accordingly.

## Pending real execution

With the same shell and stable artifact, set explicit isolation variables and use the actual CLI:

```sh
export CLEC_WORKSPACE="$RUN_DIR/workspace"
export CLEC_STATE_DIR="$RUN_DIR/state"
export CLEC_QMD_URL=http://localhost:18181
node backend/dist/cli.js build "$RUN_DIR/intake.json" --hybrid
node backend/dist/cli.js status
node backend/dist/cli.js build "$RUN_DIR/intake.json" --hybrid
node backend/dist/cli.js qmd-serve 18181
```

The final command runs in a separately managed foreground process; confirm real HTTP readiness before queries and stop the process group on every exit. Capture sanitized outputs, exact timestamps and durations. On a hybrid dependency/model failure, record it and stop dependent steps; a separately authorized lexical run must be labelled lexical, never hybrid. Compare the unchanged rebuild generation identity and status. Ask each of the four development questions in the file via CLI, and one natural unrelated no-evidence question, with at most two repetitions total per question. Supply the secret only to each spawned `ask` process, via an environment assignment inside that process, without printing the key, environment, or request headers. The selected key path is provided in the task and must not be copied to scripts or reports. Do not pass expected answer/rubric/evidence to the backend. Capture actual NDJSON, exit code, elapsed time, initial cold vs subsequent warm conditions, returned usage and estimated cost if exposed. No metrics on failed/cancelled requests means usage and cost **unknown**, not zero. `estimatedCostUsd` is an SDK catalog estimate when `costEstimateAvailable`, not a bill.

For each citation retrieve `node backend/dist/cli.js source <source-id>`, compare source/version to the citation and SQLite row, compare UTF-16 range and quote with SQLite and the unchanged original file, then manually assess answer claims against the development rubric including attribution, forbidden inferences and caveats. Preserve citations and failures as sanitized evidence, not merely citation regex checks. Keep actual provider failures sanitized and exact as publicly emitted; do not substitute a model or provider. The default is DeepSeek `deepseek-flash`. On any failed prerequisite stop dependent stages and report the specific failure. Capture child cleanup and initial/final artifact hashes. Do not make full-collection claims from this sample.

Current reported limits: four Pi model requests, 2048 output tokens per request, and 100000 JS characters of context. The 60000 totalTokens check uses prior usage as an admission threshold; it is not a hard total cap. No budget stress test is included in this first run. Sessions, SSE, cancellation, lifecycle and the separately frozen full-corpus >=57-case acceptance remain unverified. Do not open held-out data during development.
