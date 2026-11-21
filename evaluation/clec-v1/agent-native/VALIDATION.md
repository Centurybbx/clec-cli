# Agent-native local validation, 2026-11-21

The local host, index, and packaging checks passed on macOS arm64, and the authorized 8-call synthetic Jev calibration completed. Independent holdout quality acceptance and live real-corpus Jev evaluation remain open. The original full-hit CLI and active snapshot are retained. The rebuilt corpus is active only in its private test directory.

## Agent host

The sibling `clec-agent-native-offline-v1` profile uses a real Pi 1.5.2 process, the candidate native binary, a synthetic local corpus, and the existing IPv4 loopback fixture. The seven provider requests observed five native invocations. The 20-lead search used 9,710 bytes and the timeline read used 21,261 bytes. The validation compares the exact native output with the tool messages arriving at the next provider request. It also checks wrong-release rejection, byte-exact retries, cue times and source slices, input bounds, and the binary and corpus pins.

Run from the repository root with a fresh private output directory.

```sh
node evaluation/clec-v1/agent-native/host/verify.mjs \
  .audit/agent-native-host-recheck \
  "$HOME/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
```

The receipt is `.audit/agent-native-host-20261121-current/receipt.json`. The profile reuses the public fixture boundaries, including the 16 MiB corpus cap. It verifies delivery with a scripted provider. The old Stage 6B host files, configuration, and evidence keep their original pins.

## Index and source identity

New releases use `opencc-tw2s-nfkc-lower-morphology-v2`. Repair the OpenCC outputs `什幺` and `怎幺` after conversion, without changing literal `幺` in text such as `我要幺鸡`. The CLI selects query and expansion normalization from the opened snapshot. The publisher and structural validator use the same revision for postings. Sync rejects a manifest that claims a different revision from its database and keeps the previous active pointer. The same check applies when dry-run sees that release already active.

The private full rebuild is `.audit/agent-native-morphology-final-20261121.CL3olU`, release `3becdd9f615a2e095a70fd402c88a9b748725166ea420c0ad1c03409067937b4`. Rebuilt and original citation tables had zero row differences across works, sources, canonical mappings, passages, spans, cues, inventory, and blob hash and length. All 20 development labels validated on both releases. The original active pointer and SQLite SHA-256 matched the before-run hashes. On the rebuilt corpus, `什么`, `什麼`, and `什幺` produced identical query terms and ordered passage IDs. The corresponding control on the legacy snapshot still distinguishes them.

Intake accepts an optional work `family` with an explicit `key` and `provenance`. The saved publisher navigation supplies a hash-bound family mapping for 49 works in the CLEC Wisdom book. Work IDs, edition source IDs, canonical equivalence, and passage coordinates stay separate. Unknown relationships have no family key. Long work keys are omitted from search leads when they exceed the display budget. Read retains the exact key. The production ranker still uses its original work-ID diversity behavior.

```sh
python3 evaluation/clec-v1/agent-native/index/verify_index.py .audit/agent-native-index-recheck
python3 evaluation/clec-v1/agent-native/ranking/verify_fusion.py
```

The index check verifies two deterministic builds against authored title and body postings. It also exercises Chinese spellings, financial token boundaries, full citation text, edition IDs, active-release mismatch rejection, BM25 ties, fusion, and diversity backfill. The independent fusion control reproduces the RRF cross-coverage case. Two rank-50 hits contribute `2/110`, above one rank-1 contribution of `1/61`. The round-robin prototype gives each query a first turn, skips already returned IDs, and ignores duplicate lanes. Default policy and quality comparisons still require an independent evaluation.

## Jev request planning

Every Jev model has the same wire limits. Each request can carry up to 32 questions and 65,536 bytes of serialized UTF-8 JSON. The canonical header block is capped at 8 KiB and the response at 128 KiB, with one overflow byte observed. At most four requests run concurrently. Every batch in a round sends the full seed set. A singleton that exceeds an admission limit fails before any request for its round.

