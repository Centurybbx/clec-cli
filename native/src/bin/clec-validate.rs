use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use clec_core::domain::{
    CORPUS_FORMAT, ClecError, DICTIONARY_REVISION, EQUIVALENCE_REVISION, ErrorCode, ErrorEnvelope,
    NORMALIZATION_REVISION, SCHEMA_VERSION, SEGMENTATION_REVISION, TOKENIZATION_REVISION,
};
use clec_core::snapshot::{
    SnapshotValidationReceipt, VALIDATOR_KIND, file_size_and_sha256, validate_sqlite_snapshot,
};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(
    name = "clec-validate",
    version,
    about = "Internal developer validator for clec-native-v2 SQLite snapshots"
)]
struct ValidateCli {
    /// Path to SQLite corpus snapshot to validate without mutating it
    #[arg(long, value_name = "FILE", required_unless_present = "identity")]
    db: Option<PathBuf>,

    /// Emit validator binary and format identity JSON without reading a database
    #[arg(long)]
    identity: bool,

    /// Optional path to write the bound validation receipt JSON
    #[arg(long, value_name = "FILE")]
    out: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatorIdentity {
    schema_version: u32,
    validator_kind: &'static str,
    package_version: &'static str,
    corpus_format: &'static str,
    segmentation_revision: &'static str,
    tokenization_revision: &'static str,
    normalization_revision: &'static str,
    dictionary_revision: &'static str,
    equivalence_revision: &'static str,
    binary_path: String,
    binary_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundValidationReceipt {
    binary_path: String,
    binary_sha256: String,
    #[serde(flatten)]
    snapshot: SnapshotValidationReceipt,
}

fn current_binary_identity() -> Result<(String, String), ClecError> {
    let exe = std::env::current_exe().map_err(|e| {
        ClecError::new(
            ErrorCode::IoError,
            format!("Cannot resolve validator executable path: {e}"),
        )
    })?;
    let canonical = fs::canonicalize(&exe).unwrap_or(exe);
    let (_, sha) = file_size_and_sha256(&canonical)?;
    Ok((canonical.display().to_string(), sha))
}

fn emit_json_and_optionally_write<T: Serialize>(
    payload: &T,
    out_path: Option<&PathBuf>,
) -> Result<(), ClecError> {
    let json = serde_json::to_string_pretty(payload).map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("JSON serialization failed: {e}"),
        )
    })?;
    if let Some(path) = out_path {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                ClecError::new(
                    ErrorCode::IoError,
                    format!("Cannot create receipt parent directory: {e}"),
                )
            })?;
        }
        fs::write(path, format!("{json}\n")).map_err(|e| {
            ClecError::new(
                ErrorCode::IoError,
                format!("Cannot write receipt {}: {e}", path.display()),
            )
        })?;
    }
    println!("{json}");
    Ok(())
}

fn fail_error(err: &ClecError) -> ExitCode {
    let env = ErrorEnvelope::from_error(err, Some("validate"));
    eprintln!("{}", serde_json::to_string(&env).unwrap());
    ExitCode::from(u8::try_from(err.code.exit_code()).unwrap_or(1))
}

fn main() -> ExitCode {
    let cli = match ValidateCli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            if matches!(
                e.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                print!("{e}");
                return ExitCode::SUCCESS;
            }
            let err = ClecError::new(ErrorCode::InvalidArgument, e.to_string().trim().to_owned());
            return fail_error(&err);
        }
    };

    let (binary_path, binary_sha256) = match current_binary_identity() {
        Ok(v) => v,
        Err(err) => return fail_error(&err),
    };

    if cli.identity {
        let id = ValidatorIdentity {
            schema_version: SCHEMA_VERSION,
            validator_kind: VALIDATOR_KIND,
            package_version: env!("CARGO_PKG_VERSION"),
            corpus_format: CORPUS_FORMAT,
            segmentation_revision: SEGMENTATION_REVISION,
            tokenization_revision: TOKENIZATION_REVISION,
            normalization_revision: NORMALIZATION_REVISION,
            dictionary_revision: DICTIONARY_REVISION,
            equivalence_revision: EQUIVALENCE_REVISION,
            binary_path,
            binary_sha256,
        };
        if let Err(err) = emit_json_and_optionally_write(&id, cli.out.as_ref()) {
            return fail_error(&err);
        }
        return ExitCode::SUCCESS;
    }

    let db_path = cli.db.expect("required unless --identity");
    let snapshot = match validate_sqlite_snapshot(&db_path) {
        Ok(r) => r,
        Err(err) => return fail_error(&err),
    };
    let exit_code = match snapshot.error_code {
        None => ExitCode::SUCCESS,
        Some(code) => ExitCode::from(u8::try_from(code.exit_code()).unwrap_or(1)),
    };
    let receipt = BoundValidationReceipt {
        binary_path,
        binary_sha256,
        snapshot,
    };
    if let Err(err) = emit_json_and_optionally_write(&receipt, cli.out.as_ref()) {
        return fail_error(&err);
    }
    exit_code
}
