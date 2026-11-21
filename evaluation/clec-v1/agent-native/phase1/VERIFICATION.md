# Stage 1 search and read delivery

Stage 1 uses the existing `clec-native-v2` snapshot and ranker. The [Stage 0 protocol](../phase0/PROTOCOL.md) defines how to seal the future holdout and run its original CLI baseline. The 20 Phase 3 development cases and previous pilots remain development material.

## Run the CLI checks

From the repository root, build the candidate and exercise the offline fixture. The fixture uses a temporary corpus to test long titles, escaped characters, UTF-8 excerpts, subtitle coordinates, release pinning, and budget retries.

```sh
cargo build --offline --manifest-path native/Cargo.toml --locked --release --bins
python3 evaluation/clec-v1/agent-native/phase1/test_delivery.py
cargo test --offline --manifest-path native/Cargo.toml --locked \
  --features test-hooks -- --test-threads=1
```

The SAG2 integration suite uses a loopback provider. It verifies 20-lead output, exact budget failure, and snapshot binding alongside the existing Jev batching controls.

## Compare on the existing snapshot

Run both binaries on the [pinned development data](../phase0/BASELINE.md). The script verifies the original source spans, exact UTF-8 stdout sizes, ordered read prefixes, and the snapshot hash. At limit five, it compares the old delivered IDs plus the old budget omissions with the new ordered IDs and requires identical candidate counts. It records the raw offline calls and scores full read evidence separately from the locations and excerpt bytes delivered by search.

```sh
umask 077
clec_original=.audit/agent-native-phase0-20261120/clec-14c34a9a049770b76b51a994d3f3501748b6fe7d3af6aa9257a74dac981a12b6
shasum -a 256 "$clec_original"
clec_delivery_run=$(mktemp -d .audit/agent-native-phase1-recheck.XXXXXX)
python3 evaluation/clec-v1/agent-native/phase1/verify_delivery.py \
  --original "$clec_original" --candidate native/target/release/clec \
  --dataset .audit/phase3-frozen-v1/development.dataset.json \
  --data-dir .cache/clec-local-verification/data --output "$clec_delivery_run/paired"
CLEC_PHASE3_LEGACY_BIN="$clec_original" \
CLEC_PHASE3_LEGACY_PUBLISH=.audit/agent-native-index-20261121.6Wzrl1/legacy-clec-publish \
python3 -m unittest discover \
  -s evaluation/clec-v1/phase3 -p test_phase3.py
```

Keep the report and raw output local. The archived CLEC v1 Phase 1 verifier targets `clec-native-v1`. Run the Phase 2 verifier and Phase 3 full-hit replay tools with the preserved original `clec-native-v2` executable. Use the preserved publisher when the verifier builds a legacy-normalization fixture. The Stage 1 comparison reads indexed coordinates to measure what the returned IDs locate. Only read output counts toward candidate evidence.

## Development results

| Profile | Search leads delivered | Complete chains located by search IDs | Complete chains after the controlled read | Requested read items delivered |
| --- | ---: | ---: | ---: | ---: |
| Original, 32 KiB, limit 5 | 77/100 | 5/18 | 5/18 | 49/58 |
| Stage 1, 32 KiB, limit 5 | 100/100 | 7/18 | 5/18 | 59/60 |
| Stage 1, 32 KiB, limit 10 | 200/200 | 8/18 | 5/18 | 59/60 |
| Stage 1, 32 KiB, limit 20 | 400/400 | 9/18 | 5/18 | 59/60 |
| Original, 64 KiB, limit 5 | 99/100 | 7/18 | 5/18 | 58/60 |
| Stage 1, 64 KiB, limit 5 | 100/100 | 7/18 | 5/18 | 60/60 |
| Stage 1, 64 KiB, limit 10 | 200/200 | 8/18 | 5/18 | 60/60 |
| Stage 1, 64 KiB, limit 20 | 400/400 | 9/18 | 5/18 | 60/60 |

All reads selected up to the first three delivered IDs and explicitly requested one neighbor on each side. Stage 1 preserved every old limit-five candidate ID and its ordering at both caps. The largest 20-lead JSON response on these cases was 13,005 bytes. The single legacy read error at 32 KiB disappeared. Read coverage retained one of four conditions and both counterexamples, the same counts as the original read profiles. The original CLI's 64 KiB search-and-read union covered 7/18 because full search passages were available for citation. The new top-three read covers 5/18. Search excerpts alone displayed zero complete chains at all three widths. This comparison measures deterministic delivery. It leaves Agent read selection and independent answer quality open.

The final private report is `.audit/agent-native-phase1-final-20261120/report.json` with SHA-256 `4f638f13418a1642c86e28e5cf4867b954edde865cefba1b2fde8b70dec28803`. The candidate executable SHA-256 is `e39b7e9ced9bde869f3ff2e1ed97458ae570f4d601fb34e787b134ea197f9b7d`. All 60 Rust library tests, the publisher help test, all 19 mock SAG2 tests, and the three new CLI contract tests passed. Old Phase 3 passed all 23 tests with the preserved executable. The old Phase 2 verifier passed 10 checks with that executable.

## Phase 6 host compatibility

The [Phase 6B proof host](../../phase6/host/PROTOCOL.md) pins a specific installed original CLI and Skill. Its request profile caps search at five, does not expose cues, pins read identity via the host's separate corpus checks, and strips structured retry fields from native errors. The pin and request behavior were checked locally. Stage 1 checks drive the new binary directly. Running the new binary through that host requires a new or revised host profile that binds the new CLI and Skill, exposes 20 leads and cues, adds the read release pin, and delivers bounded retry information. The existing Stage 6B proof profile remains bound to its original artifacts.

The [sibling Agent-native host validation](../VALIDATION.md#agent-host) exercises the new contract without changing the Stage 6B proof.
