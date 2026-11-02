#![cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[test]
fn bundled_shell_ignores_path_startup_and_imported_functions_without_mcp() {
    let directory = tempfile::tempdir().unwrap();
    let fake = directory.path().join("bash");
    std::fs::write(&fake, "#!/bin/sh\nprintf planted\nexit 88\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_buzz-agent-command"))
        .args(["--shell", "printf '%s\\n' native", "bootstrap-test"])
        .env("PATH", directory.path())
        .env("BASH_ENV", &fake)
        .env("ENV", &fake)
        .env("BASH_FUNC_printf%%", "() { echo planted; }")
        .env_remove("BUZZ_AGENT_CONNECTION")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"native\n");
    assert!(output.stderr.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn contained_file_reader_allows_workspace_but_denies_private_paths_and_aliases() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let private = root.join("approval");
    std::fs::create_dir(&private).unwrap();
    let secret = private.join("decision");
    let public = root.join("report; quoted \"name\".txt");
    let alias = root.join("alias");
    std::fs::write(&secret, b"private marker").unwrap();
    std::fs::write(&public, b"workspace marker").unwrap();
    std::os::unix::fs::symlink(&secret, &alias).unwrap();
    // Exercise ~/ expansion without changing HOME or writing in the real home.
    let reader_home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
    assert!(reader_home.is_absolute());
    let home_relative = std::path::PathBuf::from(format!(
        "~/{}{}",
        "../".repeat(reader_home.components().count() - 1),
        public.strip_prefix("/").unwrap().display(),
    ));
    let profile = format!(
        "(version 1)(allow default)(deny file-read* (subpath {}))",
        serde_json::to_string(private.to_str().unwrap()).unwrap()
    );
    for (path, allowed) in [
        (&public, true),
        (&home_relative, true),
        (&secret, false),
        (&alias, false),
    ] {
        let output = std::process::Command::new("/usr/bin/sandbox-exec")
            .args([
                "-p",
                &profile,
                env!("CARGO_BIN_EXE_buzz-agent-command"),
                "--shell",
                "case \"$1\" in \"~/\"*) set -- \"$HOME/${1:2}\";; esac; exec /usr/bin/base64 -i \"$1\"",
                "buzz-read",
            ])
            .arg(path)
            .env_remove("BUZZ_AGENT_CONNECTION")
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            allowed,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        if allowed {
            assert_eq!(
                String::from_utf8(output.stdout).unwrap().trim(),
                "d29ya3NwYWNlIG1hcmtlcg=="
            );
        } else {
            assert!(output.stdout.is_empty());
            assert!(!String::from_utf8_lossy(&output.stderr).contains("private marker"));
        }
    }
}
