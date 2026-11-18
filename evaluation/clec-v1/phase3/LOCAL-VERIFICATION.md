# Verify CLEC on this Mac

Use the native release binary, a synced full corpus, and a labeled Phase 3 development dataset that names that corpus hash. This exercise uses real CLEC text and CLI output. It measures evidence retrieval and expansion under the Agent host's 32 KiB per-call cap.

## Run the development checks

Build the current checkout and run both profiles from the repository root. The paths below use the local full-corpus copy and the retained development dataset. Use a new output directory for each run.

```sh
cargo build --manifest-path native/Cargo.toml --locked --release --bin clec
python3 evaluation/clec-v1/phase3/verify_local.py \
  --clec native/target/release/clec \
  --data-dir .cache/clec-local-verification/data \
  --dataset .audit/phase3-frozen-v1/development.dataset.json \
  --output .audit/clec-local-baseline
```

If you need to set up a new machine-local data directory, run `clec --offline --data-dir DIR sync --manifest LOCAL_MANIFEST` with the retained archive and its manifest. Use the matching development labels or revalidate them against the new snapshot with `eval.py validate-dataset`.

The first profile runs the original question as one search. The second repeats that search and requests one `read --context 1` for up to three of its returned passages. Both use offline CLI calls and the same 32 KiB search cap. The comparison requires matching first-search argv and output for each question. The Phase 3 scorer verifies the database hash, the labeled quotes, and returned evidence against the original UTF-8 bytes.

Open `summary.json` for the input hashes, counts, and per-question changes. Each profile retains the scorer's full report, raw calls, and replayable outcomes. Exit `0` means both profiles satisfy the Phase 3 gates. Exit `1` means reports are available and at least one gate failed. Exit `2` means the wrapper could not establish a paired result. Keep the run directory private because calls and labels contain corpus text.

### Compare after a change

1. Rebuild `clec` and repeat the check with a new `--output` and `--baseline .audit/clec-local-baseline`. The script requires the same corpus, dataset, and profile settings. Open `baselineChanges` in the new `summary.json` to find recovered and newly missing obligations, including conditions and counterexamples.
2. For each loss, open the paired `calls.jsonl` records. Check omitted result IDs on search, inspect any read error or partial result, and probe a scoped follow-up against the source. Record the original failing command, the expected source span, and which action recovered it. If you add the case to the development set, verify its labels with `eval.py validate-dataset`.
3. Use `eval.py score-outcomes` to check a saved result without rerunning CLEC. Pass the saved dataset, corpus hash, and the same per-call caps as in the run. Supply `--read-max-bytes 32768` for `search-read`.

## Check a live Agent answer

Start a fresh session with the product [CLEC Skill](../../../cli/skills/clec/SKILL.md), the question, and access to the pinned native binary and local corpus. Keep the labels and previous answers outside its context. Capture each CLI call, stdout, stderr, exit code, and the final answer. Record the model, Skill hash, corpus hash, and output and call limits.

Review the saved answer against the labeled claims and required conditions. Check each quotation against the cited source bytes. For an unsupported or scoped-absence question, check that the answer states what the source cannot establish and that the Agent inspected the specified source or a verified equivalent. A different transcript of the same episode may contain different text.

Keep same-session trials in the development record. Use new held-out questions, frozen scoring criteria, and separate author, runtime, and judge roles for a quality acceptance run. The [Phase 6 host protocol](../phase6/host/PROTOCOL.md) records the existing simulated provider checks.
