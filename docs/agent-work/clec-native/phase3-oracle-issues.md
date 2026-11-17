# Phase 3 oracle execution integrity issues and verification

Base commit `d2b62ea20313f99484a033b44f184532e0eeda76` had five confirmed gaps in the Phase 3 evaluation oracle.
This report records each before-fix failure, the structural fix, and the synthetic verification receipts.
All checks in this round ran against synthetic fixtures only.
Real dataset scoring remains unexecuted pending independent review.

## Repeated premise and domain boundary

Prior revisions trusted the outer outcome `status` string, file presence on disk, Python default `str.isspace` and `text=True` subprocess assumptions, and raw query list length.
We replaced those boolean checks with typed structural boundaries.

1. `evaluation/clec-v1/phase3/score.py` models each step as `CompletedStep` or `FailedStep`, then derives either `ScoreableExecution` or `NonScoreableExecution`.
2. `evaluation/clec-v1/phase3/score.py` models active data-directory coherence once in `ActiveCorpusBinding` and `verify_active_corpus_binding`.
3. `evaluation/clec-v1/phase3/adapter.py` captures raw subprocess `bytes`, decodes strictly as UTF-8 without newline translation, and emits `stdoutUtf8: null` with `stdoutDecodeError` when bytes are undecodable.
4. `evaluation/clec-v1/phase3/projection.py` matches Rust `char::is_whitespace` (`25` Unicode `White_Space` codepoints) and Rust `str::lines()` and timestamp parsing in `native/src/ingest.rs`.
5. `evaluation/clec-v1/phase3/bench.py` determines comparison eligibility from distinct effective query term sets reported by `clec search`, after a deduplicated raw-query pre-check.

## Issue resolution log

### 1. Execution boundary on failed, timed-out, and incoherent steps

**Before.** `_parse_step_payload` returned `(None, stdout_bytes, stderr_bytes, None)` whenever `timedOut` was true or `exitCode != 0`. A valid `search` step followed by a failed or timed-out `read` step with outer `status: "completed"` produced `evidenceCoverage: 1.0`, `completeChain: true`, and `conditionLoss: 0`.

**Fix.** `_parse_step_payload` returns `FailedStep` for timeouts, nonzero or missing `exitCode`, incoherent `timedOut=true` with `exitCode=0`, undecodable output, or invalid JSON envelopes. `_derive_execution_outcome` checks every step against outer `status` and constructs `NonScoreableExecution` whenever any step failed, timed out, had undecodable bytes, or contradicted outer `status`.

**Verification.** `test_execution_boundary_rejects_failed_timedout_and_incoherent_steps` and `.audit/phase3-after-receipts.json` confirm failed and timed-out supplemental `read` steps under both honest and forged outer `completed` status produce `status: "error"`, `evidenceCoverage: null`, `completeChain: null`, `conditionLoss: null`, and `verdict: "inconclusive_errors_present"`.

### 2. Active corpus coherence across all evaluation commands

**Before.** `eval.py validate-dataset` and `eval.py score-outcomes` opened `<corpus_sha256>.sqlite` directly without checking `active.json`, and `adapter.verify_active_corpus` skipped checking `active.json` when missing. A temporary data directory with `active.json` release `0000...0000` passed `validate-dataset` (`valid: true`) and `score-outcomes` (`verdict: "complete"` with all gates true).

**Fix.** `CorpusIndexView.open_active` calls `verify_active_corpus_binding` to enforce regular `active.json`, valid `release` matching `corpusSha256`, non-empty `manifestPath`, regular `<release>.sqlite`, and streaming SHA-256 verification before loading metadata. `eval.py validate-dataset`, `eval.py run`, `eval.py score-outcomes`, `adapter.verify_active_corpus`, and `bench.py` all share this verifier without requiring a `clec` binary for standalone commands.

**Verification.** `test_active_corpus_coherence_across_validate_run_and_score_outcomes` confirms all-zero `release`, missing `active.json`, malformed JSON, and directory-obstructed `active.json` fail across `validate-dataset`, `score-outcomes`, and `run`, while relocated directories with a removed external manifest directory still validate per the supported lifecycle in `native/src/snapshot.rs`.

### 3. Rust Unicode whitespace and extraction parity

**Before.** `projection.py` used Python `str.isspace()`, `splitlines(keepends=True)`, and a strict `HH:MM:SS` regex. On `"alpha\u001cbeta"`, Python treated `U+001C` as whitespace while Rust `char::is_whitespace` did not, producing equivalence hash `6678d3d1...` instead of native `380626aa...` and raising an uncaught `ValueError` during empty-search scoring.

**Fix.** `projection.py` uses `RUST_WHITESPACE_CHARS` (the exact `25` scalar values matching Rust `char::is_whitespace`), splits lines only on `\r\n` and `\n`, and ports `parse_timestamp_ms` and `is_archive_md_ts_header` from `native/src/ingest.rs`. `score_question` catches `ProjectionVerificationError` per question and records `status: "inconclusive"` with explicit `stopReason` instead of aborting the run or awarding fake credit.

**Verification.** `test_unicode_whitespace_and_projection_parity_with_native_corpus` publishes `plain_text`, `subtitle_cue_payload` (`.srt` and `.vtt`), and `archive_voice_note_md` fixtures containing `U+001C` through `U+001F`, `U+0085`, `U+00A0`, `U+2028`, `U+3000`, BOM, CRLF, bare `\r`, and `MM:SS.mmm` headers through `clec-publish` and asserts exact `equivalenceHash` parity on every source, plus per-question `inconclusive` isolation on hash corruption.

### 4. Subprocess raw byte capture and strict UTF-8 decoding

