#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod legacy_cli_invocation;

fn main() -> std::process::ExitCode {
    // Reject before native startup, including the single-instance plugin, which
    // would otherwise foreground the app and report success without doing work.
    if std::env::args_os()
        .nth(1)
        .as_deref()
        .is_some_and(legacy_cli_invocation::is_legacy_cli_arg)
    {
        eprintln!(
            "This executable is the Buzz desktop app. The legacy Buzz CLI is not \
             included in this app bundle; no CLI command was executed. Update \
             your script to use a separately installed Buzz CLI."
        );
        return std::process::ExitCode::from(2);
    }
    buzz_foundation_lib::run();
    std::process::ExitCode::SUCCESS
}
