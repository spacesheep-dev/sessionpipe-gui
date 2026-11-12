//! The Hub against a fake spacesheep on loopback: connecting, the doors, what is refused
//! before any network, where the key is and is not, what survives a restart.

use super::*;
use crate::account::AccountConfig;
use crate::registry::{Kind, Registry};
use crate::status::StatusFile;
use crate::testutil::{logged, serve_replies, Reply, Seen, TempDir};
use serde_json::{json, Value};
use std::path::Path;

/// The bundled page's origin on an iPhone.
const APP: &str = "tauri://localhost";
const MACHINE: &str = "m_0123456789abcdefABCD";
const RELAY: &str = "/api/sessionpipe/v1/relay";

#[derive(Clone, Copy, PartialEq)]
enum Verdict {
    Pending,
    Approved,
    Denied,
    Expired,
}

type Hook = Arc<dyn Fn(&Seen) -> Option<Reply> + Send + Sync>;

/// What the fake spacesheep holds.
struct World {
    key: String,
    token: String,
    code: String,
    email: String,
    verdict: Verdict,
    revoked: bool,
    /// The link in the connect answer, when not the real one.
    link: Option<String>,
    /// Answers a request before the routes do.
    hook: Option<Hook>,
    seen: Vec<Seen>,
}

#[derive(Clone)]
struct Fake {
    port: u16,
    w: Arc<Mutex<World>>,
}

impl Fake {
    /// A fake with secrets of its own (`tag` is letters and dashes), so a test can look
    /// for them in every log line of the process.
    async fn start(tag: &str) -> Fake {
        let w = Arc::new(Mutex::new(World {
            key: format!("ss_KEY-{tag}-9f3b1c7a5d2e8f60"),
            token: format!("POLLTOKEN-{tag}-0a1b2c3d4e5f6a7b8c9d"),
            code: format!("{:x<24}", format!("code-{tag}-")),
            email: format!("{tag}@example.com"),
            verdict: Verdict::Pending,
            revoked: false,
            link: None,
            hook: None,
            seen: Vec::new(),
        }));
        let w2 = w.clone();
        let port = Arc::new(Mutex::new(0u16));
        let p2 = port.clone();
        let got = serve_replies(move |s| {
            let origin = format!("http://127.0.0.1:{}", *p2.lock().unwrap());
            let mut w = w2.lock().unwrap();
            w.seen.push(s.clone());
            let hooked = w.hook.as_ref().and_then(|h| h(s));
            hooked.unwrap_or_else(|| route(&w, &origin, s))
        })
        .await;
        *port.lock().unwrap() = got;
        Fake { port: got, w }
    }
    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    fn set(&self, f: impl FnOnce(&mut World)) {
        f(&mut self.w.lock().unwrap())
    }
    fn hook(&self, f: impl Fn(&Seen) -> Option<Reply> + Send + Sync + 'static) {
        self.set(|w| w.hook = Some(Arc::new(f)));
    }
    fn key(&self) -> String {
        self.w.lock().unwrap().key.clone()
    }
    fn token(&self) -> String {
        self.w.lock().unwrap().token.clone()
    }
    fn email(&self) -> String {
        self.w.lock().unwrap().email.clone()
    }
    fn seen(&self) -> Vec<Seen> {
        self.w.lock().unwrap().seen.clone()
    }
    fn count(&self) -> usize {
        self.w.lock().unwrap().seen.len()
    }
    /// Requests whose path starts with `prefix`.
    fn asked(&self, prefix: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|s| s.target().starts_with(prefix))
            .collect()
    }
    fn last(&self) -> Seen {
        self.seen().pop().expect("a request")
    }
    /// The test's secrets are nowhere in `text`.
    fn absent(&self, text: &str, what: &str) {
        assert!(!text.contains(&self.key()), "the key is in {what}");
        assert!(!text.contains(&self.token()), "the poll token is in {what}");
    }
}

