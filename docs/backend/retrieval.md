# Retrieval remediation handoff — 2026-11-10

This bounded implementation supersedes the retrieval/default/dependency freeze notes in handoff.md and integration.md. Product code is TypeScript. No children, tests, corpus build, application/CLI smoke invocation, QMD request/server, model download/inference or provider call was run by this worker. No held-out data was read. Actual quality remains for Terra medium real E2E. Original collection files, existing evaluation artifacts and prior generation/session state remain preserved. The old dist was copied to `/tmp/clec-qmd-upstream/frozen-dist-before-remediation` before compilation; the new dist is the coordinated replacement, not the earlier frozen executable.

## Dependency and installation

Official QMD source is pinned to **86d2365d17fc682e491c2c53d1e4a884aee8682a**, package version still **2.8.3**. Manifest and lock resolved identity are both `git+https://github.com/tobi/qmd.git#86d2365d17fc682e491c2c53d1e4a884aee8682a`. No floating branch, fork, private QMD SQL or second vector store. Public git installation and its upstream prepare/build succeeded under Node25.7.0/npm11.10.1 (changed one package, about four minutes). No upstream tests were invoked. npm initially normalized this hosted dependency to SSH; after npm11 lock regeneration the resolved transport was canonicalized to the equivalent explicit HTTPS URL. The final checked lock has no git+ssh dependency. A future lock refresh must preserve HTTPS. Fresh-install portability is still Terra's check, not a claimed clean-install runtime pass.

Context Hub `chub --help` and `chub search qmd --json` returned no QMD entry. API references were the official commit's source archive and installed public declarations/source: [SDK](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/index.ts), [HTTP](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/mcp/server.ts), [metadata](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/metadata.ts), [retrieval/reuse](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/store.ts). Official codeload archive SHA-256 observed during dependency inspection: `fb287ec3c7c38b81cfe49e8a90053fe779b0f69cce5b05908bdea93cc162659c`. No archive or node_modules needs checking into this workspace.

The upstream npm prepare builds from an archive without git history, so installed `dist/cli/build-info.json` has an empty commit and a build timestamp. Do not use that empty field or the unchanged version string as provenance. Generation settings bind explicit qmdCommit plus SHA-256 of installed index.js, store.js, metadata-filter.js and metadata.js. Build-info timestamp is deliberately outside the reusable runtime fingerprint. The release inventory records both source pin and actual built files.

Fresh install/build commands, from repository root, with Node25.7.0/npm11.10.1 on PATH:

```sh
npm ci --prefix backend --no-audit --no-fund --fetch-timeout=180000 --fetch-retries=1 --maxsockets=2
npm --prefix backend run typecheck
npm --prefix backend run build
node backend/scripts/artifact-manifest.ts docs/backend/retrieval-artifacts-20261110.json
```

The git dependency needs prepare scripts enabled. Its upstream prepare installs/builds its dependencies and compiles TypeScript; native packages may need their supported platform prebuild/toolchain. No unpublished tar artifact workaround was necessary. Do not install/build while Terra is using the released artifact. The artifact-manifest script only reads/hashes static files; it imports/executes no product or QMD modules. No downloaded GGUF assets are included.

## Natural query planning

The observed all-zero full-question failure had a concrete adapter cause: upstream lexical queries join tokens with AND and unspaced CJK terms become exact phrases. The adapter now uses Intl.Segmenter word boundaries, NFKC/OpenCC TW→CN canonicalization shared with indexed text, literal codes/numbers/Latin names and grammatical stopwords. It produces at most ten individual lexical anchors plus two adjacent meaningful CJK phrases. Alternatives are separate public pre-expanded queries, never a mandatory whole-question conjunction. One full-question canonical vector query is added in hybrid mode. The raw original question remains in the host ledger/Pi message; retrieval context stays separately labelled. No answer vocabulary, evaluation IDs or corpus fact special cases occur in the planner.

The typed SDK SearchOptions shape supplies queries, intent, filter, collections, limit40, candidateLimit40 and rerank. Official HTTP `/query` maps its searches field directly to SDK queries, bypassing automatic expansion; no expansion-model call is requested. Original question/context is also the reranking intent. QMD currently retrieves up to20 hits per individual variant, then fuses and caps40 candidates/results. CLEC deduplicates by passage, stable score/ID order, and exposes at most12 navigation candidates. Independent passages from the same source remain separate. Scores come from upstream, never fabricated and never treated as evidence. The existing host limit is unchanged: one initial search and at most one directed agent supplement.

