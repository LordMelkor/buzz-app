use std::path::Path;

/// Read-only validation. Never creates a folder, replaces a symlink, or moves repositories.
fn validate(value: &str, home: Option<&Path>) -> Result<String, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("Choose a valid repositories folder.".into());
    }
    let path = crate::workspace_folder::expand(value.trim(), home);
    if !path.is_absolute() {
        return Err("Choose an absolute folder path or a path under ~/.".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "The repositories folder is unavailable. Choose an existing folder.")?;
    if !path.is_dir() || std::fs::read_dir(&path).is_err() {
        return Err("Choose a folder you can access, not a file.".into());
    }
    crate::workspace_folder::display(&path, home)
}

#[tauri::command]
pub(crate) async fn repositories_folder_validate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<String, String> {
    use tauri::Manager as _;
    let home = app.path().home_dir().ok();
    tauri::async_runtime::spawn_blocking(move || validate(&path, home.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_accessible_directories_are_accepted_without_mutation() {
        let root = std::env::temp_dir().join(format!("buzz-repositories-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("checkout.txt");
        std::fs::write(&file, "keep this checkout").unwrap();
        let home = root.canonicalize().unwrap();
        for value in ["~", "~/", home.to_str().unwrap()] {
            assert_eq!(validate(value, Some(&home)).unwrap(), "~");
        }
        assert!(validate("relative", Some(&root)).is_err());
        assert!(validate(file.to_str().unwrap(), Some(&root)).is_err());
        assert!(validate(root.join("missing").to_str().unwrap(), Some(&root)).is_err());
        assert!(!root.join("missing").exists());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "keep this checkout"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
