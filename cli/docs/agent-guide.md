# Using CLEC as an agent

Start with `clec --help` and `clec status --format json`. If data is missing, obtain a release manifest from your user or publisher and follow `clec sync --help`. The GitHub source repository supplies the tool; it does not supply a public corpus manifest.

1. For a named episode or document, use `clec sources 'title or episode identifier' --format json`. Keep identifiers when reformulating. Inspect the returned title, path, date, date basis and quality to choose an edition.
2. Use `clec search 'quoted query' --format json` for evidence. Narrow with the returned `sourceRef` using `--source`. `--match all` requires all generated tokens, not an exact phrase. A zero-hit search means this query found nothing; it does not establish absence from the corpus.
3. Read candidates before answering. Previews are navigation excerpts. Batch selected refs with `clec read REF REF --format json`, or pipe one ref per line into `clec read --stdin --format json`. Reads include neighboring sections by default, each with its own reference and exact span.
4. For incomplete conditions, navigate the source using `clec source SOURCE_REF --format json`, then read the relevant sections. For another result page, repeat the same query/options with its `page.nextOffset` and `--release` value. A stale-release error requires a fresh search.
5. Answer from the text actually read. Cite section refs and source titles. Preserve dates, comparison periods, eligibility conditions and numerical units. Distinguish original statements from curated interpretations and unverified transcription. Metadata alone does not identify who spoke a sentence. If editions differ or the question is ambiguous, explain the distinction. If support is missing, state the gap.

For shell composition with jq installed:

```sh
clec search '退休 提領' --limit 3 --format json |
  jq -r '.data.hits[].ref' |
  clec read --stdin --format json
```

Successful JSON is one stdout document. Failures produce a nonzero exit and an error on stderr with a machine code and remedy. An atomic read batch fails without partial stdout when any input fails; correct the reported input and retry. See command help for bounds and `README.md` for the output contract.