Candidates include an optional <=420 UTF-16 navigation excerpt with exact ORIGINAL start/end/text, near a literal matched anchor when available. Fullwidth/canonicalization differences may fall back to the passage beginning. No normalized offsets are used to slice originals. Navigation excerpts/metadata remain untrusted navigation; RunEvidenceReader must issue a fresh current-run citation before support is accepted. HTTP DTOs retain the navigation extension. No all-source original text scan or eager corpus read was added.

## Typed metadata and scope

Every generated passage starts with `qmd.metadata` typed frontmatter: sourceId, sourceType, sourceVersion, and optional date/dateBasis. JSON scalar quoting keeps identifiers/calendar dates strings. Unknown date is omitted; dateBasis is retained independently. Invalid calendar dates, missing date basis for a known date, or values outside upstream string limits fail admission/generation. Source metadata is stable across generations: generation is routed by the single `clec_<generation-id>` collection and strict evidence binding, **not embedded into Markdown**. This preserves unchanged content hashes/vector reuse.

Public QMD listMetadata validates complete current typed metadata coverage before publication. All source/date/type predicates are validated public AST nodes sent to QMD before ranked limits. Returned hits must already satisfy the requested scope; CLEC checks this as a protocol invariant and fails on violations instead of silently postfiltering the top40. Every hit must map to the pinned collection, a strict hash.md locator, exact sourceId/sourceVersion/sourceType/date/dateBasis, and original evidence in that generation. Missing/unknown/malformed data is failure, not no evidence. Metadata-only eligibility is checked without reading all originals; an empty eligible set is a valid no-hit result, although the existing service still checks actual QMD generation readiness before searching.

One shared external validator/type lives in domain/search-filter.ts. Optional filter fields:

- sourceIds: set of source SHA IDs, at most64 external entries; an empty list selects nothing.
- types: set of document/qa/transcript/curated/metadata, at most64 external entries; empty selects nothing.
- dateFrom/dateTo: inclusive real YYYY-MM-DD bounds; unknown dates do not satisfy a bound. Reversed ranges and unknown keys/types are rejected.

Arrays are deduplicated/sorted and object key order canonicalized. Missing scope and `{}` have identical semantics/identity. HTTP validates through the store's admission parser before insertion. Canonical filter persists in schema2 `runs.filter_json`, HostRun/RunContext, queued events and public DTOs; restart retains it. Exact retries with reordered equivalent sets reuse the existing run; different scope with the same requestId is REQUEST_CONFLICT/HTTP409. Invalid filters return HTTP400 INVALID_FILTER. The schema bump intentionally rejects old session DBs before migration: preserve old databases and use fresh state. Crash reconciliation, Pi branching, scheduling/settlement and no automatic replay remain unchanged.

Natural source resolution runs once per QA run, using actual EvidenceStore metadata. Explicit current-question episode syntax takes priority. If the current turn is genuinely anaphoric according to the existing conversation policy and has no recognized source selection, only its latest prior user question is considered for scope; the other older retrieval-context questions never union into scope. An unrecognized multi-turn implicit chain may need explicit restatement. Ranked query context still uses the existing bounded three-question policy independently.

Episode numbers/codes resolve only from recognized CLECTW `short-<number>[suffix]`, `ep-<number>[suffix]` or `chat-<number>[suffix]` canonical HTTPS origins under clectw.com/ep/, or the actual collection/web/clectw/transcripts family path grammar. Arbitrary filename digit groups/dates/archive numbers are never episode identities. Explicit full filename or quoted exact existing title can select its actual source. Bare years/fund codes do not implicitly scope. Ambiguous numerical episode references may admit several known families/representations; this is not equivalence deduplication. Unresolved explicit episode selection yields empty scope. Caller filters intersect discovered IDs and supplements retain the resolved scope. Discovered internal representations can exceed64; they are split into public AST membership groups, subject to upstream AST depth/node budgets, without reapplying the external-list cap.

## Public commands/contracts

From backend/ with the same local configuration:

```sh
node dist/cli.js ask --scope '{"types":["transcript"],"dateFrom":"2024-01-01"}' '<original question>'
node dist/cli.js session ask <session-id> --scope '{"sourceIds":["<actual source SHA ID>"]}' '<original question>'
```

The API accepts optional `filter` on `POST /v1/sessions/<id>/runs`, alongside question/requestId/timeoutMs:

```json
{"question":"<original question>","requestId":"<unique request id>","filter":{"types":["transcript"],"dateFrom":"2024-01-01","dateTo":"2025-12-31"}}
```

