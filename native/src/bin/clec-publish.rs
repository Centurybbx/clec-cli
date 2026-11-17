use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use clec_core::domain::{ClecError, ErrorCode, ErrorEnvelope};
use clec_core::snapshot::publish_release;

#[derive(Debug, Parser)]
#[command(
    name = "clec-publish",
    version,
    about = "Build a clec-native-v1 corpus.sqlite.zst release and manifest.json"
)]
struct PublishCli {
    /// Workspace root containing admitted relative source files
    #[arg(long, value_name = "DIR")]
    workspace: PathBuf,

    /// Path to intake.json declaring works and sources
    #[arg(long, value_name = "FILE")]
    intake: PathBuf,

    /// New output directory for manifest.json and corpus.sqlite.zst
    #[arg(long, value_name = "DIR")]
    output: PathBuf,
}

fn main() -> ExitCode {
    let cli = match PublishCli::try_parse() {
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
            let env = ErrorEnvelope::from_error(&err, Some("publish"));
            eprintln!("{}", serde_json::to_string(&env).unwrap());
            return ExitCode::from(err.code.exit_code() as u8);
        }
    };

    match publish_release(&cli.workspace, &cli.intake, &cli.output) {
        Ok(manifest) => {
            println!("{}", serde_json::to_string(&manifest).unwrap());
            ExitCode::SUCCESS
        }
        Err(err) => {
            let env = ErrorEnvelope::from_error(&err, Some("publish"));
            eprintln!("{}", serde_json::to_string(&env).unwrap());
            ExitCode::from(err.code.exit_code() as u8)
        }
    }
}
