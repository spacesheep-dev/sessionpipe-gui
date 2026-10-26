//! `sessionpipe://` links (NATIVE-SPEC.md §3.6). A link navigates or prefills; it never
//! signs, sends, approves or adds a receiver without a native confirmation. Every
//! parameter is validated; anything else is ignored and logged.
//!
//! Dev builds declare no URL scheme: links arrive through `--deep-link <url>` (argv, also
//! forwarded by packaging's single-instance plugin) and the unit tests below.

use std::collections::HashMap;
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Page {
    Inbox,
    Feed,
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Open,
    Session {
        harness: String,
        id: String,
        rx: Option<String>,
    },
    Page(Page),
    New {
        rx: Option<String>,
        machine: Option<String>,
        harness: Option<String>,
        folder: Option<String>,
    },
    Pair {
        code: String,
        rx: Option<String>,
    },
    Connect {
        url: String,
        key: Option<String>,
        ca: Option<String>,
    },
}

fn ok_rx(s: &str) -> bool {
    s.len() == 10
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c))
}
fn ok_harness(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}
fn ok_session_id(s: &str) -> bool {
    (1..=200).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
        && s != "."
        && s != ".."
}
fn ok_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}
fn ok_code(s: &str) -> bool {
    (4..=12).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
fn ok_key(s: &str) -> bool {
    (1..=200).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Parses and validates a link. `Err` says why it was ignored (for the log).
pub fn parse(link: &str) -> Result<DeepLink, String> {
    let u = url::Url::parse(link.trim()).map_err(|e| format!("not a URL: {e}"))?;
    if u.scheme() != "sessionpipe" {
        return Err(format!("scheme {}", u.scheme()));
    }
    if u.username() != "" || u.password().is_some() || u.port().is_some() || u.fragment().is_some()
    {
        return Err("unexpected URL parts".into());
    }
    let host = u.host_str().unwrap_or("");
    let segs: Vec<String> = u
        .path_segments()
        .map(|s| {
            s.filter(|x| !x.is_empty())
                .map(percent_decode)
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or(Some(vec![]))
        .ok_or("bad escape")?;
    let mut q: HashMap<String, String> = HashMap::new();
    for (k, v) in u.query_pairs() {
        if q.insert(k.to_string(), v.to_string()).is_some() {
            return Err(format!("repeated parameter {k}"));
        }
    }
    let allow = |keys: &[&str]| -> Result<(), String> {
        match q.keys().find(|k| !keys.contains(&k.as_str())) {
            Some(k) => Err(format!("unknown parameter {k}")),
            None => Ok(()),
        }
    };
    let rx = |q: &HashMap<String, String>| -> Result<Option<String>, String> {
        match q.get("rx") {
            None => Ok(None),
            Some(r) if ok_rx(r) => Ok(Some(r.clone())),
            Some(_) => Err("bad rx".into()),
        }
    };
    let opt = |q: &HashMap<String, String>,
               k: &str,
               ok: &dyn Fn(&str) -> bool|
     -> Result<Option<String>, String> {
        match q.get(k) {
            None => Ok(None),
            Some(v) if v.is_empty() => Ok(None),
            Some(v) if ok(v) => Ok(Some(v.clone())),
            Some(_) => Err(format!("bad {k}")),
        }
    };
    match (host, segs.as_slice()) {
        ("open", []) => {
            allow(&[])?;
            Ok(DeepLink::Open)
        }
        ("inbox", []) | ("feed", []) | ("settings", []) => {
            allow(&[])?;
            Ok(DeepLink::Page(match host {
                "inbox" => Page::Inbox,
                "feed" => Page::Feed,
                _ => Page::Settings,
            }))
        }
        ("session", [h, id]) => {
            allow(&["rx"])?;
            if !ok_harness(h) || !ok_session_id(id) {
                return Err("bad session".into());
            }
            Ok(DeepLink::Session {
                harness: h.clone(),
                id: id.clone(),
                rx: rx(&q)?,
            })
        }
        ("new", []) => {
            allow(&["rx", "machine", "harness", "folder"])?;
            Ok(DeepLink::New {
                rx: rx(&q)?,
                machine: opt(&q, "machine", &|s| ok_text(s, 100))?,
                harness: opt(&q, "harness", &ok_harness)?,
                folder: opt(&q, "folder", &|s| {
                    ok_text(s, 1024)
                        && (s.starts_with('/')
                            || s.starts_with('~')
                            || s.as_bytes().get(1) == Some(&b':'))
                })?,
            })
        }
        ("pair", [code]) => {
            allow(&["rx"])?;
            if !ok_code(code) {
                return Err("bad pairing code".into());
            }
            Ok(DeepLink::Pair {
                code: code.clone(),
                rx: rx(&q)?,
            })
        }
        ("connect", []) => {
            allow(&["url", "k", "ca"])?;
            let raw = q.get("url").ok_or("connect needs url")?;
            let origin =
                sp_receivers::id::canonical_origin(raw).ok_or("connect url is not http(s)")?;
            let key = opt(&q, "k", &ok_key)?;
            let ca = match q.get("ca") {
                None => None,
                Some(c) => Some(sp_receivers::normalise_sha256(c).ok_or("bad ca")?),
            };
            Ok(DeepLink::Connect {
                url: origin,
                key,
                ca,
            })
        }
        _ => Err(format!("unknown route {host}/{}", segs.join("/"))),
    }
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
    String::from_utf8(out).ok()
}

/// Finds `--deep-link <url>` (or `--deep-link=<url>`) in argv.
pub fn from_argv<I: IntoIterator<Item = String>>(argv: I) -> Option<String> {
    let mut it = argv.into_iter();
    while let Some(a) = it.next() {
        if a == "--deep-link" {
            return it.next();
        }
        if let Some(v) = a.strip_prefix("--deep-link=") {
            return Some(v.to_string());
        }
    }
    None
}

/// The page path a link opens (None: just bring the window forward or act natively).
pub fn page_path(l: &DeepLink) -> Option<String> {
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    match l {
        DeepLink::Open | DeepLink::Connect { .. } | DeepLink::New { .. } => None,
        DeepLink::Page(Page::Inbox) => Some("/inbox".into()),
        DeepLink::Page(Page::Feed) => Some("/feed".into()),
        DeepLink::Page(Page::Settings) => Some("/settings".into()),
        DeepLink::Session { harness, id, .. } => Some(format!("/s/{}/{}", enc(harness), enc(id))),
        DeepLink::Pair { code, .. } => Some(format!("/pair?code={}", enc(code))),
    }
}

/// The entry packaging's single-instance code (and argv at launch) calls.
pub fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let link = match parse(url) {
        Ok(l) => l,
        Err(why) => {
            log::warn!("deep link ignored ({why})");
            return;
        }
    };
    crate::actions::deep_link(app, link);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RX: &str = "abcdefgh23";

    #[test]
    fn every_route() {
        assert_eq!(parse("sessionpipe://open"), Ok(DeepLink::Open));
        assert_eq!(parse("sessionpipe://open/"), Ok(DeepLink::Open));
        assert_eq!(
            parse("sessionpipe://inbox"),
            Ok(DeepLink::Page(Page::Inbox))
        );
        assert_eq!(parse("sessionpipe://feed"), Ok(DeepLink::Page(Page::Feed)));
        assert_eq!(
            parse("sessionpipe://settings"),
            Ok(DeepLink::Page(Page::Settings))
        );
        assert_eq!(
            parse(&format!("sessionpipe://session/claude/4f2a-91.x?rx={RX}")),
            Ok(DeepLink::Session {
                harness: "claude".into(),
                id: "4f2a-91.x".into(),
                rx: Some(RX.into())
            })
        );
        assert_eq!(
            parse("sessionpipe://session/codex/abc"),
            Ok(DeepLink::Session {
                harness: "codex".into(),
                id: "abc".into(),
                rx: None
            })
        );
        assert_eq!(
            parse(&format!("sessionpipe://new?rx={RX}&machine=studio-mac&harness=claude&folder=%2FUsers%2Fm%2Fsrc")),
            Ok(DeepLink::New {
                rx: Some(RX.into()),
                machine: Some("studio-mac".into()),
                harness: Some("claude".into()),
                folder: Some("/Users/m/src".into())
            })
        );
        assert_eq!(
            parse("sessionpipe://new"),
            Ok(DeepLink::New {
                rx: None,
                machine: None,
                harness: None,
                folder: None
            })
        );
        assert_eq!(
            parse(&format!("sessionpipe://pair/482913?rx={RX}")),
            Ok(DeepLink::Pair {
                code: "482913".into(),
                rx: Some(RX.into())
            })
        );
        let ca = "ab".repeat(32);
        assert_eq!(
            parse(&format!("sessionpipe://connect?url=https%3A%2F%2Fstudio-mac.local%3A7373%2F%3Fk%3Dx&k=key_1-A&ca={ca}")),
            Ok(DeepLink::Connect { url: "https://studio-mac.local:7373".into(), key: Some("key_1-A".into()), ca: Some(ca.clone()) })
        );
        assert_eq!(
            parse("sessionpipe://connect?url=http://192.168.1.9:7373"),
            Ok(DeepLink::Connect {
                url: "http://192.168.1.9:7373".into(),
                key: None,
                ca: None
            })
        );
    }

    #[test]
    fn junk_is_refused() {
        for bad in [
            "",
            "nonsense",
            "https://open",
            "sessionpipe-dev://open",
            "sessionpipe://",
            "sessionpipe://unknown",
            "sessionpipe://open?x=1",
            "sessionpipe://open#frag",
            "sessionpipe://user:pw@open",
            "sessionpipe://open:99",
            "sessionpipe://inbox/extra",
            "sessionpipe://session/claude",
            "sessionpipe://session/claude/a/b",
            "sessionpipe://session/Claude!/x",
            "sessionpipe://session/claude/..",
            "sessionpipe://session/claude/%2e%2e",
            "sessionpipe://session/claude/a%2Fb",
            "sessionpipe://session/claude/x?rx=SHORT",
            "sessionpipe://session/claude/x?rx=abcdefgh23&rx=abcdefgh23",
            "sessionpipe://session/claude/x?send=1",
            "sessionpipe://new?message=rm%20-rf",
            "sessionpipe://new?folder=relative/path",
            "sessionpipe://new?machine=a%0Ab",
            "sessionpipe://pair/12",
            "sessionpipe://pair/12%2034",
            "sessionpipe://connect",
            "sessionpipe://connect?url=javascript:alert(1)",
            "sessionpipe://connect?url=file:///etc/passwd",
            "sessionpipe://connect?url=http://a&ca=nothex",
            "sessionpipe://connect?url=http://a&k=sp%20ace",
            "sessionpipe://connect?url=http://a&approve=1",
        ] {
            assert!(
                parse(bad).is_err(),
                "{bad} should be refused, got {:?}",
                parse(bad)
            );
        }
    }

    #[test]
    fn argv_and_paths() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            from_argv(a(&["app", "--deep-link", "sessionpipe://open"])).as_deref(),
            Some("sessionpipe://open")
        );
        assert_eq!(
            from_argv(a(&["app", "--deep-link=sessionpipe://inbox"])).as_deref(),
            Some("sessionpipe://inbox")
        );
        assert_eq!(from_argv(a(&["app", "sessionpipe://open"])), None);
        assert_eq!(
            page_path(&parse("sessionpipe://session/claude/a.b").unwrap()).as_deref(),
            Some("/s/claude/a.b")
        );
        assert_eq!(
            page_path(&parse("sessionpipe://pair/1234").unwrap()).as_deref(),
            Some("/pair?code=1234")
        );
        assert_eq!(
            page_path(&parse("sessionpipe://inbox").unwrap()).as_deref(),
            Some("/inbox")
        );
        assert_eq!(page_path(&DeepLink::Open), None);
    }
}
