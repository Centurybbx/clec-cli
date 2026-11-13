# Incremental ingestion and original-evidence integration

Implementation milestone: source changes only. No tests, mocks, smoke runs, corpus builds, QMD requests, embedding runs, model calls, evaluation data or held-out material were executed/read by this worker. `backend/dist` and `backend/node_modules` were not modified. Terra must validate runtime behavior with real source data after the parent coordinates a new artifact. Existing handoff/architecture descriptions of full rebuilds and unbounded QA describe the older artifact; this document describes the new source implementation.

## Entry points and ownership

`buildGeneration({ workspace, stateRoot, manifestPath, hybrid, signal })` and `currentGeneration(stateRoot)` keep their existing signatures. CLI build syntax is unchanged. Their metadata now has the locally exported `IngestionGeneration extends Generation` type, with optional `buildSettings` and `incremental` fields for reading older generations. Newly completed generations require both fields. No domain/contracts changes were made; parent may promote these additive types later.

Owned implementation modules are ingestion/generation.ts (publication/orchestration), ingestion/settings.ts (cache/model identity), ingestion/qmd-build.ts (public QMD lifecycle), ingestion/sections.ts, evidence/store.ts and evidence/reader.ts. No retrieval ranking/filter or HTTP/session composition changes are included.

## Reuse and version identity

Build still reads, UTF-8-validates, hashes and inventories every admitted original. Source IDs bind the original workspace-relative path. Content hashes continue to bind original bytes; version hashes bind content plus intake provenance (including title, type, quality, status, date, date basis and origin). No original content or UTF-16 span is normalized.

The previous **validated CURRENT completed generation** is the reuse baseline. Its evidence DB is opened read-only. If source version and text derivation settings match, the builder exports/imports its exact original, ordered sections and passage records, and copies its generated passage Markdown. It does not segment or normalize those sources. Copying creates independent files, never hardlinks. Imported originals are checked against the freshly admitted exact text and byte hash. Added/changed sources are segmented and their passage text normalized. Removed, unavailable, quarantined and newly excluded sources are absent from the next evidence store and active search collection. Removing every usable source still fails EMPTY_CORPUS and retains CURRENT.

Text reuse binds segmentation revision, normalization revision and Markdown format revision. Vector seeding additionally binds all build settings: QMD installed package version, Node version/platform/architecture, node-llama-cpp version, search mode, explicit embedding/rerank/query-expansion model URIs, and local model byte hashes. Change these and the next QMD database is fresh. Text can still be reused when only model/runtime settings change. Legacy generations lacking settings remain readable but are conservatively reprocessed once.

`NORMALIZATION_REVISION = nfkc-opencc-js-1.0.5-tw-cn-v1` explicitly binds NFKC plus pinned OpenCC TW→CN. Changes to normalization implementation/dependency require updating it. Segmentation revision is `original-utf16-v2-bounded-qa`. Embedding/chunking policy is bound by `embeddingRevision = qmd-regex-batched-v1`; changes must bump it. This milestone explicitly uses QMD regex chunking and bounded embedding batches (32 documents / 1,000,000 bytes).

This is incremental expensive derivation/inference, not a sublinear build. Scanning/hashing originals, reading/copying reusable originals and Markdown, SQLite insertion into a new evidence DB, coherent QMD backup, and QMD filesystem/content hashing remain O(corpus bytes/documents). All admitted decoded originals are currently buffered in memory. A source transaction is bounded by the existing 100,000,000-byte intake limit, not by a smaller streaming batch. There is no generation garbage collector.

## QMD public API and collection relocation

Context Hub was consulted (`chub --help`, `chub search qmd --json`); no QMD entry exists. The API source of truth was the installed **@tobilu/qmd 2.8.3** README, public index.d.ts and implementation behavior of its exported methods. No application code queries or writes QMD tables, uses `internal`, or maintains another vector index.

When all settings match:

