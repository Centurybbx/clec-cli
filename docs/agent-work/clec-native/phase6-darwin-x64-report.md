# Stage 6 darwin-x64 Rosetta evidence

Independent review `55f9db75` accepted `88ee6c2e20768ab08a4acab0f819ff0cafc79ea9` for CLEC's x64 archive and offline npm install under Rosetta on an Apple Silicon Mac running macOS 26.4.1 (25E253). Both verification runs recorded `uname -m = x86_64` and `sysctl.proc_translated = 1`. Physical Intel execution and older macOS releases remain open. [Environment observation](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/env-observation.json)

The reviewer independently checked the staged and installed binaries, x64 npm lifecycle, UTF-8 reads, budget behavior, rollback and signal handling. The locked build and 79 Rust test results were inspected from the author receipts. The original author evidence links below resolve in the verification checkout at `/Users/century/.t3/worktrees/clec/t3-ee5bab60-74d5aec69d80962e`. Fresh review evidence is in `/private/tmp/clec-astra-x64.t0yaCLAC/`.

## Build and artifact identity

The production inputs match the assigned base `9a0124487f3fca68e99376646c28ed47874d0c13`. The build used the source export recorded at verifier commit `69440e7539d1ec5b955ab7c674e003738a9813f3`. The original planned base `579ca824b943694fc333e149f3d57e10eba69ac4` has byte-equivalent `native/`, `cli/`, and `tools/`. The Cargo.lock SHA-256 is `200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda`. [Source and build observation](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/cross-build-observation.json)

Run the verifier from the worktree root. It creates a new output directory and prints its path.

```sh
python3 -B -m unittest discover -s evaluation/clec-v1/phase6/platform/darwin-x64 -v
python3 -B evaluation/clec-v1/phase6/platform/darwin-x64/verify_darwin_x64.py
```

The run used the arm64-host Rust 1.89.0 compiler `29483883e`, Xcode SDK 26.4, and a separate Cargo target directory. Cargo used two jobs, offline dependency resolution, and the locked graph. Rust test execution used two test threads. The release and test commands below ran from the exported checkout. Each command has an argv, exit status, stdout, and stderr record. [Cargo context](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/cargo-context.json) · [Build command](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/build/cargo-release-bins.json) · [Test command](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/tests/cargo-test-x64.json)

```sh
cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --target x86_64-apple-darwin -j 2 --release --bins
cargo +1.89.0 test --manifest-path native/Cargo.toml --locked --target x86_64-apple-darwin -j 2
```

The three retained binaries have thin x86_64 `MH_EXECUTE` Mach-O headers. Their direct dylib dependencies are Security, CoreFoundation, libiconv, and libSystem. The load command `LC_VERSION_MIN_MACOSX` records 10.12 and SDK 26.4. Each binary embeds the x64 target, the locked dependency hash, the Rust 1.89.0 compiler, release profile, and an empty feature set. [Mach-O and library output](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/cross-build-observation.json) · [Embedded build identities](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/darwin-x64-prebuilt-receipt.json)

The reviewed `clec` binary directly imports `SecTrustEvaluateWithError` from Security. The SDK declares the API available from macOS 10.14. The 10.12 load command is a build setting. The compatibility baseline must account for the imported APIs and be verified on the intended macOS version before publication.

All 79 Rust tests passed across five inspected x86_64 test executables. The three run-ownership tests also passed. The lowest free-space sample was 3,546,380 KiB (3.38 GiB). The run retained the binaries and logs before deleting its Cargo intermediates. [Rust results](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/tests/cargo-test-x64.stdout) · [Ownership results](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/run-ownership.txt) · [Cleanup receipt](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/cleanup-receipt.json)

## Packaging and CLI execution

