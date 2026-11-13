# First milestone handoff — implementation frozen

## Scope and validation boundary

Implementation worker: GPT-6.1 Sol, medium. No children spawned. No tests, mocks, synthetic backend, CLI smoke run, corpus build, QMD query, model request or E2E executed by this worker. No credential value was read. Parent reports DeepSeek credential securely supplied to Terra; it is no longer a prerequisite blocker. The previous Terra attempt stopped before runtime on an older dist artifact; a NEW Terra task should use the final compilation below. Do not infer runtime success from compilation or package installation.

Final production source is in `backend/src/`; architecture, contracts, interfaces and plan are in this directory. Existing implementation and all collection/original assets are preserved. New root is backend only; no PR/commit or Web UI.

## Installation and compilation evidence

Node 25.7.0, npm 11.10.1 (`/Users/century/.nvm/versions/node/v25.7.0/bin/npm`). `npm ci --prefix backend --no-audit --no-fund --fetch-timeout=180000 --fetch-retries=1 --maxsockets=2` completed successfully: 266 packages added. Lockfile has 291 package records and zero missing versions. Published better-sqlite3 package includes darwin-arm64 native prebuild; native runtime loading remains Terra's check.

The system `/usr/local/bin/npm` was npm 9.5.0. Early network failures left partial package trees; its node-gyp then failed against Python 3.14's removed distutils. Those trees were moved to `/tmp/clec-api-docs/partial-node_modules` solely for recovery, not linked into the final app. npm 11.10.1 clean installation succeeded. Do not use that temporary tree for runtime. No authored Python implementation was added; Python appeared only in the failed native dependency build tooling.

Final build activities (both exit 0):

```sh
/Users/century/.nvm/versions/node/v25.7.0/bin/npm --prefix backend run build
/Users/century/.nvm/versions/node/v25.7.0/bin/npm --prefix backend run typecheck
```

These are compilation/typechecking, not tests. `dist/cli.js`, `dist/catalog/index.js`, and `dist/io/catalogue-output.js` exist in the frozen artifact. Frozen CLI SHA-256: `14d33f0916bbb4039a7ae4e6f38c99f9b50b741f1f690ff03836c39071803dbc`. Generation adapter: `296adbfc0ead1d92c04af3da4dcdd06d99792936eb9ce26e1201ffa81e61c67c`; Pi adapter: `df8809b60d8d6768cc0470fb03f26644164a1b79fb6ee31143220827687e959c`; lockfile: `99cfb3982e485813e7c36fb74a0a221f634a187791d5a7e41aac13637471c289`. No more dist/dependency mutations by this worker after handoff.

## Exact Terra commands using compiled CLI

Run from `/Users/century/vibing/clec/backend`. Keep tests' outputs/state isolated; parent privately provisions DEEPSEEK_API_KEY into the process environment. Do not put the key in shell history or output logs.

Small real-source vertical slice:

```sh
export CLEC_WORKSPACE=/Users/century/vibing/clec
export CLEC_STATE_DIR=/Users/century/vibing/clec/backend/.data/terra-first
export CLEC_QMD_URL=http://localhost:18181
export DEEPSEEK_MODEL=deepseek-flash
export DEEPSEEK_BASE_URL=https://api.deepseek.com
node dist/cli.js build ../docs/backend/intake.example.json
node dist/cli.js status
node dist/cli.js qmd-serve 18181
```

Leave the last command running in its own terminal; QMD starts only through this real upstream CLI, never a substitute server. In another terminal with the same environment and privately supplied API key:

```sh
node dist/cli.js ask '資料中如何描述退休所需的年開銷倍數？'
```

Full catalogue → intake (no hand-curated scope):

```sh
node dist/cli.js catalogue --root /Users/century/vibing/clec --manifest "$CLEC_STATE_DIR/intake-v1.json" --report "$CLEC_STATE_DIR/corpus-v1.json"
node dist/cli.js build "$CLEC_STATE_DIR/intake-v1.json"
node dist/cli.js status
```

Stop/restart the QMD serving process after the build so it serves the newly published generation; an old process has the old collection and cannot serve new passages. `qmd-serve` pins CURRENT at startup. Small/full builds above are separate options; no full-corpus build was run by implementation. Full build may be slow due to the batching limitation below. Do not promise full evaluation completion from the three-source example.

Use `build <intake.json> --hybrid` for real vector retrieval and reranking. This requires real local QMD embedding/rerank models and may download GGUF assets. Set QMD_EMBED_MODEL consistently for build and serving; upstream documents multilingual Qwen3 embedding as an option. Lexical mode requires no inference-model provisioning for retrieval but has no paraphrase-recall promise. All factual QA uses real DeepSeek API through Pi.

`source <source-id>` prints the complete stored original and section offsets for citation inspection. Ask returns NDJSON `start/search/read/text/citation/complete/error`; the current source completion includes answerability, normalized blocks and metrics (superseding the earlier completion fields). See qa-contract-handoff.md for the incompatible schema-3 result/publication contract. SIGINT/SIGTERM cancel the active request. That earlier CLI milestone predates the current HTTP/durable composition documented in integration.md.

## Catalogue report association

Catalogue command persists BOTH the intake and complete provenance/coverage/relationship report. Each output is atomically replaced independently, report first. A crash between outputs is detectable through `report.outputs.manifestSha256`, the exact byte hash of intake. Non-ready intake entries remain present. Outputs must be inside CLEC_STATE_DIR; collection/original archive state roots and outside-state/symlink escapes are refused. Use versioned filenames so previous provenance remains available.

