use super::*;
use tauri::ipc::InvokeResponseBody;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

fn channel() -> (
    Channel<McpEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

async fn next(events: &mut mpsc::UnboundedReceiver<serde_json::Value>) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("MCP event")
        .expect("open channel")
}

/// The `host:port` of `info`'s server.
fn authority(info: &McpServerInfo) -> &str {
    info.url
        .trim_start_matches("http://")
        .trim_end_matches(ENDPOINT)
}

/// Sends a raw request to `info`'s server and returns the whole response.
async fn send(info: &McpServerInfo, request: String) -> String {
    let authority = authority(info);
    let mut socket = TcpStream::connect(authority).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    response
}

fn post(info: &McpServerInfo, token: &str, extra: &str, body: &str) -> String {
    let authority = authority(info);
    format!(
        "POST /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n{extra}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn status(response: &str) -> &str {
    response.split(' ').nth(1).unwrap_or_default()
}

#[tokio::test]
async fn answers_a_request_with_the_page_reply() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    assert!(info.url.starts_with("http://127.0.0.1:"));
    let named = initialize(&servers, &info, &mut events).await;
    let request = post(
        &info,
        &info.token,
        &named,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
    );
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let event = next(&mut events).await;
    assert_eq!(event["type"], "message");
    assert_eq!(
        event["body"],
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
    );
    let reply = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
    // Another plugin cannot answer it.
    assert!(servers
        .reply(
            "other",
            info.handle,
            event["request"].as_u64().unwrap(),
            Some(reply.into())
        )
        .is_err());
    servers
        .reply(
            "plugin",
            info.handle,
            event["request"].as_u64().unwrap(),
            Some(reply.into()),
        )
        .unwrap();
    let response = client.await.unwrap();
    assert_eq!(status(&response), "200");
    assert!(response
        .to_ascii_lowercase()
        .contains("content-type: application/json\r\n"));
    assert!(response.ends_with(reply));
}

#[tokio::test]
async fn accepts_a_notification_without_a_body() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    let named = initialize(&servers, &info, &mut events).await;
    let request = post(
        &info,
        &info.token,
        &named,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    );
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let event = next(&mut events).await;
    servers
        .reply(
            "plugin",
            info.handle,
            event["request"].as_u64().unwrap(),
            None,
        )
        .unwrap();
    assert_eq!(status(&client.await.unwrap()), "202");
}

/// The `Mcp-Session-Id` a response names.
fn session(response: &str) -> Option<&str> {
    response
        .split("\r\n")
        .find_map(|line| line.strip_prefix("mcp-session-id: "))
}

/// Sends `request` and answers the message it carries with `reply`.
async fn exchange(
    servers: &HostMcpServers,
    info: &McpServerInfo,
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    request: String,
    reply: Option<&str>,
) -> String {
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let event = next(events).await;
    servers
        .reply(
            "plugin",
            info.handle,
            event["request"].as_u64().unwrap(),
            reply.map(Into::into),
        )
        .unwrap();
    client.await.unwrap()
}

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
const INITIALIZED: &str = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;

/// Claims `info`'s session, returning the header that names it.
async fn initialize(
    servers: &HostMcpServers,
    info: &McpServerInfo,
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
) -> String {
    let request = post(info, &info.token, "", INITIALIZE);
    let response = exchange(servers, info, events, request, Some(INITIALIZED)).await;
    assert_eq!(status(&response), "200");
    format!(
        "Mcp-Session-Id: {}\r\n",
        session(&response).expect("a session id")
    )
}

#[tokio::test]
async fn admits_only_the_session_that_initialized() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    // Before `initialize`, discovery needs no session and joins none; a tool
    // call is refused.
    let discover = r#"{"jsonrpc":"2.0","id":0,"method":"server/discover"}"#;
    let not_found = r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"No"}}"#;
    let request = post(&info, &info.token, "", discover);
    let response = exchange(&servers, &info, &mut events, request, Some(not_found)).await;
    assert_eq!(status(&response), "200");
    assert_eq!(session(&response), None);
    let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send"}}"#;
    let request = post(&info, &info.token, "", call);
    assert_eq!(status(&send(&info, request).await), "404");
    assert!(events.try_recv().is_err());

    let named = initialize(&servers, &info, &mut events).await;
    // The token alone, as read from where the agent saved it, admits nothing
    // more, nor does a guessed session.
    for extra in ["", "Mcp-Session-Id: guess\r\n"] {
        let request = post(&info, &info.token, extra, call);
        assert_eq!(status(&send(&info, request).await), "404");
    }
    assert!(events.try_recv().is_err());
    let request = post(&info, &info.token, &named, call);
    let response = exchange(&servers, &info, &mut events, request, None).await;
    assert_eq!(status(&response), "202");
    assert_eq!(
        session(&response).map(|id| format!("Mcp-Session-Id: {id}\r\n")),
        Some(named)
    );
}

#[tokio::test]
async fn stops_when_a_second_client_initializes() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    initialize(&servers, &info, &mut events).await;
    // Whoever claimed the session, two clients hold the token.
    let request = post(&info, &info.token, "", INITIALIZE);
    assert_eq!(status(&send(&info, request).await), "404");
    assert_eq!(next(&mut events).await["type"], "closed");
}

