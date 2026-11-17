//! `host.publish`: signs and publishes one event of a kind the calling plugin's
//! manifest declares in `host.relayKinds`. The grant and the reserved kinds are
//! read here, not trusted from the page. The event is signed once, sent once and
//! never replayed: a retry is a new call whose same template makes the same id.
use super::*;
use crate::{with_manager, PluginManager};
use buzzodz_plugins::{reserved_relay_kind, HostGrants};

/// Longest relay text handed back, in characters.
const MESSAGE_CHARS: usize = 512;
/// Statuses in which the relay refuses the event itself, with its own words.
const REFUSALS: [u16; 8] = [400, 401, 403, 404, 409, 413, 422, 429];

#[derive(Serialize)]
pub(crate) struct Publication {
    event_id: String,
    accepted: bool,
    message: String,
}

fn admit(grants: &HostGrants, event: &EventTemplate) -> Result<()> {
    if !grants.relay_kinds.contains(&event.kind) {
        return Err("This plugin did not declare that event kind".into());
    }
    if reserved_relay_kind(event.kind) {
        return Err("Buzz keeps that event kind for its own use".into());
    }
    if event.created_at > 9_007_199_254_740_991 {
        return Err("Invalid event time".into());
    }
    buzz_agent_controller::bounded(event.kind, &event.content, &event.tags)
}

fn text(value: &str) -> String {
    value.chars().take(MESSAGE_CHARS).collect()
}

/// The relay's answer for `id`. Only its own receipt or refusal is an outcome;
/// anything else may have reached it, so the caller must not treat it as a no.
fn outcome(response: RelayResponse, id: &str) -> Result<Publication> {
    let body: Option<serde_json::Value> = serde_json::from_str(&response.body).ok();
    let field = |name: &str| body.as_ref().and_then(|body| body[name].as_str());
    let publication = |accepted: bool, message: &str| Publication {
        event_id: id.into(),
        accepted,
        message: text(message),
    };
    if (200..300).contains(&response.status) {
        let accepted = body.as_ref().and_then(|body| body["accepted"].as_bool());
        return match (accepted, field("event_id")) {
            (Some(accepted), Some(received)) if received == id => {
                Ok(publication(accepted, field("message").unwrap_or_default()))
            }
            _ => Err("Relay returned an invalid delivery receipt; outcome unknown".into()),
        };
    }
    if REFUSALS.contains(&response.status) {
        let status = format!("Relay rejected the event ({})", response.status);
        return Ok(publication(false, field("error").unwrap_or(&status)));
    }
    Err(format!(
        "Relay delivery could not be confirmed ({}); outcome unknown",
        response.status
    ))
}

pub(super) async fn publish(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: Url,
    grants: &HostGrants,
    viewer: &str,
    event: EventTemplate,
) -> Result<Publication> {
    admit(grants, &event)?;
    if host.viewer().await? != viewer {
        return Err("Your identity changed. Try again.".into());
    }
    let signed = host.sign(event).await?;
    let id = signed["id"]
        .as_str()
        .ok_or("Invalid signed event")?
        .to_owned();
    if signed["pubkey"] != viewer {
        return Err("Your identity changed. Try again.".into());
    }
    // No host age check: whether an old event is accepted is the relay's answer.
    let response = send(
        host,
        fi,
        url,
        "POST",
        Some(signed.to_string()),
        true,
        64 * 1024,
    )
    .await?;
    outcome(response, &id)
}

/// `viewer` and `community` are what the page's selected session named when it
/// asked; a different signed-in key refuses before anything is signed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_host_relay_publish(
    manager: tauri::State<'_, PluginManager>,
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    id: String,
    revision: String,
    community: String,
    viewer: String,
    event: EventTemplate,
) -> Result<Publication> {
    let url = request_url(&community, "/events", "POST")?;
    let grants = with_manager(manager, move |manager| manager.host_grants(&id, &revision))
        .await
        .map_err(|_| "Relay publishing is unavailable")?;
    publish(host.inner(), Some(fi.inner()), url, &grants, &viewer, event).await
}

