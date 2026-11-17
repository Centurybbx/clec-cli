# CLEC native evidence CLI (`@clec/cli`)

`clec` searches `clec-native-v2` corpora with BM25 + RRF and reads exact verbatim UTF-8 text and byte spans. The host agent plans queries, follows links, and writes answers.

## Local installation from a staged tarball

Staged npm packages install a native binary into package-local `bin/clec.exe` during `npm install`. After installation completes, `clec` runs without Node.js, Python, or a background server.

```sh
npm install --global /path/to/staged/clec-cli-1.0.0-dev.0.tgz
clec --version
clec schema
clec status
```

Installing with `--ignore-scripts` is unsupported for the aggregate npm package because the shipped placeholder at `bin/clec.exe` requires the `postinstall` verification and copy step. Use the per-target archive (`clec-v1.0.0-dev.0-<tuple>.tar.gz` or `.zip`) when lifecycle scripts are disabled.

No public corpus manifest endpoint is configured (`defaultConfigured: false`, `providerVerified: false`). Obtain a `clec-native-v2` publisher manifest and synchronize explicitly:

```sh
clec sync --manifest /absolute/path/to/release/manifest.json
clec search '退休 提領' --offline
clec sources '退休' --canonical-only
clec read '<PassageId>' --context 1
clec read '<SourceId>' --original --find '每年提領'
```

## Cache directory ownership

Data directory precedence is `--data-dir PATH`, then nonempty `CLEC_DATA_DIR`, then the platform default:

- Unix: `~/.local/share/clec/native-v2`
- Windows: `%LOCALAPPDATA%\clec\native-v2` (with `%USERPROFILE%\AppData\Local\clec\native-v2` fallback)

Commands `schema`, `--help`, and `--version` work without a home directory. Legacy directories containing a `current` marker are rejected before sync mutation; pass a separate `--data-dir` rather than sharing a legacy cache.

## Skill and discovery

The distributable agent Skill lives at `skills/clec/SKILL.md`. Neither `npm` install hooks nor `clec` write into user-global Skill directories automatically. Copy `skills/clec/SKILL.md` manually into your host Skill directory if desired.

## Staged local packaging and maintainer binaries

Run a controlled build and capture a bound `clec-controlled-build-receipt`, or inspect prebuilt binaries into a `clec-inspected-prebuilt-receipt` without promoting unverified git or command strings, then stage archives and the npm tarball into a new directory:

```sh
node cli/scripts/build-receipt.mjs --tuple darwin-arm64 --target-dir native/target --run-build --toolchain 1.89.0 --out /path/to/darwin-arm64-receipt.json
node cli/scripts/build-receipt.mjs --tuple darwin-arm64 --target-dir .cache/stage6a-v2/target-msrv --toolchain 1.89.0 --cargo-lock native/Cargo.lock --out /path/to/darwin-arm64-prebuilt-receipt.json
node cli/scripts/stage.mjs --input /path/to/inputs.json --output /path/to/staged --allow-partial
npm test --prefix cli
```

Use `--allow-partial` only for local non-publishable staging when fewer than all five target tuples (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`) are present. Production staging rejects incomplete inventories, dirty git trees on controlled builds, test-hook binaries, interpreted ELF binaries in `musl-static` slots, legacy v1 receipts, or inputs without matching build receipts and executable headers. Inspected-prebuilt receipts verify executable headers and embedded compile metadata (`target`, `profile`, `features`, `rustcVersion`, `cargoLockSha256`) against exact payload bytes while keeping unestablished build source and command fields as `not_verified_unknown`. Unsigned local receipts do not authenticate a remote publisher, prove full hermeticity, or certify execution on unexecuted target OSes.

Maintainer corpus tools (`clec-publish` and `clec-validate`) ship in separate maintainer archives and are excluded from consumer packages. Recorded repository metadata (`Centurybbx/clec-cli`) and distribution licensing remain unverified for public release.
