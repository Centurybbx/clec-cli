# CLEC backend architecture — first milestone

This is a replacement in `backend/`; existing implementation and every collection asset remain intact. No Web UI. This milestone supplies a CLI vertical slice, not the final HTTP product. Runtime correctness awaits independent Terra E2E validation.

The current QA/session contract supersedes the first milestone's transport/status details below: one shared result-returning QA service, pure domain block parser/renderer, run-scoped evidence projection registry, injected bounded diagnostics, and schema-3 session final-output transaction. See [QA handoff](qa-contract-handoff.md). Runtime acceptance remains pending; no second agent or semantic verifier is introduced.

## Boundaries

- `domain`: source/version, section/span, passage, citation and event contracts; typed public failures.
- `ingestion`: explicit JSON intake manifest validation, UTF-8 text preservation, conservative segmentation and immutable generation builder.
- `evidence`: SQLite is authoritative for exact original text, provenance, sections and passage mappings. Search-normalized content is separate.
- `search`: exports stable passage-ID Markdown and uses public QMD SDK to build; long-lived QMD HTTP `/query` serves retrieval. No QMD private SQL. Every query scopes a generation-specific collection and validates returned locators against the pinned evidence generation.
- `qa`: host forces initial retrieval and original reads before Pi; optional model-directed search is limited to one. Only `search_evidence` and `read_evidence` tools. Explicit empty resource loader, no filesystem/coding tools, API-key-only model access. Citation validation checks version and actual read ranges, not entailment.
- `cli`: composes the same services intended for the future HTTP transport. NDJSON events; SIGINT propagates cancellation.

## Publication and recovery

A generation directory contains evidence.sqlite, search Markdown, QMD index, configuration and generation metadata. Content/provenance/segmentation settings determine its hash. Existing matching generation is reused. Build in a new directory; publish CURRENT by atomic rename only after complete QMD update (and embedding when requested). Failure leaves CURRENT intact; abandoned build directories may be removed after readers exit. Readers pin CURRENT once. Published directories are immutable. Old generations remain available for citations and rollback. No incremental mutation of a live QMD database. Initial implementation rebuilds derived search on changed input; unchanged entire builds are reused. Per-source content reuse and garbage collection are later work.

QMD HTTP must serve the selected generation database/config. Generation-specific collection scoping prevents an old server from returning citations from a different version; fail closed on unmapped hits. Deployment swaps the QMD process/port before swapping a future service's active generation. CLI operator explicitly starts the generation server. Cancellation aborts client HTTP; whether QMD stops already running GPU work is an upstream limitation.

## Corpus fidelity

Intake is explicit, never recursive blind ingestion. Required provenance distinguishes original extracted text, automatic transcript, curated article, metadata-only and quarantine. Dates and speakers remain unknown unless supplied with a basis. Preserve UTF-8 decoded text exactly, including page breaks/cell locators. SQLite offsets are half-open JavaScript UTF-16 code units into that exact text (not byte or normalized offsets). Short sources remain whole; headings begin sections for structured documents; long text uses contiguous line-aware windows with adjacent expansion at read time. These are conservative search boundaries, not assertions of complete semantic QA exchanges. Whole-source fallback is bounded by the read budget and reports failure rather than silently truncating.

Podcast RSS is metadata; clec168 introductions/comments are not transcripts; clectw automatic transcripts are unverified; clec-md knowledge is curated third-party interpretation with absent raw transcripts. Archive TXT/SRT/MD/.str representations may only collapse after verified equivalence, never just matching episode IDs. First milestone does no deduplication. Empty, missing, unsupported, metadata-only and quarantined entries are counted and excluded from search. Binary document extraction, subtitles/timestamps and full manifest-family importers follow independent slice validation.

## Final transport target (not implemented here)

Local-only HTTP sessions create/restore/delete; serialized runs per session, independent sessions concurrently; ask event stream/cancel; message/citation/source views; health/corpus/index status. Pi SessionManager is authoritative for restored model context. Never assign agent.state.messages to restore history. Completion occurs only after prompt resolves to settled lifecycle, after validation; aborted/error runs never emit complete. Original reads must be refreshed per run; earlier assistant statements never become evidence. Persistent host run/citation/session storage is a separate next milestone.