1. Open the published QMD database read-only and use Node's public SQLite `backup()` API to create a coherent, independent destination database. The backup includes committed WAL state and closes its source connection before opening destination QMD. A published QMD writer is never opened by ingestion. No plain main-file copy or writable SQLite hardlink is used.
2. Write destination index.yml with pinned models and two explicit registrations: new `clec_<new-id>` → final new-generation `markdown/`, old `clec_<old-id>` → an existing **empty destination-local** `retired-collection/` directory. No destination collection references the old generation directory.
3. Public `createStore({dbPath, configPath})` synchronizes registrations. Public `update({collections:[newCollection]})` indexes all destination Markdown first. Content-addressed unchanged Markdown can use the backed-up content embeddings. Collection document registrations are new, so QMD `update.indexed` can equal all passages even when no embeddings are recomputed.
4. Public `update({collections:[oldCollection]})` scans its empty directory and deactivates its former documents. Only then does public `removeCollection(oldCollection)` remove its registration. This ordering keeps retained content referenced while QMD performs automatic orphan-content cleanup. `removeCollection` alone does not retire active documents; `renameCollection` only changes registration in this pinned SDK and is deliberately unused.
5. Hybrid mode calls public `embed({collection:newCollection, force:false, chunkStrategy:'regex', maxDocsPerBatch:32, maxBatchBytes:1000000})`. Unchanged content embeddings remain available; only missing embeddings are requested. Public skipped-file counts or embedding errors fail the build. Public `listCollections()` must show exactly the destination collection, correct final Markdown path and expected active passage count.

These assumptions deliberately cover exactly one generation-specific collection. Source/date/type scoped search needs a separately designed public collection partition or other supported approach. Top-N metadata postfiltering is not made complete by this work. Future multi-collection layouts must replace this relocation policy, not append extra collections unnoticed.

The cloned QMD DB can retain inactive old document rows and obsolete vectors/cache entries; no private cleanup SQL is introduced. Removed originals are absent from authoritative evidence and active destination retrieval. Disk size is not guaranteed to shrink. Public collection-scoped queries and evidence locator validation remain mandatory. Full QMD index scan/copy cost remains; real inference reuse must be demonstrated by Terra's public embed metrics. SDK upgrade behavior must be revalidated rather than inferred from this implementation.

## Pinned models

Default embedding URI is explicitly `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`, the installed README's multilingual recommendation for CLEC's Chinese corpus. It replaces upstream embeddinggemma's English-oriented default. `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL` and `QMD_GENERATE_MODEL` override build choices. Rerank and expansion defaults explicitly retain the pinned SDK defaults.

All three resolved choices are written to generation `buildSettings.models` and index.yml `models`. QMD serving reads config models ahead of the shell environment, so restarting from that config stays pinned even with different environment overrides. Local model paths become absolute and their bytes are hashed with AbortSignal-aware streaming. HF URIs are pinned identifiers, not immutable remote-byte attestations: changing bytes behind the same URI/cache is outside this cache contract. Likewise, local model files must not be replaced underneath a running published generation; parent serving integration should verify stored local hashes if it supports such replacement. There is no model download, model inference or default-quality claim from this worker.

## Metrics

New generation metadata persists `incremental`:

| Field | Meaning |
| --- | --- |
| previousGeneration | Validated baseline ID or null |
| reused | Exact original/sections/passages/Markdown imported with matching version and text settings |
| changed | Existing source ID with a different source version, including provenance-only changes |
| added | Source ID absent from baseline |
| removed | Baseline source ID absent from admitted next corpus |
| reprocessed | Same source version processed because baseline text settings are missing/different |
| copiedMarkdown / generatedMarkdown | Actual completed per-passage copy/write counts |
| qmd.seededFromGeneration | Backed-up generation ID, or null for fresh QMD build |
| qmd.update | Public destination UpdateResult: collections, indexed, updated, unchanged, removed, skipped, needsEmbedding |
| qmd.retired | Public old-empty-collection UpdateResult, or null |
| qmd.embed | Public EmbedResult (docsProcessed, chunksEmbedded, errors, durationMs; upstream optional failures), or null for lexical mode |

