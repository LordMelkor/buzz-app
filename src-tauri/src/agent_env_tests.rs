use super::*;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
pub(crate) struct FakeStore {
    pub(crate) text: StdMutex<Option<String>>,
    unreadable: StdMutex<bool>,
    pub(crate) unwritable: StdMutex<bool>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self.text.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn replace(&self, text: &str) -> Result<(), String> {
        if *self.unwritable.lock().unwrap() {
            return Err("locked".into());
        }
        *self.text.lock().unwrap() = Some(text.into());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        if *self.unwritable.lock().unwrap() {
            return Err("locked".into());
        }
        *self.text.lock().unwrap() = None;
        Ok(())
    }
}

pub(crate) fn set(name: &str, value: &str) -> Row {
    Row {
        name: name.into(),
        value: Some(value.into()),
    }
}
fn keep(name: &str) -> Row {
    Row {
        name: name.into(),
        value: None,
    }
}
fn env(store: &Arc<FakeStore>) -> AgentEnv {
    AgentEnv::with(Box::new(store.clone()))
}
async fn given(
    env: &AgentEnv,
    plugin: &str,
    process: &str,
    protected: bool,
) -> Vec<(String, String)> {
    env.for_process(plugin, process, protected)
        .await
        .into_iter()
        .map(|(n, v)| (n.into_string().unwrap(), v.into_string().unwrap()))
        .collect()
}

#[tokio::test]
async fn only_local_agent_processes_get_the_list() {
    let store = Arc::new(FakeStore::default());
    let env = env(&store);
    env.set(vec![set("FOO", "bar")]).await.unwrap();
    let foo = vec![("FOO".to_string(), "bar".to_string())];
    for (plugin, process) in [
        ("buzz.claude-code", "claude-sh"),
        ("buzz.codex", "codex-sh"),
        ("buzz.goose", "goose"),
        ("buzz.pi", "pi-sh"),
        ("buzz.pi", "node"),
    ] {
        assert_eq!(
            given(&env, plugin, process, false).await,
            foo,
            "{plugin} {process}"
        );
        assert!(
            given(&env, plugin, process, true).await.is_empty(),
            "protected {plugin}"
        );
    }
    for (plugin, process) in [
        ("buzz.claude-code", "claude-protected-arm64"),
        ("buzz.claude-code", "read"),
        ("buzz.pi", "pi-protected-sh"),
        ("other.plugin", "claude-sh"),
    ] {
        assert!(
            given(&env, plugin, process, false).await.is_empty(),
            "{plugin} {process}"
        );
    }
}

#[tokio::test]
async fn an_unreadable_store_starts_agents_without_the_list() {
    let store = Arc::new(FakeStore::default());
    *store.unreadable.lock().unwrap() = true;
    assert!(given(&env(&store), "buzz.goose", "goose", false)
        .await
        .is_empty());
}

#[tokio::test]
async fn rows_keep_replace_or_delete_saved_values() {
    let store = Arc::new(FakeStore::default());
    env(&store)
        .set(vec![set("A", "1"), set("B", "2"), set("C", "3")])
        .await
        .unwrap();
    // As after a relaunch: values are read back from the store.
    let env = env(&store);
    assert_eq!(
        env.status().await.unwrap(),
        Status {
            names: vec!["A".into(), "B".into(), "C".into()],
            saved: false
        }
    );
    env.set(vec![keep("A"), set("B", "two"), set("D", "4")])
        .await
        .unwrap();
    assert_eq!(
        given(&env, "buzz.goose", "goose", false).await,
        [("A", "1"), ("B", "two"), ("D", "4")].map(|(n, v)| (n.to_string(), v.to_string()))
    );
    assert!(env.status().await.unwrap().saved);
    assert!(env.set(vec![keep("MISSING")]).await.is_err());
}

#[tokio::test]
async fn a_failed_save_changes_nothing() {
    let store = Arc::new(FakeStore::default());
    let env = env(&store);
    env.set(vec![set("A", "1")]).await.unwrap();
    let env = AgentEnv::with(Box::new(store.clone()));
    *store.unwritable.lock().unwrap() = true;
    assert!(env.set(vec![set("A", "2")]).await.is_err());
    assert!(env.set(vec![set("PATH", "/x")]).await.is_err());
    assert!(!env.status().await.unwrap().saved);
    assert_eq!(
        given(&env, "buzz.goose", "goose", false).await,
        vec![("A".into(), "1".into())]
    );
}

