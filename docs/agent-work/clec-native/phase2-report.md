# CLEC Native Phase 2 Report

Phase 2 implements conservative work grouping, deterministic cross-format duplicate collapse inside `clec_core`, normalized canonical membership (`clec-native-v2`), bounded-memory full-corpus publishing and staging validation, full inventory reconciliation against the 0.3.0 snapshot, and a rerunnable Phase 2 verification suite.

## Implemented changes

- **`native/src/domain.rs`.** Upgrades `CORPUS_FORMAT` to `clec-native-v2` (rejecting legacy revisions 1, 2, 3, and `clec-native-v1`), persists `TOKENIZATION_REVISION`, `NORMALIZATION_REVISION`, `DICTIONARY_REVISION`, and `EQUIVALENCE_REVISION`, adds `AutomaticUnverified` and `OriginalUnknown` attribution variants, adds `ProjectionKind` and `EquivalenceBasis` validated enums, and adds `select_canonical_index` as the shared deterministic election rule.
- **`native/src/ingest.rs`.** Adds `compute_equivalence_projection` for subtitle cue payloads (`srt`, `str`, `vtt`), recognized `# 語音筆記：` plus `## [ts – ts]` archive Markdown files, and plain text with documented Unicode whitespace folding and no OpenCC, punctuation deletion, or semantic normalization.
- **`native/src/store.rs`.** Adds `source_canonical_map` and `canonical_sources` counts, validates canonical election and zero-passage invariants for collapsed representations, replaces full-corpus in-memory posting maps with partitioned binary buckets (`64` disk buckets when passages exceed `2000`, `1` in-memory bucket for small fixtures) plus per-source streaming validation, exposes `canonicalSourceId` and `equivalentSources` on `read` and `sources`, and adds `--canonical-only` filtering.
- **`native/src/snapshot.rs` and `native/src/cli.rs`.** Switches `build_in_staging` to two-pass streaming (metadata/blobs/cues first, canonical selection, then passage/FTS indexing on canonical sources only), supports `excluded`, `empty`, `missing`, and `statusReason` intake fields, updates `clec schema` for `phase2` (`cross_format_dedup` enabled; `sag2` and `http_bootstrap` unsupported), and updates `--max-bytes` fixed-point output formatting.
- **`tools/prepare_phase2_intake.py`.** Deterministically reads collection manifests under `/Users/century/vibing/clec`, groups archive containers (`archive:{id}`), `clectw` episodes (`clectw:{slug}`), `local-asr`/`podcast-asr`, and distinct document/web origins conservatively, preserves unverified attribution labels, reconciles all `12,532` admitted sources and `17,972` inventory items against the 0.3.0 snapshot, and reports unmerged cross-work duplicate candidates (`55` groups).
- **`evaluation/clec-v1/phase2/PROTOCOL.md` and `evaluation/clec-v1/phase2/verify_phase2.py`.** Adds Phase 2 verification protocol and blackbox driver covering all Phase 1 regression invariants plus synthetic triples, false-friend non-merge controls, canonical tampering guards, and `00318`/`00575` canonical collapse.

## Reconciliation against the 0.3.0 snapshot

- **Deterministic intake preparation.** Two independent runs of `tools/prepare_phase2_intake.py` produced identical SHA-256 digests (`87ba9715247037376619cfe7df99e353f5d9ca7a8ccc0f1fb8c722d5ed0b6e45` for `intake.json` and `1a0e71eadb985a2b689075a8381c2e39b3910b6ed6e6a40b896d10fa160b9070` for `reconciliation.json`).
- **Source and inventory completeness.** All `12,532` previously admitted sources (`0` missing, `0` added, `0` SHA-256 mismatches against `/Users/century/vibing/clec` on disk) and all `17,972` inventory items (`12,532` indexed, `5,355` metadata_only, `59` unsupported, `18` quarantined, `4` empty, `2` excluded, `2` missing) reconcile 1:1.
- **Role and attribution breakdown (`12,532` ready sources).** Roles: `6,461` `transcript`, `4,526` `summary`, `1,507` `document`, `38` `qa`. Attributions: `6,071` `original_unknown`, `4,272` `unverified_transcript`, `2,153` `automatic_unverified`, `36` `machine_unverified`.
- **Canonical equivalence collapse.** `1,436` same-`(work, role)` equivalence groups (`1,424` archive triples, `8` `local-asr` triples, `4` `podcast-asr` triples) collapsed `2,872` redundant representations (`1,436` `.txt`, `1,424` archive `.md`, `12` `.vtt`) to their `.srt`/`.str` canonical representatives (`12,532` sources -> `9,660` canonical indexed sources). All `55` cross-work body-duplicate groups (including `10` exact raw-byte duplicates across distinct works) stayed separate works.

