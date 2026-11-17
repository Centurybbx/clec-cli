use std::process::ExitCode;

fn main() -> ExitCode {
    let code = clec_core::cli::run_cli();
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