#[cfg(test)]
mod tests {
    use super::super::tests::fixture_server;
    use super::*;
    use std::net::TcpListener;

    fn grants(kinds: &[u16]) -> HostGrants {
        HostGrants {
            relay_kinds: kinds.to_vec(),
            ..Default::default()
        }
    }
    fn template(kind: u16, created_at: u64) -> EventTemplate {
        EventTemplate {
            kind,
            created_at,
            tags: vec![
                vec!["z".into(), "second".into()],
                vec!["a".into(), "first".into()],
            ],
            content: "{\"n\":1}".into(),
        }
    }
    /// What the fixture relay answers: the body is the relay's own JSON.
    fn reply(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }
    async fn id_of(host: &IdentityHost, event: EventTemplate) -> String {
        host.sign(event).await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    /// A relay that must never be asked.
    fn silent() -> (Url, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!("http://{}/events", listener.local_addr().unwrap())).unwrap();
        (url, listener)
    }
    fn untouched(listener: &TcpListener) {
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn a_declared_kind_is_signed_by_the_viewer_and_sent_in_order() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let id = id_of(&host, template(47000, 1_700_000_000)).await;
        let (url, relay) = fixture_server(reply(
            "200 OK",
            &format!(r#"{{"event_id":"{id}","accepted":true,"message":"stored"}}"#),
        ));
        let result = publish(
            &host,
            None,
            url,
            &grants(&[47001, 47000]),
            &viewer,
            template(47000, 1_700_000_000),
        )
        .await
        .unwrap();
        assert_eq!(
            (result.event_id, result.accepted, result.message),
            (id.clone(), true, "stored".to_owned())
        );
        let (_, body) = relay.join().unwrap();
        let sent: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            (sent["kind"].as_u64(), sent["id"].as_str()),
            (Some(47000), Some(id.as_str()))
        );
        assert_eq!(sent["pubkey"], viewer.as_str());
        assert_eq!(sent["created_at"], 1_700_000_000);
        assert_eq!(
            sent["tags"],
            serde_json::json!([["z", "second"], ["a", "first"]])
        );
        verify_signature(&sent).unwrap();
    }