Generation metadata records `intakePath`, `intakeFileHash` (matching report.outputs.manifestSha256), canonical semantic `manifestHash`, intakeSourceCount, readySelectedSourceCount, actual indexed sourceCount, sectionCount, and exclusion inventory. The rich report is a separate durable sidecar, not stored in SQLite or copied into every generation. Preserve it with its intake; reusing an identical generation retains its first intake association. Catalogue selectedSources counts all selected statuses; selectedReadySources is exposed separately. Neither is a count of independently verified episodes.

## Generation recovery invariant

Reader, existing-generation reuse, and final publication all use one completed-generation validator: computed ID/directory, metadata ID, expected collection, READY content, required metadata and nonempty evidence/index/config files must agree. Failure is INVALID_INDEX; no silently accepted swapped metadata. Incomplete QMD builds with matching BUILDING.json, no metadata and no READY can be moved to a `.failed-*` directory under the build lock, then rebuilt. CURRENT is never moved on failure. A damaged completed generation, or crash after metadata write but before READY, fails closed for manual recovery; never mutate it in place. Stale BUILD.lock requires verifying its owner exited before manual removal. No power-loss/fsync durability guarantee is claimed beyond atomic rename and explicit completion validation.

## Unexecuted real-source scenarios for Terra

- Small real-source build, actual QMD server search, original text/read-scope citation verification and live Pi→DeepSeek answer.
- Catalogue all collected families; verify ready/metadata/quarantine/unsupported/missing/empty/error accounting, retries, archive member provenance and non-ready retention. Compare report hash to generation intake hash.
- Traditional/simplified, short terms, episode IDs and fund codes; direct and paraphrased questions; conditions/speakers/curated interpretation versus transcript; multiple independent same-source passages and multiple sources.
- Related but non-supporting hits: insufficient output without forced irrelevant citation; partial answer with explicit missing support; nonexistent evidence and search failure distinguished.
- Real update and unchanged-build reuse; old QMD server versus new generation; no mixed citations; actual failed-build recovery; wrong ID/collection/READY and metadata-before-READY rejection; source path/UTF-8 failures.
- Real cancellation while QMD HTTP or Pi streams, deadline timeout, service unavailable, provider error and token-limit termination; no complete on failed/aborted runs.
- Actual long QA above 40,000 units: currently expected READ_BUDGET limitation, not success. Parent owns the next fix and real-source coverage.
- Restart/restore/serialized followups/session deletion/isolation/SSE are NOT integrated in this CLI slice. Independent session and HTTP modules need one shared structured QA service and persistent Pi SessionManager integration before those acceptance cases can pass.

Use Terra's separate >=40 real CLEC development/held-out evaluation plan; this worker never read evaluation/backend-e2e or tuned against held-out cases. Record evidence coverage, answer fidelity, missing-evidence honesty, citation accuracy, cold/warm latency, model calls and available usage/cost. No score promises.

## Precise remaining limitations and next boundaries

1. Runtime correctness remains unverified. No ingestion/search/API end-to-end success claimed. Install and TypeScript compile are the only executed checks.
2. QMD 2.8.3 lacks published metadata filter forwarding despite main README. Host source/type filtering after top40 can lose recall; dates not implemented. No private QMD DB coupling.
3. Complete changed-input generations are rebuilt; same generation reuses hashes. Per-source incremental reuse, bounded insertion transactions, prepared-statement reuse, batching/rollback/abort boundaries are next milestone. Current EvidenceStore autocommits every insert, unsuitable for efficient ~10k-source build. Normalized SQLite text also duplicates Markdown and should be measured before keeping/removing it.
4. Only existing UTF-8 TXT/MD ingestion. No binary extraction, subtitle cue/time mapping, new ASR/OCR or semantic duplicate collapse. All original representations preserved; rich catalogue provenance remains external sidecar.
5. Long QA is one whole section, including >40k units, so may be unreadable within budget. Need real Q/A boundaries plus contiguous fallback without truncating originals. Tool guard currently treats read size/scope refusals as fatal; next service should return recoverable bounded refusal/budget information for a narrower read while corruption/cancellation/exhaustion remain fatal.
6. Heading/contiguous fallback does not assert semantic completeness. Neighbour/source expansion is bounded and never silently truncated. Two prefetched neighbours plus all navigation candidates are available, but budgets limit total reads.
7. Stateless boolean-return ask + events is current CLI service. Return one structured result for session/HTTP composition next; do not parse emitted NDJSON or create a second agent implementation. Host session ledger and Pi SessionManager responsibilities must be explicit; restore through SessionManager, never agent.state.messages.
8. Text is one buffered post-validation event, not token-by-token output. Output cap is 2048/request, four requests maximum, 100k serialized-context characters; 60k reported-token guard prevents further calls after threshold but does not reserve worst-case input in advance. Exact tokenizer accounting is future work. Cost is Pi catalog estimate and marked unavailable for unknown custom model IDs.
9. HTTP fetch cancellation stops the client request; QMD's already-running GPU computation may continue upstream. QMD SDK update/embed do not expose an AbortSignal here; cancelled builds finish current upstream operation then cannot publish.
10. Marker validation establishes citation existence/version/read range, never entailment. Model answerability status likewise requires independent human/real-source assessment.

Parallel-owned contributions: `catalog/**` and corpus.md from catalogue worker (CLI integration completed here); `sessions/**` and sessions.md from session worker (not wired); `http/**` and http.md from HTTP worker (not touched or wired here). Compilation includes files present at build time; later parallel HTTP edits require their own build after Terra coordination.
