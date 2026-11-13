# Portable CLEC contract

The consumer installs a small Node CLI and syncs publisher-prepared data. Search, evidence reads and source navigation work offline without source files, a server, a model or credentials. An external agent chooses queries and writes answers. This document defines the replacement under implementation; passing checks are recorded separately.

## Usage

```sh
clec sync --manifest /path/to/release/manifest.json
clec search '退休 提領' --limit 8
clec read '<release-sha256>:<section-id>'
clec source '<release-sha256>:<source-id>' --offset 0 --limit 20
clec status
```

Every command accepts `--data-dir`. Success and failure each emit one JSON value to stdout; diagnostics go to stderr. Errors have a stable code and nonzero exit status. Only sync accesses the network. HTTPS distribution and explicit local manifests are supported; HTTP is allowed only for loopback development tests. No default public URL exists yet.

Publisher usage is a separate repository command, excluded from the installed consumer file list.

```sh
npm run build:corpus -- --workspace /path/workspace --intake /path/intake.json --output /path/release
```

The publisher reads explicit intake, preserves original text and metadata, and creates `corpus.sqlite` and `manifest.json`. Optional `--artifact-url URL` records the public artifact download URL in the manifest. It never embeds an absolute producer path. The canonical old evidence DB is a verification oracle, not a supported input needed for future releases.

## Data and ownership

One immutable SQLite file owns sources, sections, inventory, format metadata and contentless FTS5. Originals appear only in sources. A section is both a retrieval unit and a readable exact UTF-16 span; there is no duplicate passage table. Reuse existing source identity, version serialization, segmentation and admission behavior. Preserve non-indexed inventory and its reasons rather than implying all intake entries were searchable.

`release` is SHA-256 of the closed SQLite file. It lives in the external manifest and managed file name, never inside the same file. A reference is `release:section` or `release:source`, validated according to the command. Old references return `VERSION_UNAVAILABLE` after activation of a new release. They never silently resolve against the current dataset.

The successor package is `cli/`. Its modules have substantive ownership.

* `cli.ts` parses commands and formats JSON.
* `corpus.ts` owns the database schema, bounded retrieval, exact reads, source paging and package validation.
* `lexical.ts` owns shared search-only normalization and tokenization.
* `releases.ts` owns bounded transfer, integrity checking, exclusive update ownership and atomic activation.
* `publisher.ts` owns direct intake build and release files. Retained intake/catalogue helpers belong to the publisher and have no dependency on old service modules.
* `contracts.ts` owns the small source, section, reference, result and error types. Internal modules are not a promised public SDK.

The installed files include only the consumer dependency closure and OpenCC. No Pi, QMD, model downloads, native npm compilation or postinstall patching. A modern Node with built-in SQLite is an explicit prerequisite. Supported runtime/platform claims require actual verification.

## Retrieval and exact evidence

Normalize only indexed and queried text with the existing NFKC, OpenCC and case rules. Emit adjacent Han bigrams and Latin/numeric tokens; support single Han characters through a separate indexed representation. Contentless FTS avoids retaining another full searchable text copy. Generated token syntax is internal, never raw user MATCH syntax.

Use bounded lexical retrieval with BM25 title weighting and deterministic ties. `--match any` is the default OR; optional `--match all` requires all generated tokens in one indexed section across its title/body fields. It promises neither phrase matching nor cross-section matching. Support exact source and date filters. Return the interpreted terms and match mode so an agent can refine a query. No semantic-recall claim. Search previews are navigation, not verified answers; read returns exact original text with source version, original content hash, range, date basis, quality and origin. Include adjacent section references for context. Source pages list ordered section references and a continuation offset.

Queries have at most 512 UTF-16 units and 64 terms. Search returns 1–50 hits, previews at most 320 units. Read returns one complete section of at most 5,000 units without silent truncation. Source pages contain at most 100 section descriptors. Metadata is bounded at admission. Oversized requests fail clearly rather than silently changing meaning.

## Update and storage

The manifest has a format revision, fixed artifact basename, exact byte length, SHA-256 and counts. Optional `artifactUrl` is an absolute HTTPS URL; HTTP is allowed only on loopback. Remote sync uses `artifactUrl` when present. Otherwise it resolves `corpus.sqlite` relative to the final manifest response URL after redirects. GitHub release manifests can specify the public artifact download URL so opaque signed manifest redirects do not determine artifact location. Local manifests always use the sibling `corpus.sqlite`. URLs cannot contain credentials or fragments. Remote artifact pointers cannot use `file:` URLs. Redirects and artifact resolution cannot downgrade HTTPS to HTTP. Download raw SQLite without archive extraction. Bound manifest size, transfer bytes and package size. Reject unsupported revisions and malformed artifacts. Check digest before opening SQLite; open read-only with extension loading disabled and trusted schema disabled. Validate schema, integrity, source hashes, contiguous spans, identity and FTS row coverage before activation. The publisher owns token correctness. Consumer sync does not retokenize the entire corpus or rebuild an index. A checksum binds data to the selected publisher's manifest; it does not prove an untrusted publisher is honest.

A managed data directory has one active release and at most one incoming candidate. A single sync owns its staging file and writer lock. Readers open the immutable active file once. If sync removes that file between pointer resolution and open, unqualified operations retry current resolution a bounded number of times; explicit references fail with `VERSION_UNAVAILABLE`. Publish the current pointer only after full validation. Failure before activation leaves the old pointer usable. Reclaim only this tool's obsolete managed files. If activation succeeds but an open reader prevents cleanup, return success with `cleanupPending: true` and refuse further growth until cleanup succeeds. No version registry, reader lease service or automatic rollback framework.

A stale lock is reclaimed only when its local owner is proven gone, never merely because it is old. Check space for the incoming artifact plus a 5 GiB reserve before downloading. Set an explicit artifact ceiling and enforce it during streaming. Repeated sync must not accumulate copies. Status reports managed bytes and active identity. Power-loss durability and Windows file-sharing behavior are not established by macOS tests.

## Migration decision

Design candidates A and B recommend direct intake and a single SQLite artifact; C recommends a narrow legacy evidence importer to reduce initial parity work. Use A as the base. Keep C's exact migration comparison, but avoid making the old database a prerequisite for future publishing. Adopt single-active-version retention to avoid a separate retention subsystem. The price is explicit failure of old references after update.

The independent Sol judge selected A and identified the resolve/open race addressed above. Root accepted that correction. All four designs were screened for duplicated invariant owners, forwarding layers, legacy dependencies and unbounded retained state. A and the synthesis scored 24/25, D 23, B 22 and C 21 against the five criteria. The panel used four Astra designs under the user's configuration, so design-model diversity was limited; the judge used Sol. Runtime measurements remain pending. Remove replaced service/session/QA/QMD dependencies only after real full-corpus, install, relocation, update-failure and evidence checks pass. Preserve original data, historical reports and publisher catalogue behavior. See `.audit/cli-20261113/acceptance.md` for the execution gates.