#[tokio::test]
async fn every_blocked_name_is_rejected_in_any_case() {
    let env = env(&Arc::new(FakeStore::default()));
    for name in BLOCKED
        .iter()
        .chain(PATHS)
        .copied()
        .chain(["BUZZ_AGENT", "NOSTR_KEY", "path"])
        // Named here too, so dropping one from `BLOCKED` fails.
        .chain([
            "OPENAI_BASE_PATH",
            "LITELLM_BASE_PATH",
            "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
            "AZURE_OPENAI_RESOURCE_NAME",
            "KIMI_CODE_OAUTH_HOST",
            "KIMI_OAUTH_HOST",
            "ANTHROPIC_FOUNDRY_RESOURCE",
            "CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL",
            "CODEX_AGENT_IDENTITY_JWKS_BASE_URL",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_EC2_METADATA_SERVICE_ENDPOINT",
            "HOME",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "GOOSE_PATH_ROOT",
            "PI_CODING_AGENT_DIR",
            "USERPROFILE",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "LOCALAPPDATA",
        ])
    {
        let mixed: String = name
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i % 2 == 0 {
                    c.to_ascii_lowercase()
                } else {
                    c
                }
            })
            .collect();
        for name in [name.to_string(), name.to_ascii_lowercase(), mixed] {
            assert!(
                env.set(vec![set(&name, "x")]).await.is_err(),
                "{name} was allowed"
            );
        }
    }
    for name in [
        "ANTHROPIC_API_KEY",
        "AWS_REGION",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "GITHUB_TOKEN",
        "DATABRICKS_TOKEN",
        "_X1",
    ] {
        env.set(vec![set(name, "x")]).await.unwrap();
    }
}

#[tokio::test]
async fn invalid_names_values_and_duplicates_are_rejected() {
    let env = env(&Arc::new(FakeStore::default()));
    for name in ["", "1A", "A-B", "A B", "A=B", "É", &"A".repeat(129)] {
        assert!(env.set(vec![set(name, "x")]).await.is_err(), "{name:?}");
    }
    assert!(env.set(vec![set("A", "x\0y")]).await.is_err());
    assert!(env
        .set(vec![set("Foo", "1"), set("FOO", "2")])
        .await
        .is_err());
}

#[tokio::test]
async fn the_list_fits_windows_utf16_limit() {
    let env = env(&Arc::new(FakeStore::default()));
    // `{"A":"…"}` is 8 characters around the value; 1280 UTF-16 units fit.
    env.set(vec![set("A", &"x".repeat(1272))]).await.unwrap();
    assert!(env.set(vec![set("A", &"x".repeat(1273))]).await.is_err());
    // A character outside the BMP is two UTF-16 units.
    env.set(vec![set("A", &"😀".repeat(636))]).await.unwrap();
    assert!(env.set(vec![set("A", &"😀".repeat(637))]).await.is_err());
}

pub(crate) const ADA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const BO: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(crate) type Stores = Arc<StdMutex<std::collections::HashMap<String, Arc<FakeStore>>>>;

/// One fake item per agent, kept by the test.
pub(crate) fn envs() -> (AgentEnvs, Stores) {
    let stores: Stores = Default::default();
    let held = stores.clone();
    let envs = AgentEnvs::with(Box::new(move |pubkey: &str| -> Box<dyn KeyStore> {
        Box::new(
            held.lock()
                .unwrap()
                .entry(pubkey.to_owned())
                .or_default()
                .clone(),
        )
    }));
    (envs, stores)
}
async fn agent_given(envs: &AgentEnvs, pubkey: &str) -> Vec<(String, String)> {
    envs.for_process(pubkey, "buzz.goose", "goose", false)
        .await
        .into_iter()
        .map(|(n, v)| (n.into_string().unwrap(), v.into_string().unwrap()))
        .collect()
}

#[tokio::test]
async fn each_agent_gets_only_its_own_list() {
    let (envs, _) = envs();
    envs.set(ADA, vec![set("FOO", "ada")], || Ok(true))
        .await
        .unwrap();
    assert_eq!(
        agent_given(&envs, ADA).await,
        vec![("FOO".to_string(), "ada".to_string())]
    );
    assert!(agent_given(&envs, BO).await.is_empty());
    assert!(envs
        .for_process(ADA, "buzz.goose", "goose", true)
        .await
        .is_empty());
    assert_eq!(envs.status(BO).await.unwrap().names, Vec::<String>::new());
}

#[tokio::test]
async fn an_agent_list_uses_the_same_rules() {
    let (envs, _) = envs();
    assert!(envs
        .set(ADA, vec![set("ANTHROPIC_MODEL", "x")], || Ok(true))
        .await
        .is_err());
    assert!(envs
        .set(ADA, vec![set("FOO", &"x".repeat(SIZE_LIMIT))], || Ok(true))
        .await
        .is_err());
    assert!(envs.set("ADA", vec![], || Ok(true)).await.is_err());
    assert!(envs.status("../x").await.is_err());
}

#[tokio::test]
async fn an_ineligible_agent_saves_nothing() {
    let (envs, stores) = envs();
    let refused = envs.set(ADA, vec![set("FOO", "bar")], || Ok(false)).await;
    assert!(refused.is_err());
    assert!(stores.lock().unwrap().get(ADA).is_none_or(|store| store
        .text
        .lock()
        .unwrap()
        .is_none()));
}

