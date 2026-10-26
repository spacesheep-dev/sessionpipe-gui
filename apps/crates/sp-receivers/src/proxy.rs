//! The `rx:` protocol (NATIVE-SPEC.md §2.1): the page's requests to a receiver, carried
//! by Rust. This file holds the pure parts (URL mapping, refusals, CORS); `Hub::proxy`
//! does the forwarding.

use http::{HeaderValue, Method, Response, StatusCode};

pub const MAX_BODY: usize = 32 * 1024 * 1024;
pub const TIMEOUT_SECS: u64 = 15;

/// Request headers carried upstream. Everything else the webview adds stays behind.
/// The webview's user-agent goes too, so the receiver labels this device ("Mac").
pub const FORWARD_REQUEST_HEADERS: &[&str] = &[
    "content-type",
    "accept",
    "if-match",
    "if-none-match",
    "user-agent",
];
/// Response headers carried back to the page (status and body always pass).
pub const FORWARD_RESPONSE_HEADERS: &[&str] =
    &["content-type", "etag", "cache-control", "last-modified"];

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NotRx,
    UnknownReceiver,
    BadPath,
    TooLarge,
    BadUpstream,
}

impl Refusal {
    pub fn status(&self) -> StatusCode {
        match self {
            Refusal::NotRx | Refusal::BadPath | Refusal::BadUpstream => StatusCode::BAD_REQUEST,
            Refusal::UnknownReceiver => StatusCode::NOT_FOUND,
            Refusal::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        }
    }
}

/// `rx://localhost/<id>/<path>?<q>` (macOS, iOS, Linux) or `http://rx.localhost/<id>/<path>?<q>`
/// (Windows) → (`id`, `/<path>?<q>`).
pub fn parse_rx_uri(uri: &str) -> Result<(String, String), Refusal> {
    let rest = if let Some(r) = uri.strip_prefix("rx://localhost/") {
        r
    } else if let Some(r) = uri.strip_prefix("http://rx.localhost/") {
        r
    } else {
        return Err(Refusal::NotRx);
    };
    let (id, path) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(Refusal::UnknownReceiver);
    }
    let path = if path.is_empty() || path.starts_with('?') {
        format!("/{path}")
    } else {
        path.to_string()
    };
    check_path(&path)?;
    Ok((id.to_string(), path))
}

/// Refuses `..`, `.` segments (raw or percent-encoded), backslashes, `//` and anything
/// that looks like an absolute URL.
pub fn check_path(path_and_query: &str) -> Result<(), Refusal> {
    let path = path_and_query.split(['?', '#']).next().unwrap_or("");
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(Refusal::BadPath);
    }
    let decoded = percent_decode(path).ok_or(Refusal::BadPath)?;
    if decoded.contains('\\')
        || decoded.contains("://")
        || decoded.contains('\0')
        || decoded.starts_with("//")
    {
        return Err(Refusal::BadPath);
    }
    if decoded.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(Refusal::BadPath);
    }
    // A raw `://` anywhere before decoding, too (`/http:%2F%2Fevil`).
    if path.to_ascii_lowercase().contains("%2f%2f") {
        return Err(Refusal::BadPath);
    }
    Ok(())
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// The upstream URL: the receiver's origin plus the page's path and query. Only http(s).
pub fn upstream_url(origin: &str, path_and_query: &str) -> Result<url::Url, Refusal> {
    let o = url::Url::parse(origin).map_err(|_| Refusal::BadUpstream)?;
    if !matches!(o.scheme(), "http" | "https") {
        return Err(Refusal::BadUpstream);
    }
    let u = url::Url::parse(&format!(
        "{}{}",
        o.origin().ascii_serialization(),
        path_and_query
    ))
    .map_err(|_| Refusal::BadPath)?;
    // Belt and braces: the joined URL must still be on the receiver's origin.
    if u.origin() != o.origin() {
        return Err(Refusal::BadPath);
    }
    Ok(u)
}

/// The bundled origins that may read `rx:` responses.
pub fn default_allowed_origins(dev_url: Option<&str>) -> Vec<String> {
    let mut v = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
    ];
    if cfg!(debug_assertions) {
        if let Some(o) = dev_url.and_then(crate::id::canonical_origin) {
            v.push(o);
        }
    }
    v
}

/// The `Access-Control-Allow-Origin` value for a request's `Origin`, or None.
pub fn allow_origin<'a>(origin: Option<&'a str>, allowed: &[String]) -> Option<&'a str> {
    let o = origin?;
    allowed.iter().any(|a| a == o).then_some(o)
}

fn with_cors(
    mut res: Response<Vec<u8>>,
    origin: Option<&str>,
    allowed: &[String],
) -> Response<Vec<u8>> {
    if let Some(o) = allow_origin(origin, allowed) {
        let h = res.headers_mut();
        if let Ok(v) = HeaderValue::from_str(o) {
            h.insert("access-control-allow-origin", v);
        }
        h.insert(
            "access-control-expose-headers",
            HeaderValue::from_static("etag, content-type"),
        );
    }
    res.headers_mut()
        .insert("vary", HeaderValue::from_static("Origin"));
    res
}

