//! Restarts Buzz after an update installs or a sign-out commits.
//!
//! Tauri's restart opens the next instance while this one is still exiting. The
//! macOS Dock then shows that instance in a tile of its own beside the pinned
//! one, which stays in its recent apps once it quits: another Buzz icon for
//! every restart. On macOS the next instance therefore opens only after this
//! process has exited.

/// Exits through the usual teardown, then opens Buzz again.
pub(crate) fn request<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if macos::bundle().is_some() {
        macos::PENDING.store(true, std::sync::atomic::Ordering::Relaxed);
        app.exit(0);
        return;
    }
    app.request_restart();
}

#[cfg(target_os = "macos")]
pub(crate) use macos::on_exit;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::OsString;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;

    pub(super) static PENDING: AtomicBool = AtomicBool::new(false);

    /// The app bundle this process was started from, as Tauri's restart uses it.
    pub(super) fn bundle() -> Option<PathBuf> {
        if !crate::dock::bundled() {
            return None;
        }
        let executable = tauri::utils::platform::current_exe().ok()?;
        executable.ancestors().nth(3).map(Path::to_path_buf)
    }

    /// On `RunEvent::Exit`, after teardown: hands a requested relaunch to a
    /// process that outlives this one, or restarts as Tauri does if it can't.
    pub(crate) fn on_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        if !PENDING.load(Ordering::Relaxed) {
            return;
        }
        let env = app.env();
        let spawned = bundle()
            .ok_or_else(|| "Buzz is not running from an app bundle".to_string())
            .and_then(|bundle| {
                relauncher(
                    Path::new("/usr/bin/open"),
                    std::process::id(),
                    &bundle,
                    env.args_os.iter().skip(1),
                )
                .spawn()
                .map_err(|error| error.to_string())
            });
        if let Err(error) = spawned {
            eprintln!("Could not relaunch Buzz after it exits: {error}");
            tauri::process::restart(&env);
        }
    }

    /// Waits for `pid` to exit, then runs `open -n <bundle> --args <args>`,
    /// detached from this process's stdio and process group.
    fn relauncher<'a>(
        open: &Path,
        pid: u32,
        bundle: &Path,
        args: impl IntoIterator<Item = &'a OsString>,
    ) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(r#"pid=$1; shift; while /bin/kill -0 "$pid" 2>/dev/null; do /bin/sleep 0.1; done; exec "$@""#)
            .arg("sh")
            .arg(pid.to_string())
            .arg(open)
            .arg("-n")
            .arg(bundle)
            .arg("--args")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        command
    }

    #[cfg(test)]
    mod tests {
        use super::relauncher;
        use std::ffi::OsString;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        #[test]
        fn opens_the_bundle_only_after_the_process_has_exited() {
            let dir = tempfile::tempdir().unwrap();
            let record = dir.path().join("record");
            // Stands in for `open`: records whether the old process was still
            // running when it ran, and each argument it was given on its own line.
            let open = dir.path().join("open");
            std::fs::write(
                &open,
                format!(
                    "#!/bin/sh\nif /bin/kill -0 \"$OLD\" 2>/dev/null; then s=running; else s=exited; fi\nprintf '%s\\n' \"$s\" \"$@\" > '{}'\n",
                    record.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&open, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
            let mut old = Command::new("/bin/sleep")
                .arg("30")
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let args = [OsString::from("--flag"), OsString::from("two words")];

            let mut command = relauncher(&open, old.id(), "/Applications/Buzz.app".as_ref(), &args);
            let mut waiter = command.env("OLD", old.id().to_string()).spawn().unwrap();
            // Exit the old process only once the relauncher is polling it (its
            // `sleep` child is running) or has already finished without waiting.
            let deadline = Instant::now() + Duration::from_secs(10);
            let waiter_pid = waiter.id().to_string();
            let polling = || {
                Command::new("/usr/bin/pgrep")
                    .args(["-P", &waiter_pid, "sleep"])
                    .stdout(Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            };
            while !polling() && waiter.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "relauncher never polled");
                std::thread::sleep(Duration::from_millis(20));
            }

            old.kill().unwrap();
            old.wait().unwrap();
            while waiter.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "relauncher never ran");
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(
                std::fs::read_to_string(&record).unwrap(),
                "exited\n-n\n/Applications/Buzz.app\n--args\n--flag\ntwo words\n"
            );
        }
    }
}
