# Full collected-corpus catalogue

`backend/src/catalog/index.ts` exports the production TypeScript adapter entry point:

```ts
import { catalogueCorpus, type CorpusCatalogue } from './catalog/index.js';
const catalogue: CorpusCatalogue = await catalogueCorpus(workspaceRoot);
// catalogue.manifest satisfies the existing domain IntakeManifest interface.
```

Signature: `catalogueCorpus(workspaceRoot: string): Promise<CorpusCatalogue>`. The workspace root is mandatory and resolves to its real path. All intake and provenance source paths are workspace-relative. Unsafe absolute/traversing/outside-symlink paths produce issues and never enter intake. The function reads files only: no extraction, downloads, model calls, index construction, asset rewriting, package changes or derived content files. It imports existing domain contracts and does not extend or replace them.

## Adapter map

| Family | Authoritative input | Search treatment |
| --- | --- | --- |
| Local documents | `collection/text/local/manifest.json` | Existing TXT extraction, labelled unverified; original source path retained and separately inventoried. |
| Local spreadsheets | `collection/text/local/spreadsheets-manifest.json` | Existing cell-address-preserving TXT; unverified spreadsheet extraction. |
| Drive documents | `collection/sources/drive/{text,nested-text,deep-text}-manifest.json` | Existing extracted paths, Drive URLs, IDs and groups preserved; original document versus uncertain text origin labelled. |
| Drive archive transcripts | `collection/sources/drive/archive-transcripts-manifest.jsonl` | **Explicitly invoked inside `driveDocuments()`.** Every nested member retained, declared member SHA-256 checked against available bytes. TXT and substantive MD admitted independently as probable unverified ASR. SRT, STR and VTT unsupported. Original nested member, filename and hash remain in provenance. |
| CLECTW transcripts | `collection/web/clectw/episode-inventory.jsonl` | Only explicit transcript paths; automatic, unverified, unknown speakers/timing. Missing transcript statuses remain inventory gaps. `mentions_transcript` is never used. |
| CLECTW pages | `collection/web/clectw/manifest.jsonl` | Page extracts and HTML are metadata; mixed page summaries/navigation never substitute for transcript text. |
| CLECTW quality audit | `collection/web/clectw/transcript-quality-audit.jsonl` | Automatic flags requiring review quarantine the exact path. A clean heuristic result does not certify a transcript. |
| CLEC168 body extracts | `collection/web/clec168/manifest.jsonl` | Explicit blog/docs/database content pages admitted as unverified website body text, potentially including comments. |
| CLEC168 video introductions/comments | Same manifest, `/video/` URLs | Metadata only, explicitly not transcripts. Listings, categories and pagination are metadata too. |
| CFNAVI | `collection/web/cfnavi/manifest.jsonl` | Explicit saved body text labelled third-party course summaries, never speaker transcripts. |
| clec-md knowledge | Only `collection/sources/clec-md/knowledge/**/*.md` | Third-party AI-curated interpretations, raw transcripts absent. Original frontmatter preserved verbatim; collected repository commit and URL retained. Repository code, rendered copies, posts and raw scaffolding are not crawled. |
| Local ASR / podcast ASR | `collection/transcripts/{local-asr,podcast-asr}/*/metadata.json` | Metadata-defined `<id>.txt`, labelled unverified machine ASR. Media URL/checksum and model remain in sidecar. Other matching output formats inventoried as subtitle/metadata sidecars. |
| Quarantine | `collection/transcripts/quarantine/*/metadata.json` | Outputs always quarantined. Any quarantine status on an otherwise active manifest record is sticky for that path. |
| Partial OCR | `collection/transcripts/ocr/*/metadata.json` | Existing `frames-raw.txt`, labelled incomplete sampled-frame OCR, not transcript. Original method and limitations retained. |
| Podcast feeds | `collection/sources/podcast/episode-inventory.jsonl` plus shallow feed metadata listing | Episode records, RSS/Apple files and enclosure URLs are metadata only. Candidate matches remain unverified relationships. |
| Drive folder inventories | `collection/sources/drive/*folder-inventory.json` | Group-keyed `files` arrays parsed explicitly; remote folders/assets retained as metadata, never assumed downloaded or searchable. |
| Other collection indexes/audits | Shallow JSON/JSONL/XML/TXT files in the explicitly named web/Drive/podcast metadata directories | Metadata assets only. No generic recursive extension crawler. |
| Known original downloads | Local manifest originals; Drive archive ZIP and separately downloaded PDF/DOCX | Original assets inventoried without rewriting. Binaries unsupported; large binary contents are not loaded merely to inventory them. |
| Outside-collection summaries | Excluded by adapter scope | Never primary evidence; no optional derived-summary ingestion is implemented. |

This covers the supported *collected* families; it does not claim every original local binary, remote folder, web episode or recording is searchable. No held-out evaluation data is read. Unknown/unlisted acquisition families need an explicit adapter rather than opportunistic crawling.

## Provenance, dates and representation policy

`entries` contains stable record IDs, family, exact source file and 1-based record/JSONL line, path where present, title, availability category, reason, selected flag, original manifest record, and actual content hash where read. Record zero denotes the metadata/file asset itself. Missing/empty/read-error/status-error records remain visible. Malformed files/records produce contextual `issues` and `catalogue-validation` error entries, rather than silently returning an empty collection. Failure to resolve the workspace root rejects the call; individual collection failures return issues.

