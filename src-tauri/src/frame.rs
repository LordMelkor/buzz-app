//! `buzz-frame://localhost/`, given to plugins as `host.frameUrl`, is one fixed
//! page that a plugin can fill with any HTML document, scripts included, in an
//! iframe that cannot reach Buzz. The app's own policy blocks inline scripts in
//! `srcdoc` frames, and an opaque-origin frame cannot load the app's `blob:`
//! scripts, so there is no other way to show such a document as a browser
//! would. The page holds no state; see "Isolated frame" in
//! `docs/plugin-architecture.md` for the contract. macOS and Linux only; see
//! where `lib.rs` registers it.
use std::borrow::Cow;

use tauri::http::{header, Method, Request, Response, StatusCode};

/// The response policy every written document keeps. `sandbox` without
/// `allow-same-origin` gives the page an opaque origin, so it cannot read the
/// app's storage and its IPC requests carry `Origin: null`, which Tauri
/// refuses. It covers this page's documents only: the iframe's own `sandbox`
/// attribute is what keeps a page the document moves its frame to sandboxed.
/// Tauri counts this scheme as the app's own, so its `postMessage` IPC route
/// is closed only by the invoke key, which it adds to the main frame only;
/// never add the app's scripts to subframes.
/// The rest is the most the document may load; the plugin narrows it with its
/// own `<meta>` policy, which can only remove access.
const POLICY: &str =
    "sandbox allow-scripts; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'";

/// No device access for a written document, where the engine applies this
/// header. WebKit may not; there the iframe having no `allow` attribute is
/// what denies it.
const PERMISSIONS: &str = "camera=(), microphone=(), geolocation=(), display-capture=()";

/// Waits for `{ type: "buzz-frame:write", html }` from the embedding window,
/// then replaces itself with `html`. It writes only once, and only with an
/// opaque origin.
const PAGE: &str = include_str!("frame.html");

pub(crate) fn frame_protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    page(request.method(), request.uri().path())
}

fn page(method: &Method, path: &str) -> Response<Cow<'static, [u8]>> {
    if method != Method::GET && method != Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    if path != "/" {
        return empty(StatusCode::NOT_FOUND);
    }
    let body: &'static [u8] = if method == Method::HEAD {
        &[]
    } else {
        PAGE.as_bytes()
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, POLICY)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("permissions-policy", PERMISSIONS)
        .body(Cow::Borrowed(body))
        .expect("static response")
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Borrowed(&[][..]))
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_the_page_with_an_opaque_origin_sandbox() {
        let response = page(&Method::GET, "/");
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        let sandbox = policy.split(';').next().unwrap().trim();
        assert_eq!(sandbox, "sandbox allow-scripts");
        assert!(!policy.contains("allow-same-origin"));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert!(headers["permissions-policy"]
            .to_str()
            .unwrap()
            .contains("microphone=()"));
        // The message names are the plugin contract.
        let body = std::str::from_utf8(response.body()).unwrap();
        assert!(body.contains(r#"{ type: "buzz-frame:ready" }"#));
        assert!(body.contains(r#"data.type !== "buzz-frame:write""#));
    }

    #[test]
    fn head_has_the_headers_and_no_body() {
        let response = page(&Method::HEAD, "/");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY));
        assert!(response.body().is_empty());
    }

    #[test]
    fn refuses_other_paths_and_methods() {
        for (method, path, status) in [
            (Method::GET, "/index.html", StatusCode::NOT_FOUND),
            (Method::GET, "/a/b", StatusCode::NOT_FOUND),
            (Method::POST, "/", StatusCode::METHOD_NOT_ALLOWED),
            (Method::PUT, "/", StatusCode::METHOD_NOT_ALLOWED),
        ] {
            let response = page(&method, path);
            assert_eq!(response.status(), status, "{method} {path}");
            assert!(response.body().is_empty());
            assert!(!response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY));
        }
    }
}
