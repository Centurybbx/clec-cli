# Hybrid execution evidence for the next Terra acceptance

Static review, 2026-11-11. This is an acceptance evidence decision, not a runtime result or executable test. No product or test code changed.

## What the current interface can prove

`backend/src/search/qmd-http.ts` sends typed lexical and vector searches to QMD's public HTTP `/query`, with reranking enabled for a hybrid generation. It does not request automatic query expansion. These request fields establish intent, not successful vector retrieval or native reranker inference.

At the pinned QMD commit `86d2365d17fc682e491c2c53d1e4a884aee8682a`, the installed `dist/mcp/server.js` REST handler (around lines 945–1023) forwards queries, scope, limits, intent and rerank to `store.search`. It neither forwards `explain` nor returns explanation fields. Adding `explain: true` to a REST request therefore cannot establish the missing evidence.

The public root SDK `SearchOptions` does expose `explain`. The installed `dist/store.js` typed-query path constructs vector contribution traces and rerank scores (around lines 5408–5553). A real public SDK search with equivalent production options can provide useful supplementary evidence of retrieval contributions. It is not by itself proof that the separate CLEC HTTP request executed the same operations.

The rerank implementation (around lines 4223–4274) can return cached scores without calling native inference. A nonzero rerank score, an on-rerank callback, an elapsed duration, or a loaded GGUF file is not sufficient evidence of fresh inference. Cache reuse is valid product behavior and should be reported separately.

## Acceptance disposition

Terra should retain a real CLEC API request and its terminal answer/citations, together with the owned QMD process identity and observations during that request. Resolve the actual serving process rather than sampling the npm/shell wrapper; the previous hybrid report explicitly found this observation gap. Do not run background indexing during latency measurements or attribute its inference to search.

Use an isolated index/state without prior search-result cache for the initial search measurement where feasible. Retain how that state was created; an existing index plus a restarted server is not an entirely cold cache. Observe actual native work in the serving process and distinguish query embedding from reranking if the observation supports that distinction. Model mapping alone remains insufficient. Do not patch inference, mock responses, insert artificial delays, alter SDK internals, or bypass production validation to produce evidence.

A separate public root SDK search with `explain: true`, on the same completed generation and equivalent typed queries, scope, intent and limits, may demonstrate vector contributions and score blending. Label it as a separate real retrieval diagnostic, not as the CLEC API run. Avoid running it before the cold API measurement because it may warm caches. If process observations or SDK traces remain ambiguous, report the corresponding execution claim as unproven rather than extending the dependency patch merely for instrumentation.

Final acceptance still requires all 45 development questions on the complete hybrid corpus, semantic review of conditions and attribution, exact source-version and citation reconciliation, and the independent held-out run after freezing. Retrieval diagnostics do not replace answer-quality acceptance. The forthcoming embedding lifetime patch must not be taken as evidence that search-time vector or reranker work succeeded.
