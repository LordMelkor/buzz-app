//! Old Buzz linked `~/.local/bin/buzz` to the CLI inside its `Buzz.app`. This app
//! replaces that bundle without a CLI, and on a case-insensitive volume the link's
//! `Contents/MacOS/buzz` then opens this app's `Buzz` executable, so every `buzz`
//! command launches and foregrounds Buzz. Startup removes the link once no file
//! named exactly `buzz` is beside its target; a dangling link is removed too,
//! because installing this app at its target turns it into the same launcher.
use std::path::Path;

pub(crate) fn remove_stale(local_bin: &Path) -> std::io::Result<()> {
    let link = local_bin.join("buzz");
    // Old Buzz linked only to the absolute `buzz` inside its own `Buzz.app`.
    let Ok(target) = std::fs::read_link(&link) else {
        return Ok(());
    };
    let Some(directory) = target.parent() else {
        return Ok(());
    };
    if !target.is_absolute()
        || target.file_name() != Some("buzz".as_ref())
        || !directory.ends_with("Buzz.app/Contents/MacOS")
    {
        return Ok(());
    }
    match std::fs::read_dir(directory) {
        Ok(entries) => {
            for entry in entries {
                if entry?.file_name() == "buzz" {
                    return Ok(());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::remove_file(link)
}

#[cfg(test)]
mod tests {
    use super::remove_stale;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn removes_only_old_buzz_links_without_a_cli() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        for (bundle, executable) in [
            ("Buzz.app", "Buzz"),
            ("Old/Buzz.app", "buzz"),
            ("Other.app", "Buzz"),
        ] {
            let directory = root.join(bundle).join("Contents/MacOS");
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(executable), "").unwrap();
        }
        let local_bin = root.join("bin");
        fs::create_dir(&local_bin).unwrap();
        let link = local_bin.join("buzz");
        // Case-collided and dangling `Buzz.app` links go; the CLI, other bundles,
        // relative links and files stay.
        for (target, removed) in [
            (root.join("Buzz.app/Contents/MacOS/buzz"), true),
            (root.join("Gone/Buzz.app/Contents/MacOS/buzz"), true),
            (root.join("Old/Buzz.app/Contents/MacOS/buzz"), false),
            (root.join("Other.app/Contents/MacOS/buzz"), false),
            ("../Buzz.app/Contents/MacOS/buzz".into(), false),
        ] {
            symlink(&target, &link).unwrap();
            remove_stale(&local_bin).unwrap();
            remove_stale(&local_bin).unwrap();
            assert_eq!(
                link.symlink_metadata().is_err(),
                removed,
                "{}",
                target.display()
            );
            let _ = fs::remove_file(&link);
        }
        fs::write(&link, "").unwrap();
        remove_stale(&local_bin).unwrap();
        assert!(link.is_file());
    }
}