`reused + changed + added + reprocessed = sourceCount`. Removed is measured independently. These are measured execution counters, not estimated speedups. Counts belong to the generation's first successful build; selecting an already completed identical generation returns its persisted metadata and does not rewrite counters. Upstream needsEmbedding can describe the whole copied store at that update stage, before old-collection retirement; it is not a count of destination-only new work. There is no fabricated reused-vector count; compare public chunksEmbedded/docsProcessed across actual controlled real-source updates.

## EvidenceStore

New stores have no unused normalized column. Inspection found no consumer; normalized search text remains only in Markdown. Existing databases with the legacy column remain readable through the same SELECT projections. Read-only `source`, `original`, `section`, `sections`, `passage`, `counts`, `close` behavior is retained.

All statements are cached by SQL for the lifetime of one store. `PRAGMA foreign_keys=ON` applies on each connection. New public APIs:

```ts
interface SourceBundle { source: Source; original: string; sections: Section[]; passages: Passage[] }
store.sources(): Source[]
store.exportSourceBundle(sourceId: string): SourceBundle
store.importSourceBundle(bundle: SourceBundle): void
store.add(source: Source, original: string, sections: Section[]): Passage[]
```

`add` drops the obsolete normalized argument; generation was its only consumer in inspected source. Import validates source/path/content hashes, version shape, section ownership/version/order/boundary/unique IDs, exact contiguous full original coverage and one-to-one passage mappings before beginning one `BEGIN IMMEDIATE` source transaction. INSERT failure rolls back every row for that source; no per-row autocommit/fsync. Read-only stores reject imports. Cancellation is checked between sources and copied/written passages, not within a synchronous source transaction. A failed/cancelled build never publishes its partial store.

`generationId` is a read-only binding to the enclosing hashed generation directory (undefined in staging/non-generation paths). Reader construction requires this to equal its pinned generation; use a location returned by the validated completed-generation loader.

## QA segmentation and reader integration

Short sources (≤5,000 UTF-16 units), including short QA, remain whole. Long QA no longer bypasses segmentation. For QA only, unambiguous line-start `Q:`/`A:`, `問：`/`答：`, `问题：`/`回答：`, or `問題：`/`答案：` labels, optionally preceded by a Markdown heading marker, identify question starts followed by an answer label. Explicit Q/A cuts take priority over headings so heading-like answer labels do not cut an exchange. Other syntax is not guessed. Original labels, prefixes and preambles remain intact.

Every long resulting span uses contiguous ≤5,000-unit windows. Cuts prefer the last available newline within the window; overlong individual lines require a bounded UTF-16 cut that preserves surrogate pairs and CRLF. Transcript headings do not invent structure/speakers/timing. Plain transcript spans use contiguous fallback. Concatenating ordered original slices reproduces the complete original exactly. A long question or answer can span multiple contiguous sections: continuation is represented by ordered neighbours, not by invented speaker labels, timestamps or a claim of a semantically complete exchange. No additive boundary enum was needed.

`RunEvidenceReader.read(passageId, expansion)` keeps its EvidenceRead[] return and section/neighbours/source scopes. Defaults and hard ceilings remain **8 attempted reads and 40,000 unique original UTF-16 units**. Successful and refused attempts count; custom budgets can only lower the ceilings. Duplicate section reads reuse the same frozen citation and consume no additional character budget. Returned section/citation/read records are frozen to prevent caller mutation of the citation ledger. Scope checks still require a locator explicitly allowed from current-run search; generation-path binding and original version/span checks remain enforced. Invalid markers or unread IDs fail citation validation. Structural validation proves neither semantic support nor entailment.

Read-only getters: `readCalls` (attempts), `readCharacters` and `uniqueOriginalCharacters` (same deduplicated count), `remainingReadCalls`, `remainingCharacters`. Use these counts for unique-original estimates; do not sum repeated quote strings. Model serialized-context accounting must still charge actual repeated text if the QA layer sends it again; parent can deduplicate outbound context by citation ID.

Exact recoverable public refusal:

- Code `READ_TOO_LARGE`: `Requested evidence exceeds the remaining character budget. Retry with section scope on a search locator; no evidence was read.` Returned only when a requested unread complete section can still fit and another attempt remains.
- Code `READ_BUDGET`: exhausted attempt budget or no requested unread complete section fits. No evidence is silently trimmed. Previously read citations remain valid.