Source titles use manifest titles, original filenames, curated frontmatter titles, or the saved website body heading (after stripping collector header lines). An unambiguous valid calendar date embedded in a title is retained with `dateBasis: 'source_title'`. Explicit manifest dates retain their declared basis, falling back to `declared_manifest_date`; the curated article's simple frontmatter date uses `third_party_curated_frontmatter`. These dates are **not verified recording dates**. Collection timestamps, file mtimes and Drive created/modified times are never used as publication dates. Absent/ambiguous dates remain absent with `dateBasis: 'unknown'`. Curated nested YAML is preserved, not interpreted as primary source evidence; scalar title/date/status extraction is deliberately narrow and requires no YAML dependency.

Manifest retries select the latest available valid record **for the exact path** by append-order line/array record. Cross-file same-path conflicts use deterministic manifest pathname/record ordering. Quarantine assertions take precedence over successful records. Error retries are retained and do not discard a prior usable record. Different paths remain distinct versions/representations even if their URL, title, episode ID or archive group matches. One intake source is emitted per workspace path; every record remains in the sidecar. Source-version IDs remain the ingestion core's responsibility; catalogue record IDs are a separate namespace.

No content-equivalence deduplication is performed. TXT and MD are both admitted when substantive and valid; subtitles remain unsupported even when an associated TXT exists. All archive representations retain an unverified shared-container relationship. There are no fabricated TXT timestamps, inferred speakers, episode equivalence claims or title-based merges. Manifest-marked `header_only`/`heading_only` TXT/MD and text consisting entirely of Markdown heading lines are excluded. Whitespace-only files are empty. Hash mismatches are errors and not ready.

Relationships use catalogue IDs as `from`; `to` is another catalogue ID, original workspace path, URL, or archive URL/member locator. `extracted_from`, `representation_of`, `retry_of`, `same_path`, and `candidate_match` each include an explicit basis and `verified: false`. A stored checksum verifies bytes, not semantic equivalence or source authenticity. Exact original manifest fields remain available in `provenance`, including relationships not normalized into the relationship list.

## Coverage and core integration

Return shape:

```ts
interface CorpusCatalogue {
  schemaVersion: 1;
  manifest: IntakeManifest;
  entries: CatalogueEntry[];
  relationships: CatalogueRelationship[];
  coverage: {
    families: Record<string, FamilyCoverage>;
    total: FamilyCoverage;
    complete: boolean; // always false: this is not a completeness certification
  };
  issues: CatalogueIssue[];
  limitations: string[];
}
```

`FamilyCoverage` supplies `records`, `selectedSources`, counts for `ready`, `quarantined`, `unsupported`, `metadata_only`, `excluded`, `missing`, `empty`, `error`, and reason counts. Counts include retry records and distinct representations, not unique lectures. Filter entries by `selected` and category to obtain selected ready-path coverage. Sources with no extracted path can exist only in the sidecar; no invented path is supplied to intake. Invalid-record diagnostics are counted separately under `catalogue-validation` with exact input locations. `complete: false` remains true to known remote/download/extraction/verification gaps even when `issues` is empty.

The existing intake status vocabulary has no missing/empty/error/excluded states: those retain precise categories in the sidecar, with `quarantined` used as the fail-closed intake status for their actual paths. Metadata and unsupported assets use their corresponding intake statuses. Callers must persist both outputs, not infer full coverage from `manifest.sources` alone.

The backend/CLI owner has now integrated the `catalogue` command. Set CLEC_STATE_DIR to a derived output directory; both outputs must be inside it. For example, from the repository root:

```sh
npm --prefix backend run build
CLEC_STATE_DIR=/absolute/output npm --prefix backend run clec -- catalogue --root /Users/century/vibing/clec --manifest /absolute/output/intake.json --report /absolute/output/corpus.json
```

The command invokes `catalogueCorpus(root)`, atomically writes `.manifest` to the intake output and the entire result plus output hashes/locations to the report output, and surfaces issues and selected-ready counts. Non-ready intake entries remain present. Catalogue adapters themselves remain read-only. See handoff.md for the final compiled artifact, output safeguards, generation/report hash association and unexecuted Terra validation commands.

Needed additive core interfaces: original-format extractors with immutable extracted-to-original span mapping; subtitle type/reader and cue/line/time locator contracts for SRT/STR/VTT; richer original-asset/version/relationship and availability categories in evidence/citation/status views. Current TXT/MD source citations can display quality, origin, date and date basis; richer sidecars are not automatically persisted into SQLite by this module.

## Validation and limitations

Implementation-only handoff. The isolated catalogue module compiled with existing TypeScript using strict, unchecked-index and exact-optional checks. No tests, E2E, product smoke checks, catalogue execution, full backend build, model API calls or runtime coverage measurements were performed. The CLI/package owner controls full build setup. Terra owns runtime/E2E validation against the actual corpus without mocks.

Static source inspection establishes manifest shapes, not runtime correctness. Terra should assess complete family accounting, quarantine propagation, malformed/missing/empty cases, retry/version behavior, member hashes, UTF-8 preservation, source dates/bases, deterministic output, retained provenance and faithful downstream QMD/SQLite citations. There is deliberately no fabricated fixture, no merged episode count and no claim that all collected sources can answer questions.
