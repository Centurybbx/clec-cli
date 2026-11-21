# Stage 0 local baseline, 2026-11-20

The current CLEC CLI ran offline against the full local corpus. The development baseline reproduced the earlier 32 KiB results. Independent holdout acceptance is pending. Stage 1 delivery and development regression can proceed on this index.

## Inputs

| Input | Identity |
| --- | --- |
| Checkout | `adea5adc2817c57c0514d864a499d00c0880e3da`, plus the four pre-existing edits in Phase 5 protocol and SAG2 code and tests. The existing tracked patch SHA-256 is `03cf517bf78775820e1edac80f13dfa7224a43b5b9d785c7a5ed88b331658d92` for `git diff --no-ext-diff --binary`. |
| Toolchain | macOS arm64, Rust 1.93.0, Cargo 1.93.0, Python 3.14.3. Offline, locked release build. `native/Cargo.lock` SHA-256 `200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda`. |
| CLI | `clec 1.0.0-dev.0`, SHA-256 `14c34a9a049770b76b51a994d3f3501748b6fe7d3af6aa9257a74dac981a12b6`. All retrieval was local lexical search. |
| Snapshot | `clec-native-v2`, 1,058,467,840 bytes, SHA-256 `5b14d29d703806cf9710b527425afdb43e833f33f8f30ab3c28b70f835114cb5`. Read-only queries counted 7,507 works, 12,532 sources, and 77,099 passages. |
| Retained release | `.cache/clec-local-verification/release/manifest.json`, SHA-256 `f93650ebb3e8532d25948fe12b93b18c650cfc296d294222e22c097841b1dbbf`. Adjacent `corpus.sqlite.zst`, SHA-256 `a26dc28d1934f990c212233bc5f77c194a614d13a705df9c57890bec416b678c`. The cached active snapshot was reused. |
| Phase 3 development | `.audit/phase3-frozen-v1/development.dataset.json`, SHA-256 `2a5515b831c8d64dda7e7e2c9cb651ecd00d3acb8ba8404590ce4d402b61d72c`. 20 scheduled, 18 answerable, two insufficient-evidence questions. |
| Route regression | `.audit/sag2-clec-benchmark/adjudicated-labels.json`, SHA-256 `2eef235c74e06243c4da816fd46e894787d63b9f7981c0b628668234d3fcbd0a`. Six answerable development cases. |

## Observed results

| Phase 3 profile | Complete chains | Conditions | Counterexamples | CLI errors | Search replies with omissions | Batch read delivered every requested ID |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 KiB search | 5/18 | 1/4 | 2/2 | 0 | 11/20 | |
| 32 KiB search and read | 5/18 | 1/4 | 2/2 | 1 | 11/20 | 13/20 |
| 64 KiB search | 7/18 | 1/4 | 2/2 | 0 | 1/20 | |
| 64 KiB search and read | 7/18 | 1/4 | 2/2 | 0 | 1/20 | 19/20 |

First-search argv and captured output matched within each byte-cap pair. The Phase 3 scorer verified all observed successful source spans and found no stdout budget violation. All four profiles failed the critical-condition gate. The two insufficient-evidence cases have no answer judgments.

The 32 KiB searches delivered 2 to 5 hits and reported 23 omitted hits across 11 calls. Six successful reads omitted seven items in total. One read returned `OUTPUT_BUDGET_TOO_SMALL` (P3-D03) and suggested a retry using the `search` command. At 64 KiB that read succeeded with one item and reported two omissions. The two extra complete chains at 64 KiB were already complete in that budget's first search. The experiment changed the output cap and kept the ranker fixed.

On the same 20 questions, every request for 10 and every request for 20 returned CLI exit 2 with `INVALID_ARGUMENT` and `--limit must be 1..=5.` These profiles measure an unsupported request. No top-10 or top-20 retrieval quality estimate is available.

On the six route regression cases, the fresh top-five, 32 KiB local run had zero failed calls, mean evidence recall of 25%, and all obligations covered in 1/6 cases. At k = 1 and 2, complete evidence was 0/6 and mean recall was 8.33%. The scores matched the historical local-output replay, including case-level results. Earlier outputs informed the adjudicated labels. These runs measure development retrieval and byte delivery, with no live Agent answer or Jev measurement.

## Reproduce the runs

Run from the repository root. The cached inputs and private transcripts are local. For the future sealed holdout, use the preserved original executable at `.audit/agent-native-phase0-20261120/clec-14c34a9a049770b76b51a994d3f3501748b6fe7d3af6aa9257a74dac981a12b6` and verify its SHA-256 against the CLI row above before running. Use a fresh private output directory. See the [local verification guide](../../phase3/LOCAL-VERIFICATION.md) for local sync with the retained archive if the active snapshot is missing.

