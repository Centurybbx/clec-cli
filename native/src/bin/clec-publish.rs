use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use clec_core::domain::{CORPUS_FORMAT, ClecError, ErrorCode, ErrorEnvelope};
use clec_core::snapshot::publish_release_with_artifact_url;

#[derive(Debug, Parser)]
#[command(
    name = "clec-publish",
    version,
    about = format!("Build a {CORPUS_FORMAT} corpus.sqlite.zst release and manifest.json")
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

    /// Optional public artifact download URL recorded in manifest.json
    #[arg(long, value_name = "URL")]
    artifact_url: Option<String>,
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

    match publish_release_with_artifact_url(
        &cli.workspace,
        &cli.intake,
        &cli.output,
        cli.artifact_url.as_deref(),
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn help_about_derives_from_corpus_format_constant() {
        let cmd = PublishCli::command();
        let about = cmd.get_about().expect("about text").to_string();
        assert!(about.contains(CORPUS_FORMAT), "about={about}");
        assert!(!about.contains("clec-native-v1"), "about={about}");
    }
}