Parent QA must catch READ_TOO_LARGE and return bounded tool-error data (including the remaining getters) so the model/host can narrow. Other errors retain existing failure semantics; never turn INDEX_MISMATCH, READ_SCOPE, cancellation or a corrupt generation into no evidence. Host prefetch can also narrow after READ_TOO_LARGE. Existing service/transport owners must wire this; this worker did not edit QA.

## Publication and cancellation

Deterministic generation identity includes manifest/inventory/source versions and full build settings. Build lock, explicit BUILDING marker, matching failed-directory quarantine, validated ID/READY/collection/artifact checks and atomic CURRENT rename remain. Config paths name the final directory before QMD runs; every build step, public QMD close and completion validation precede pointer publication. Cancellation is checked immediately before pointer rename. Published generations, originals, SQLite DBs and Markdown are never edited by this builder, and old references remain readable. Legacy original-utf16-v1 completed generations remain accepted for reads.

A failure before staging rename can leave an unreferenced `.building-*` directory. A failure after rename but before metadata/READY can be quarantined and retried under the existing build rules. Metadata written without READY still fails closed for manual recovery. No new power-loss/fsync durability promise is made. SDK operations expose no AbortSignal; progress callbacks/checks provide best-effort cancellation, and an in-flight upstream operation or SQLite backup can finish before cancellation is observed. CURRENT remains unchanged if cancellation is observed before atomic publication. Signals arriving after that commit point cannot undo publication.

## Required Terra real-source validation (not run here)

1. Build a real multi-source intake in isolated state; then genuinely edit one copied real original, add another real source and remove/exclude one. Verify source/version/inventory counts, exact source-bundle and Markdown reuse, active retrieval, and old generation byte immutability. Do not mutate collected originals.
2. Change provenance only (title, quality, origin/date basis). Verify changed/version/section IDs and rendered provenance update; source content byte hash stays unchanged. Change normalization/segmentation settings separately and verify reprocessed rather than reused.
3. Change only a nonindexed intake entry so admitted sources remain identical. Verify all admitted sources reused and an actual seeded hybrid build reports zero new embedding work where QMD fingerprints agree. For a genuine source content update, compare real public embed docsProcessed/chunksEmbedded with baseline/full build; do not substitute QMD document registration indexed counts as vector-reuse proof.
4. Change embedding model/runtime or search mode. Verify seeding is disabled, models/config/cache identity agree, and new hybrid embedding work occurs. Restart serving with a different shell embedding override; verify generated config remains authoritative. Verify destination config and public listCollections contain only the new final path/collection after relocation, and old retired documents do not retrieve.
5. Cancel during source hashing/copy, SQLite/QMD backup, QMD update and real embedding. Verify no CURRENT move, no partial citation exposure, and old generation remains usable. Retry an actual failed unfinished build and verify quarantine plus successful fresh completion. Check malformed READY/metadata/artifacts and metadata-without-READY remain rejected.
6. Keep an old reader/reference alive across publication. Verify old/new generation scope, removed/new locators, unknown IDs and forged citation markers; old refs still read the old immutable original. Current-run search is mandatory for every read.
7. Use actual long QA with visible Q/A labels, long answers/questions, unlabelled QA, CRLF and a real long single line. Verify all slices concatenate exactly, max span ≤5,000, correct original UTF-16 offsets, truthful contiguous continuation and neighbour reads. Include a >40,000-unit real source; oversized source expansion must refuse without spending characters, then a narrower section must succeed while attempts remain.
8. Verify repeated original reads retain citations/unique counts; eight total attempts including refusals terminate; low remaining characters distinguish recoverable expansion from exhaustion. Verify source transaction rollback and FK consistency under an actual insertion/build failure. No synthetic fixtures/mocks are authorized for this worker.

Compilation evidence: `backend/node_modules/.bin/tsc -p backend/tsconfig.json --noEmit` exited 0 after implementation. This is static compilation only; no runtime success, model quality, retrieval recall or semantic citation accuracy is asserted.