    #[tokio::test]
    async fn an_undeclared_kind_never_reaches_the_relay() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let (url, relay) = silent();
        for declared in [&[][..], &[47001][..]] {
            let error = publish(
                &host,
                None,
                url.clone(),
                &grants(declared),
                &viewer,
                template(47000, 1),
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error, "This plugin did not declare that event kind");
        }
        untouched(&relay);
    }

    #[tokio::test]
    async fn a_reserved_kind_is_refused_even_when_a_grant_lists_it() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let (url, relay) = silent();
        for kind in [1984, 9007, 22242, 27235, 30078, 41010, 45010] {
            let error = publish(
                &host,
                None,
                url.clone(),
                &grants(&[kind]),
                &viewer,
                template(kind, 1),
            )
            .await
            .err()
            .unwrap();
            assert_eq!(
                error, "Buzz keeps that event kind for its own use",
                "{kind}"
            );
        }
        untouched(&relay);
    }

    #[tokio::test]
    async fn another_signed_in_key_or_an_oversized_event_is_refused_before_signing() {
        let host = IdentityHost::fixture();
        let (url, relay) = silent();
        let other = "ab".repeat(32);
        let error = publish(
            &host,
            None,
            url.clone(),
            &grants(&[47000]),
            &other,
            template(47000, 1),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error, "Your identity changed. Try again.");
        let viewer = host.viewer().await.unwrap();
        let mut large = template(47000, 1);
        large.content = "x".repeat(64 * 1024 + 1);
        let error = publish(&host, None, url, &grants(&[47000]), &viewer, large)
            .await
            .err()
            .unwrap();
        assert_eq!(error, "Event is too large");
        untouched(&relay);
    }

    #[tokio::test]
    async fn the_relays_own_refusal_text_comes_back_unchanged_for_every_conflict() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let id = id_of(&host, template(47000, 1)).await;
        for (status, body, message) in [
            (
                "409 Conflict",
                r#"{"error":"duplicate: that name is taken"}"#,
                "duplicate: that name is taken",
            ),
            (
                "409 Conflict",
                r#"{"error":"conflict: expected revision abc"}"#,
                "conflict: expected revision abc",
            ),
            (
                "403 Forbidden",
                r#"{"error":"restricted: members only"}"#,
                "restricted: members only",
            ),
            (
                "429 Too Many Requests",
                r#"{"error":"rate-limited: slow down"}"#,
                "rate-limited: slow down",
            ),
            (
                "422 Unprocessable Entity",
                "not json",
                "Relay rejected the event (422)",
            ),
        ] {
            let (url, relay) = fixture_server(reply(status, body));
            let result = publish(
                &host,
                None,
                url,
                &grants(&[47000]),
                &viewer,
                template(47000, 1),
            )
            .await
            .unwrap();
            relay.join().unwrap();
            assert_eq!(
                (
                    result.event_id.as_str(),
                    result.accepted,
                    result.message.as_str()
                ),
                (id.as_str(), false, message)
            );
        }
        let (url, relay) = fixture_server(reply(
            "200 OK",
            &format!(r#"{{"event_id":"{id}","accepted":false,"message":"blocked: not allowed"}}"#),
        ));
        let result = publish(
            &host,
            None,
            url,
            &grants(&[47000]),
            &viewer,
            template(47000, 1),
        )
        .await
        .unwrap();
        relay.join().unwrap();
        assert_eq!(
            (result.accepted, result.message.as_str()),
            (false, "blocked: not allowed")
        );
    }

    #[tokio::test]
    async fn an_answer_that_is_not_the_relays_receipt_is_an_unknown_outcome() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        for (status, body) in [
            ("500 Internal Server Error", r#"{"error":"error: boom"}"#),
            ("503 Service Unavailable", r#"{"sent":false}"#),
            ("200 OK", r#"{"event_id":"other","accepted":true}"#),
            ("200 OK", "<html>captive portal</html>"),
        ] {
            let (url, relay) = fixture_server(reply(status, body));
            let error = publish(
                &host,
                None,
                url,
                &grants(&[47000]),
                &viewer,
                template(47000, 1),
            )
            .await
            .err()
            .unwrap();
            relay.join().unwrap();
            assert!(error.contains("outcome unknown"), "{status}: {error}");
        }
    }

    #[tokio::test]
    async fn a_long_relay_text_is_cut_by_characters() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let long = "é".repeat(MESSAGE_CHARS + 100);
        let (url, relay) =
            fixture_server(reply("409 Conflict", &format!(r#"{{"error":"{long}"}}"#)));
        let result = publish(
            &host,
            None,
            url,
            &grants(&[47000]),
            &viewer,
            template(47000, 1),
        )
        .await
        .unwrap();
        relay.join().unwrap();
        assert_eq!(result.message.chars().count(), MESSAGE_CHARS);
    }

    #[tokio::test]
    async fn the_same_template_is_sent_as_the_same_event_even_when_hours_old() {
        let host = IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        let old = 1_700_000_000;
        let id = id_of(&host, template(47000, old)).await;
        let mut sent = Vec::new();
        for _ in 0..2 {
            let (url, relay) = fixture_server(reply(
                "200 OK",
                &format!(
                    r#"{{"event_id":"{id}","accepted":true,"message":"duplicate: already stored"}}"#
                ),
            ));
            let result = publish(
                &host,
                None,
                url,
                &grants(&[47000]),
                &viewer,
                template(47000, old),
            )
            .await
            .unwrap();
            assert_eq!(result.message, "duplicate: already stored");
            let (_, body) = relay.join().unwrap();
            sent.push(serde_json::from_str::<serde_json::Value>(&body).unwrap());
        }
        assert_eq!(sent[0]["id"], sent[1]["id"]);
        assert_eq!(sent[0]["id"], id.as_str());
        assert_eq!(sent[1]["created_at"], old);
    }
}
