# Stage 4 Static Distribution Implementation Report

Stage 4 adds bounded static HTTP/HTTPS package acquisition, cold cache bootstrap, and manifest-only `sync --dry-run` to the native Rust CLI. Retrieval ranking, corpus schema `clec-native-v2`, `--sag2` rejection, and Stage 3 quality findings remain unchanged.

## Gate status

1. **Transport implementation gate (`PASS`).** All Rust unit checks, Phase 2 capacity and blackbox regressions, Phase 3 synthetic harness tests, the real-binary Phase 4 HTTP/HTTPS/offline/bootstrap/dry-run matrix, the 30-second shipped manifest stall test, and the full-corpus local HTTP capacity run passed on the macOS arm64 host.
2. **Production default endpoint gate (`OPEN`).** No authoritative native-v2 static manifest URL exists in the repository record. `BUILTIN_DEFAULT_MANIFEST_URL` stays `None` (`schema.defaultConfigured` is `false`), and unconfigured cold installs return `NO_DATA` with the explicit `clec sync --manifest PATH_OR_HTTPS_URL` remedy. Ordinary default cold search and offline repeat remain unverified until a real static release endpoint is published and built in.
3. **Platform scope.** Verification ran on macOS arm64 (`macOS-26.4.1-arm64-arm-64bit-Mach-O`) with Rust `1.93.0` against project MSRV `1.89.0`. Non-macOS targets remain unverified.
4. **Stage 3 quality independence.** Stage 3 quality gate failures and open issues remain unresolved and untouched.

## Architecture and changes

- `native/src/cli.rs` and `native/src/retrieval.rs` move store-independent validation and search tokenization into `PreparedSearch`, `PreparedRead`, and `PreparedSources` before any cache open or bootstrap.
- `native/src/distribution.rs` owns `ManifestLocation`, `NetworkPolicy`, `TransferPolicy`, `LoadedManifest`, `AcquiredArtifact`, bounded `1 MiB + 1` manifest reads, optional `artifactUrl` resolution, `reqwest` `0.13.5` blocking Rustls transport (`no_gzip`, `no_brotli`, `no_deflate`, `no_zstd`, `Accept-Encoding: identity`, `redirect::Policy::none()`, `retry::never()`), manual 5-redirect traversal with non-downgrade checks, whole-transfer deadlines (`10s` connect, `30s` manifest, `300s` artifact), `localhost` loopback-only resolution verification, URL query redaction in error messages, and drop-guarded `.incoming.zst.tmp` download staging.
- `native/src/snapshot.rs` renames `sync_local_with_prepare` to `sync_with_prepare`, delegates intake to `distribution`, excludes `.incoming.zst.tmp` from projected `storageBytes`, implements lock-rechecked `ensure_current_store` cold bootstrap, and adds manifest-only `sync_dry_run`.
- `native/src/domain.rs` adds `OFFLINE_REQUIRED` (exit 2), `TRANSFER_FAILED` (exit 4), and `TRANSFER_TIMEOUT` (exit 4), and updates remedies for `PATH_OR_HTTPS_URL`.
- `native/src/bin/clec-publish.rs` adds optional `--artifact-url` without changing default publisher output bytes when omitted.
- `native/examples/clec_test_fixture.rs` provides the feature-gated (`test-hooks`) fixture entry point for shortened timeouts, fixture CA trust, and injected default manifest URLs without exposing test overrides in the shipped `clec` binary.
- `evaluation/clec-v1/phase4/PROTOCOL.md`, `evaluation/clec-v1/phase4/verify_phase4.py`, and `evaluation/clec-v1/phase4/capture_http_capacity.py` establish the tracked protocol and rerunnable verification harness. `evaluation/clec-v1/phase2/verify_phase2.py` updates only the expected `phase4` schema and `http_bootstrap` removal assertions.

## Measured artifacts and verification

| Artifact | SHA-256 |
| --- | --- |
| `native/target/release/clec` | `1811aa0d36673961ef9d9b9ea5d9faea92a2c701b76519adf4f69295cdd35f45` |
| `native/target/release/clec-publish` | `37663bfdb7e939ed33f0f60e9cf382e4557c3c46c316a77e40ffbfbf19698cdc` |
| `native/target/release/clec-validate` | `b9871ad6b02dc920d5457716f44493ca273001de5c32c43828d4ea7d97f5e498` |
| `native/target/release/examples/clec_test_fixture` | `e363ffe055425450bc34ab2cc43115e5f71abade3500fc4ea5cee763b63277d3` |

- `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo clippy --locked --all-targets --features test-hooks -- -D warnings`, and `cargo test --locked` passed (`37` Rust tests total). Transitive lock-graph metadata confirms all resolved crates declare `rust-version <= 1.89`.
- `python3 -m unittest discover -s evaluation/clec-v1/phase2 -p 'test_*.py' -v` passed (`5` tests).
- `python3 -m unittest evaluation/clec-v1/phase3/test_phase3.py -v` passed (`20` synthetic tests; no private Phase 3 gold files read).
- `python3 evaluation/clec-v1/phase2/verify_phase2.py` passed (`10/10` blackbox checks).
- `python3 evaluation/clec-v1/phase4/verify_phase4.py` passed (`9/9` real-binary matrix groups, including the shipped 30-second manifest stall check, logged in `.cache/phase4/phase4-matrix-report.json`).
- Single-run local HTTP full-corpus capacity capture (`.cache/phase4/full-http-capacity/receipt.json`, localhost fixture, not a speed benchmark or universal storage bound) fetched `corpus.sqlite.zst` (`327,255,080` bytes, SHA-256 `34a01433e41a7b71e635f4aa1ddac5f6c99a05dcce2a453ae0e9e264a7f73f66`) in 1 manifest GET and 1 artifact GET, validated `1,058,476,032` SQLite bytes (`7e106db6b5f06287d4a8e8d1323af2c5098cc702719f8aa310aa75af8df610a0`), completed in `59.15` wall seconds with `334,774,272` bytes max RSS and `3,001,511,467` logical bytes sampled 50 ms lower-bound peak disk on the 16 GiB RAM host, left final `storageBytes` at `1,058,476,174` with zero temporary files, and returned `5` hits for offline `search 0050`.
