# CLEC offline evidence search

The CLI searches CLEC evidence with BM25 and reads exact original text. The host agent plans follow-up queries, compares sources, and writes the answer. Node.js 22.19.0 or later is required.

## Install and start

Install the release tarball. This package is not published to the npm registry. Installation requires network access for npm dependencies or a prepared npm cache. After installation and corpus sync, search and reads run offline without Python, an API key, or a server.

```sh
npm install --prefix /tmp/clec https://github.com/Centurybbx/clec-cli/releases/download/v0.3.0/clec-cli-0.3.0.tgz
/tmp/clec/node_modules/.bin/clec --help
/tmp/clec/node_modules/.bin/clec sync --manifest /absolute/path/to/release/manifest.json
/tmp/clec/node_modules/.bin/clec guide research
```

No public corpus manifest endpoint is supplied. Obtain a publisher manifest separately. Choose a corpus directory with `--data-dir PATH` or `CLEC_DATA_DIR`; the default is `~/.local/share/clec`. Repeat `clec sync` to use the last successful origin.

```sh
clec coverage --format json
clec sources '退休' --format json
clec search '退休 生活費' --format json
clec search '退休 現金' --match all --format json
clec source 'RELEASE:SOURCE' --limit 20 --format json
clec read 'RELEASE:SECTION' --context 1 --format json
clec find '每年提領' --format json
clec read-range 'RELEASE:SOURCE' --start 0 --end 200 --format json
```

Copy real references from returned results. A reference binds a section or source to the active release SHA-256. Updating the corpus makes old references unavailable. Restart discovery and pagination after `VERSION_UNAVAILABLE`.

## Search and read contracts

Search normalizes traditional and simplified characters and uses SQLite FTS5 BM25 with title weight 4 and section text weight 1. Source and date filters apply to all matching sections. Each source contributes at most `--per-source` sections, default two, selected by BM25. Results sort by ascending SQLite BM25 score, then section ID; lower scores rank first. Pagination follows this per-source cap across the complete filtered match set. This preserves the 0.2 BM25 ranking and pagination behavior.

A null `page.nextOffset` exhausts the matches allowed by these options; it does not establish that no other relevant evidence exists. There is no fixed candidate limit. Repeat identical options with `--release HASH` when paging. Date filters exclude unknown dates. `coverage` reports admission outcomes, quality labels, extraction diagnostics, and unknown dates.

`--match any` uses token OR; `--match all` uses token AND. Neither is phrase matching. Queries allow 1..512 UTF-16 units and at most 64 distinct tokens. Search uses literal token overlap and cannot discover evidence solely through conceptual similarity. Vary terminology and follow source references across multiple rounds. There is no search mode option. Existing format 1 corpora remain searchable; new publications use format 3. Trial format 2 is rejected explicitly and must be rebuilt.

`find` uses exact original substrings without normalization. It reports original UTF-16 offsets and overlapping section references. `read-range` accepts a source reference and an interval of 1..20000 UTF-16 units. It rejects intervals that split a surrogate pair.

`read` returns exact originals and up to two neighboring sections on each side. Each context section carries its own reference. Subtitle originals retain timestamps and markup. Cue metadata reports subtitle-file times and original text offsets; these times are not verified video seek locations. Partial cue extraction retains the whole original for search and reads, with diagnostics in read metadata and coverage.

Source metadata distinguishes unverified transcripts, mixed summary pages, and introductions with comments. Source type and quality labels never establish who spoke. Repeated editions and pages describing one episode are not independent witnesses. Search previews help navigation; cite text actually read.

## Output and lifecycle

Text is the default, including in pipes. Explicit JSON produces one stdout document with `{schemaVersion:1,ok:true,command,data}`. Errors leave stdout empty and write `{schemaVersion:1,ok:false,command,error}` to stderr. Single and batch `read` results always use `data.items`. A batch preserves input order and duplicates and fails atomically.

```sh
clec search '退休 提領' --limit 3 --format json |
  jq -r '.data.hits[].ref' |
  clec read --stdin --format json
```

Handle an empty hit list before calling `read --stdin`. Stdin accepts 1..50 newline references and at most 64 KiB. `clec help COMMAND` lists bounds and options. Run `clec guide research` for the packaged multi-round evidence workflow.

Sync verifies one SQLite artifact, including its exact schema, source identities and hashes, complete section coverage, and format 3 extraction metadata/cues, before atomically activating it. Failed transfer or validation retains the previous active release. Artifacts are capped at 2 GiB. Incoming transfer requires its bytes plus 5 GiB reserve. The CLI keeps only the current corpus and does not promise archival reference retention.

Exit codes are 0 for success, 2 for invalid input, 3 for unavailable data, 4 for transfer or filesystem failures, 5 for package integrity failures, 1 for unexpected errors, and 130 for interruption.

## Build a publisher release

From the repository root:

```sh
npm ci --prefix cli
npm run typecheck --prefix cli
npm test --prefix cli
node cli/dist/publisher.js \
  --workspace "$PWD" \
  --intake /absolute/path/to/intake.json \
  --output /absolute/path/to/new-release
npm pack ./cli
```

The publisher requires a new output directory and an intake with `schemaVersion: 1` and a `sources` array. Each source records `path`, `title`, `type`, `quality`, and `status`; known dates require `date` and `dateBasis`. It admits ready UTF-8 `.md`, `.txt`, `.srt`, `.str`, and `.vtt` sources. Subtitle files need at least one usable cue. Unsupported formats require upstream text extraction. Quarantine, missing files, unsupported encodings, empty sources, and metadata-only records remain visible in inventory rather than silently becoming evidence. Optional `--artifact-url URL` sets the manifest download URL.

Tests use tiny authored fixtures to verify build, sync, search, exact reads, subtitle diagnostics, rollback, and format compatibility. They do not establish full-corpus retrieval quality or support for untested platforms.
