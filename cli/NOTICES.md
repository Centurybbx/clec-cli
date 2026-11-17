# Third-Party Notices and Licensing Status

## Repository License Status

No repository-wide open-source distribution license has been confirmed or assigned in this repository. Public redistribution, npm publication, and release hosting remain pending maintainer confirmation of distribution licensing and package ownership.

## Bundled Native Dependencies

Distributed native binaries are compiled from `native/Cargo.toml` and `native/Cargo.lock` and bundle:

- SQLite (public domain, via `rusqlite` with `bundled` feature)
- `rustls` and `aws-lc-rs` TLS stack (no runtime OpenSSL dependency)
- `clap`, `ferrous-opencc`, `jieba-rs`, `reqwest`, `schemars`, `serde`, `serde_json`, `sha2`, `thiserror`, `unicode-normalization`, `zstd`

Inspect `native/Cargo.lock` in the source distribution for exact dependency versions and upstream crate metadata.
