//! The native route that saves an origin: check, ask, then save. Each test
//! answers in place of the dialog.
use super::*;
use std::future::{ready, Future, Ready};
use tauri::{test::MockRuntime, Manager as _};

const ID: &str = "example.origins";
const OPEN: &str = "Another network access request is open";

struct Fixture {
    _root: tempfile::TempDir,
    source: std::path::PathBuf,
    manager: buzzodz_plugins::Manager,
    app: tauri::App<MockRuntime>,
    revision: String,
}
fn install(manager: &buzzodz_plugins::Manager, source: &std::path::Path, about: &str) -> String {
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!({
            "id": ID, "name": "Origins\u{0} fixture", "description": about, "apiVersion": 1,
            "host": {"networkOrigins": ["https://declared.example"]}
        }))
        .unwrap(),
    )
    .unwrap();
    let catalog = manager.install(source).unwrap();
    catalog
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == ID)
        .unwrap()
        .revision
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let manager =
        buzzodz_plugins::Manager::open(Some(root.path().join("data")), "test", false).unwrap();
    let source = root.path().join("plugin");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    let revision = install(&manager, &source, "first");
    manager.change("enable", ID).unwrap();
    let app = tauri::test::mock_app();
    app.manage(PluginManager(Ok(manager.clone())));
    Fixture {
        _root: root,
        source,
        manager,
        app,
        revision,
    }
}
fn ask<Asked: Future<Output = bool>>(
    f: &Fixture,
    asking: &tokio::sync::Mutex<()>,
    origin: &str,
    answer: impl FnOnce(String) -> Asked,
) -> Result<bool, String> {
    tauri::async_runtime::block_on(request_origin(
        f.app.state(),
        asking,
        ID.into(),
        f.revision.clone(),
        origin.into(),
        answer,
    ))
}
fn never_asked(_: String) -> Ready<bool> {
    panic!("Buzz asked")
}
fn approved(f: &Fixture) -> Vec<String> {
    let catalog = f.manager.catalog().unwrap();
    let plugin = catalog.plugins.into_iter().find(|p| p.manifest.id == ID);
    plugin.unwrap().approved_origins
}

#[test]
fn asks_with_the_printable_name_once_then_returns_true_without_asking() {
    let f = fixture();
    let asking = tokio::sync::Mutex::new(());
    assert_eq!(
        ask(&f, &asking, "https://mcp.example", |name| {
            assert_eq!(name, "Origins fixture");
            ready(true)
        }),
        Ok(true)
    );
    for reached in ["https://declared.example", "https://mcp.example"] {
        assert_eq!(ask(&f, &asking, reached, never_asked), Ok(true));
    }
    assert_eq!(approved(&f), ["https://mcp.example"]);
}

#[test]
fn a_malformed_origin_errors_before_asking() {
    let f = fixture();
    for origin in [
        "https://mcp.example/path",
        "https://*.example",
        "http://mcp.example",
    ] {
        assert!(ask(&f, &tokio::sync::Mutex::new(()), origin, never_asked).is_err());
    }
}

#[test]
fn a_plugin_disabled_or_updated_while_asked_saves_nothing() {
    for update in [false, true] {
        let f = fixture();
        let outcome = ask(
            &f,
            &tokio::sync::Mutex::new(()),
            "https://mcp.example",
            |_| {
                if update {
                    install(&f.manager, &f.source, "second");
                } else {
                    f.manager.change("disable", ID).unwrap();
                }
                ready(true)
            },
        );
        assert_eq!(
            outcome,
            Err("Plugin was disabled or updated; refresh the catalog".into())
        );
        assert!(approved(&f).is_empty());
    }
}

#[test]
fn a_second_request_while_one_is_open_rejects() {
    let f = fixture();
    let asking = tokio::sync::Mutex::new(());
    let first = ask(&f, &asking, "https://first.example", |_| async {
        let second = request_origin(
            f.app.state(),
            &asking,
            ID.into(),
            f.revision.clone(),
            "https://second.example".into(),
            never_asked,
        );
        assert_eq!(second.await, Err(OPEN.into()));
        false
    });
    assert_eq!(first, Ok(false));
    assert_eq!(
        ask(&f, &asking, "https://second.example", |_| ready(true)),
        Ok(true)
    );
}