#[tokio::test]
async fn child_initialization_keeps_parent_callbacks_alive() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, true)
        .unwrap();
    let parent = initialize(&servers, &info, &mut events).await;
    let request = post(&info, &info.token, "", INITIALIZE);
    let child = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let event = next(&mut events).await;
    assert_eq!(
        event["type"], "message",
        "child initialization must not close the parent server"
    );
    servers
        .reply(
            "plugin",
            info.handle,
            event["request"].as_u64().unwrap(),
            Some(INITIALIZED.into()),
        )
        .unwrap();
    let response = child.await.unwrap();
    assert_eq!(status(&response), "200");
    assert_eq!(
        session(&response).map(|id| format!("Mcp-Session-Id: {id}\r\n")),
        Some(parent.clone())
    );
    // A failed joining client must not revoke the working parent's session.
    let request = post(&info, &info.token, "", INITIALIZE);
    let failed = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"No"}}"#;
    let response = exchange(&servers, &info, &mut events, request, Some(failed)).await;
    assert_eq!(session(&response), None);
    // Shared initialization still requires the token, and calls still require
    // the session ID. Refusing a request must leave the server running.
    for (token, extra, body) in [
        ("wrong", "", INITIALIZE),
        (info.token.as_str(), "Mcp-Session-Id: wrong\r\n", INITIALIZE),
        (
            info.token.as_str(),
            "",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call"}"#,
        ),
    ] {
        assert_eq!(
            status(&send(&info, post(&info, token, extra, body)).await),
            "404"
        );
    }
    assert!(events.try_recv().is_err());
    let request = post(
        &info,
        &info.token,
        &parent,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call"}"#,
    );
    assert_eq!(
        status(&exchange(&servers, &info, &mut events, request, Some(INITIALIZED)).await),
        "200"
    );
}

#[tokio::test]
async fn releases_a_claim_that_did_not_succeed() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    let claim = || claim(&servers, &info);
    // The page answered with an error.
    let failed = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"No"}}"#;
    let request = post(&info, &info.token, "", INITIALIZE);
    let response = exchange(&servers, &info, &mut events, request, Some(failed)).await;
    assert_eq!(status(&response), "200");
    assert_eq!(session(&response), None);
    assert_eq!(claim(), UNCLAIMED);
    // The client hung up before the answer.
    let request = post(&info, &info.token, "", INITIALIZE);
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    next(&mut events).await;
    assert_eq!(claim(), CLAIMING);
    client.abort();
    tokio::time::timeout(Duration::from_secs(5), async {
        while claim() != UNCLAIMED {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the claim released");
    initialize(&servers, &info, &mut events).await;
    assert_eq!(claim(), CLAIMED);
}

/// Where `info`'s session claim stands.
fn claim(servers: &HostMcpServers, info: &McpServerInfo) -> u8 {
    servers
        .owned("plugin", info.handle)
        .unwrap()
        .claim
        .load(Ordering::SeqCst)
}

#[tokio::test]
async fn keeps_the_session_across_requests() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    let named = initialize(&servers, &info, &mut events).await;
    let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
    for _ in 0..3 {
        let request = post(&info, &info.token, &named, call);
        let response = exchange(&servers, &info, &mut events, request, None).await;
        assert_eq!(status(&response), "202");
        assert_eq!(claim(&servers, &info), CLAIMED);
    }
    // The session stays claimed, so another `initialize` still stops it.
    let request = post(&info, &info.token, "", INITIALIZE);
    assert_eq!(status(&send(&info, request).await), "404");
    assert_eq!(next(&mut events).await["type"], "closed");
}

#[tokio::test]
async fn holds_the_claim_while_initialize_waits() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    let request = post(&info, &info.token, "", INITIALIZE);
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let initializing = next(&mut events).await;
    assert_eq!(claim(&servers, &info), CLAIMING);
    // A `ping` meanwhile is answered and leaves the claim alone.
    let ping = r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#;
    let request = post(&info, &info.token, "", ping);
    let pong = r#"{"jsonrpc":"2.0","id":3,"result":{}}"#;
    let response = exchange(&servers, &info, &mut events, request, Some(pong)).await;
    assert_eq!(status(&response), "200");
    assert_eq!(session(&response), None);
    assert_eq!(claim(&servers, &info), CLAIMING);
    servers
        .reply(
            "plugin",
            info.handle,
            initializing["request"].as_u64().unwrap(),
            Some(INITIALIZED.into()),
        )
        .unwrap();
    let response = client.await.unwrap();
    assert!(session(&response).is_some());
    assert_eq!(claim(&servers, &info), CLAIMED);
}

#[tokio::test]
async fn refuses_without_starting_oauth() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel, false)
        .unwrap();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    // A wrong token and a web page are both told there is nothing here.
    for request in [
        post(&info, "wrong", "", body),
        post(&info, &info.token, "Origin: https://example.test\r\n", body),
    ] {
        assert_eq!(status(&send(&info, request).await), "404");
    }
    let authority = authority(&info);
    let get = format!(
        "GET /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\nAccept: text/event-stream\r\n\r\n",
        info.token
    );
    assert_eq!(status(&send(&info, get).await), "405");
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn stops_with_the_page() {
    let servers = HostMcpServers::default();
    let (events_channel, mut events) = channel();
    let page = servers.page();
    let info = servers
        .serve(page, "plugin".into(), events_channel, false)
        .unwrap();
    let request = post(
        &info,
        &info.token,
        "",
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    assert_eq!(next(&mut events).await["type"], "message");
    servers.stop_all();
    assert_eq!(next(&mut events).await["type"], "closed");
    // The request waiting on the page is dropped, not left hanging.
    assert!(!client.await.unwrap().contains("200 OK"));
    assert!(servers.reply("plugin", info.handle, 0, None).is_err());
    let (late, _events) = channel();
    assert!(servers.serve(page, "plugin".into(), late, false).is_err());
}
