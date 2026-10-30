//! Exercise the real executable: these commands must exit before any GUI or
//! single-instance initialization, even with no configured desktop identity.
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(args: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_Buzz"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Legacy CLI invocation started a long-running app instead of exiting");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn legacy_cli_commands_fail_without_echoing_payloads() {
    for args in [
        vec!["--help"],
        vec!["messages", "send", "--content", "private-message-payload"],
        vec!["--private-key=private-key-payload", "messages", "list"],
        vec!["--format", "compact", "channels", "list"],
    ] {
        let output = invoke(&args);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("Buzz desktop app"));
        assert!(stderr.contains("no CLI command was executed"));
        assert!(!stderr.contains("private-message-payload"));
        assert!(!stderr.contains("private-key-payload"));
    }
}
