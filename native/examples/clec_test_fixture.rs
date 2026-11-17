use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use clec_core::cli::{TestFixtureOptions, run_cli_with_test_options};

fn main() -> ExitCode {
    let default_origin = env::var("CLEC_TEST_DEFAULT_MANIFEST")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let connect_timeout_ms = env::var("CLEC_TEST_CONNECT_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let manifest_timeout_ms = env::var("CLEC_TEST_MANIFEST_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let artifact_timeout_ms = env::var("CLEC_TEST_ARTIFACT_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let extra_root_pem = env::var("CLEC_TEST_CA_PEM_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|path| fs::read(&path).expect("fixture CA PEM path must be readable"));
    let resolver_delay_ms = env::var("CLEC_TEST_RESOLVER_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let resolver_delay_host = env::var("CLEC_TEST_RESOLVER_DELAY_HOST")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let setup_delay_ms = env::var("CLEC_TEST_SETUP_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let cleanup_delay_ms = env::var("CLEC_TEST_CLEANUP_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    let hook_log_path = env::var("CLEC_TEST_HOOK_LOG_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from);

    let code = run_cli_with_test_options(TestFixtureOptions {
        default_origin,
        connect_timeout_ms,
        manifest_timeout_ms,
        artifact_timeout_ms,
        extra_root_pem,
        resolver_delay_ms,
        resolver_delay_host,
        setup_delay_ms,
        cleanup_delay_ms,
        hook_log_path,
    });
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