No filter leaves the default scope unchanged. Caller IDs must be actual source IDs returned by source/catalogue/status workflows; do not substitute episode numbers into sourceIds. CLI original question content remains separate from the scope JSON.

## Hybrid, reuse and bounds

`build <intake.json>` now defaults to hybrid; --hybrid remains an accepted explicit spelling. --lexical is explicitly diagnostic degraded retrieval, with no semantic recall promise. Chosen Chinese default remains official Qwen3-Embedding-0.6B Q8_0. Local QMD_EMBED_MODEL/QMD_RERANK_MODEL overrides become absolute paths, are streamed/hashed, and are persisted in generation settings/config. qmd-serve verifies installed runtime fingerprints and local model bytes before opening the published QMD database. It rejects older/runtime-incompatible generations rather than migrating them in place. QMD generation config is authoritative over later shell model overrides. Remote HF identifiers do not attest immutable remote bytes; Terra's verified local files avoid that ambiguity. No downloader framework was added; parent/Terra own provisioning in ~/.cache/clec/models and its separate report.

The changed Markdown/runtime revisions intentionally force a fresh QMD index and derived text on first upgrade. Subsequent matching settings retain the previous worker's original bundle/Markdown reuse, coherent Node SQLite backup including committed WAL, independent destination database, destination-first registration, old-collection retirement and bounded embed batches. Upstream's current public update explicitly copies existing content vectors into new collection partitions BEFORE orphan-vector cleanup; public UpdateResult now records vectorsCopied/staleVectorsRemoved. No private-schema assumption is used by CLEC. Real vector reuse must be measured through actual update/embed metrics; a copied DB alone is not proof. No original offset, evidence reader budget or incremental metric was discarded.

This pinned upstream differs from the old release's small-scope/global-window vector code. Its filtered vector path applies eligible row IDs inside sqlite-vec MATCH and collection partition constraints for every scoped KNN scan; there is no old large-scope global ANN/postfilter fallback or small-scope threshold in this inspected commit. Structured search requests20 documents per variant, starts at60 vector chunks, doubles while underfilled, and stops at sqlite-vec's4096-row k cap. Chunk concentration can still underfill distinct documents at that cap; semantic recall is not exhaustive. BM25 materializes the complete lexical match set before metadata/collection filtering and the final limit, fixing the former scoped crowd-out window. Broad generic terms can therefore incur corpus-sized lexical materialization. No latency/quality improvement is claimed without Terra measurements.

Response handling buffers at most2,000,000 received bytes plus one transport chunk, cancels the response reader on overflow, rejects malformed UTF-8/JSON and limits hits to40. Local endpoint/redirect, strict locator/version/generation checks and meaningful protocol/unavailable errors remain. Cancelling client HTTP does not prove upstream GPU work stops. Read/answer budgets and actual-read citation validation remain in the shared integrated service. The prompt now explicitly requires source/metadata support for provenance/completeness/absence caveats too; narrative form alone does not establish recording provenance. Prompt correction is not an entailment guarantee.

## Fresh Terra regression — commands not run here

Use the parent-approved artifact and privately provisioned DeepSeek environment. Do not reuse schema1 sessions or the frozen generation. From repository root, set CLI to the absolute backend/dist/cli.js and RUN_DIR to a NEW isolated directory under the system temp root. Parent supplies verified QMD_EMBED_MODEL and QMD_RERANK_MODEL local paths; do not launch parallel downloads. The prior macOS /var alias failure is fixed by canonicalizing the nearest existing output parent before containment/creation and rechecking the actual created parent. Outside-state/symlink parents and roots overlapping originals remain refused; the final target symlink itself is replaced by rename, never followed.

```sh
# Small operational copy/catalogue with the same real five-source selection:
node evaluation/backend-e2e/runtime/prepare.ts "$RUN_DIR"
export CLEC_WORKSPACE="$RUN_DIR/workspace"
export CLEC_STATE_DIR="$RUN_DIR/state-hybrid-v2"
export CLEC_QMD_URL=http://localhost:18181
export CLEC_PORT=18080
node "$CLI" build "$RUN_DIR/intake.json" --hybrid
node "$CLI" status
node "$CLI" qmd-serve 18181
# Separate terminal, same environment and privately supplied key:
node "$CLI" serve
```

