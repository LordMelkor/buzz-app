//! Microphone access for Huddles and voice notes on Linux and Windows.
//!
//! macOS keeps Wry's default grant and the TCC prompt. Elsewhere an unhandled
//! request is denied (WebKitGTK) or prompts for `tauri.localhost` (WebView2).
//! Capture belongs to the main app page; the Huddle companion never captures.

use tauri::webview::{PermissionKind, PermissionResponse};
use url::Url;

/// Other permission kinds keep their platform defaults.
pub(crate) fn decide(
    label: &str,
    page: Option<&Url>,
    development: Option<&Url>,
    kind: PermissionKind,
) -> PermissionResponse {
    if !matches!(kind, PermissionKind::Microphone) {
        return PermissionResponse::Default;
    }
    // `tauri://` has an opaque URL origin, so compare scheme and host instead.
    let app_page = page.is_some_and(|page| {
        matches!(
            (page.scheme(), page.host_str()),
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
        ) || development.is_some_and(|development| development.origin() == page.origin())
    });
    if label == "main" && app_page {
        PermissionResponse::Allow
    } else {
        // Deny rather than defer so WebView2 cannot offer its own prompt.
        PermissionResponse::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_app_page_gets_the_microphone() {
        use PermissionResponse::{Allow, Default, Deny};
        let development = Url::parse("http://localhost:1430").unwrap();
        let cases = [
            ("main", "tauri://localhost/", Allow),
            ("main", "http://tauri.localhost/", Allow),
            ("main", "https://tauri.localhost/", Allow),
            ("main", "http://localhost:1430/channels", Allow),
            ("main", "http://localhost:1431/", Deny),
            ("main", "https://example.org/", Deny),
            ("main", "http://tauri.localhost.example.org/", Deny),
            ("huddle", "tauri://localhost/huddle.html", Deny),
        ];
        for (label, page, expected) in cases {
            let page = Url::parse(page).unwrap();
            let decision = decide(
                label,
                Some(&page),
                Some(&development),
                PermissionKind::Microphone,
            );
            assert_eq!(decision, expected, "{label} {page}");
            // Other permissions keep the platform default, even for the app page.
            let decision = decide(
                label,
                Some(&page),
                Some(&development),
                PermissionKind::Camera,
            );
            assert_eq!(decision, Default, "{label} {page}");
        }
        // Packaged builds pass no development origin, so a local server is denied.
        let page = Url::parse("http://localhost:1430/").unwrap();
        assert_eq!(
            decide("main", Some(&page), None, PermissionKind::Microphone),
            Deny
        );
        let decision = decide("main", None, Some(&development), PermissionKind::Microphone);
        assert_eq!(decision, Deny);
    }
}