## Full-corpus build, validation, and capacity facts

Host: macOS arm64 (`16 GiB` physical RAM, `37 GiB` free disk before full build, `rustc 1.93.0`, `Python 3.14.3`). These are single-run capacity feasibility measurements, not comparative performance benchmarks.

- **Ascending feasibility samples.** `50` works (`86` sources, `56` canonical, `8,214` passages, `6,882` cues): `clec-publish` `5.40 s`, `83.3 MB` max RSS; `clec sync` `2.68 s`, `80.5 MB` max RSS; `0` errors. `500` works (`740` sources, `572` canonical, `15,360` passages, `121,278` cues): `clec-publish` `11.61 s`, `106.9 MB` max RSS; `clec sync` `5.96 s`, `95.8 MB` max RSS; `0` errors.
- **Full-corpus build and sync (`clec-native-v2`).** `7,507` works, `12,532` sources, `9,660` canonical sources, `12,522` blobs, `77,099` passages (max length `2,000` Unicode scalars, `0` over cap, `0` passages on non-canonical sources), `1,321,134` cues, `17,972` inventory items.
- **Artifact footprint and SHA-256.** Uncompressed `corpus.sqlite`: `1,058,467,840` bytes (`5b14d29d703806cf9710b527425afdb43e833f33f8f30ab3c28b70f835114cb5`); compressed `corpus.sqlite.zst`: `327,255,557` bytes (`a26dc28d1934f990c212233bc5f77c194a614d13a705df9c57890bec416b678c`).
- **Full-run resource usage.** `clec-publish`: `121.97 s` wall (`96.03 s` user, `11.00 s` sys), `478.2 MB` max RSS (`478,150,656` B), `0` errors. `clec sync`: `64.41 s` wall (`51.26 s` user, `5.54 s` sys), `570.1 MB` max RSS (`570,130,432` B), `0` errors. `35 GiB` disk remained free after completion.
- **Full CLI smoke and root immutability.** `status`, `search` (`0050`, `QQQ`, `4%`, `退休 資產配置`), `read p_... --context 1`, `read s_... --original` on both canonical `.srt` and non-canonical `.txt` `SourceId`s, `sources --canonical-only`, and failed-sync rollback preservation all passed on `.cache/phase2/full-data`. All `14` baseline input SHA-256 digests under `/Users/century/vibing/clec` matched unchanged after completion.

## Verification summary

- `cd native && cargo fmt --check`: pass.
- `cd native && cargo clippy --locked --all-targets -- -D warnings`: pass.
- `cd native && cargo test --locked`: `25` of `25` unit tests pass.
- `cd native && cargo build --release --locked`: pass (`clec` SHA-256 `806142ad7423d90071b6b2f76feb9387c44af7027f6bd368ba3a725d3e728a2f`, `clec-publish` SHA-256 `e3c11aecb0e3d522a793f09b7442ed6575c29c751045a4040abd166acfc04bda`).
- `python3 evaluation/clec-v1/phase2/verify_phase2.py --clec native/target/release/clec --publish native/target/release/clec-publish --report .cache/phase2/verify-phase2-report.json`: `8` of `8` blackbox suites pass.

## Known limitations

- Phase 2 verifies corpus construction, conservative identity/equivalence rules, provenance retention, and bounded-memory validation; full-corpus retrieval quality evaluation belongs to Phase 3.
- HTTP manifest/artifact bootstrap (Phase 4), SAG2 synthesis (Phase 5), and cross-OS Linux/Windows verification (Phase 6) remain unimplemented and out of scope.
- `evaluation/clec-v1/verify_phase1.py` pins `clec-native-v1` schema strings and uncollapsed `00318`/`00575` counts from Phase 1; Phase 1 behavioral regressions are verified under `clec-native-v2` by `native/` unit tests and `evaluation/clec-v1/phase2/verify_phase2.py`.
- Independent Astra acceptance review of the final committed head is pending parent-thread coordination.
