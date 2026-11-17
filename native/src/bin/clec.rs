use std::process::ExitCode;

fn main() -> ExitCode {
    clec_core::build_identity::retain(clec_core::clec_build_identity!("clec"));
    let code = clec_core::cli::run_cli();
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
