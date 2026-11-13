# Full supported-corpus preparation — 2026-11-10

The real independent clean-install CLI catalogued the original workspace and all **6,775 catalogue-selected ready sources** were copied to a new isolated workspace with their relative paths and exact bytes. No build, QMD server, model download, inference, provider call, credential, held-out file, or quality evaluation was involved. Coverage is the catalogue's supported collected corpus, not a claim that all recordings or remote assets are available. Full quality scores remain unmeasured.

## Identity and execution

- Node: `/Users/century/.nvm/versions/node/v25.7.0/bin/node`, v25.7.0, SHA-256 `67252740eb6dadeff855b991ec85d7a7cf1d5d70ba7e68adf8d73b17df8a4b95`.
- Independent CLI: `/tmp/clec-clean-install-T6uI1J/backend/dist/cli.js`, SHA-256 `b6a30a3f50645151455a8a007a933e71668ef680a90f706f0478782c246f2a0d`; matches the retrieval artifact identity and clean-install deployment. Its package and lock hashes match clean-install evidence: `4f86534be5f8014c89d131645c40c9ccac734ee420352eadb6102d5cb28ca6bf` and `6527d08af337325369773fe992c28d1cacd5d845fd01d1bea390560c031ce318`. All 46 independent `backend/src` files recorded in the frozen retrieval inventory matched. This check did not rely on concurrently rebuilt shared dist.
- Retained run directory: `/tmp/clec-full-corpus-20261110-r6jctg` (macOS canonical `/private/tmp/clec-full-corpus-20261110-r6jctg`). Workspace: `.../workspace`; catalogue state: `.../state`. These are outside the original workspace.

Executed with `DEEPSEEK_API_KEY` removed:

```sh
RUN_DIR=/tmp/clec-full-corpus-20261110-r6jctg
env -u DEEPSEEK_API_KEY CLEC_STATE_DIR="$RUN_DIR/state" \
  /Users/century/.nvm/versions/node/v25.7.0/bin/node \
  /tmp/clec-clean-install-T6uI1J/backend/dist/cli.js catalogue \
  --root /Users/century/vibing/clec \
  --manifest "$RUN_DIR/state/full-intake.json" \
  --report "$RUN_DIR/state/full-catalogue.json"
/Users/century/.nvm/versions/node/v25.7.0/bin/node "$RUN_DIR/prepare.mjs"
```

Original full intake SHA-256 `779d05849efd50d6974f3b60c19dc788fe8f4953221fa0f8b3af48dc3df2d59d`; full catalogue SHA-256 `41f35009d519a66fbb21aec70e8e4123ff7b8e147230eab4d3d74f3e237789e5`. The intact catalogue includes entries, original manifest records, provenance, relationships, issues and coverage. Its intake has 17,972 unique paths and no duplicate path. It retains non-ready statuses; no unsupported source was relabelled. Build contract inspection shows non-ready and metadata entries are skipped before opening their paths, so no separate ready-only intake is required.

## Coverage and reconciliation

Catalogue **record** categories, including retries and records without paths: ready 6,775; quarantined 18; unsupported 1,509; metadata-only 21,510; excluded 2; missing 5; empty 2; error 438. These sum to 30,259 records, not unique sources. The 17,972 selected intake paths have statuses ready 6,775, quarantined 24, unsupported 1,509 and metadata-only 9,664; fail-closed intake statuses do not preserve every detailed sidecar category. `complete` is false.

| Selected ready family | Files |
| --- | ---: |
| Drive archive | 2,848 |
| CLECTW transcripts | 2,153 |
| Drive documents | 783 |
| CLEC168 body extracts | 667 |
| clec-md knowledge | 132 |
| CFNAVI curated | 123 |
| Local documents | 50 |
| Local spreadsheets | 6 |
| Local ASR | 8 |
| Podcast ASR | 4 |
| OCR | 1 |

By intake type: transcript 5,013, document 840, curated 922. All were copied: **204,686,007 bytes**, zero copy errors. `/tmp/clec-full-corpus-20261110-r6jctg/copy-records.jsonl` (SHA-256 `a961c3718cb761a9bc614e22263c616682b2f1f8565c71a1de785687d11fe71b`) records original and isolated paths, full intake metadata, catalogue family and ID, catalogue content hash, byte size, original and copy SHA-256, and source stat times. The catalogue's content hash is recorded; ingestion source-version IDs are assigned by the later build and do not yet exist. Unknown dates and original quality/origin labels remain as catalogued. No case-based filtering, generated facts or gold answers were added.

The preparation script streams each source for hashing and copying, checks source real paths remain inside the original root and destination parents inside the isolated workspace, and creates ordinary files rather than copying symlinks. Each original hash matched the catalogue hash, each copy hash and size matched the original, and pre/post copy stats agreed. A subsequent streamed hash and stat pass over every original found no changes. This detects the checked changes but is not an atomic filesystem snapshot: transient changes reverted between observations, or concurrent changes to catalogue metadata, cannot be ruled out. No metadata or originals were modified by preparation. The retained stdout/stderr, script, identity and summary give execution details.

## Omissions and handoff

No ready source was omitted. The catalogue excludes or inventories other materials rather than admitting them: 1,426 Drive archive subtitle representations require a subtitle interface, plus 24 ASR subtitle representations; binary originals require extraction or have separate extracts; HTML, navigation, video introductions/comments, remote folder and podcast listings are metadata; quarantine is excluded; empty and heading-only records are not admitted. Other detailed reasons and per-record paths are in the retained sidecar. Binary originals and media are not copied; catalogue provenance retains the references and any hashes already recorded. Those external original paths/URLs may be unavailable if the original workspace moves, and the text-only isolated workspace cannot itself provide original binary evidence.

Two catalogue issues are missing metadata files: `collection/transcripts/local-asr/ep-00176/metadata.json` and `collection/transcripts/local-asr/ep-00260/metadata.json`. The sidecar also records three CLECTW missing transcripts, two empty and two heading-only archive texts, and 436 collection-status error records. These are inventory limitations, not copy failures; see the full report for exact records and retry context.

For the next Terra hybrid build, use the isolated workspace above, a **new separate state directory**, the retained full intake, an explicitly selected and verified compatible CLI/build artifact, Node 25.7.0, and separately provisioned verified local models. The clean-install CLI used for catalogue predates any pending protocol fix; this preparation does not validate that fix or hybrid retrieval. Do not recatalogue the text-only workspace as though it retained the original catalogue metadata. Preserve the full catalogue and intake alongside the generation for provenance and omission accounting.
