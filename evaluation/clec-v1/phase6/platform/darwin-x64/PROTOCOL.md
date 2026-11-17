# Verify CLEC on macOS x64 under Rosetta

This run builds the three CLEC release binaries with Rust 1.89.0 on Apple Silicon. It verifies the packaged CLI under Rosetta and records the observed macOS version. Physical Intel Macs and older macOS versions require separate execution evidence.

## Run the verifier

Use the assigned worktree based on `9a0124487f3fca68e99376646c28ed47874d0c13`. The production inputs and public fixtures must match that base. The run needs an Apple Silicon Mac with Rosetta, an installed Rust 1.89.0 x64 target, cached Cargo dependencies, an Xcode SDK, and the universal Node and npm under `/usr/local`. Allow room for the build in addition to the 2 GiB free-space reserve.

From the worktree root, run these commands.

```sh
python3 -B -m unittest discover -s evaluation/clec-v1/phase6/platform/darwin-x64 -v
python3 -B evaluation/clec-v1/phase6/platform/darwin-x64/verify_darwin_x64.py
```

The verifier prints an exclusive `RUN_ROOT` under `.cache/phase6-darwin-x64-runs/`. Every attempt gets a new directory. The append-only UTC audit records each phase. Cargo uses the run's target directory, offline dependency resolution, and two jobs. The driver monitors free space during logged commands and stops the owned process group near the reserve. It removes its compilation directory after recording release binaries, build logs, test metadata, and test results.

## What the verifier checks

1. Confirm translated x64 execution and extract a task-local x64 slice of Node. Record macOS, Xcode SDK, compiler, and Node identities.
2. Export and hash the production inputs. Build locked x64 release binaries, inspect the three Mach-O executables and their system-library dependencies, and run the locked x64 Rust test suite. Build the x64 test-hook fixture separately for an installer rejection check.
3. Pass the three release binaries through the unchanged schema v2 receipt and staging scripts. Compare all staged files across two fresh partial stages. Verify the tarball and consumer archive preserve the Skill, README, and notices. The inventory has only `darwin-x64` present and is incomplete and unpublishable.
4. Use the x64 publisher to create snapshots from the authored Linux fixture files. Sync each snapshot with an absent PATH and check the resulting database with the x64 validator. Create a copy of snapshot B whose manifest advertises a bad SQLite checksum.
5. Run npm's actual offline postinstall under x64 Node in a space-and-Unicode prefix with isolated npm configuration. Check that its native command matches the direct archive by SHA-256. Exercise explicit local-tarball npx, repeat install, uninstall, disabled scripts and repair, and rejections for a bad checksum, an ARM Mach-O payload, and a test-hook build.
6. Invoke the direct and installed commands with an absent PATH. Compare outputs and exits for help, schema, status, errors, reuse, UTF-8 search and reads, and budget limits. Compare exact fixture bytes, test legacy cache refusal and preservation, and verify rollback and cleanup when switching snapshots. For each signal, wait for a loopback HTTP request before interrupting the direct and installed sync processes. Compare the signal and captured output.

## Read the evidence

The `receipts/` directory contains environment, cross-build, staging, validator, and installed-command observations. The `logs/` directory contains commands, exits, stdout, and stderr. The `.audit/phase6-darwin-x64.tsv` file has append-only phase results and paths to the attempts. A full run ends with `PASS`.

`darwin-x64-prebuilt-receipt.json` records the binary metadata and hashes under the stager's inspected-prebuilt trust model. Its source and build invocation status fields are `not_verified_unknown`. The separate `cross-build-observation.json` links the locally observed Cargo commands, exported source hashes, and compiler details to the same release binaries. Matching staged hashes establish deterministic repacking of those binary inputs. The deployment load command records the linker's target, and the execution receipts record the observed host.

Publication, physical Intel and older macOS execution, host-answer quality, production bootstrap, and live Jev stay outside this verification.
