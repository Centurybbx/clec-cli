# CLEC CLI

Installable offline search and exact, original-backed reads for publisher-prepared CLEC evidence. Requires Node.js **22.19.0 or later**. No model, API key or running server is required.

## Install

Install the [0.2.0 trial package](https://github.com/Centurybbx/clec-cli/releases/tag/v0.2.0):

```sh
npm install --global https://github.com/Centurybbx/clec-cli/releases/download/v0.2.0/clec-cli-0.2.0.tgz
clec --help
clec status
```

To build from source instead:

```sh
git clone https://github.com/Centurybbx/clec-cli.git
cd clec-cli
npm ci
npm link
clec version
clec help
```

`npm ci` also builds through the package's `prepare` script. A publisher-provided `.tgz` package can instead be installed with `npm install --global /path/to/clec-cli-0.2.0.tgz`. The public repository supplies CLI code; **it does not supply a corpus or a public manifest endpoint**. Obtain a release manifest from your corpus publisher. No npm registry publication is implied.

The installed executable selectively suppresses Node's experimental-feature warning using `--disable-warning=ExperimentalWarning`. When invoking JavaScript directly, use `node --disable-warning=ExperimentalWarning dist/cli.js ...` to keep machine stderr clean. The normal supported entry point is `clec`. Platform coverage is recorded by the release checks; do not assume untested platforms work.

## Set up and explore

```sh
clec status
clec sync --manifest /path/to/release/manifest.json
clec sync                         # reuse the last successful origin
clec sources '退休'
clec search '退休 提領' --limit 8
clec search '退休 現金' --match all --per-source 2
clec source 'RELEASE:SOURCE' --limit 20
clec read 'RELEASE:SECTION' --context 1
clec help search
```

Use actual `ref` and `sourceRef` values returned by discovery/search. Every command accepts `--data-dir PATH` before or after the command. The default is `~/.local/share/clec`, overridable with `CLEC_DATA_DIR`. `status` succeeds before setup and shows the next command. `sync` remembers an explicit local absolute path or validated URL only after success. If saving the origin fails after activation, its error names the active release; fix the filesystem and repeat explicit sync.

Search uses traditional/simplified normalization and lexical tokens. `any` is token OR; `all` requires every generated token in a section's indexed title/body, **not an exact phrase**. Query limits fail explicitly: 1..512 UTF-16 units and at most 64 lexical tokens. `--source` accepts a raw source ID or a full source ref. Date filters (`--date-from`, `--date-to`) are inclusive and exclude sources with unknown dates.

`sources [QUERY]` searches existing titles and full paths with all normalized whitespace terms as literal substrings. It keeps edition rows separate. Source metadata includes date basis, stored quality and section count. Search defaults to at most two sections per source, applied across the full ranked result before pagination. Change `--per-source 1..50` when needed.

`search`, `sources` and `source` accept `--limit 1..50` and `--offset 0..10000000`. Defaults are 8 search hits or 20 source/section entries. Repeat identical options and the returned release (`--release HASH` for search/sources) with `page.nextOffset`; a null next offset marks the end. Source refs already pin their release. Updates replace the active release, so old refs and page guards fail with `VERSION_UNAVAILABLE`; discover again and restart paging.

## Compose with an agent or shell

Text is the deterministic default, including when piped. Request JSON explicitly:

```sh
clec search '退休 提領' --format json |
  jq -r '.data.hits[].ref' |
  clec read --stdin --context 1 --format json

clec sources '退休' --format json | jq '.data.items[] | {title,path,sourceRef}'
```

JSON success is one newline-terminated document: `{schemaVersion:1,ok:true,command,data}`. Errors leave stdout empty and write `{schemaVersion:1,ok:false,command,error:{code,message,remedy}}` to stderr in JSON mode. Text errors expose the same code, message and recovery action. Errors may add zero-based `inputIndex` or an activated `release` when relevant.

`read` always returns `data.items`, even for one ref. It preserves order and duplicates and verifies the whole batch before writing any result. Supply 1..50 positional refs **or** `--stdin`, never both. Explicit stdin accepts at most 64 KiB of UTF-8 newline refs, ignores blank lines, and rejects interactive input, malformed refs and mixed releases. Empty search/discovery results succeed; a pipe without any hits needs to handle the resulting empty ref list before invoking `read`.

Exit statuses: 0 success (including zero hits and a downstream closed pipe); 2 invalid usage/input; 3 unavailable evidence/release or missing setup; 4 lock/transfer/filesystem failure; 5 package/integrity failure; 1 unexpected internal error; 130 interruption.

Version 0.2 changes the 0.1 wire interface: text is now the default, JSON fields live under `data`, and single reads use `data.items[0]`. The corpus schema and release-qualified reference encoding are unchanged.

## Cite evidence

Read results preserve exact original text, UTF-16 start/end spans and content hashes. Context defaults to one neighboring section on each side (`--context 0..2`), each separately cited with its own ref and span. Context never silently expands the requested section. Search previews center on an original literal match when safely located; otherwise `previewKind: "leading"` labels a leading excerpt. Previews are navigation, not answers.

Preserve source date, quality, speaker attribution and qualifying conditions. Keep episode identifiers when refining queries; discover their source, inspect sections, then search within that source. Empty results do not establish that a topic is absent. See the [agent guide](docs/agent-guide.md) for the complete navigation workflow.

Only sync accesses the network. Manifests use explicit local paths or HTTPS (HTTP only for loopback); credentials, fragments and protocol downgrades are rejected. Downloads verify length, SHA-256, schema and original spans before activation. Failed transfers retain the previous active release. Storage keeps one active corpus plus a bounded incoming candidate, caps artifacts at 2 GiB, and requires another 5 GiB free before transfer. Original corpus files are not included in this package.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack
```

Smoke checks publish a tiny authored fixture and run real CLI processes. The publisher is available as `npm run build:corpus`; normal users consume an existing release and need no local corpus build. The CLI provides evidence retrieval, not an automated answering service.
