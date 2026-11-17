# Stage 5 Native SAG2 Implementation Report

Stage 5 adds explicit `clec search --sag2` retrieval (`sag2_native_v1`) using a shared bounded HTTP worker (`http_transport.rs`), strict Jev Decisions wire validation (`sag2/jev.rs`), one local lexical expansion round, greedy Cholesky DPP top-10 ranking, native raw-blob rematerialization, tagged mode output, and whole-item output budgeting. Default `clec search`, corpus format `clec-native-v2`, Stage 4 static distribution policy, and Stage 3 quality findings remain unchanged.

## Gate status

1. **Mock contract gate (`MOCK_CONTRACT_COMPLETE`).** Tested code commit `4e5303189beced665c1d3972190827a2d7a4e6c5` stacked on accepted base `3efbc4cfe447040ffba830b59fa99969c45a0ae1` passes all 53 library unit tests, 1 `clec-publish` unit test, all 10 shipped real-CLI protocol groups in `native/tests/sag2_protocol.rs` (both debug and `--release`), all 11 `test-hooks` real-CLI protocol checks (including `clec_test_fixture` DNS/setup/cleanup stalls and local CA TLS/SNI), 5 Phase 2 capacity tests, 20 Phase 3 synthetic tests, 10 Phase 2 blackbox checks, 9 Phase 4 matrix groups (including the 30-second shipped stall), and 7 DNS/proxy/cleanup regressions. This is a mock contract gate only and awaits independent review.
2. **Live provider gate (`OPEN`).** `schema.providerVerified` remains `false`. Live OpenRouter/System One endpoint availability, account entitlement, default `~typesafe/jev-latest` alias resolution, actual provider tokenizer counts, pricing, and billing behavior remain unverified. No live API calls or real credentials were used.
3. **Production endpoint and retrieval quality gates (`OPEN`).** `BUILTIN_DEFAULT_MANIFEST_URL` stays `None` (`schema.defaultConfigured` is `false`). Stage 3 quality gate (`FAILED`/`open`) and Stage 6 host answer quality remain separate open gates. No private Phase 3 data or heldout benchmarks were read.
4. **Platform and MSRV scope.** Verified on macOS arm64 with Rust `1.93.0`. Actual Rust `1.89.0` execution and non-macOS targets remain unverified (`rust-version = "1.89.0"` and `Cargo.lock` are unchanged).

## Architecture and intentional adaptations

- `native/src/http_transport.rs` extracts the bounded detached HTTP worker (`HttpRequest`, `TransferLimits`, `TransferEvent`, `RemoteTransfer`, `WorkerSession`, `WorkerContext`, `WorkerResponse`, `TransportFailure`, and gated `TestTransferHooks`) shared by `distribution.rs` GET sessions and `sag2/jev.rs` single-POST sessions without plugins, traits, or async application runtimes.
- `native/src/retrieval.rs` extracts `collect_rrf_candidates`, `materialize_passage_hit`, and `apply_work_diversity_indices` so default `execute_search` and `sag2` share the exact local candidate and raw-blob materialization path.
- `native/src/store.rs` adds scoped SQLite read snapshots (`BEGIN DEFERRED` / `ROLLBACK`), deadline `progress_handler` interruption (using existing `rusqlite` `hooks` feature with zero `Cargo.lock` diff), `passage_count`, `body_term_document_frequency`, and `query_bm25_candidates_excluding`.
- `native/src/sag2/jev.rs` enforces target-bound credential precedence (`--key-file` > `OPENROUTER_API_KEY` for `openrouter.ai`, `JEV_API_KEY` for custom targets without fallback), HTTPS or literal-loopback-IP endpoint validation with `/systemone` normalization, strict duplicate-key/trailing-data/closed-`noul` JSON parsing, no redirects, zero retries, whole-record seed prefix packing (`contextOmittedCount`), conditional byte-token admission (`32,000`/question, `64,000`/batch, `4,000,000`/run), and byte/attempt/deadline bounds (`8 KiB` headers, `64 KiB` request, `2 MiB` total request, `128 KiB` response, `4 MiB` total response, `32` attempts, `5 s` connect, `20 s` request, `90 s` run).
- `native/src/sag2/mod.rs` implements `sag2_native_v1` with intentional adaptations from the Python reference: one expansion round (maximum 2 scoring rounds, 100 initial candidates, 10 seeds, 20 local expansion terms, 100 new expansion candidates, 115 second-round pool, 215 scored occurrences, 24 SQL candidate queries, 4,096 distinct DF lookups), native OpenCC/jieba lexical tokenization, stable UTF-8 lexical term tie breaking, greedy Cholesky DPP over top 10, and genuine `rrfScore` provenance kept separate from `jevScore`.
- `native/src/cli.rs` and `native/src/domain.rs` add pre-bootstrap `SearchMode` authorization (`--offline --sag2` conflict at exit 2), tagged `SearchOutput` (`mode: "local"` vs `"sag2"`), `SchemaData.phase = "phase5"` with `providerVerified: false`, redacted `Sag2ErrorContext` counters on errors, and exit mapping (`2` config/offline/budget, `3` no data, `4` transport/status/timeout, `5` invalid response/integrity, `1` internal).

## Measured artifacts and verification (`4e5303189beced665c1d3972190827a2d7a4e6c5`)

| Artifact | SHA-256 |
| --- | --- |
| `native/target/release/clec` | `1f56d7bf3a943f70b95b9e120e45ab41e6eff4febacba4f7c12e1441bbbc2191` |
| `native/target/release/clec-publish` | `9ff917c977325089f992a7840151329ef3a9c5733c36e4912cec4a3b6f69de40` |
| `native/target/release/clec-validate` | `8ea4596a2d9e4a1143a6a0fda1f4ba8ea579f60da6265eb3f03e8a4a3e2ef8b1` |
| `native/target/release/examples/clec_test_fixture` | `c1e387ed2043961e0d28c722ee4e89a1899e0fec3c18a6dab0c5abb97ed150f8` |

- `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo clippy --locked --all-targets --features test-hooks -- -D warnings`: passed.
- `cargo test --locked`: passed (`53` library tests + `1` `clec-publish` test + `10` real-CLI `sag2_protocol` groups = `64` tests).
- `cargo test --release --locked --test sag2_protocol`: passed (`10/10` real-CLI groups on release binary).
- `cargo test --locked --features test-hooks --test sag2_protocol`: passed (`11/11` checks including `clec_test_fixture` DNS/setup/cleanup stalls and fixture-CA TLS/SNI).
- `python3 -m unittest discover -s evaluation/clec-v1/phase2 -p 'test_*.py' -v`: passed (`5/5`).
- `python3 -m unittest evaluation/clec-v1/phase3/test_phase3.py -v`: passed (`20/20` synthetic tests).
- `python3 evaluation/clec-v1/phase2/verify_phase2.py`: passed (`10/10` blackbox checks, with Phase 5 schema/SAG2 assertions updated).
- `python3 evaluation/clec-v1/phase4/verify_phase4.py`: passed (`9/9` real-binary matrix groups including 30-second shipped stall, with schema phase assertion updated to `phase5`).
- `python3 evaluation/clec-v1/phase4/verify_dns_deadline.py`: passed (`7/7` DNS/proxy/setup/cleanup regressions).
