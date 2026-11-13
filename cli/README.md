# CLEC CLI

Search publisher-prepared CLEC evidence locally. Requires Node.js 22.19.0 or later. No model, API key, service or local corpus build is required. Public distribution URLs have not yet been configured.

```sh
clec sync --manifest /path/to/release/manifest.json
clec search '退休 提領' --limit 8
clec search '退休 現金' --match all
clec read 'RELEASE:SECTION'
clec source 'RELEASE:SOURCE' --offset 0 --limit 20
clec status
```

Use the `ref` and `sourceRef` returned by search. Every command accepts `--data-dir PATH`; the default is `~/.local/share/clec`, overridable with `CLEC_DATA_DIR`. Commands emit JSON. Failures return a nonzero exit code. Only sync accesses the network, using HTTPS or an explicit local manifest.

Search is lexical, with traditional/simplified normalization. `--match any` is the default. `--match all` requires every generated query token in one section's indexed title/body; it does not promise exact phrases. Source and date filters are `--source ID`, `--date-from YYYY-MM-DD` and `--date-to YYYY-MM-DD`.

Keep episode identifiers when reformulating queries. Search an identifier first, inspect the source, then narrow within its source ID. Read selected results and their `previous`/`next` references before citing. Previews are navigation, not answers. Preserve the source's date, quality, speaker attribution and conditions. Search cannot establish that a topic is absent from the corpus.

Read returns exact original UTF-16 spans and source hashes. Source pages expose ordered section references. Updating replaces the active release; old references return `VERSION_UNAVAILABLE`. Failed downloads leave the previous release active. An unchanged sync verifies and reuses its local file. Only use manifests from a publisher you trust.

The current full database is approximately 503 MiB. An update can temporarily require both current and incoming data. The CLI caps an artifact at 2 GiB and requires another 5 GiB free before downloading. Deferred cleanup blocks further growth.

Verified on macOS arm64 with Node 22.19.0 and 25.7.0. Windows and Linux remain unverified. Web introductions/comments and subtitle timing from the earlier Python tool are not migrated. Retrieval quality has known gaps; this is an evidence tool for an external agent, not an automated answering service.