/// The answer to an `OPTIONS` preflight.
pub fn preflight(origin: Option<&str>, allowed: &[String]) -> Response<Vec<u8>> {
    let mut res = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Vec::new())
        .expect("response");
    if allow_origin(origin, allowed).is_some() {
        let h = res.headers_mut();
        h.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        h.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("content-type, accept, if-match, if-none-match"),
        );
        h.insert("access-control-max-age", HeaderValue::from_static("600"));
    }
    with_cors(res, origin, allowed)
}

/// A plain-text error response (with CORS so the page can read the status).
pub fn refusal(
    status: StatusCode,
    msg: &str,
    origin: Option<&str>,
    allowed: &[String],
) -> Response<Vec<u8>> {
    let res = Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .expect("response");
    with_cors(res, origin, allowed)
}

pub fn finish(
    res: Response<Vec<u8>>,
    origin: Option<&str>,
    allowed: &[String],
) -> Response<Vec<u8>> {
    with_cors(res, origin, allowed)
}

pub fn is_preflight(m: &Method) -> bool {
    m == Method::OPTIONS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_both_url_forms() {
        assert_eq!(
            parse_rx_uri("rx://localhost/abc234defg/api/ui/info?x=1").unwrap(),
            ("abc234defg".into(), "/api/ui/info?x=1".into())
        );
        assert_eq!(
            parse_rx_uri("http://rx.localhost/abc234defg/api/ui/sessions/claude/1").unwrap(),
            ("abc234defg".into(), "/api/ui/sessions/claude/1".into())
        );
        assert_eq!(
            parse_rx_uri("rx://localhost/abc234defg").unwrap(),
            ("abc234defg".into(), "/".into())
        );
        assert_eq!(
            parse_rx_uri("rx://localhost/abc234defg?q=1").unwrap(),
            ("abc234defg".into(), "/?q=1".into())
        );
        assert_eq!(parse_rx_uri("https://evil.com/abc/x"), Err(Refusal::NotRx));
        assert_eq!(parse_rx_uri("rx://other/abc/x"), Err(Refusal::NotRx));
        assert_eq!(
            parse_rx_uri("rx://localhost//x"),
            Err(Refusal::UnknownReceiver)
        );
        assert_eq!(
            parse_rx_uri("rx://localhost/ABC/x"),
            Err(Refusal::UnknownReceiver)
        );
    }

    #[test]
    fn refuses_traversal_and_absolute_urls() {
        for bad in [
            "rx://localhost/abc/../etc/passwd",
            "rx://localhost/abc/api/../../x",
            "rx://localhost/abc/%2e%2e/x",
            "rx://localhost/abc/%2E%2E%2Fx",
            "rx://localhost/abc/./x",
            "rx://localhost/abc//evil.com/x",
            "rx://localhost/abc/http://evil.com/",
            "rx://localhost/abc/http:%2F%2Fevil.com",
            "rx://localhost/abc/a\\b",
            "rx://localhost/abc/%zz",
        ] {
            assert_eq!(parse_rx_uri(bad), Err(Refusal::BadPath), "{bad}");
        }
        // Dots inside names are fine.
        assert!(parse_rx_uri("rx://localhost/abc/brand/mark.svg").is_ok());
        assert!(parse_rx_uri("rx://localhost/abc/x..y/z").is_ok());
        // `..` in the query is not a path.
        assert!(parse_rx_uri("rx://localhost/abc/api/ui/search?q=../x").is_ok());
    }

    #[test]
    fn upstream_stays_on_origin_and_only_http() {
        assert_eq!(
            upstream_url("http://127.0.0.1:7811", "/api/ui/info?a=b")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:7811/api/ui/info?a=b"
        );
        assert_eq!(upstream_url("file:///etc", "/x"), Err(Refusal::BadUpstream));
        assert_eq!(upstream_url("ftp://h", "/x"), Err(Refusal::BadUpstream));
        assert_eq!(
            upstream_url("http://a", "@evil.com/x"),
            Err(Refusal::BadPath)
        );
    }

    #[test]
    fn cors_only_for_the_bundled_origins() {
        let allowed = default_allowed_origins(Some("http://127.0.0.1:7812"));
        assert!(
            allowed.contains(&"http://127.0.0.1:7812".to_string()),
            "debug devUrl is allowed in tests"
        );
        assert_eq!(
            allow_origin(Some("tauri://localhost"), &allowed),
            Some("tauri://localhost")
        );
        assert_eq!(
            allow_origin(Some("http://tauri.localhost"), &allowed),
            Some("http://tauri.localhost")
        );
        assert_eq!(allow_origin(Some("http://127.0.0.1:7811"), &allowed), None);
        assert_eq!(allow_origin(Some("https://evil.com"), &allowed), None);
        assert_eq!(allow_origin(None, &allowed), None);
        let r = finish(Response::new(vec![]), Some("https://evil.com"), &allowed);
        assert!(r.headers().get("access-control-allow-origin").is_none());
        let r = finish(Response::new(vec![]), Some("tauri://localhost"), &allowed);
        assert_eq!(
            r.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
    }

    #[test]
    fn options_preflight() {
        let allowed = default_allowed_origins(None);
        let r = preflight(Some("tauri://localhost"), &allowed);
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            r.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
        assert!(r.headers()["access-control-allow-methods"]
            .to_str()
            .unwrap()
            .contains("POST"));
        assert!(r.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("content-type"));
        let r = preflight(Some("https://evil.com"), &allowed);
        assert!(r.headers().get("access-control-allow-origin").is_none());
        assert!(r.headers().get("access-control-allow-methods").is_none());
    }
}
