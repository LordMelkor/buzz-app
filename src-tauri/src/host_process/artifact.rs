//! Verified artifact generations shared by every contained worker. Published
//! generations are never repaired in place while another worker may use them.
use buzzodz_plugins::ProcessArtifact;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub(super) fn verify_artifact(artifact: &ProcessArtifact) -> Result<PathBuf, String> {
    let executable = PathBuf::from(&artifact.path);
    let parent = executable.parent().ok_or("Artifact has no parent")?;
    for (name, hash, executable) in files(artifact)? {
        verified_file(&parent.join(name), hash, executable, None)?;
    }
    Ok(executable)
}

pub(super) fn snapshot(artifact: &ProcessArtifact, store: &Path) -> Result<PathBuf, String> {
    let files = files(artifact)?;
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(artifact).map_err(|_| "Invalid artifact")?)
    );
    fs::create_dir_all(store).map_err(|_| "Artifact storage is unavailable")?;
    canonical_path(store)?;
    let generation = store.join(key);
    let executable = generation.join(files[0].0);
    let validate = || -> Result<(), String> {
        let metadata =
            fs::symlink_metadata(&generation).map_err(|_| "Artifact generation is unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Invalid artifact generation".into());
        }
        let entries = fs::read_dir(&generation).map_err(|_| "Artifact generation is unreadable")?;
        let mut count = 0;
        for entry in entries {
            let name = entry
                .map_err(|_| "Artifact generation is unreadable")?
                .file_name();
            if !files.iter().any(|(expected, _, _)| *expected == name) {
                return Err("Artifact generation has undeclared files".into());
            }
            count += 1;
        }
        if count != files.len() {
            return Err("Artifact generation is incomplete".into());
        }
        for (name, hash, executable) in &files {
            let path = generation.join(name);
            #[cfg(unix)]
            if fs::symlink_metadata(&path)
                .map_err(|_| "Artifact is unavailable")?
                .permissions()
                .mode()
                & 0o222
                != 0
            {
                return Err("Artifact generation is writable".into());
            }
            verified_file(&path, hash, *executable, None)?;
        }
        Ok(())
    };
    if generation
        .try_exists()
        .map_err(|_| "Artifact storage is unavailable")?
    {
        validate()?;
        return Ok(executable);
    }
    let temporary = tempfile::Builder::new()
        .prefix("pending-")
        .tempdir_in(store)
        .map_err(|_| "Artifact staging failed")?;
    let parent = Path::new(&artifact.path)
        .parent()
        .ok_or("Artifact has no parent")?;
    for (name, hash, executable) in &files {
        verified_file(
            &parent.join(name),
            hash,
            *executable,
            Some(&temporary.path().join(name)),
        )?;
    }
    // The parent agents directory is denied to every protected worker. Read-only
    // file modes also prevent accidental writes by ordinary runtime code.
    match fs::rename(temporary.path(), &generation) {
        Ok(()) => {
            let _ = temporary.keep();
        }
        Err(_) if generation.try_exists().unwrap_or(false) => validate()?,
        Err(_) => return Err("Artifact publication failed".into()),
    }
    Ok(executable)
}

fn files(artifact: &ProcessArtifact) -> Result<Vec<(&std::ffi::OsStr, &str, bool)>, String> {
    let name = Path::new(&artifact.path)
        .file_name()
        .ok_or("Artifact has no filename")?;
    if artifact
        .siblings
        .iter()
        .any(|sibling| name == std::ffi::OsStr::new(&sibling.name))
    {
        return Err("Artifact sibling replaces its executable".into());
    }
    Ok(std::iter::once((name, artifact.sha256.as_str(), true))
        .chain(artifact.siblings.iter().map(|sibling| {
            (
                std::ffi::OsStr::new(&sibling.name),
                sibling.sha256.as_str(),
                false,
            )
        }))
        .collect())
}

fn canonical_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Artifact path must be absolute".into());
    }
    for component in path.ancestors() {
        if fs::symlink_metadata(component)
            .map_err(|_| "Artifact is unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("Artifact path contains a symlink".into());
        }
    }
    let canonical = path.canonicalize().map_err(|_| "Artifact is unavailable")?;
    if dunce::simplified(&canonical) != dunce::simplified(path) {
        return Err("Artifact path is not canonical".into());
    }
    Ok(())
}

