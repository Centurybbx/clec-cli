# Lexical operational real E2E — 2026-11-10

**Outcome: FAIL, systemic pre-provider blocker.** This is a five-source operational regression, not full-corpus or hybrid acceptance. Four unchanged development questions were submitted to real HTTP/Pi services against a new schema-2 lexical generation. All were accepted and settled as failed before a search result or provider call. The matching QMD service returned an MCP `initialize` response with `Content-Type: text/event-stream` and an SSE `data:` envelope, while `qa/qmd-generation.ts` reads the response with `JSON.parse` as a JSON document. The independent [clean-install report](clean-install-20261110.md) confirms the same failure and identifies `SEARCH_UNAVAILABLE`; this run's HTTP API exposes the sanitized `RUN_FAILED`. Do not treat zero `searchResults` in failed metrics as a completed zero-hit retrieval or evidence of retrieval quality. Stop here until product repair; no test-only bypass was used.

## Scope and procedure

Node `/Users/century/.nvm/versions/node/v25.7.0/bin/node` (25.7.0), macOS arm64. `prepare.ts` catalogued real originals and copied five sources to a fresh isolated workspace. The isolated generation was created using `backend/dist/cli.js build "$RUN_DIR/intake.json" --lexical`; generation `a6429466d4f10cf21e5825abdaaa97278576bf392562e1b672dc57ac52ca4336` reports five indexed sources, lexical mode, no embedding. The process environment used `CLEC_WORKSPACE`, `CLEC_STATE_DIR`, `CLEC_QMD_URL`, `CLEC_PORT`; `DEEPSEEK_API_KEY` was supplied only to the owned API process from the approved private file, not to catalogue or QMD. No model was downloaded. HTTP service and QMD used dynamically selected loopback ports. Recorder command: `node evaluation/backend-e2e/runtime/lexical-20261110.ts` with the pinned Node executable. The recorder's initial 127.0.0.1 QMD URL could not connect to the localhost IPv6 listener; the final attempt used `localhost`. A brief intermediate attempt had an incorrectly constructed URL and was terminated; it is not evidence of a product defect. The final attempt used the correctly configured service.

Full raw request, SSE and result evidence: `/var/folders/3t/ttww_h754h92jvsvhg66v2p80000gn/T/clec-lexical-e2e-20261110-terra/real-e2e.jsonl`. `selection.json`, isolated generation and service logs remain in that directory. The service logs combine stdout and stderr; this is a recorder limitation, and they were small in this run. No credential value was recorded. The log file is overwritten between attempts, while JSONL preserves each attempt. The runner records cleanup and was not used as an acceptance oracle.

## Questions

| Case | Outcome | End-to-end latency | Model calls / reads |
| --- | --- | ---: | --- |
| CLEC-002 | FAIL: `RUN_FAILED`, result null | 15 ms | 0 / 0 |
| CLEC-011 | FAIL: `RUN_FAILED`, result null | 10 ms | 0 / 0 |
| CLEC-031 | FAIL: `RUN_FAILED`, result null | 9 ms | 0 / 0 |
| CLEC-038 | FAIL: `RUN_FAILED`, result null | 8 ms | 0 / 0 |

Each received HTTP 202, pinned the generation, recorded one attempted search, no candidates or original reads, and emitted terminal failed then settled. There were no answers, citations, original UTF-16 spans, or provenance claims to grade; semantic quality and improvement over the previous four no-hit baseline are **not measurable**. The run records report `usageReports: 0`, `modelCalls: 0`, and `costEstimateAvailable: 0`; no provider usage or estimated cost is available. Four submissions, zero admitted model calls.

## Smallest observed reproduction

Start the frozen `qmd-serve` against the isolated lexical generation and `serve` with matching workspace/state and a key. `GET /health?check=ready` returns 503 `{"status":"not_ready"}`. An MCP POST to `/mcp` with `Accept: application/json, text/event-stream` and JSON-RPC `initialize` returned HTTP 200 with `Content-Type: text/event-stream` and `event: message` / `data: {"result":...}`. A normal full question submitted via `POST /v1/sessions/:id/runs` returns 202 and ends `failed`, `RUN_FAILED`, no result, zero model calls. The QMD status tool independently reported the exact matching generation collection path and five documents, including the required typed metadata keys. Thus the failure is before status validation and actual lexical search, not a demonstrated empty index. See the independent clean-install report for a separately reproduced diagnostic and exact provider-side failure classification.

## Remaining acceptance

NOT_EXERCISED: successful question/followup, semantic/citation grading, scope switch and intersection, reordered-filter idempotency/conflict, same-session FIFO and cross-session context, SSE disconnect/replay comparison, queued and active cancellation/settlement/slot release, deadlines, completed-session Pi restoration, crash/restart and orphan exclusion. Although complete failed-run SSE sequences were recorded, reconnect was not tested. These need a working real retrieval path and genuine in-flight provider work; the blocker prevents claiming those preconditions. Incremental vectors, hybrid, full 45+12 heldout, and clean-install portability are outside this assignment. Held-out data was not opened.

## Integrity and cleanup

Before and after static inventory record SHA-256: `2c7d9f70cb5f0d110ef69ffcd40c8c00f1fb40f95a272602b2fe8114d4a9324e`; final CLI SHA-256: `b6a30a3f50645151455a8a007a933e71668ef680a90f706f0478782c246f2a0d`; inventory JSON SHA-256: `5ff2344baf25c160f445742b1e5cc349b8e7daeacdaa408f7fa7b572186ddd87`. Inventory generated outside the workspace using `backend/scripts/artifact-manifest.ts`; product files were not edited. Before/after original and copy hashes matched for every source:

| Source | SHA-256 before and after, original and copy |
| --- | --- |
| short-00400.txt | `539682ea9a594c4e8860b68bf4c23e6943b332f24de4ea842ff2e8c834aadada` |
| short-00200.txt | `fd4ebda00154c9c1303081fcb7bb4380ec7661978c20812cb9f03d96c533111d` |
| short-00014.txt | `292166bf912616cea095076fe55eafeca731106afc9361a06a6ad04762d3a46e` |
| short-00558.txt | `159714610b9fce8ab6d32ebff15c56030fa10cddacc8589527d44edd8c2b702a` |
| short-00575.txt | `cb1943d6898564f84ab091485c5c1fd03160b965a21a63e12f7ac4a98f3c35c4` |

All paths are under `collection/web/clectw/transcripts/`. All owned API/QMD process groups were terminated and waited for; final recorded API and QMD exit codes were 0, and a process listing found no remaining process for this isolated run. Unrelated processes were untouched. Isolated state and evidence are intentionally retained for diagnosis.