The default `typesafe/jev-1.14` and exact `typesafe/jev-1.14-20261014` use body-bounded admission. The eight saved synthetic calls requested `typesafe/jev-1.14` and resolved to the dated model. The non-blocking batch forecast `ceil(2 * body_bytes / 5) + 42 * question_count + 4` estimates combined input and output tokens for accounting; three of the eight synthetic calls slightly exceeded this forecast (for example, 1,947 observed vs 1,848 forecast on `s0-q1`), confirming that the 8 synthetic samples provide an informational forecast rather than a universal token upper bound across all text or models. It is separate from reported provider usage and the wire caps. See `.audit/jev-synthetic-calibration-20261121/requests.jsonl`.

All other requested IDs, including the moving alias `~typesafe/jev-latest`, also enforce a conservative byte bound. The planner charges twice the sum of shared JSON bytes, question JSON bytes, and a 4,096-byte allowance. It caps the result at 32,000 units per singleton and 64,000 per batch. Boundary tests cover 65,536 and 65,537 body bytes and 32,000 and 32,002 conservative units.

The previous full-context binary rejected all six development cases at second-round admission. The first rejected singleton in each case used 31,655–35,898 body bytes and 71,394–79,880 conservative units. See `.audit/agent-native-jev-replay-final-20261121/report.json`.

The calibrated replay completed both rounds for all six development cases against a constant-score loopback. All 70 Round 1 batches carried ten seeds. No case omitted context, every batch carried wire model `typesafe/jev-1.14` with `limits.admissionPolicy == "calibrated_jev_1_14_body_bounded"`, and the largest body was 65,529 bytes. The moving-alias control (`~typesafe/jev-latest`) stopped after Round 0 at 79,880 conservative units for a 35,898-byte singleton with zero seeded requests. See `.audit/agent-native-jev-replay-calibrated-v2-20261121/report.json` and `.audit/agent-native-jev-replay-calibrated-v2-20261121/uncalibrated-alias-control.json`. The replay checks request planning under synthetic scores. Ranking quality remains outside its scope.

The historical pilot audit retains numeric fields only. The native smoke recorded 4,257 body bytes, 1,616 input tokens, and 44 output tokens. Four completed native searches reported 130 successful calls, 3,405,981 request-body bytes, 1,195,194 input tokens, and 34,000 output tokens. These run totals cannot identify the highest-usage call. The old Python request shape supports a cost forecast of 0.368 input tokens per compact JSON byte and 22.17 output tokens per question. A separate 43-call archive gives a 4.5% median and 24.9% worst input error. That shape and its recalculated compact bytes do not establish a safe admission threshold for the current native payload.

```sh
python3 evaluation/clec-v1/agent-native/sag2/pilot_usage.py \
  --pilot .audit/sag2-clec-benchmark/jev-pilot-batched \
  --fit-archive .cache/research-comparison-v2/runs \
  --validation-archive .cache/retrieval
```

Historical pre-calibration plan (executed across 8 of 12 authorized synthetic calls in `.audit/jev-synthetic-calibration-20261121/requests.jsonl`; 4 synthetic calls remain unused by default): cross zero and ten seeds with one and several questions on non-sensitive fixtures against a pinned model, record final body bytes, shared and question JSON bytes, actual provider model, and per-call reported usage, and exercise independent near-body-cap cases while keeping the 65,536-byte cap and full seed set in force. Any live real-corpus Jev evaluation, release publication, or active index switch requires separate explicit authorization.

## Holdout and local package

The independent custodian checked the four remaining local originals and the historical Phase 3 material. The local checks found zero known overlaps, but family overlap remains unknown. The Backend E2E protocol reserves the sealed material for its final evaluator. That evaluator needs to return overlap-only decisions for proposed families and each applicable evidence route. A source owner needs to resolve the two possible Drive derivative links and provide the first publication and edition provenance. Prior custodians need to confirm manual tuning and adjudication exposure. No new case was sealed or scored. The owner-only record is `.audit/agent-native-holdout-review-20261121/custodian-receipt.json`.

The inspected darwin-arm64 package was staged and installed with npm offline in a private prefix. The installed binary and Skill matched the staged inputs, and the installed CLI returned 20 leads on the rebuilt local release. Other target tuples, independent Agent answer quality, and live Jev performance remain outside this local receipt.