fn verified_file(
    path: &Path,
    expected: &str,
    executable: bool,
    destination: Option<&Path>,
) -> Result<(), String> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid artifact checksum".into());
    }
    canonical_path(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = options.open(path).map_err(|_| "Artifact is unreadable")?;
    let metadata = file.metadata().map_err(|_| "Artifact is unavailable")?;
    if !metadata.is_file() {
        return Err("Artifact is not a regular file".into());
    }
    #[cfg(unix)]
    if executable && metadata.permissions().mode() & 0o111 == 0 {
        return Err("Artifact is not executable".into());
    }
    #[cfg(not(unix))]
    let _ = executable;
    let mut output = destination
        .map(File::create_new)
        .transpose()
        .map_err(|_| "Artifact staging failed")?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Artifact is unreadable")?;
        if count == 0 {
            break;
        }
        if let Some(output) = &mut output {
            output
                .write_all(&buffer[..count])
                .map_err(|_| "Artifact staging failed")?;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("Artifact checksum does not match".into());
    }
    #[cfg(unix)]
    if let Some(output) = output {
        // Executable companions (such as Codex's code-mode host) stay executable.
        let mode = if metadata.permissions().mode() & 0o111 != 0 {
            0o555
        } else {
            0o444
        };
        output
            .set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|_| "Artifact staging failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, ProcessArtifact) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let executable = root.join("agent");
        fs::write(&executable, b"original native bytes").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let descriptor = ProcessArtifact {
            path: executable.to_str().unwrap().into(),
            sha256: format!("{:x}", Sha256::digest(b"original native bytes")),
            siblings: vec![],
        };
        (directory, descriptor)
    }
    #[test]
    fn launch_snapshot_survives_source_replacement_and_rejects_corrupt_generations() {
        let (directory, descriptor) = fixture();
        let store = directory.path().canonicalize().unwrap().join("store");
        let staged = snapshot(&descriptor, &store).unwrap();
        fs::write(&descriptor.path, b"replacement").unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"original native bytes");
        assert_eq!(snapshot(&descriptor, &store).unwrap(), staged);
        #[cfg(unix)]
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(&staged, b"corrupt").unwrap();
        assert!(snapshot(&descriptor, &store).is_err());
        assert_eq!(fs::read(staged).unwrap(), b"corrupt");
    }
    #[test]
    fn complete_descriptor_selects_generation_and_undeclared_files_are_not_copied() {
        use buzzodz_plugins::ProcessArtifactSibling;
        let (directory, mut descriptor) = fixture();
        let root = directory.path().canonicalize().unwrap();
        let store = root.join("store");
        fs::write(root.join("undeclared"), b"ignored").unwrap();
        let first = snapshot(&descriptor, &store).unwrap();
        fs::write(root.join("companion"), b"companion").unwrap();
        descriptor.siblings.push(ProcessArtifactSibling {
            name: "companion".into(),
            sha256: format!("{:x}", Sha256::digest(b"companion")),
        });
        #[cfg(unix)]
        fs::set_permissions(root.join("companion"), fs::Permissions::from_mode(0o755)).unwrap();
        let second = snapshot(&descriptor, &store).unwrap();
        assert_ne!(first, second);
        let companion = second.parent().unwrap().join("companion");
        assert_eq!(fs::read(&companion).unwrap(), b"companion");
        assert!(!second.parent().unwrap().join("undeclared").exists());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(companion).unwrap().permissions().mode() & 0o777,
            0o555
        );
        descriptor.siblings[0].name = "agent".into();
        assert!(snapshot(&descriptor, &store).is_err());
        fs::write(second.parent().unwrap().join("extra"), b"unexpected").unwrap();
        descriptor.siblings[0].name = "companion".into();
        assert!(snapshot(&descriptor, &store).is_err());
    }
    #[test]
    fn concurrent_publication_reuses_the_complete_winner() {
        let (directory, descriptor) = fixture();
        let store = directory.path().canonicalize().unwrap().join("store");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (descriptor, store, barrier) =
                    (descriptor.clone(), store.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    snapshot(&descriptor, &store).unwrap()
                })
            })
            .collect();
        let paths: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(paths[0], paths[1]);
        assert_eq!(fs::read(&paths[0]).unwrap(), b"original native bytes");
        assert_eq!(fs::read_dir(store).unwrap().count(), 1);
    }
    #[test]
    #[cfg(unix)]
    fn rejects_sibling_and_ancestor_symlinks_and_noncanonical_components() {
        use buzzodz_plugins::ProcessArtifactSibling;
        use std::os::unix::fs::symlink;
        let (directory, mut descriptor) = fixture();
        let root = directory.path().canonicalize().unwrap();
        symlink(root.join("agent"), root.join("alias")).unwrap();
        descriptor.siblings.push(ProcessArtifactSibling {
            name: "alias".into(),
            sha256: descriptor.sha256.clone(),
        });
        assert!(verify_artifact(&descriptor).is_err());
        descriptor.siblings.clear();
        symlink(&root, root.join("linked")).unwrap();
        descriptor.path = root.join("linked/agent").to_str().unwrap().into();
        assert!(verify_artifact(&descriptor).is_err());
        fs::create_dir(root.join("nested")).unwrap();
        descriptor.path = root.join("nested/../agent").to_str().unwrap().into();
        assert!(verify_artifact(&descriptor).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn fifo_cannot_block_the_verification_thread() {
        use std::ffi::CString;
        let (directory, mut descriptor) = fixture();
        let fifo = directory.path().canonicalize().unwrap().join("fifo");
        assert_eq!(
            unsafe {
                libc::mkfifo(
                    CString::new(fifo.to_str().unwrap()).unwrap().as_ptr(),
                    0o600,
                )
            },
            0
        );
        descriptor.path = fifo.to_str().unwrap().into();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(verify_artifact(&descriptor)).unwrap();
        });
        let answer = receive.recv_timeout(std::time::Duration::from_secs(2));
        // Release a regressed blocking reader before failing, so no thread leaks.
        let release = answer.is_err().then(|| {
            OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&fifo)
                .unwrap()
        });
        worker.join().unwrap();
        drop(release);
        assert!(answer.expect("opening a FIFO blocked").is_err());
    }
    #[test]
    #[cfg(windows)]
    fn windows_normal_and_extended_paths_select_the_same_file() {
        let (_directory, mut descriptor) = fixture();
        let ordinary = dunce::simplified(Path::new(&descriptor.path)).to_path_buf();
        descriptor.path = ordinary.to_str().unwrap().into();
        assert!(verify_artifact(&descriptor).is_ok());
        descriptor.path = ordinary.canonicalize().unwrap().to_str().unwrap().into();
        assert!(verify_artifact(&descriptor).is_ok());
    }
}