**Before.** `adapter.run_clec_command` used `subprocess.run(..., text=True)` with universal newline translation and `errors="replace"` on timeout. A subprocess emitting `56` bytes with `\r\n` collapsed to `54` UTF-8 bytes, and a timed-out subprocess emitting partial UTF-8 bytes `\xe4\xb8` replaced them with `U+FFFD`.

**Fix.** `run_clec_command` runs in binary mode (`text=False`), decodes stdout and stderr strictly as UTF-8, preserves exact CRLF byte counts, and marks undecodable outputs with `stdout: null`, `stdoutDecodeError`, `stdoutRawByteLen`, `stdoutRawSha256`, and bounded raw base64 bytes. `score.py` keeps the raw quote and provenance audit of all returned items before budget selection.

**Verification.** `test_subprocess_byte_capture_crlf_multibyte_invalid_utf8_and_timeout_partial_bytes` verifies exact `1517`-byte and `56`-byte CRLF retention, per-call and cumulative cap accounting with over-budget quote audit failure, strict rejection of invalid UTF-8 exit-0 output, and `stdout: null` with `stdoutRawByteLen: 7` on a timed-out `b'{"a":\xe4\xb8'` subprocess.

### 5. Distinct effective query plan eligibility in `bench.py`

**Before.** `bench.py` checked only `len(q_rrf) < 2 or q_rrf == q_base`, accepting duplicate queries `["稅務", "稅務"]` as `DISTINCT_QUERY_PLANS` and `valid_interleaved_latency_comparison`.

**Fix.** `bench.py` deduplicates raw query strings first and then inspects the normalized `terms` list returned by warmup `clec search` runs under OpenCC `tw2s`, NFKC, lowercase, and jieba segmentation. Duplicate strings and semantically equivalent rewrites that map to fewer than two distinct effective term sets or match the baseline term set are labeled `IDENTICAL_QUERY_PLANS` with `no_comparison_identical_query_plans`. Timed or warmup errors force `inconclusive_errors_present`.

**Verification.** `test_bench_rejects_duplicate_and_semantically_identical_rewrite_plans` and `.audit/phase3-after-receipts.json` confirm both `["稅務", "稅務"]` and `["稅務問題", "税务问题"]` report `IDENTICAL_QUERY_PLANS` and `no_comparison_identical_query_plans`, while distinct rewrites `["匯回臺灣 稅務問題", "稅務 問題"]` report `DISTINCT_QUERY_PLANS` and `valid_interleaved_latency_comparison`.

### 6. Adapter execution grammar and command-plan binding (follow-up on `b481630`)

**Before.** `_derive_execution_outcome` checked whether each step succeeded, not whether the sequence of steps or their `argv` and declared query plans obeyed the adapter's supported contract. Mutated outcomes with `read_only`, `read_before_search`, `duplicate_search`, `argv=['clec', 'read', 'invented']`, or `status='completed'` paired with `stopReason='read_cli_error:2'` passed `eval.py score-outcomes` with exit code `0`, `verdict='complete'`, `evidenceCoverage=1.0`, and `completeChain=true`.

**Fix.** `score.py` defines typed `SearchCommandPlan` and `ReadCommandPlan` models shared with `adapter.py`, plus `parse_adapter_argv` and `_validate_execution_grammar`. `ScoreableExecution` structurally encodes one `search_step` and at most one `read_step`. Before constructing `ScoreableExecution`, `_derive_execution_outcome` requires `stopReason is None`, an initial `search` step with matching declared `mode`/`queryAngle`/`queries` and `argv`, and at most one `read --context 1` step on a non-empty `search` whose requested and returned `passageId`s bind to `search` hits. Impossible sequences, missing/malformed/mismatched `argv`, and contradictory `stopReason` values remain in the scheduled denominator as `NonScoreableExecution` (`status='inconclusive'`, `evidenceCoverage=null`, `completeChain=null`, `conditionLoss=null`).

**Verification.** `test_execution_grammar_score_outcomes_positives_and_negatives` and `.audit/phase3-execution-grammar-after.json` verify genuine `search`-only, `search` + `read`, keyword-in-query, budget-trimmed `read`, and `rrf_multiquery` positives pass `score-outcomes` with exit `0`, while all `19` negative variants (including `read_only`, `read_before_search`, `duplicate_search`, `contradictory_stop_reason`, and `argv_mismatch`) exit `1` with `verdict='inconclusive_errors_present'`, `scheduledQuestions` preserved, and `null` coverage/chain/loss metrics.

### 7. Scoped type annotation cleanup

**Fix.** Replaced `# type: ignore[assignment]` on `CorpusIndexView._conn` in `score.py` with `sqlite3.Connection | None` and `_require_conn()`. Replaced `# type: ignore[union-attr]` suppressions in `test_phase3.py` with `_CliStepDict` (`TypedDict`).

## Verification summary and supported limits

- `python3 -m unittest discover -s evaluation/clec-v1/phase2 -p "test_*.py" -v` passed `4` tests.
- `python3 -m unittest discover -s evaluation/clec-v1/phase3 -p "test_*.py" -v` passed `16` tests (`15` migrated existing controls plus `1` new `score-outcomes` execution-grammar suite).
- Synthetic CLI end-to-end `validate-dataset`, `run`, and `score-outcomes` passed alongside the `b481630` probe suite (`genuine` complete, all `5` invalid probe variants rejected as `inconclusive` with `null` coverage/chain/conditionLoss).
- Known limits: undecodable base64 capture inside step records truncates at `65536` raw bytes while recording exact `stdoutRawByteLen` and `stdoutRawSha256`; no static type checker (`mypy` or `pyright`) is installed in this environment; real dataset scoring and retrieval quality remain unmeasured.