Terra must rerun the four originally failed FULL natural questions (CLEC-002/011/031/038) unchanged, not replace them with short keywords or append gold evidence. The exact question strings live in development.jsonl; implementation has no per-case behavior. For complete conversation-correct regression use the full development recorder below, which includes all four and preserves ordered predecessors. For a five-source operational rerun Terra can submit those four original question fields directly through stateless CLI/API, keeping this distinct from conversation/full-corpus acceptance. Record candidate counts, actual original reads/citations, conditions/attribution/unsupported claims, cold/warm latency and model usage, including no-hit/failure distinctions.

For full corpus: use an isolated workspace copy with the collected families, NEW state, catalogue full supported intake, review omissions, then build hybrid and start matching actual QMD/API. Existing recorder commands (Terra owns/extends it; no held-out invocation is included):

```sh
node evaluation/backend-e2e/runtime/acceptance.ts prepare --cli "$CLI" --workspace "$WORKSPACE" --state "$STATE" --api "$API" --qmd "$QMD" --out "$EVIDENCE/preparation.jsonl" --max-ms 3600000
CLEC_WORKSPACE="$WORKSPACE" CLEC_STATE_DIR="$STATE" CLEC_QMD_URL="$QMD" node "$CLI" build "$STATE/full-intake.json" --hybrid
# Operator starts real qmd-serve and serve in the same pinned environment.
node evaluation/backend-e2e/runtime/acceptance.ts dataset --split development --cases evaluation/backend-e2e/development.jsonl --cli "$CLI" --workspace "$WORKSPACE" --state "$STATE" --api "$API" --qmd "$QMD" --out "$EVIDENCE/development.jsonl" --max-questions 45 --max-calls 180 --max-ms 28800000 --run-timeout-ms 600000
node evaluation/backend-e2e/runtime/report.ts "$EVIDENCE/development.jsonl" "$EVIDENCE/development-report.json"
```

Additional required REAL scenarios: lexical diagnostic comparison in a different state using --lexical; Simplified/Traditional/full-question/code/name queries; narrow IDs/types/date filters with stronger out-of-scope distractors; unknown dates/dateBasis; explicit empty/unresolved source scope; invalid scope/date and request-id scope conflict/equivalent reordered-set retries; persisted/restarted scope; numerical 第1集 versus unrelated dated filenames; >64 naturally discovered representations; prior 第400集 followed by current 那第401集怎么说？ must admit only401 (intersect caller scope), while unresolved anaphoric follow-ups may inherit the latest relevant question. Verify no supplement widens scope, no unwanted expansion model loads/calls, actual hybrid embedding/reranking and local file fingerprints.

Also retain integration/incremental E2E gates: source updates/add/delete, unchanged content/vector reuse with real metrics, old/new generation isolation and stale server errors, exact original UTF-16 citation ranges, long-QA read narrowing/budgets, HTTP/session SSE/cancellation/restart/settlement, provenance caveats and semantic entailment. All remain unverified here. A bounded successful sample will not constitute full acceptance.

## Executed static evidence

Public pinned dependency installation/prepare succeeded. Final typecheck and build exited0 under Node25.7.0/npm11.10.1. The adjacent `retrieval-artifacts-20261110.json` records SHA-256 for package/lock, every source/dist/script file and installed QMD dist/package; its inventory hash is a static release identity only. No runtime pass is claimed. Parent may freeze this complete artifact and schedule fresh Terra E2E; no test process was started by this worker.

Frozen replacement artifact hashes (SHA-256):

| Artifact | Hash |
| --- | --- |
| Static inventory record set | `2c7d9f70cb5f0d110ef69ffcd40c8c00f1fb40f95a272602b2fe8114d4a9324e` |
| retrieval-artifacts-20261110.json | `5ff2344baf25c160f445742b1e5cc349b8e7daeacdaa408f7fa7b572186ddd87` |
| backend/dist/cli.js | `b6a30a3f50645151455a8a007a933e71668ef680a90f706f0478782c246f2a0d` |
| backend/dist/search/qmd-http.js | `9ac0a7fb29ca59dc02967194f3dfb21e3bcfe77d9d37be33a2d43a533eaba77b` |
| backend/dist/ingestion/generation.js | `ca7a60a5514d6b4060638a0d114b18a81c818d8e7aba97649474bafd5b493df7` |
| backend/package-lock.json | `6527d08af337325369773fe992c28d1cacd5d845fd01d1bea390560c031ce318` |

Source/dependency/build mutations by this worker ended after this inventory. Parent may now start the new real-runtime task. Runtime success, hybrid quality, model provisioning, clean-install portability and full acceptance remain pending Terra evidence.
