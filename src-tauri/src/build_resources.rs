use std::{io, path::Path};

/// Tauri copies resources over existing files. Unlink executable destinations so
/// macOS never associates new signed bytes with an executed file's cached inode.
pub fn prepare_executables(resources: &Path, out_dir: &Path) -> io::Result<()> {
    let target = out_dir
        .ancestors()
        .find(|path| path.file_name().is_some_and(|name| name == "build"))
        .and_then(Path::parent)
        .ok_or_else(|| io::Error::other("Could not find Cargo target directory"))?;
    for entry in std::fs::read_dir(resources)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            match std::fs::remove_file(target.join("bin").join(entry.file_name())) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read};

    #[test]
    fn rebuilding_preserves_the_old_executable_and_creates_a_fresh_file() {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("resources/bin");
        let target = dir.path().join("target/aarch64-apple-darwin/release");
        let out = target.join("build/buzz-hash/out");
        fs::create_dir_all(&resources).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(target.join("bin")).unwrap();
        let source = resources.join("helper");
        let destination = target.join("bin/helper");
        fs::write(&source, b"first signed executable").unwrap();
        prepare_executables(&resources, &out).unwrap();
        fs::copy(&source, &destination).unwrap();
        let mut running = fs::File::open(&destination).unwrap();
        // Mirrors tauri-build's resource copy on the next build.
        fs::write(&source, b"second signed executable").unwrap();
        prepare_executables(&resources, &out).unwrap();
        fs::copy(&source, &destination).unwrap();
        let mut old = String::new();
        running.read_to_string(&mut old).unwrap();
        assert_eq!(old, "first signed executable");
        assert_eq!(fs::read(&destination).unwrap(), b"second signed executable");
    }

    #[test]
    fn leaves_unrelated_output_and_rejects_an_unknown_cargo_layout() {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("resources");
        let target = dir.path().join("debug");
        fs::create_dir_all(&resources).unwrap();
        fs::create_dir_all(target.join("build/buzz/out")).unwrap();
        fs::create_dir_all(target.join("bin")).unwrap();
        fs::write(target.join("bin/unrelated"), b"keep").unwrap();
        prepare_executables(&resources, &target.join("build/buzz/out")).unwrap();
        assert_eq!(fs::read(target.join("bin/unrelated")).unwrap(), b"keep");
        assert!(prepare_executables(&resources, dir.path()).is_err());
    }
}
