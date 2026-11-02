//! Distinct plugin authority grants. Granted calls go to the adapter origin
//! with the native session as a Bearer token; the renderer never sees it.
use super::FederatedIdentity;
use crate::{with_manager, PluginManager};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

#[derive(Default)]
pub(crate) struct Registrations(Mutex<HashMap<String, (String, String)>>);
impl Registrations {
    pub(crate) fn retire(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, (plugin, _)| plugin != id);
    }
    pub(crate) fn clear(&self) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    path: String,
    #[serde(default = "method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}
fn method() -> String {
    "GET".into()
}

#[tauri::command]
pub(crate) async fn federated_identity_register(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, FederatedIdentity>,
    registrations: tauri::State<'_, Registrations>,
    id: String,
    revision: String,
    registration: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&registration).map_err(|_| "Invalid plugin registration")?;
    let owner = (id.clone(), revision.clone());
    {
        let mut live = registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.len() >= 128 || live.contains_key(&registration) {
            return Err("Plugin registration unavailable".into());
        }
        // Reserve before awaiting admission. Unload may remove this reservation,
        // and no completed admission can resurrect it.
        live.insert(registration.clone(), owner.clone());
    }
    let admitted = async {
        let grants =
            with_manager(manager, move |manager| manager.host_grants(&id, &revision)).await?;
        let grant = grants
            .federated_identity
            .ok_or("Plugin has no authenticated authority grant")?;
        if host.0.config.as_ref().map(|config| config.id.as_str()) != Some(grant.authority.as_str())
        {
            return Err("Plugin authority is not configured".into());
        }
        if registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&registration)
            != Some(&owner)
        {
            return Err("Plugin registration retired".into());
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = admitted {
        registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&registration);
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn federated_identity_unregister(
    registrations: tauri::State<'_, Registrations>,
    registration: String,
) {
    registrations
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&registration);
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn federated_identity_request(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, FederatedIdentity>,
    registrations: tauri::State<'_, Registrations>,
    id: String,
    revision: String,
    registration: String,
    session: String,
    request: Request,
) -> Result<crate::host_request::HostResponse, String> {
    let live = || {
        registrations
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&registration)
            == Some(&(id.clone(), revision.clone()))
    };
    if !live() {
        return Err("Plugin registration retired".into());
    }
    let (plugin, artifact) = (id.clone(), revision.clone());
    let grants = with_manager(manager, move |manager| {
        manager.host_grants(&plugin, &artifact)
    })
    .await?;
    let grant = grants
        .federated_identity
        .ok_or("Plugin has no authenticated authority grant")?;
    let config = host
        .0
        .config
        .as_ref()
        .ok_or("Federated identity is not configured")?;
    if grant.authority != config.id {
        return Err("Plugin authority mismatch".into());
    }
    let destination = validate(config, &grant, &request)?;
    if !live() {
        return Err("Plugin registration retired".into());
    }
    // Only the account the caller started under may answer: a session
    // replaced since then refuses instead of acting for the new account.
    let token = host
        .with_session(|token, current, _| (current == session).then(|| token.clone()))
        .ok_or("Sign in to your community first")?
        .ok_or("Federated session changed")?;
    // A refusal here (including 401) belongs to this call only. Only the
    // adapter's session and assertion routes decide that the session ended,
    // so a 401 asks the session route once.
    let response = forward(destination, &token, request).await?;
    if response.status == 401 {
        host.recheck(&session).await;
    }
    Ok(response)
}
async fn forward(
    destination: url::Url,
    token: &str,
    request: Request,
) -> Result<crate::host_request::HostResponse, String> {
    let method =
        reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "Invalid API method")?;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &request.headers {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid API header")?,
            reqwest::header::HeaderValue::from_str(value).map_err(|_| "Invalid API header")?,
        );
    }
    let mut bearer = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "Invalid session")?;
    bearer.set_sensitive(true);
    headers.insert(reqwest::header::AUTHORIZATION, bearer);
    crate::host_request::send_request(
        destination,
        method,
        headers,
        request.body,
        crate::host_request::DEADLINE,
    )
    .await
}
fn validate(
    config: &super::config::Config,
    grant: &buzzodz_plugins::FederatedIdentityGrant,
    request: &Request,
) -> Result<url::Url, String> {
    let path = &request.path;
    if path.len() > 2048
        || !super::config::canonical_path(path)
        || path.contains('%')
        || !path.starts_with(&config.api_base_path)
        || !grant
            .operations
            .iter()
            .any(|op| op.path == *path && op.method == request.method)
    {
        return Err("Authenticated operation is not granted".into());
    }
    let destination = url::Url::parse(&config.identity_origin)
        .and_then(|base| base.join(path))
        .map_err(|_| "Invalid API destination")?;
    if destination.origin().ascii_serialization() != config.identity_origin {
        return Err("Invalid API destination".into());
    }
    for route in [
        "/v1/login/start",
        "/v1/login/exchange",
        "/v1/session",
        "/v1/identity/assertions",
    ] {
        if destination.path() == config.endpoint(route).path() {
            return Err("Adapter endpoints are reserved".into());
        }
    }
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > 1024 * 1024)
        || request.headers.len() > 32
        || request
            .headers
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > 8192
    {
        return Err("Authenticated request is too large".into());
    }
    for (name, value) in &request.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Invalid API header")?;
        if matches!(
            name.as_str(),
            "authorization"
                | "nostr-authorization"
                | "nostr-federated-identity"
                | "x-bb-session-credential"
                | "cookie"
                | "host"
                | "connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
        ) || name.as_str().starts_with("proxy-")
        {
            return Err("Authenticated header is reserved".into());
        }
        reqwest::header::HeaderValue::from_str(value).map_err(|_| "Invalid API header")?;
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager as _;
    #[tokio::test]
    async fn native_grants_require_current_enabled_artifact_and_live_registration() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), r#"{"id":"example.fi","name":"Example","apiVersion":1,"host":{"networkOrigins":["https://identity.example"],"federatedIdentity":{"authority":"test","operations":[{"method":"GET","path":"/api/list"}]}}}"#).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.fi")
            .unwrap()
            .revision;
        let host =
            super::super::tests::host(std::sync::Arc::new(super::super::tests::Memory::default()));
        let app = tauri::test::mock_builder()
            .manage(crate::PluginManager(Ok(manager.clone())))
            .manage(host)
            .manage(Registrations::default())
            .build(crate::app_context())
            .unwrap();
        let register = |revision: String, registration: String| {
            federated_identity_register(
                app.state(),
                app.state(),
                app.state(),
                "example.fi".into(),
                revision,
                registration,
            )
        };
        let token = uuid::Uuid::new_v4().to_string();
        assert!(register(revision.clone(), token.clone()).await.is_err());
        manager.change("enable", "example.fi").unwrap();
        assert!(register("stale".into(), token.clone()).await.is_err());
        register(revision.clone(), token.clone()).await.unwrap();
        let request = |path: &str, headers: BTreeMap<String, String>| {
            federated_identity_request(
                app.state(),
                app.state(),
                app.state(),
                "example.fi".into(),
                revision.clone(),
                token.clone(),
                String::new(),
                Request {
                    path: path.into(),
                    method: "GET".into(),
                    headers,
                    body: None,
                },
            )
        };
        // Reaching this refusal proves all admission guards passed; with no
        // session nothing is sent.
        assert!(request("/api/list", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("Sign in"));
        assert!(request("/api/other", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("not granted"));
        for header in [
            "Authorization",
            "Nostr-Federated-Identity",
            "X-BB-Session-Credential",
            "Cookie",
        ] {
            assert!(request(
                "/api/list",
                BTreeMap::from([(header.into(), "Bearer fixture".into())])
            )
            .await
            .unwrap_err()
            .contains("reserved"));
        }
        {
            let host = app.state::<FederatedIdentity>();
            let mut state = host.state();
            let session = super::super::tests::record();
            state.snapshot.revision = session.record.revision.clone();
            state.session = Some(session);
        }
        // A call started under another session revision never gets its token.
        assert!(request("/api/list", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("changed"));
        app.state::<Registrations>().retire("example.fi");
        assert!(request("/api/list", BTreeMap::new())
            .await
            .unwrap_err()
            .contains("retired"));
        register(revision.clone(), token.clone()).await.unwrap();
        manager.change("disable", "example.fi").unwrap();
        assert!(request("/api/list", BTreeMap::new()).await.is_err());
    }
    #[tokio::test]
    async fn a_granted_401_asks_the_session_route_once_before_answering() {
        use super::super::tests::{adapter_with_status, at_adapter, record, Memory};
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), r#"{"id":"example.fi","name":"Example","apiVersion":1,"host":{"federatedIdentity":{"authority":"test","operations":[{"method":"GET","path":"/api/list"}]}}}"#).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.fi")
            .unwrap()
            .revision;
        manager.change("enable", "example.fi").unwrap();
        let (base, server) = adapter_with_status(vec![
            (401, serde_json::json!({})),
            (401, serde_json::json!({"error":"session_expired"})),
        ])
        .await;
        let store = std::sync::Arc::new(Memory::default());
        let mut host = at_adapter(store.clone(), base.clone());
        // Plain loopback wire fixture only, as `at_adapter` is.
        std::sync::Arc::get_mut(&mut host.0)
            .unwrap()
            .config
            .as_mut()
            .unwrap()
            .identity_origin = url::Url::parse(&base)
            .unwrap()
            .origin()
            .ascii_serialization();
        let session = record();
        *store.raw.lock().unwrap() = Some(session.raw.clone());
        {
            let mut state = host.state();
            state.snapshot.revision = session.record.revision.clone();
            state.snapshot.status = super::super::Status::SignedIn;
            state.session = Some(session.clone());
        }
        let app = tauri::test::mock_builder()
            .manage(crate::PluginManager(Ok(manager)))
            .manage(host)
            .manage(Registrations::default())
            .build(crate::app_context())
            .unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        federated_identity_register(
            app.state(),
            app.state(),
            app.state(),
            "example.fi".into(),
            revision.clone(),
            token.clone(),
        )
        .await
        .unwrap();
        let response = federated_identity_request(
            app.state(),
            app.state(),
            app.state(),
            "example.fi".into(),
            revision,
            token,
            session.record.revision.clone(),
            Request {
                path: "/api/list".into(),
                method: "GET".into(),
                headers: BTreeMap::new(),
                body: None,
            },
        )
        .await
        .unwrap();
        // The caller still gets its own 401; the adapter ended the session.
        assert_eq!(response.status, 401);
        let host = app.state::<FederatedIdentity>();
        assert!(!host.current(&session.record.revision));
        assert!(host.snapshot().status == super::super::Status::ReauthenticationRequired);
        let seen = server.await.unwrap();
        assert_eq!(seen[0].target, "GET /api/list HTTP/1.1");
        assert_eq!(seen[1].target, "GET /mount/v1/session HTTP/1.1");
    }
    #[tokio::test]
    async fn forwarding_adds_only_the_native_bearer_and_returns_refusals() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let count = socket.read(&mut buffer).unwrap();
            let text = String::from_utf8_lossy(&buffer[..count]).to_lowercase();
            socket
                .write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 2\r\n\r\n{}")
                .unwrap();
            text
        });
        let response = forward(
            url::Url::parse(&format!("http://{address}/api/v1/buzz/communities/list")).unwrap(),
            "fixture-session-token",
            Request {
                path: "/api/v1/buzz/communities/list".into(),
                method: "POST".into(),
                headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
                body: Some("{}".into()),
            },
        )
        .await
        .unwrap();
        // A 401 comes back as this call's response, not as a session change.
        assert_eq!(serde_json::to_value(&response).unwrap()["status"], 401);
        let sent = server.join().unwrap();
        assert!(sent.starts_with("post /api/v1/buzz/communities/list "));
        assert!(sent.contains("authorization: bearer fixture-session-token"));
        assert!(!sent.contains("cookie") && !sent.contains("x-bb-"));
    }
}