#[tokio::test]
async fn forgetting_deletes_the_item_and_its_read_copy() {
    let (envs, stores) = envs();
    // None saved is already gone.
    envs.forget(ADA).await.unwrap();
    envs.set(ADA, vec![set("FOO", "bar")], || Ok(true))
        .await
        .unwrap();
    envs.forget(ADA).await.unwrap();
    assert!(stores.lock().unwrap()[ADA].text.lock().unwrap().is_none());
    assert!(agent_given(&envs, ADA).await.is_empty());
}

#[tokio::test]
async fn a_failed_forget_is_reported_and_can_be_retried() {
    let (envs, stores) = envs();
    envs.set(ADA, vec![set("FOO", "bar")], || Ok(true))
        .await
        .unwrap();
    let store = stores.lock().unwrap()[ADA].clone();
    *store.unwritable.lock().unwrap() = true;
    assert!(envs.forget(ADA).await.is_err());
    // Still read as saved: nothing claims it is gone.
    assert_eq!(agent_given(&envs, ADA).await.len(), 1);
    *store.unwritable.lock().unwrap() = false;
    envs.forget(ADA).await.unwrap();
    assert!(agent_given(&envs, ADA).await.is_empty());
}

/// A save queued between the cleanup and the row change finds the Delete
/// started and is refused, so no list outlives the agent.
#[tokio::test]
async fn a_save_after_cleanup_is_refused() {
    let (envs, stores) = envs();
    envs.set(ADA, vec![set("FOO", "bar")], || Ok(true))
        .await
        .unwrap();
    let mut row = agent_row(ADA);
    row.deleting = true;
    let rows = vec![row];
    envs.forget(ADA).await.unwrap();
    let late = envs
        .set(ADA, vec![set("FOO", "again")], || Ok(eligible(&rows, ADA)))
        .await;
    assert!(late.is_err());
    assert!(stores.lock().unwrap()[ADA].text.lock().unwrap().is_none());
}

pub(crate) fn agent_row(pubkey: &str) -> buzz_agent_controller::AppAgent {
    serde_json::from_value(serde_json::json!({
        "pubkey": pubkey,
        "relay": "wss://relay.example",
        "owner": "c".repeat(64),
        "auth": "[]",
    }))
    .unwrap()
}

#[test]
fn only_live_unprotected_agents_are_eligible() {
    let live = agent_row(ADA);
    assert!(eligible(std::slice::from_ref(&live), ADA));
    assert!(!eligible(std::slice::from_ref(&live), BO));
    for change in [
        |a: &mut buzz_agent_controller::AppAgent| a.deleted = true,
        |a: &mut buzz_agent_controller::AppAgent| a.deleting = true,
        |a: &mut buzz_agent_controller::AppAgent| a.joining = true,
    ] {
        let mut row = live.clone();
        change(&mut row);
        assert!(!eligible(&[row], ADA));
    }
}

/// Agents here, as `rows`, for the spawn checks.
fn host_with(
    rows: &[buzz_agent_controller::AppAgent],
) -> (tempfile::TempDir, crate::app_agents::AppAgentHost) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identities.json");
    std::fs::write(&path, serde_json::to_vec(rows).unwrap()).unwrap();
    let host = crate::app_agents::AppAgentHost::new(
        Ok(path),
        Err("unused".into()),
        true,
        crate::federated_identity::agent::AgentTokens::unconfigured(),
    );
    (dir, host)
}

#[tokio::test]
async fn a_spawn_gets_only_an_eligible_named_agents_list() {
    let (envs, _) = envs();
    envs.set(ADA, vec![set("FOO", "ada")], || Ok(true))
        .await
        .unwrap();
    let mut deleting = agent_row(BO);
    deleting.deleting = true;
    let (_dir, host) = host_with(&[agent_row(ADA), deleting]);
    let asks = vec![SECRET.to_string()];
    let spawn =
        |agent, protected| for_spawn(&envs, &host, &asks, agent, "buzz.goose", "goose", protected);
    assert_eq!(spawn(Some(ADA), false).await.unwrap().len(), 1);
    // No agent named: no list in this build.
    assert!(spawn(None, false).await.unwrap().is_empty());
    // An agent being removed, or not here, is refused.
    assert!(spawn(Some(BO), false).await.is_err());
    let absent = "c".repeat(64);
    assert!(spawn(Some(&absent), false).await.is_err());
    // Protected launches and processes outside the allowlist are refused.
    assert!(spawn(Some(ADA), true).await.is_err());
    assert!(for_spawn(
        &envs,
        &host,
        &asks,
        Some(ADA),
        "buzz.goose",
        "install",
        false
    )
    .await
    .is_err());
    // A process that doesn't ask gets nothing.
    assert!(
        for_spawn(&envs, &host, &[], Some(ADA), "buzz.goose", "goose", false)
            .await
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_anthropic_key_has_one_spelling_where_names_ignore_case() {
    // Claude's sign-in check and the host override match it exactly.
    assert!(check("anthropic_api_key", true).is_err());
    assert!(check("Anthropic_Api_Key", true).is_err());
    assert!(check("ANTHROPIC_API_KEY", true).is_ok());
    // Elsewhere it's another variable.
    assert!(check("anthropic_api_key", false).is_ok());
}