/// spacesheep's routes, as its source answers them.
fn route(w: &World, origin: &str, s: &Seen) -> Reply {
    let target = s.target();
    let path = target.split('?').next().unwrap_or("");
    let bearer = |t: &str| s.header("authorization") == Some(format!("Bearer {t}").as_str());
    match (s.method(), path) {
        ("POST", "/api/gui/connect") => {
            let url = w
                .link
                .clone()
                .unwrap_or_else(|| format!("{origin}/connect/gui?code={}", w.code));
            return Reply::json(
                201,
                json!({
                    "code": w.code, "digits": "4821", "url": url, "poll_token": w.token,
                    "expires_at": iso_ms(now_ms() + 600_000),
                })
                .to_string(),
            );
        }
        ("GET", "/api/gui/connect/poll") => {
            if !bearer(&w.token) || target != format!("{path}?code={}", w.code) {
                return Reply::json(401, r#"{"state":"unauthorized"}"#);
            }
            return match w.verdict {
                Verdict::Pending => Reply {
                    status: 204,
                    headers: vec![],
                    body: vec![],
                    delay: None,
                },
                Verdict::Approved => Reply::json(
                    200,
                    json!({ "state": "approved", "key": w.key, "email": w.email, "relay": RELAY })
                        .to_string(),
                ),
                Verdict::Denied => Reply::json(410, r#"{"state":"denied"}"#),
                Verdict::Expired => Reply::json(410, r#"{"state":"expired"}"#),
            };
        }
        _ => {}
    }
    if !bearer(&w.key) || w.revoked {
        return Reply::json(
            401,
            r#"{"error":"Unknown or revoked API key.","code":"unauthorized"}"#,
        );
    }
    let jobs = format!("/api/machines/{MACHINE}/jobs");
    match (s.method(), path) {
        ("GET", RELAY) => Reply::json(200, r#"{"events":[],"next":7,"oldest":null,"protocol":1}"#),
        ("GET", "/api/sessionpipe/v1/relay/machines") => Reply::json(
            200,
            json!({
                "machines": [{ "id": MACHINE, "name": "studio-mac", "online": true }],
                "rp_id": "localhost", "origin": origin,
            })
            .to_string(),
        ),
        ("GET", "/api/sessionpipe/v1/relay/jobs") => Reply::json(200, r#"{"jobs":[]}"#),
        ("POST", p) if p == jobs => Reply::json(202, r#"{"job":7}"#),
        ("POST", "/api/gui/device") => Reply::json(
            200,
            r#"{"id":1,"key_id":"k","code":"71","trusted_on":[],"devices_url":"x"}"#,
        ),
        ("GET", "/api/gui/device") => {
            Reply::json(200, r#"{"trusted_on":[],"machines":[],"pending":false}"#)
        }
        _ => Reply::json(404, r#"{"error":"not found"}"#),
    }
}

/// A Hub in `home`: accounts on or off, the local dev server allowed or not, the account
/// keys in a file of their own (so a test can see exactly where the key is).
fn hub_with(home: &Path, enabled: bool, allow_local_http: bool) -> Hub {
    logged();
    Hub::new(HubConfig {
        home: home.to_path_buf(),
        keys: KeyStore::File(home.join("keys.json")),
        env_receiver_url: None,
        allowed_origins: proxy::default_allowed_origins(None),
        status: StatusFile::new(Some(home.join("status.json")), "test"),
        user_agent: "sp-test/0.8.0".into(),
        account: AccountConfig {
            enabled,
            keys: Some(KeyStore::File(home.join("account-keys.json"))),
            allow_local_http,
            device: "iPhone".into(),
            version: "0.8.0".into(),
        },
    })
}

fn hub_in(home: &Path) -> Hub {
    hub_with(home, true, true)
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..600 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never: {what}");
}

fn connect_state(h: &Hub) -> Option<ConnectState> {
    h.account_status().connect.map(|c| c.state)
}

/// Connects `h` to the fake, the person saying yes; the account's id. Returns once the
/// Hub has also asked the machines door (so a test counting requests starts from rest).
async fn connected(h: &Hub, fake: &Fake) -> String {
    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("approved", || {
        connect_state(h) == Some(ConnectState::Approved)
    })
    .await;
    let id = h.account_status().accounts[0].id.clone();
    until("the rp id", || {
        h.receiver(&id).is_some_and(|r| r.rp_id.is_some())
    })
    .await;
    id
}

/// An `rx:` request as the bundled page makes it.
async fn ask(h: &Hub, method: &str, id: &str, path: &str, body: &[u8]) -> http::Response<Vec<u8>> {
    let req = http::Request::builder()
        .method(method)
        .uri(format!("rx://localhost/{id}{path}"))
        .header("origin", APP)
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .body(body.to_vec())
        .unwrap();
    h.proxy(req).await
}

fn text(res: &http::Response<Vec<u8>>) -> String {
    String::from_utf8_lossy(res.body()).to_string()
}

/// The answer whole: status, headers and body.
fn dump(res: &http::Response<Vec<u8>>) -> String {
    format!("{} {:?} {}", res.status(), res.headers(), text(res))
}

/// Whose answer: the Hub's code, or None when it is spacesheep's own.
fn hub_code(res: &http::Response<Vec<u8>>) -> Option<&str> {
    res.headers()
        .get(account::HUB_HEADER)
        .and_then(|v| v.to_str().ok())
}

/// Everything a command returns or the page's contract may hold.
fn visible(h: &Hub) -> String {
    [
        serde_json::to_string(&h.account_status()).unwrap(),
        serde_json::to_string(&h.receivers()).unwrap(),
        serde_json::to_string(&h.active()).unwrap(),
        serde_json::to_string(&h.status().doc()).unwrap(),
        serde_json::to_string(&h.needs_you()).unwrap(),
    ]
    .join("\n")
}

/// Every file under `home` but the account key store, as one text.
fn files(home: &Path) -> String {
    fn walk(dir: &Path, out: &mut String) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.file_name().is_some_and(|n| n != "account-keys.json") {
                out.push_str(&format!("\n== {}\n", p.display()));
                out.push_str(&String::from_utf8_lossy(
                    &std::fs::read(&p).unwrap_or_default(),
                ));
            }
        }
    }
    let mut out = String::new();
    walk(home, &mut out);
    out
}

fn key_store(home: &Path) -> Value {
    std::fs::read(home.join("account-keys.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}

#[tokio::test]
async fn a_connect_the_person_approves_puts_the_key_in_the_hub_alone() {
    let t = TempDir::new("acct-ok");
    let fake = Fake::start("approved").await;
    let h = hub_in(t.path());
    assert_eq!(
        h.account_origin_to_confirm(Some(&fake.origin())),
        Some(fake.origin()),
        "another origin than spacesheep.dev is the person's to confirm first"
    );
    let view = h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(view.digits, "4821");
    assert_eq!(view.state, ConnectState::Pending);
    assert_eq!(view.origin, fake.origin());
    assert!(view
        .url
        .starts_with(&format!("{}/connect/gui?code=", fake.origin())));
    assert!(crate::status::parse_iso_ms(&view.expires_at).is_some());
    // What the page is handed: these five and nothing else.
    let v = serde_json::to_value(&view).unwrap();
    let mut names: Vec<&String> = v.as_object().unwrap().keys().collect();
    names.sort();
    assert_eq!(names, vec!["digits", "expiresAt", "origin", "state", "url"]);
    // What spacesheep was asked: who is asking, and no credential of any kind.
    let first = fake.seen().remove(0);
    assert_eq!(
        (first.method(), first.target()),
        ("POST", "/api/gui/connect")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&first.body).unwrap(),
        json!({ "device": "iPhone", "version": "0.8.0" })
    );
    assert_eq!(first.header("authorization"), None);
    assert_eq!(first.header("cookie"), None);
    assert_eq!(first.header("user-agent"), Some("sp-test/0.8.0"));

    // Not spacesheep.dev: the shell asks the person before a connect starts, and not
    // again for the one that is pending.
    assert_eq!(h.account_origin_to_confirm(Some(&fake.origin())), None);
    assert_eq!(
        h.account_origin_to_confirm(Some("https://Stagesheep.dev/"))
            .as_deref(),
        Some("https://stagesheep.dev")
    );
    for none in [
        None,
        Some(""),
        Some("https://spacesheep.dev"),
        Some("https://spacesheep.dev/"),
        Some("http://evil.example"),
    ] {
        assert_eq!(h.account_origin_to_confirm(none), None, "{none:?}");
    }

    // The Hub polls on its own; pressing Connect again is the same connect, not a second.
    until("two polls", || {
        fake.asked("/api/gui/connect/poll").len() >= 2
    })
    .await;
    assert_eq!(connect_state(&h), Some(ConnectState::Pending));
    let again = h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(again, view);
    assert_eq!(
        fake.asked("/api/gui/connect")
            .iter()
            .filter(|s| s.method() == "POST")
            .count(),
        1
    );
    assert!(h.account_status().accounts.is_empty());
    assert!(h.receivers().is_empty());
    // While it waits, the pending connect is kept beside the keys, and nowhere the page reads.
    assert!(key_store(t.path()).get(PENDING_NAME).is_some());
    fake.absent(&visible(&h), "what the page sees while pending");

    let mut events = h.subscribe();
    fake.set(|w| w.verdict = Verdict::Approved);
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    let st = h.account_status();
    let c = st.connect.clone().unwrap();
    let a = st.accounts[0].clone();
    assert_eq!(c.email.as_deref(), Some(fake.email().as_str()));
    assert_eq!(c.receiver.as_deref(), Some(a.id.as_str()));
    assert_eq!(
        (a.email.as_str(), a.origin.as_str(), a.state, a.active),
        (
            fake.email().as_str(),
            fake.origin().as_str(),
            AccountState::Ok,
            true
        )
    );
    assert_eq!(a.id, crate::id::account_id(&fake.origin(), &fake.email()));
    assert!(st.enabled);
    let mut told = false;
    while let Ok(e) = events.try_recv() {
        told |= e == HubEvent::Account;
    }
    assert!(told, "the page is told without asking");

    // Every poll proved itself with the poll token, in a header; the URL had the code only.
    let polls = fake.asked("/api/gui/connect/poll");
    for s in &polls {
        assert_eq!(
            s.header("authorization"),
            Some(format!("Bearer {}", fake.token()).as_str())
        );
        assert!(!s.target().contains(&fake.token()));
        assert_eq!(s.header("cookie"), None);
    }
    // In the list it is an account, never local, with the rp id its machines door gave.
    until("the rp id", || {
        h.receiver(&a.id).is_some_and(|r| r.rp_id.is_some())
    })
    .await;
    let r = h.receiver(&a.id).unwrap();
    assert_eq!(r.account.as_ref().map(|x| x.kind), Some("spacesheep"));
    assert_eq!(r.rp_id.as_deref(), Some("localhost"));
    assert!(!r.local);
    assert_eq!(h.active().unwrap().id, a.id);
    let row = serde_json::to_value(&r).unwrap();
    assert_eq!(row["kind"], "spacesheep");
    assert_eq!(row["email"], fake.email());
    assert_eq!(row["state"], "ok");

    // The key: in the key store, under the account's own name. The pending connect is gone.
    let keys = key_store(t.path());
    assert_eq!(keys[format!("acct:{}", a.id)], fake.key());
    assert_eq!(keys.as_object().unwrap().len(), 1);
    // And nowhere else: not in the list on disk, the status file, a returned value, a log line.
    let disk = files(t.path());
    assert!(disk.contains("\"kind\": \"spacesheep\"") && disk.contains(&fake.email()));
    fake.absent(&disk, "a file beside the key store");
    fake.absent(&visible(&h), "what the page sees");
    fake.absent(&logged().join("\n"), "a log line");
    assert!(logged()
        .iter()
        .any(|l| l.contains(&format!("acct {}: connected", a.id))));
    // The poll ended with the answer.
    let n = fake.asked("/api/gui/connect/poll").len();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.asked("/api/gui/connect/poll").len(), n);
}

#[tokio::test]
async fn a_connect_denied_or_expired_ends_with_nothing_kept() {
    for (verdict, state, tag) in [
        (Verdict::Denied, ConnectState::Denied, "denied"),
        (Verdict::Expired, ConnectState::Expired, "expired"),
    ] {
        let t = TempDir::new("acct-no");
        let fake = Fake::start(tag).await;
        let h = hub_in(t.path());
        h.account_connect_start(Some(&fake.origin())).await.unwrap();
        fake.set(|w| w.verdict = verdict);
        until("the end", || connect_state(&h) == Some(state)).await;
        let c = h.account_status().connect.unwrap();
        assert_eq!((c.receiver, c.email, c.error), (None, None, None));
        assert!(h.account_status().accounts.is_empty());
        assert!(h.receivers().is_empty());
        assert_eq!(key_store(t.path()), json!({}), "no key, no pending connect");
        let n = fake.count();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fake.count(), n, "the poll ended");
        fake.absent(&visible(&h), "what the page sees");
        fake.absent(&files(t.path()), "a file");
        fake.absent(&logged().join("\n"), "a log line");
        // The outcome stays until the next connect, which is a new one.
        fake.set(|w| w.verdict = Verdict::Pending);
        let next = h.account_connect_start(Some(&fake.origin())).await.unwrap();
        assert_eq!(next.state, ConnectState::Pending);
        assert!(h.account_connect_cancel());
    }
}

#[tokio::test]
async fn the_poll_rides_out_trouble_and_ends_with_the_code() {
    let t = TempDir::new("acct-poll");
    let fake = Fake::start("poll-trouble").await;
    let h = hub_in(t.path());
    // spacesheep is down, then asks to wait, then is itself again: the connect goes on.
    let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n2 = n.clone();
    fake.hook(move |s| {
        if !s.target().starts_with("/api/gui/connect/poll") {
            return None;
        }
        match n2.fetch_add(1, Ordering::SeqCst) {
            0 | 1 => Some(Reply::json(503, "down")),
            2 => Some(Reply::json(429, "{}").header("retry-after", "0")),
            _ => None,
        }
    });
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("past the trouble", || n.load(Ordering::SeqCst) >= 5).await;
    assert_eq!(connect_state(&h), Some(ConnectState::Pending));
    // The code's own end, by the clock, with spacesheep still saying "pending": the Hub
    // stops by itself (here the end is moved into the past rather than waited for).
    let polls = fake.asked("/api/gui/connect/poll").len();
    h.0.acct
        .connect
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .expires_at_ms = now_ms() - account::CONNECT_COLLECT_MS - 1;
    until("expired", || {
        connect_state(&h) == Some(ConnectState::Expired)
    })
    .await;
    assert!(fake.asked("/api/gui/connect/poll").len() <= polls + 1);
    assert_eq!(key_store(t.path()), json!({}));
    // An answer this version cannot read ends it too, saying so.
    fake.hook(|s| {
        s.target()
            .starts_with("/api/gui/connect/poll")
            .then(|| Reply::json(200, r#"{"state":"approved","email":"a@b.example"}"#))
    });
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("failed", || connect_state(&h) == Some(ConnectState::Failed)).await;
    let c = h.account_status().connect.unwrap();
    assert_eq!(c.error.as_ref().map(|e| e.code), Some("bad_answer"));
    assert!(
        h.account_status().accounts.is_empty(),
        "half an approval is none"
    );
    assert!(
        !h.account_connect_cancel(),
        "an outcome is cleared, not cancelled"
    );
    assert_eq!(h.account_status().connect, None);
}

#[tokio::test]
async fn a_connect_cancelled_stops_asking_and_keeps_nothing() {
    let t = TempDir::new("acct-cancel");
    let fake = Fake::start("cancelled").await;
    let h = hub_in(t.path());
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("a poll", || !fake.asked("/api/gui/connect/poll").is_empty()).await;
    assert!(h.account_connect_cancel(), "it was pending");
    assert_eq!(h.account_status().connect, None);
    assert!(!h.account_connect_cancel(), "nothing left to cancel");
    assert_eq!(key_store(t.path()), json!({}));
    // The person confirms anyway, later: nobody collects.
    fake.set(|w| w.verdict = Verdict::Approved);
    let n = fake.count();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(fake.count(), n, "no poll after the cancel");
    assert!(h.account_status().accounts.is_empty());
    fake.absent(&files(t.path()), "a file");
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn a_connect_that_cannot_start_says_why_and_asks_nobody() {
    let t = TempDir::new("acct-start");
    let fake = Fake::start("cannot-start").await;
    let code = |r: Result<ConnectView, Problem>| r.unwrap_err().code;

    // Off in this build (Android until its https verifier is set up; the desktop).
    let off = hub_with(t.path(), false, true);
    assert_eq!(
        code(off.account_connect_start(Some(&fake.origin())).await),
        "unsupported"
    );
    assert!(!off.account_status().enabled);
    // A release build: https only, so the local dev server is no origin at all.
    let release = hub_with(t.path(), true, false);
    for bad in [
        fake.origin(),
        "http://localhost:8841".into(),
        "http://spacesheep.dev".into(),
        "https://spacesheep.dev@evil.example".into(),
        "https://spacesheep.dev/x".into(),
        "javascript:alert(1)".into(),
    ] {
        assert_eq!(
            code(release.account_connect_start(Some(&bad)).await),
            "bad_origin",
            "{bad}"
        );
    }
    assert_eq!(fake.count(), 0, "nothing was asked");

    let h = hub_in(t.path());
    // Nobody there.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let e = h
        .account_connect_start(Some(&format!("http://127.0.0.1:{closed}")))
        .await
        .unwrap_err();
    assert_eq!(e.code, "unreachable");
    assert!(
        e.message.starts_with("Couldn't reach 127.0.0.1"),
        "{}",
        e.message
    );
    assert!(
        !e.message.contains("http://"),
        "no URL in an error: {}",
        e.message
    );
    // Asked to wait, with how long.
    fake.hook(|s| {
        (s.target() == "/api/gui/connect")
            .then(|| Reply::json(429, r#"{"error":"slow down"}"#).header("retry-after", "42"))
    });
    let e = h
        .account_connect_start(Some(&fake.origin()))
        .await
        .unwrap_err();
    assert_eq!((e.code, e.retry_after_s), ("rate_limited", Some(42)));
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        json!({ "code": "rate_limited", "message": e.message, "retryAfterS": 42 })
    );
    // Not a spacesheep this version knows.
    fake.hook(|s| (s.target() == "/api/gui/connect").then(|| Reply::json(404, "{}")));
    assert_eq!(
        code(h.account_connect_start(Some(&fake.origin())).await),
        "refused"
    );
    // A redirect is an answer like any other wrong one: it is not followed.
    let elsewhere = Fake::start("cannot-start-elsewhere").await;
    let to = format!("{}/api/gui/connect", elsewhere.origin());
    fake.hook(move |s| {
        (s.target() == "/api/gui/connect").then(|| Reply::json(307, "{}").header("location", &to))
    });
    assert_eq!(
        code(h.account_connect_start(Some(&fake.origin())).await),
        "refused"
    );
    assert_eq!(elsewhere.count(), 0);
    // A link to anywhere but the account's own origin is not handed to the page.
    fake.set(|w| {
        w.hook = None;
        w.link = Some("https://evil.example/connect/gui?code=x".into());
    });
    let e = h
        .account_connect_start(Some(&fake.origin()))
        .await
        .unwrap_err();
    assert_eq!(e.code, "bad_answer");
    assert!(!e.message.contains("evil.example"));
    assert_eq!(h.account_status().connect, None);
    assert_eq!(
        fake.asked("/api/gui/connect/poll").len(),
        0,
        "nothing was polled"
    );
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn every_door_is_forwarded_with_the_key_and_nothing_of_the_pages() {
    let t = TempDir::new("acct-doors");
    let fake = Fake::start("doors").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let key_id = "A".repeat(43);
    let send = br#"{"cmd":"{\"v\":1}","csig":null,"grant":{"g":1},"confirm":null}"#;
    let device = br#"{"key":{"type":"device","alg":-7},"name":"iPhone"}"#;
    let jobs = format!("/api/machines/{MACHINE}/jobs");
    let status = format!("/api/gui/device?id={key_id}");
    #[rustfmt::skip]
    let table: Vec<(&str, &str, &[u8], &str, u16)> = vec![
        ("GET", "/api/sessionpipe/v1/relay?since=0&limit=500&wait=0", b"", "/api/sessionpipe/v1/relay?since=0&limit=500&wait=0", 200),
        ("GET", "/api/sessionpipe/v1/relay?wait=1&since=41", b"", "/api/sessionpipe/v1/relay?since=41&wait=1", 200),
        ("GET", "/api/sessionpipe/v1/relay", b"", "/api/sessionpipe/v1/relay", 200),
        ("GET", "/api/sessionpipe/v1/relay/machines", b"", "/api/sessionpipe/v1/relay/machines", 200),
        ("GET", "/api/sessionpipe/v1/relay/jobs?since=6", b"", "/api/sessionpipe/v1/relay/jobs?since=6", 200),
        ("POST", &jobs, send, &jobs, 202),
        ("POST", "/api/gui/device", device, "/api/gui/device", 200),
        ("GET", &status, b"", &status, 200),
    ];
    let auth = format!("Bearer {}", fake.key());
    for (method, path, body, sent, want) in table {
        let before = fake.count();
        let res = ask(&h, method, &id, path, body).await;
        assert_eq!(res.status(), want, "{method} {path}: {}", text(&res));
        assert_eq!(hub_code(&res), None, "spacesheep's own answer");
        assert_eq!(fake.count(), before + 1, "one request for one request");
        let s = fake.last();
        assert_eq!((s.method(), s.target()), (method, sent), "{method} {path}");
        assert_eq!(s.header("authorization"), Some(auth.as_str()));
        assert_eq!(s.header("accept"), Some("application/json"));
        assert_eq!(
            s.header("host"),
            Some(format!("127.0.0.1:{}", fake.port).as_str())
        );
        assert_eq!(s.header("user-agent"), Some("sp-test/0.8.0"));
        assert_eq!(s.header("cookie"), None);
        assert_eq!(s.header("origin"), None);
        assert_eq!(s.header("referer"), None);
        assert_eq!(s.body, body, "the body as the page sent it");
        if method == "POST" {
            assert_eq!(s.header("content-type"), Some("application/json"));
        }
        // The page reads it: CORS for the bundled origin, and never from a cache.
        assert_eq!(res.headers()["access-control-allow-origin"], APP);
        assert_eq!(
            res.headers()["access-control-expose-headers"],
            account::EXPOSE_HEADERS
        );
        assert_eq!(res.headers()["cache-control"], "no-store");
        assert_eq!(res.headers()["content-type"], "application/json");
        assert!(res.headers().get("set-cookie").is_none());
        fake.absent(&dump(&res), "an answer");
    }
    assert_eq!(
        text(&ask(&h, "GET", &id, RELAY, b"").await),
        r#"{"events":[],"next":7,"oldest":null,"protocol":1}"#
    );
    // The status file: reached, and when the relay last answered. Needs-you is not read
    // for an account (its page works it out from the relay).
    assert!(h.is_connected(&id));
    h.status().flush();
    let doc: Value =
        serde_json::from_slice(&std::fs::read(t.path().join("status.json")).unwrap()).unwrap();
    assert_eq!(doc["receivers"][0]["id"], id.as_str());
    assert_eq!(doc["receivers"][0]["connected"], true);
    assert!(doc["receivers"][0]["lastFrameAt"].is_string());
    assert_eq!(doc["needsYou"], 0);
    fake.absent(&files(t.path()), "a file beside the key store");
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn what_is_not_a_door_is_refused_before_any_network() {
    let t = TempDir::new("acct-refuse");
    let fake = Fake::start("refusals").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let rest = fake.count();
    let big = format!(r#"{{"cmd":"{}"}}"#, "a".repeat(256 * 1024)).into_bytes();
    let key_id = "A".repeat(43);
    let jobs = format!("/api/machines/{MACHINE}/jobs");
    let two_ids = format!("/api/gui/device?id={key_id}&id={key_id}");
    #[rustfmt::skip]
    let table: Vec<(&str, &str, &[u8], u16, &str)> = vec![
        // Other paths: the GUI's own, spacesheep's others, the connect flow itself.
        ("GET", "/", b"", 403, "not_a_door"),
        ("GET", "/api/ui/info", b"", 403, "not_a_door"),
        ("GET", "/api/ui/stream", b"", 403, "not_a_door"),
        ("GET", "/api/machines", b"", 403, "not_a_door"),
        ("GET", "/api/keys", b"", 403, "not_a_door"),
        ("POST", "/api/keys", b"{}", 403, "not_a_door"),
        ("POST", "/api/sessionpipe/v1/events", b"{}", 403, "not_a_door"),
        ("POST", "/api/machines/files", b"{}", 403, "not_a_door"),
        ("POST", "/api/gui/connect", b"{}", 403, "not_a_door"),
        ("GET", "/api/gui/connect/poll?code=x", b"", 403, "not_a_door"),
        ("GET", "/connect/gui", b"", 403, "not_a_door"),
        ("GET", "/ca.crt", b"", 403, "not_a_door"),
        // Other methods on a door's path.
        ("POST", RELAY, b"{}", 403, "not_a_door"),
        ("PUT", RELAY, b"{}", 403, "not_a_door"),
        ("DELETE", RELAY, b"", 403, "not_a_door"),
        ("HEAD", RELAY, b"", 403, "not_a_door"),
        ("PATCH", "/api/gui/device", b"{}", 403, "not_a_door"),
        ("DELETE", "/api/gui/device", b"", 403, "not_a_door"),
        ("GET", &jobs, b"", 403, "not_a_door"),
        ("DELETE", &jobs, b"", 403, "not_a_door"),
        // Path tricks.
        ("GET", "/api/sessionpipe/v1/relay/../relay", b"", 403, "not_a_door"),
        ("GET", "/api/ui/../sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/api/sessionpipe/v1/./relay", b"", 403, "not_a_door"),
        ("GET", "//api/sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/api//sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/api/sessionpipe/v1/relay/", b"", 403, "not_a_door"),
        ("GET", "/api/sessionpipe/v1/relay%2Fmachines", b"", 403, "not_a_door"),
        ("GET", "/api%2Fsessionpipe%2Fv1%2Frelay", b"", 403, "not_a_door"),
        ("GET", "/api/sessionpipe/v1/%72elay", b"", 403, "not_a_door"),
        ("GET", "/%2e%2e/api/sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/API/sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/api/sessionpipe/v1/relay;x", b"", 403, "not_a_door"),
        ("GET", "/https://evil.example/api/sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/http:%2F%2Fevil.example/api/sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("GET", "/@evil.example/api/sessionpipe/v1/relay", b"", 403, "not_a_door"),
        ("POST", "/api/machines/m_0123456789abcdef%2F..%2F..%2Fkeys/jobs", b"{}", 403, "not_a_door"),
        ("POST", "/api/machines/m_0123456789abcdefABCD/../../keys", b"{}", 403, "not_a_door"),
        ("POST", "/api/machines/not-a-machine/jobs", b"{}", 403, "not_a_door"),
        ("POST", "/api/machines/m_short/jobs", b"{}", 403, "not_a_door"),
        // A door, with what it does not take.
        ("GET", "/api/sessionpipe/v1/relay?since=1&token=x", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?wait=3600", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?limit=100000", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?since=-1", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?since=1&since=2", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?since=%31", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay/machines?all=1", b"", 400, "bad_query"),
        ("GET", "/api/gui/device", b"", 400, "bad_query"),
        ("GET", "/api/gui/device?id=short", b"", 400, "bad_query"),
        ("GET", &two_ids, b"", 400, "bad_query"),
        ("POST", "/api/machines/m_0123456789abcdefABCD/jobs?check_stub=ok", b"{}", 400, "bad_query"),
        // Bodies.
        ("GET", RELAY, b"{}", 400, "bad_body"),
        ("POST", &jobs, b"", 400, "bad_body"),
        ("POST", &jobs, b"[1]", 400, "bad_body"),
        ("POST", &jobs, b"cmd=1", 400, "bad_body"),
        ("POST", "/api/gui/device", b"null", 400, "bad_body"),
        ("POST", &jobs, &big, 413, "too_large"),
        ("POST", "/api/gui/device", &big[..16 * 1024 + 2], 413, "too_large"),
    ];
    for (method, path, body, status, code) in table {
        let res = ask(&h, method, &id, path, body).await;
        assert_eq!(res.status(), status, "{method} {path}");
        assert_eq!(hub_code(&res), Some(code), "{method} {path}");
        let v: Value = serde_json::from_slice(res.body()).unwrap();
        assert_eq!(
            (&v["hub"], &v["reason"]),
            (&json!(true), &json!(code)),
            "{method} {path}"
        );
        assert_eq!(res.headers()["content-type"], "application/json");
        assert_eq!(res.headers()["access-control-allow-origin"], APP);
        assert_eq!(res.headers()["cache-control"], "no-store");
        fake.absent(&dump(&res), "a refusal");
    }
    assert_eq!(fake.count(), rest, "spacesheep heard none of it");
    // A request the bundled page did not make (a frame, another page, no origin at all).
    for origin in [
        Some("https://evil.example"),
        Some("http://127.0.0.1:7373"),
        Some("null"),
        None,
    ] {
        let mut b = http::Request::builder().uri(format!("rx://localhost/{id}{RELAY}"));
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        let res = h.proxy(b.body(Vec::new()).unwrap()).await;
        assert_eq!(res.status(), 403, "{origin:?}");
        assert_eq!(hub_code(&res), Some("forbidden_origin"));
        assert!(res.headers().get("access-control-allow-origin").is_none());
    }
    // The other way of writing an rx: URL (Android) is the same Hub.
    let android = http::Request::builder()
        .uri(format!("http://rx.localhost/{id}/api/ui/info"))
        .header("origin", "http://tauri.localhost")
        .body(Vec::new())
        .unwrap();
    assert_eq!(hub_code(&h.proxy(android).await), Some("not_a_door"));
    assert_eq!(fake.count(), rest);
    // A preflight is answered here, as for a receiver, and reaches nobody.
    let pre = ask(&h, "OPTIONS", &id, RELAY, b"").await;
    assert_eq!(pre.status(), 204);
    assert_eq!(pre.headers()["access-control-allow-origin"], APP);
    assert_eq!(fake.count(), rest);
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn the_pages_headers_change_nothing_upstream() {
    let t = TempDir::new("acct-headers");
    let fake = Fake::start("headers").await;
    let other = Fake::start("headers-other").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let req = http::Request::builder()
        .method("POST")
        .uri(format!("rx://localhost/{id}/api/machines/{MACHINE}/jobs"))
        .header("origin", APP)
        .header("authorization", "Bearer ss_the-pages-own-idea")
        .header("host", format!("127.0.0.1:{}", other.port))
        .header("x-forwarded-host", "evil.example")
        .header("x-forwarded-for", "10.0.0.1")
        .header("forwarded", "host=evil.example")
        .header("cookie", "session=abc")
        .header("accept", "text/html")
        .header("content-type", "text/plain")
        .header("user-agent", "Mozilla/5.0 (iPhone)")
        .header("referer", "tauri://localhost/s/claude/abc")
        .header("x-http-method-override", "DELETE")
        .header("x-sessionpipe-hub", "page")
        .header("if-none-match", "\"x\"")
        .body(br#"{"cmd":"{}"}"#.to_vec())
        .unwrap();
    let res = h.proxy(req).await;
    assert_eq!(res.status(), 202);
    assert_eq!(hub_code(&res), None);
    assert_eq!(other.count(), 0, "a Host header moves nothing");
    let s = fake.last();
    assert_eq!(
        s.header("authorization"),
        Some(format!("Bearer {}", fake.key()).as_str())
    );
    assert_eq!(
        s.header("host"),
        Some(format!("127.0.0.1:{}", fake.port).as_str())
    );
    assert_eq!(s.header("accept"), Some("application/json"));
    assert_eq!(s.header("content-type"), Some("application/json"));
    assert_eq!(s.header("user-agent"), Some("sp-test/0.8.0"));
    for gone in [
        "cookie",
        "x-forwarded-host",
        "x-forwarded-for",
        "forwarded",
        "referer",
        "origin",
        "x-http-method-override",
        "x-sessionpipe-hub",
        "if-none-match",
    ] {
        assert_eq!(s.header(gone), None, "{gone}");
    }
    assert_eq!(
        s.head.matches("uthorization:").count(),
        1,
        "one Authorization: {}",
        s.head
    );
    // And downstream: of spacesheep's headers, the type and a wait. No cookie is set in
    // the webview, no header of spacesheep's can pass as the Hub's.
    fake.hook(|s| {
        s.target().starts_with(RELAY).then(|| {
            Reply::json(200, "{}")
                .header("set-cookie", "sid=1; Path=/")
                .header("x-sessionpipe-hub", "not_a_door")
                .header("location", "https://evil.example/")
                .header("etag", "\"e\"")
                .header("access-control-allow-origin", "*")
                .header("x-secret", "1")
        })
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 200);
    let mut names: Vec<&str> = res.headers().keys().map(|k| k.as_str()).collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "access-control-allow-origin",
            "access-control-expose-headers",
            "cache-control",
            "content-type",
            "vary",
            "x-content-type-options",
        ]
    );
    assert_eq!(res.headers()["access-control-allow-origin"], APP);
}

#[tokio::test]
async fn a_redirect_is_neither_followed_nor_passed_on() {
    let t = TempDir::new("acct-redirect");
    let fake = Fake::start("redirect").await;
    let thief = Fake::start("redirect-thief").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    for status in [301u16, 302, 303, 307, 308] {
        for to in [
            format!("{}/api/sessionpipe/v1/relay", thief.origin()),
            // The same origin, another path: not followed either (it is not a door).
            "/api/keys".to_string(),
        ] {
            let to2 = to.clone();
            fake.hook(move |s| {
                (!s.target().starts_with("/api/gui/connect"))
                    .then(|| Reply::json(status, "{}").header("location", &to2))
            });
            for (method, path, body) in [
                ("GET", RELAY.to_string(), &b""[..]),
                (
                    "POST",
                    format!("/api/machines/{MACHINE}/jobs"),
                    &br#"{"cmd":"{}"}"#[..],
                ),
            ] {
                let before = fake.count();
                let res = ask(&h, method, &id, &path, body).await;
                assert_eq!(res.status(), 502, "{status} {to}");
                assert_eq!(hub_code(&res), Some("redirected"));
                assert!(res.headers().get("location").is_none());
                assert!(!dump(&res).contains("/api/keys") && !dump(&res).contains(&thief.origin()));
                assert_eq!(fake.count(), before + 1, "asked once, never again");
            }
        }
    }
    assert_eq!(thief.count(), 0, "the key went nowhere else");
    assert!(fake.asked("/api/keys").is_empty());
    // Connecting is the same: the poll token is not carried to where a redirect points.
    let t2 = TempDir::new("acct-redirect-poll");
    let h2 = hub_in(t2.path());
    let to = format!("{}/api/gui/connect/poll", thief.origin());
    fake.hook(move |s| {
        s.target()
            .starts_with("/api/gui/connect/poll")
            .then(|| Reply::json(302, "{}").header("location", &to))
    });
    h2.account_connect_start(Some(&fake.origin()))
        .await
        .unwrap();
    until("the poll to end", || {
        connect_state(&h2) == Some(ConnectState::Failed)
    })
    .await;
    assert_eq!(
        h2.account_status().connect.unwrap().error.unwrap().code,
        "bad_answer"
    );
    assert_eq!(thief.count(), 0);
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn an_answer_too_large_or_holding_the_key_is_not_handed_to_the_page() {
    let t = TempDir::new("acct-answers");
    let fake = Fake::start("answers").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    // A megabyte and a byte from a door whose answers are small.
    fake.hook(|s| {
        s.target()
            .starts_with("/api/sessionpipe/v1/relay/jobs")
            .then(|| Reply::json(200, vec![b' '; 1024 * 1024 + 1]))
    });
    let res = ask(&h, "GET", &id, "/api/sessionpipe/v1/relay/jobs", b"").await;
    assert_eq!(
        (res.status().as_u16(), hub_code(&res)),
        (502, Some("answer_too_large"))
    );
    assert!(res.body().len() < 400);
    // The same size is a relay page like any other.
    fake.hook(|s| {
        s.target()
            .starts_with(RELAY)
            .then(|| Reply::json(200, vec![b' '; 1024 * 1024 + 1]))
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(
        (res.status().as_u16(), res.body().len()),
        (200, 1024 * 1024 + 1)
    );
    // An origin that echoes what it was sent: the key does not come back down.
    for place in ["body", "content-type", "retry-after"] {
        fake.hook(move |s| {
            let auth = s.header("authorization").unwrap_or("").to_string();
            Some(match place {
                "body" => Reply::json(200, json!({ "you_sent": auth }).to_string()),
                "content-type" => Reply {
                    status: 200,
                    headers: vec![("content-type".into(), format!("text/plain; x={auth}"))],
                    body: b"{}".to_vec(),
                    delay: None,
                },
                _ => Reply::json(429, "{}").header("retry-after", &auth),
            })
        });
        let res = ask(&h, "GET", &id, RELAY, b"").await;
        assert_eq!(
            (res.status().as_u16(), hub_code(&res)),
            (502, Some("withheld")),
            "{place}"
        );
        fake.absent(&dump(&res), "an answer");
    }
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn a_401_marks_the_account_and_a_429_passes_with_its_wait() {
    let t = TempDir::new("acct-401");
    let fake = Fake::start("revoked").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let jobs = format!("/api/machines/{MACHINE}/jobs");

    // Asked to wait: the status, the body and Retry-After as spacesheep sent them, and
    // the header is one the page may read across origins.
    fake.hook(|s| {
        s.target().starts_with(RELAY).then(|| {
            Reply::json(
                429,
                r#"{"error":"Too many requests","code":"rate_limited"}"#,
            )
            .header("retry-after", "591")
        })
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 429);
    assert_eq!(res.headers()["retry-after"], "591");
    assert_eq!(
        text(&res),
        r#"{"error":"Too many requests","code":"rate_limited"}"#
    );
    assert_eq!(hub_code(&res), None);
    assert!(res.headers()["access-control-expose-headers"]
        .to_str()
        .unwrap()
        .contains("retry-after"));
    assert_eq!(h.account_status().accounts[0].state, AccountState::Ok);

    // Pro or Talk off is a 403: the key is alive, the account is not marked.
    fake.hook(|_| Some(Reply::json(403, r#"{"error":"Pro","code":"pro_required"}"#)));
    assert_eq!(ask(&h, "POST", &id, &jobs, b"{}").await.status(), 403);
    // A grant that needs unlocking is the signer's 401, not the key's.
    fake.hook(|_| {
        Some(Reply::json(
            401,
            r#"{"error":"Unlock","code":"unlock","refusal":"bad_grant"}"#,
        ))
    });
    let res = ask(&h, "POST", &id, &jobs, b"{}").await;
    assert_eq!((res.status().as_u16(), hub_code(&res)), (401, None));
    assert_eq!(h.account_status().accounts[0].state, AccountState::Ok);

    // Revoked on spacesheep: the 401 passes as it is, and the Hub remembers.
    let mut events = h.subscribe();
    fake.set(|w| {
        w.hook = None;
        w.revoked = true;
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 401);
    assert_eq!(hub_code(&res), None, "spacesheep's 401, not the Hub's");
    assert!(text(&res).contains("unauthorized"));
    assert_eq!(
        h.account_status().accounts[0].state,
        AccountState::Unauthorized
    );
    assert_eq!(
        h.receiver(&id).unwrap().account.unwrap().state,
        AccountState::Unauthorized
    );
    assert!(!h.is_connected(&id));
    let mut told = false;
    while let Ok(e) = events.try_recv() {
        told |= e == HubEvent::Account;
    }
    assert!(told);
    // The key is kept: one 401 is not proof enough to throw the link away, and a key
    // that is really revoked is worth nothing to anyone.
    assert_eq!(key_store(t.path())[format!("acct:{id}")], fake.key());
    // It is in the list on disk, so the next start knows without asking.
    let again = hub_in(t.path());
    assert_eq!(
        again.account_status().accounts[0].state,
        AccountState::Unauthorized
    );
    // The jobs door's own 401 for a dead key marks it too.
    assert_eq!(ask(&again, "POST", &id, &jobs, b"{}").await.status(), 401);
    // Connecting again is allowed while it is refused, and replaces the key.
    fake.set(|w| {
        w.revoked = false;
        w.key = "ss_KEY-revoked-second-0123456789".into();
    });
    let id2 = connected(&again, &fake).await;
    assert_eq!(
        id2, id,
        "the same person at the same origin is the same account"
    );
    assert_eq!(again.account_status().accounts.len(), 1);
    assert_eq!(again.account_status().accounts[0].state, AccountState::Ok);
    assert_eq!(
        key_store(t.path())[format!("acct:{id}")],
        "ss_KEY-revoked-second-0123456789"
    );
    // While it is fine, a second connect is refused.
    let e = again
        .account_connect_start(Some(&fake.origin()))
        .await
        .unwrap_err();
    assert_eq!(e.code, "already_connected");
    // A 401 that was not the end: the next good answer clears the mark.
    fake.set(|w| w.revoked = true);
    assert_eq!(ask(&again, "GET", &id, RELAY, b"").await.status(), 401);
    assert_eq!(
        again.account_status().accounts[0].state,
        AccountState::Unauthorized
    );
    fake.set(|w| w.revoked = false);
    assert_eq!(ask(&again, "GET", &id, RELAY, b"").await.status(), 200);
    assert_eq!(again.account_status().accounts[0].state, AccountState::Ok);
    assert!(again.is_connected(&id));
    fake.absent(&files(t.path()), "a file beside the key store");
    let lines = logged().join("\n");
    fake.absent(&lines, "a log line");
    assert!(!lines.contains("ss_KEY-revoked-second"));
    assert!(lines.contains(&format!("acct {id}: spacesheep refused the key")));
}

#[tokio::test]
async fn too_many_at_once_is_refused_here() {
    let t = TempDir::new("acct-busy");
    let fake = Fake::start("busy").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    fake.hook(|s| {
        s.target().starts_with(RELAY).then(|| {
            Reply::json(200, r#"{"events":[],"next":1,"oldest":null}"#)
                .after(Duration::from_millis(400))
        })
    });
    let rest = fake.count();
    let held: Vec<_> = (0..account::MAX_IN_FLIGHT)
        .map(|_| {
            let (h, id) = (h.clone(), id.clone());
            tokio::spawn(async move {
                ask(&h, "GET", &id, "/api/sessionpipe/v1/relay?wait=5", b"").await
            })
        })
        .collect();
    until("all in flight", || {
        fake.count() == rest + account::MAX_IN_FLIGHT
    })
    .await;
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!((res.status().as_u16(), hub_code(&res)), (429, Some("busy")));
    assert_eq!(res.headers()["retry-after"], "1");
    assert_eq!(
        fake.count(),
        rest + account::MAX_IN_FLIGHT,
        "the ninth reached nobody"
    );
    for task in held {
        assert_eq!(task.await.unwrap().status(), 200);
    }
    assert_eq!(
        ask(&h, "GET", &id, RELAY, b"").await.status(),
        200,
        "room again"
    );
}

#[tokio::test]
async fn the_documents_are_the_accounts_and_go_with_it() {
    let t = TempDir::new("acct-docs");
    let fake = Fake::start("docs").await;
    let h = hub_in(t.path());
    // No account, no documents: an id that is not one is not a folder to write in.
    for id in ["", "nobody0000", "../x", "acct"] {
        assert_eq!(
            h.account_doc_set(id, "labels", &json!(1)).unwrap_err().code,
            "unknown_account"
        );
        assert_eq!(
            h.account_doc_get(id, "labels").unwrap_err().code,
            "unknown_account"
        );
        assert_eq!(
            h.account_doc_delete(id, "labels").unwrap_err().code,
            "unknown_account"
        );
    }
    assert!(!t.path().join("accounts").exists());
    let id = connected(&h, &fake).await;
    let labels = json!({ "rev": 2, "sessions": { "claude:abc": { "name": "Fix the build" } } });
    let marks = json!({ "rev": 9, "read": { "claude:abc": "2026-11-12T08:00:00.000Z" } });
    assert_eq!(h.account_doc_get(&id, "labels").unwrap(), None);
    assert_eq!(
        h.account_doc_set(&id, "labels", &labels).unwrap(),
        serde_json::to_vec(&labels).unwrap().len()
    );
    h.account_doc_set(&id, "marks", &marks).unwrap();
    h.account_doc_set(&id, "sends", &json!([])).unwrap();
    assert_eq!(
        h.account_doc_get(&id, "labels").unwrap(),
        Some(labels.clone())
    );
    assert!(t
        .path()
        .join(format!("accounts/{id}/labels.json"))
        .is_file());
    // The limits: a name that is a name, a size, a number of them.
    assert_eq!(
        h.account_doc_set(&id, "../labels", &json!(1))
            .unwrap_err()
            .code,
        "bad_name"
    );
    assert_eq!(
        h.account_doc_get(&id, "Labels").unwrap_err().code,
        "bad_name"
    );
    let over = json!("a".repeat(crate::docs::MAX_DOC_BYTES));
    let e = h.account_doc_set(&id, "marks", &over).unwrap_err();
    assert_eq!(e.code, "too_large");
    assert_eq!(
        h.account_doc_get(&id, "marks").unwrap(),
        Some(marks.clone()),
        "the kept one stands"
    );
    for i in 3..crate::docs::MAX_DOCS {
        h.account_doc_set(&id, &format!("extra-{i}"), &json!(i))
            .unwrap();
    }
    assert_eq!(
        h.account_doc_set(&id, "one-more", &json!(1))
            .unwrap_err()
            .code,
        "too_many"
    );
    assert!(h.account_doc_delete(&id, "sends").unwrap());
    assert!(!h.account_doc_delete(&id, "sends").unwrap());
    // They outlive the app and a refused key (they are the person's, not the key's).
    fake.set(|w| w.revoked = true);
    ask(&h, "GET", &id, RELAY, b"").await;
    let again = hub_in(t.path());
    assert_eq!(again.account_doc_get(&id, "labels").unwrap(), Some(labels));
    assert_eq!(again.account_doc_get(&id, "marks").unwrap(), Some(marks));
    // A build with accounts off reads none of it.
    let off = hub_with(t.path(), false, true);
    assert_eq!(
        off.account_doc_get(&id, "labels").unwrap_err().code,
        "unknown_account"
    );

    // Disconnect: the key, the documents and the entry go; the answer says what stays.
    let d = again.account_disconnect(&id).unwrap();
    assert_eq!(
        (d.id.as_str(), d.origin.as_str(), d.email.as_str()),
        (id.as_str(), fake.origin().as_str(), fake.email().as_str())
    );
    assert!(d.forgotten && !d.revoked);
    assert_eq!(d.revoke_url, format!("{}/settings/api-keys", fake.origin()));
    assert!(d.note.contains("revoke it on spacesheep"));
    fake.absent(&serde_json::to_string(&d).unwrap(), "the disconnect answer");
    assert_eq!(
        key_store(t.path()),
        json!({}),
        "the key is gone from the key store"
    );
    assert!(
        !t.path().join(format!("accounts/{id}")).exists(),
        "and its documents"
    );
    assert!(again.account_status().accounts.is_empty());
    assert_eq!(again.account_status().connect, None);
    assert!(again.receivers().is_empty());
    assert_eq!(
        again.account_doc_get(&id, "labels").unwrap_err().code,
        "unknown_account"
    );
    assert_eq!(
        again.account_disconnect(&id).unwrap_err().code,
        "unknown_account"
    );
    // Nothing is forwarded for an account that is not there, door or not.
    let rest = fake.count();
    let res = ask(&again, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 404);
    assert_eq!(fake.count(), rest);
    let list = std::fs::read_to_string(t.path().join("receivers.json")).unwrap();
    assert!(!list.contains(&id) && !list.contains("spacesheep"));
    // `rx_remove` on an account is the same forgetting.
    fake.set(|w| w.revoked = false);
    let id = connected(&again, &fake).await;
    again.account_doc_set(&id, "labels", &json!(1)).unwrap();
    assert!(again.remove(&id).unwrap());
    assert_eq!(key_store(t.path()), json!({}));
    assert!(!t.path().join(format!("accounts/{id}")).exists());
    fake.absent(&files(t.path()), "a file");
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn an_account_survives_a_restart_of_the_hub() {
    let t = TempDir::new("acct-restart");
    let fake = Fake::start("restart").await;
    let id = {
        let h = hub_in(t.path());
        let id = connected(&h, &fake).await;
        h.set_active(&id).unwrap();
        h.account_doc_set(&id, "labels", &json!({ "rev": 1 }))
            .unwrap();
        id
    };
    let h = hub_in(t.path());
    h.start(tokio::runtime::Handle::current());
    let st = h.account_status();
    assert_eq!(st.accounts.len(), 1);
    let a = &st.accounts[0];
    assert_eq!(
        (a.id.as_str(), a.email.as_str(), a.state, a.active),
        (id.as_str(), fake.email().as_str(), AccountState::Ok, true)
    );
    assert_eq!(st.connect, None, "an old outcome is not news");
    let r = h.active().unwrap();
    assert_eq!(r.id, id);
    assert_eq!(
        r.rp_id.as_deref(),
        Some("localhost"),
        "the rp id is kept too"
    );
    assert_eq!(
        h.account_doc_get(&id, "labels").unwrap(),
        Some(json!({ "rev": 1 }))
    );
    let rest = fake.count();
    let res = ask(
        &h,
        "GET",
        &id,
        "/api/sessionpipe/v1/relay?since=7&wait=0",
        b"",
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        fake.last().header("authorization"),
        Some(format!("Bearer {}", fake.key()).as_str())
    );
    // Started, and it opened no stream to the account and asked it nothing of a receiver.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(fake.count(), rest + 1);
    assert!(fake.asked("/api/ui").is_empty());

    // The entry without its key (a backup restored on another phone): it says so, and
    // the doors answer here.
    std::fs::remove_file(t.path().join("account-keys.json")).unwrap();
    let h = hub_in(t.path());
    assert_eq!(h.account_status().accounts[0].state, AccountState::NoKey);
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(
        (res.status().as_u16(), hub_code(&res)),
        (401, Some("not_connected"))
    );
    assert_eq!(fake.count(), rest + 1);
    // Connecting again is how it gets one.
    assert_eq!(connected(&h, &fake).await, id);
    assert_eq!(h.account_status().accounts[0].state, AccountState::Ok);
    assert_eq!(
        h.account_doc_get(&id, "labels").unwrap(),
        Some(json!({ "rev": 1 })),
        "the same person keeps their documents"
    );
    fake.absent(&files(t.path()), "a file beside the key store");
    fake.absent(&visible(&h), "what the page sees");
}

#[tokio::test]
async fn a_pending_connect_goes_on_after_the_app_was_closed() {
    let t = TempDir::new("acct-resume");
    let fake = Fake::start("resume").await;
    let kept = {
        let h = hub_in(t.path());
        h.account_connect_start(Some(&fake.origin())).await.unwrap();
        let kept = std::fs::read(t.path().join("account-keys.json")).unwrap();
        // The app is closed: its poll stops, and what it kept stays.
        h.account_connect_cancel();
        kept
    };
    std::fs::write(t.path().join("account-keys.json"), &kept).unwrap();
    // The person confirms in the browser while the app is gone.
    fake.set(|w| w.verdict = Verdict::Approved);
    let h = hub_in(t.path());
    assert_eq!(h.account_status().connect, None, "nothing before it starts");
    h.start(tokio::runtime::Handle::current());
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    assert_eq!(h.account_status().accounts[0].email, fake.email());
    assert!(key_store(t.path()).get(PENDING_NAME).is_none());
    assert_eq!(
        fake.asked("/api/gui/connect")
            .iter()
            .filter(|s| s.method() == "POST")
            .count(),
        1
    );

    // What was kept is believed only as far as a fresh answer would be.
    let other = Fake::start("resume-other").await;
    for (what, f) in [
        (
            "another origin",
            Box::new(|v: &mut Value| v["origin"] = json!(other.origin()))
                as Box<dyn Fn(&mut Value)>,
        ),
        (
            "an origin that is none",
            Box::new(|v: &mut Value| v["origin"] = json!("http://evil.example")),
        ),
        (
            "a link elsewhere",
            Box::new(|v: &mut Value| v["url"] = json!("https://evil.example/connect/gui")),
        ),
        (
            "long expired",
            Box::new(|v: &mut Value| v["expires_at"] = json!("2020-01-01T00:00:00.000Z")),
        ),
        (
            "no token",
            Box::new(|v: &mut Value| v["poll_token"] = json!("")),
        ),
    ] {
        let t2 = TempDir::new("acct-resume-bad");
        let mut all: Value = serde_json::from_slice(&kept).unwrap();
        let mut rec: Value = serde_json::from_str(all[PENDING_NAME].as_str().unwrap()).unwrap();
        f(&mut rec);
        all[PENDING_NAME] = json!(rec.to_string());
        std::fs::write(t2.path().join("account-keys.json"), all.to_string()).unwrap();
        let h2 = hub_in(t2.path());
        h2.start(tokio::runtime::Handle::current());
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(h2.account_status().connect, None, "{what}");
        assert_eq!(key_store(t2.path()), json!({}), "{what}: dropped");
    }
    assert_eq!(other.count(), 0, "the poll token went nowhere else");
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn nothing_that_speaks_to_a_receiver_speaks_to_an_account() {
    let t = TempDir::new("acct-kind");
    let fake = Fake::start("kind").await;
    let h = hub_in(t.path());
    h.start(tokio::runtime::Handle::current());
    let id = connected(&h, &fake).await;
    let rest = fake.count();
    // No stream, no view window with a key in its URL, no request to a path of the page's.
    assert_eq!(
        h.open_stream(&id, "/api/ui/stream", "main", |_| true)
            .unwrap_err(),
        "account_no_stream"
    );
    assert_eq!(h.view_url(&id, "/t/canvas").unwrap_err(), "not a receiver");
    assert!(h.get(&id, "/api/ui/stream").await.is_err());
    assert!(h.get(&id, "/api/keys").await.is_err());
    assert!(h.get(&id, "/ca.crt").await.is_err());
    assert!(h
        .post_json(&id, "/api/ui/control/send", b"{}".to_vec())
        .await
        .is_err());
    assert!(h
        .post_json(
            &id,
            &format!("/api/machines/{MACHINE}/jobs"),
            b"{}".to_vec()
        )
        .await
        .is_err());
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(fake.count(), rest, "none of it reached spacesheep");
    assert_eq!(h.open_streams(), 0);
    assert!(h.needs_you().is_empty());

    // What the signer asks of a receiver, answered from the machines door: the rp id it
    // signs for, the machines' names for a prompt.
    let info: Value = serde_json::from_slice(&h.get(&id, "/api/ui/info").await.unwrap()).unwrap();
    assert_eq!(info["control"]["rpId"], "localhost");
    let ms: Value =
        serde_json::from_slice(&h.get(&id, "/api/ui/control/machines").await.unwrap()).unwrap();
    assert_eq!(
        ms,
        json!({ "machines": [{ "machineId": MACHINE, "name": "studio-mac" }] })
    );
    assert_eq!(fake.count(), rest + 2);
    assert!(fake.seen()[rest..]
        .iter()
        .all(|s| s.target() == "/api/sessionpipe/v1/relay/machines"));

    // A receiver beside it is a receiver still: its cookie, never the account's key.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let port =
        crate::testutil::serve(|_| (200, "application/json", b"{}".to_vec()), Some(tx)).await;
    let mut reg = Registry::load(t.path());
    let (mut r, _) = Receiver::from_url(&format!("http://127.0.0.1:{port}")).unwrap();
    r.local = false;
    r.id = "remote1234".into();
    reg.upsert(r).unwrap();
    let h = hub_in(t.path());
    h.0.cfg.keys.set("remote1234", "uikey").unwrap();
    let res = ask(&h, "GET", "remote1234", "/api/ui/info", b"").await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["access-control-expose-headers"],
        "etag, content-type"
    );
    let seen = rx.recv().await.unwrap();
    assert_eq!(seen.header("cookie"), Some("spgui=uikey"));
    assert_eq!(seen.header("authorization"), None);
    let rows = serde_json::to_value(h.receivers()).unwrap();
    let plain = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "remote1234")
        .unwrap();
    let mut names: Vec<&String> = plain.as_object().unwrap().keys().collect();
    names.sort();
    assert_eq!(
        names,
        vec!["id", "local", "name", "origin"],
        "a receiver's row is what it was"
    );
    assert_eq!(h.account_status().accounts.len(), 1);
}

#[tokio::test]
async fn an_entry_never_changes_kind_and_a_rewritten_one_finds_no_key() {
    let t = TempDir::new("acct-tamper");
    let fake = Fake::start("tamper").await;
    let thief = Fake::start("tamper-thief").await;
    let id = connected(&hub_in(t.path()), &fake).await;

    // A receiver whose id met the account's cannot take its place in the list…
    let mut reg = Registry::load(t.path());
    let (mut r, _) = Receiver::from_url(&thief.origin()).unwrap();
    r.local = false;
    r.id = id.clone();
    assert!(reg.upsert(r.clone()).is_err());
    assert_eq!(Registry::load(t.path()).list()[0].kind, Kind::Spacesheep);
    // …and one that shadows it for a run (SP_RECEIVER_URL) gets no key of the account's:
    // the account's is not under the bare id.
    let h = hub_in(t.path());
    h.0.transient.lock().unwrap().push(r);
    assert_eq!(h.find(&id).unwrap().kind, Kind::Receiver);
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 401, "the thief's own answer to no key at all");
    let s = thief.last();
    assert_eq!(
        (s.header("authorization"), s.header("cookie")),
        (None, None)
    );
    assert!(h.view_url(&id, "/x").unwrap().query().is_none());

    // The list rewritten on disk to send the account elsewhere, keeping its id: the id
    // is no longer its origin's, and nothing is sent.
    let path = t.path().join("receivers.json");
    let list = std::fs::read_to_string(&path).unwrap();
    let rest = (fake.count(), thief.count());
    for (what, to) in [
        (
            "another origin",
            list.replace(&fake.origin(), &thief.origin()),
        ),
        (
            "another person",
            list.replace(&fake.email(), "someone@else.example"),
        ),
        ("no account in it", list.replace("\"account\"", "\"was\"")),
    ] {
        assert_ne!(to, list);
        std::fs::write(&path, to).unwrap();
        let h = hub_in(t.path());
        for (method, door, body) in [
            ("GET", RELAY.to_string(), &b""[..]),
            ("POST", format!("/api/machines/{MACHINE}/jobs"), &b"{}"[..]),
        ] {
            let res = ask(&h, method, &id, &door, body).await;
            let code = hub_code(&res).map(str::to_string);
            assert!(
                matches!(code.as_deref(), Some("bad_account")) || res.status() == 404,
                "{what}: {} {code:?}",
                res.status()
            );
        }
        assert!(h.get(&id, "/api/ui/info").await.is_err(), "{what}");
    }
    assert_eq!(
        (fake.count(), thief.count()),
        rest,
        "nobody was sent anything"
    );
    // With the id rewritten to match the new origin, there is no key under that name.
    let moved = crate::id::account_id(&thief.origin(), &fake.email());
    std::fs::write(
        &path,
        list.replace(&fake.origin(), &thief.origin())
            .replace(&id, &moved),
    )
    .unwrap();
    let h = hub_in(t.path());
    assert_eq!(h.account_status().accounts[0].state, AccountState::NoKey);
    let res = ask(&h, "GET", &moved, RELAY, b"").await;
    assert_eq!(hub_code(&res), Some("not_connected"));
    assert_eq!(thief.count(), rest.1);

    // A kind this version does not know is kept as it is and never spoken to.
    std::fs::write(&path, list.replace("\"spacesheep\"", "\"teleport\"")).unwrap();
    let h = hub_in(t.path());
    h.start(tokio::runtime::Handle::current());
    assert_eq!(h.receivers().len(), 1, "the list still loads");
    assert!(h.account_status().accounts.is_empty());
    assert_eq!(ask(&h, "GET", &id, RELAY, b"").await.status(), 404);
    assert!(h.get(&id, "/api/ui/info").await.is_err());
    assert!(h
        .open_stream(&id, "/api/ui/stream", "main", |_| true)
        .is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!((fake.count(), thief.count()), rest);
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn an_account_in_a_build_without_the_mode_is_forwarded_nothing() {
    let t = TempDir::new("acct-off");
    let fake = Fake::start("off").await;
    let id = connected(&hub_in(t.path()), &fake).await;
    let rest = fake.count();
    // The same home, opened by a build with accounts off, and by one that takes https only.
    let off = hub_with(t.path(), false, true);
    let res = ask(&off, "GET", &id, RELAY, b"").await;
    assert_eq!(
        (res.status().as_u16(), hub_code(&res)),
        (403, Some("account_off"))
    );
    let release = hub_with(t.path(), true, false);
    let res = ask(&release, "GET", &id, RELAY, b"").await;
    assert_eq!(
        (res.status().as_u16(), hub_code(&res)),
        (403, Some("bad_account")),
        "plain http is no origin there"
    );
    assert_eq!(fake.count(), rest);
}