The unchanged stager produced identical files across two partial stages. Only `darwin-x64` was present. The inventory records `complete: false` and `publishable: false`. The schema v2 inspected-prebuilt receipt records `not_verified_unknown` for source and build invocation under the stager's trust model. The separate build observation records this local invocation and binds it to the release binary hashes. Both the tarball and direct consumer archive carry byte-identical copies of the Skill, README, and notices. [Staging summary](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/stage-summary.json) · [Stager checksums](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/staged-1/SHA256SUMS)

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `clec` | 17,108,816 | `ada271927b3f5b23990510cc66ce1b7c0405549559572c2c0220d9170338e24a` |
| `clec-cli-1.0.0-dev.0.tgz` | 8,029,871 | `b4111548f5e37c3825c2476b39b283553e8fae4c17b44de8ed2197c0bf59d0d4` |
| `clec-maintainer-v1.0.0-dev.0-darwin-x64.tar.gz` | 10,893,196 | `ef449bad35410b194f20dec33bd79a0be8259d2eca42df5ac6a8afab6b1754fb` |
| `clec-publish` | 11,221,856 | `1b87683d5726f55c4e00aefa289a2aba0863609735ec8aa60a4220f8c35f5b6c` |
| `clec-v1.0.0-dev.0-darwin-x64.tar.gz` | 8,019,654 | `7592997dc27cc822a7684da00af6b761513b10311f5145640d4b2c8548583c69` |
| `clec-validate` | 10,352,560 | `b16380bb5f490793e0f82ee7587a753b4d9afa5d9af570cae5b183c4f3779a59` |

The actual npm 9.5.0 lifecycle ran with a thin x64 slice of Node 18.14.2, offline mode, and isolated npm config, cache, and home. The prefix contained spaces and Chinese characters. The postinstall reported selecting `darwin-x64`. The command symlink resolved directly to package-local `bin/clec.exe` with the same SHA-256 as the direct archive's executable. Repeat install and uninstall passed. npx also ran offline with an explicit local tarball and retained its Node dependency. [Postinstall log](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/npm-install-global-offline.stdout) · [npx command](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/npx-offline-node-dependent.json)

The installer rejected a bad checksum, an actual ARM Mach-O slice, and the separately built x64 test-hook fixture. Each rejection restored the placeholder. An npm install with disabled scripts left that placeholder, which the observed shell rejected with exit 1. Running the unchanged installer repaired the command. [Checksum rejection](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/checksum.stderr) · [Wrong-architecture rejection](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/wrong-arch.stderr) · [Test-hook rejection](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/test-hooks.stderr) · [Disabled-script execution](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/ignore-scripts-execution.json)

With PATH pointing to a nonexistent directory, the direct and installed commands matched on output and exit behavior for startup, errors, and fixture operations. The x64 publisher and validator produced and validated both public authored snapshots. Search used multiword UTF-8 arguments and preserved argument boundaries. Passage and context spans sliced the original UTF-8 bytes exactly. The source original retained its BOM and CRLF, and every reported literal match mapped back to the original bytes. The 4,000-byte search limit returned 3,242 bytes and omitted 2 whole hits. [CLI receipt](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/darwin-x64-cli.json) · [Validator A](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/validate-release-a.json) · [Validator B](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/validate-release-b.json) · [Fixture hashes](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/receipts/fixture-inputs.json)

A bad manifest checksum left the prior database and active pointer byte-identical. Sync to the valid replacement removed the previous active database and preserved both unrelated test files, including a hash-named SQLite file. A separate legacy directory retained its `current` marker and its files. For SIGTERM and SIGINT, the loopback server observed each invocation's pending manifest request before the verifier sent the signal. Direct and installed processes exited on the same signal with matching output. None wrote an active snapshot in the interrupted directory. [Rollback result](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/status-after-rollback-installed.stdout) · [SIGTERM result](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/SIGTERM-installed.json) · [SIGINT result](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/logs/cli/commands/SIGINT-installed.json)

## Evidence and remaining gates

Earlier attempts remain in their own directories. The draft used publisher flags and a checksum field that differed from the native interface. The diagnostic runs corrected those and established the npx local-tarball and disabled-script checks. The final run used a fresh root from build through execution. The package run covers sequential sync and interruption. Lock contention is covered by the native Rust suite. [Protocol](../../../evaluation/clec-v1/phase6/platform/darwin-x64/PROTOCOL.md) · [UTC audit](../../../.audit/phase6-darwin-x64.tsv) · [Evidence hashes](../../../.cache/phase6-darwin-x64-runs/run-337pggj3/evidence-sha256.txt)

This run establishes the Rosetta execution result for the observed host. Physical Intel and older macOS execution, signing and notarization, release publication, production bootstrap, live Jev, and Stage 6 host-answer quality remain separate gates.
