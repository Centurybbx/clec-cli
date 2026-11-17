# CLEC Native Phase 2 Design, Domain Shape, and Responsibility Map

Phase 2 builds the admitted CLEC source corpus from immutable local inputs into `clec-native-v2` with explicit conservative work identities, verified cross-format duplicate collapse for indexing, full original provenance retention, complete inventory reconciliation against the 0.3.0 snapshot (`12,532` admitted sources, `17,972` inventory items), and bounded-memory full validation on a 16 GiB host.

## Falsifiable Phase 2 predicate

Phase 2 is complete only when all of the following hold on committed code with unmodified root inputs:

1. **Deterministic intake and reconciliation.** Running `tools/prepare_phase2_intake.py` twice on `/Users/century/vibing/clec` produces byte-identical intake JSON and reconciliation reports, accounts for all `12,532` old admitted sources and `17,972` old inventory rows with zero silent drops, and keeps distinct works separate across archive containers, Drive IDs, and local paths.
2. **Core canonical equivalence and non-destructive provenance.** `clec-publish` collapses proven-equivalent `(work_id, role, equivalence_hash)` index inputs to one deterministic canonical representative (preferring valid subtitle cue timings) while preserving all original `blobs`, `sources`, `cues`, `source_diagnostics`, and `source_canonical_map` relations readable by `SourceId`.
3. **Bounded-resource full build and validation.** Ascending sample runs (`50`, `500`) establish memory and disk feasibility before the full build. The full `clec-publish` and `clec sync` complete on the 16 GiB RAM host with measured peak RSS, peak disk, elapsed time, and zero validation errors.
4. **End-to-end integrity and regression suite.** Every Phase 1 invariant (`fts5vocab` postings, `search_docsize`, SQLite FTS5 `integrity-check`, live `bm25`, cue/span/continuation checks, zstd pre-reuse stream/hash checks, checked cue timestamps, convergent `--max-bytes`, atomic `active.json`) plus Phase 2 synthetic triples, false friends, canonical/non-canonical read navigation, and bad-input controls pass in `cargo test --locked` and `evaluation/clec-v1/phase2/verify_phase2.py`.
5. **Immutable root preservation.** Source hashes under `/Users/century/vibing/clec` match the pre-run baseline after completion.

## Domain shape (`clec-native-v2`)

### Core invariants

- **Work identity (`WorkId`) vs. equivalence (`source_canonical_map`).** Work grouping models which real-world episode, container, or document a source belongs to. Cross-format equivalence models which sources within the same `(work_id, role)` share identical literal body text under deterministic projection. Different works never merge even when raw bytes are identical. Different roles under one work (such as `transcript` vs. `summary`, or `qa` vs. `document`) never merge.
- **Explicit provenance and attribution.** `Attribution` carries `machine_unverified`, `automatic_unverified`, `unverified_transcript`, `original_unknown`, `publisher_verified`, and `authored_fixture`. Phase 2 never upgrades unverified extracts, OCR, web pages, or ASR transcripts to verified status.
- **Deterministic projection and whitespace fold.**
  - `ProjectionKind::SubtitleCuePayload` (`srt`, `str`, `vtt`): joins each parsed cue text slice with `\n` and folds Unicode whitespace (`split_whitespace` joined by `' '`).
  - `ProjectionKind::ArchiveVoiceNoteMarkdown` (`.md` starting with `# 語音筆記：` and containing `## [H+:MM:SS[.,]MMM – H+:MM:SS[.,]MMM]` headers): strips the header and timestamp lines, collects payload lines, and folds Unicode whitespace. Unrecognized Markdown falls through to `PlainText`.
  - `ProjectionKind::PlainText` (`.txt` and unrecognized `.md`): strips optional leading UTF-8 BOM and folds Unicode whitespace.
  - `equivalence_hash = sha256("equiv-v1:" || folded_body)`. No OpenCC conversion, punctuation removal, or semantic matching occurs during equivalence checking.
- **Canonical representative election.** Within each `(work_id, role, equivalence_hash)` group, `clec_core` selects the canonical representative by: valid subtitle with cues over non-subtitle, extension order (`srt < str < vtt < txt < md < other`), attribution order, fewer extraction diagnostics, lexicographic `path`, and `source_id`.
- **Canonical-only indexing invariant.** Only sources where `source_id == canonical_source_id` emit rows into `passages`, `passage_spans`, and `search`. Non-canonical equivalent sources emit zero rows into `passages` and `search`, while retaining full `blobs`, `sources`, `cues`, `source_diagnostics`, and `source_canonical_map` entries.

### Schema refinement

`metadata` persists `corpus_format = 'clec-native-v2'`, `segmentation_revision`, `tokenization_revision`, `normalization_revision`, `dictionary_revision`, and `equivalence_revision`. Legacy format revisions `1`, `2`, `3`, and `clec-native-v1` are rejected without compatibility shims.

`source_canonical_map` stores normalized canonical membership instead of boolean flags:

```sql
CREATE TABLE source_canonical_map(
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  canonical_source_id TEXT NOT NULL REFERENCES sources(id),
  equivalence_hash TEXT NOT NULL,
  projection_kind TEXT NOT NULL,
  equivalence_basis TEXT NOT NULL
);
CREATE INDEX source_canonical_by_canon ON source_canonical_map(canonical_source_id);
```

## Module responsibility map

- `native/src/domain.rs`: revision constants (`CORPUS_FORMAT`, tokenization/normalization/dictionary/equivalence versions), `Attribution` variants (`AutomaticUnverified`, `OriginalUnknown`), `ProjectionKind`, and `EquivalenceBasis` validated constructors and `JsonSchema` definitions.
- `native/src/ingest.rs`: cue extraction, Unicode scalar segmentation (`1000..1200` target, `2000` hard cap), and `compute_equivalence_projection` pure transform.
- `native/src/store.rs`: `clec-native-v2` schema, `source_canonical_map` validation (including canonical winner verification and zero-passage invariant for non-canonical sources), bounded-memory streaming `validate_staging_db` using partitioned binary posting buckets (`B = 64` when passages > 2000, in-memory `B = 1` for small fixtures), read navigation exposing canonical and equivalent source links, and `--canonical-only` source filtering.
- `native/src/snapshot.rs`: two-pass streaming publisher (`build_in_staging`) that reads each input once to store `blobs`/`sources`/`cues`/`diagnostics`, elects canonical representatives in `clec_core`, streams canonical blobs to populate `passages`/`search`, validates via `validate_staging_db`, compresses to `corpus.sqlite.zst`, and writes `manifest.json` with full revision metadata and `canonicalSources` count.
- `native/src/cli.rs`: `sources --canonical-only`, updated `schema` (`phase2`, `clec-native-v2`, `cross_format_dedup` supported), and unchanged `--max-bytes` fixed-point convergence.
- `tools/prepare_phase2_intake.py`: developer-only stdlib Python tool that reads immutable manifests under `/Users/century/vibing/clec`, assigns conservative `workKey`, `role`, `attribution`, `quality`, and `status`, generates deterministic `intake.json` (plus subset intakes for `50` and `500` capacity trials), and emits a reconciliation report against `.cache/bm25-release-030/release/corpus.sqlite` and `.cache/clec-trial/intake.json`.
- `evaluation/clec-v1/phase2/verify_phase2.py`: rerunnable Phase 2 blackbox driver covering Phase 1 regression invariants on `clec-native-v2`, synthetic cross-format triples, false-friend non-merge controls, canonical/non-canonical navigation, and tampering controls.