```sh
umask 077
clec_original=.audit/agent-native-phase0-20261120/clec-14c34a9a049770b76b51a994d3f3501748b6fe7d3af6aa9257a74dac981a12b6
shasum -a 256 "$clec_original"
clec_data=.cache/clec-local-verification/data
clec_dev=.audit/phase3-frozen-v1/development.dataset.json
clec_release=5b14d29d703806cf9710b527425afdb43e833f33f8f30ab3c28b70f835114cb5
clec_eval=evaluation/clec-v1/phase3
clec_run=$(mktemp -d .audit/agent-native-phase0-recheck.XXXXXX)

python3 "$clec_eval/verify_local.py" --clec "$clec_original" \
  --data-dir "$clec_data" --dataset "$clec_dev" --output "$clec_run/paired" \
  --baseline .audit/clec-local-baseline

# For the 64 KiB companion, repeat with clec_top_n=3.
clec_top_n=0
python3 "$clec_eval/eval.py" run --clec "$clec_original" \
  --data-dir "$clec_data" --dataset "$clec_dev" --corpus-sha256 "$clec_release" \
  --limit 5 --per-work 2 --match-mode any --max-bytes 65536 --read-max-bytes 65536 \
  --read-top-n "$clec_top_n" --raw-logs "$clec_run/64k-read-$clec_top_n/calls.jsonl" \
  --outcomes-out "$clec_run/64k-read-$clec_top_n/outcomes.json" \
  --output "$clec_run/64k-read-$clec_top_n/report.json"
```

Expect evaluator exit 1 for the recorded Phase 3 gate misses. For the width probes, repeat `eval.py run` with `--max-bytes 32768 --read-max-bytes 32768 --read-top-n 0` and use `--limit 10` or `--limit 20` and new output paths. Inspect the raw stderr for each rejection.

For the fresh route baseline, rerun one offline search per question with `clec --offline --data-dir DIR --json --max-bytes 32768 search --release SHA --limit 5 QUESTION`. Record raw CLI outputs with the [route benchmark observation schema](../../phase3/ROUTE-BENCHMARK.md) and run `score_routes.py`. Use `.audit/sag2-clec-benchmark/jev-pilot-batched/local-observations.json` to replay the historical local results. That file contains offline local commands only.

All run output for this baseline is in `.audit/agent-native-phase0-20261120/`. The main receipts are `paired/summary.json`, the two `64k-read-*/report.json` files, `search-10/calls.jsonl`, `search-20/calls.jsonl`, and `six-case-local-fresh.json`. The paired summary SHA-256 is `139d1ff8ff0f6c286670a31c7b863663ff3e8ce46cbea3008c8e47f2d182189b`. The fresh route report SHA-256 is `7de448f9940ded0391de329c7c204e00e3a17c893ca7f620d54c6f305af84d68`.

## Holdout inventory and remaining checks

The read-only inventory checked Phase 3 development gold, the six route labels, Backend E2E development gold and the earlier six-topic discovery inventory. It expanded exclusions through exact paths, content and equivalence hashes, and a conservative CLEC168 site grouping by the first two path components. It matched 4,821 work keys directly and excluded 5,120 after expansion. Independent SQL checks found 10 raw-content hash groups and six equivalence hash groups crossing more than one native work ID. Provenance must extend this grouping.

The screen found 395 provisional documents with local extracted text identical to the snapshot blobs. They comprise 382 Drive extracts and 13 local collection extracts. All 13 local originals were available. Re-running the existing extractors on private copies reproduced all 13 snapshot blobs, with `pdftotext` 26.02.0 for the six PDFs. The two separately downloaded Drive originals checked were outside this shortlist. The Drive shortlist has byte-verified extracts and still needs source-by-source original checks.

The local original inventory includes episode-number and book-family overlaps. The four numbered groups inspected had matches in prior topic discovery under other native work keys. Examples include a book with multiple English editions and related episode slides. The crosswalk records the links for exclusion or review. The provisional counts describe available material before full family and exposure review.

The private receipts are `document-source-candidates.json`, `local-originals-receipt.json`, and `local-episode-crosswalk.json`. The existing Backend E2E holdout and prior Phase 3 evaluation questions and labels stayed unopened. A custodian still needs to clear overlap against those sets and other tuning exposures, check semantic work-family links and provenance, and have an independent annotator and reviewer seal new questions and exact spans. Then validate the sealed data and capture the pre-change baseline under the [Stage 0 protocol](PROTOCOL.md). This run froze zero new independent holdout cases.
