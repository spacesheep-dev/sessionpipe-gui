//! The Hub against a fake spacesheep on loopback: connecting, the doors, what is refused
//! before any network, what the person is asked and when, where the key is and is not,
//! what survives a restart.

use super::*;
use crate::account::{AccountConfig, Answered, Confirm};
use crate::registry::Registry;
use crate::status::StatusFile;
use crate::testutil::{logged, serve_replies, Reply, Seen, TempDir};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::time::Instant;

/// The bundled page's origin on an iPhone.
const APP: &str = "tauri://localhost";
const MACHINE: &str = "m_0123456789abcdefABCD";
const RELAY: &str = "/api/sessionpipe/v1/relay";
const MACHINES: &str = "/api/sessionpipe/v1/relay/machines";
const JOBS_DOOR: &str = "/api/sessionpipe/v1/relay/jobs";
/// A signed command as the signer writes one under the day's grant.
const SEND: &[u8] = br#"{"cmd":"{\"v\":1,\"kind\":\"prompt\"}","csig":"c2ln","grant":{"cred":"k","sig":"s","str":"g"},"confirm":null}"#;

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
    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
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
    fn code(&self) -> String {
        self.w.lock().unwrap().code.clone()
    }
    fn email(&self) -> String {
        self.w.lock().unwrap().email.clone()
    }
    /// The id the Hub gives this fake's account.
    fn id(&self) -> String {
        crate::id::account_id(&self.origin(), &self.email())
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
    fn starts(&self) -> usize {
        self.seen()
            .iter()
            .filter(|s| s.method() == "POST" && s.target() == "/api/gui/connect")
            .count()
    }
    fn last(&self) -> Seen {
        self.seen().pop().expect("a request")
    }
    /// The key and the poll token are nowhere in `text`.
    fn absent(&self, text: &str, what: &str) {
        assert!(!text.contains(&self.key()), "the key is in {what}");
        assert!(!text.contains(&self.token()), "the poll token is in {what}");
    }
    /// Nor is the connect's code (and so its link): for what the page may read.
    fn absent_from_page(&self, text: &str, what: &str) {
        self.absent(text, what);
        assert!(!text.contains(&self.code()), "the code is in {what}");
        assert!(!text.contains("/connect/gui"), "the link is in {what}");
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
                Verdict::Pending => Reply::empty(204),
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
        ("GET", MACHINES) => Reply::json(
            200,
            json!({
                "machines": [{ "id": MACHINE, "name": "studio-mac", "online": true }],
                "rp_id": "localhost", "origin": origin,
            })
            .to_string(),
        ),
        ("GET", JOBS_DOOR) => Reply::json(200, r#"{"jobs":[]}"#),
        ("POST", p) if p == jobs => Reply::json(202, r#"{"job":7}"#),
        // A cloud box runs what it is sent, signed or not: the Hub must never get here.
        ("POST", p) if p.starts_with("/api/machines/m_box") => {
            Reply::json(202, r#"{"ok":true,"ran":"unsigned"}"#)
        }
        ("POST", "/api/gui/device") => {
            let b: Value = serde_json::from_slice(&s.body).unwrap_or_default();
            Reply::json(
                200,
                json!({
                    "id": 1, "key_id": b["key"]["id"], "code": "71", "trusted_on": [MACHINE],
                    "devices_url": format!("{origin}/devices"),
                })
                .to_string(),
            )
        }
        ("GET", "/api/gui/device") => {
            Reply::json(200, r#"{"trusted_on":[],"machines":[],"pending":true}"#)
        }
        _ => Reply::json(404, r#"{"error":"not found"}"#),
    }
}

/// The person, scripted: what they were asked, and what they say.
struct Script {
    asked: Mutex<Vec<Question>>,
    /// The next answers: yes, no, or None for a question that could not be shown.
    next: Mutex<VecDeque<Option<bool>>>,
    otherwise: Option<bool>,
    /// While set, a question stays open until `release`: the one about keeping an
    /// approved account, or (`hold_every`) any.
    hold: Mutex<Option<Arc<Notify>>>,
    hold_every: std::sync::atomic::AtomicBool,
}

impl Script {
    fn saying(otherwise: bool) -> Arc<Script> {
        Script::answering(Some(otherwise))
    }
    /// A device on which no question can be shown (until told otherwise with `then`).
    fn unshown() -> Arc<Script> {
        Script::answering(None)
    }
    fn answering(otherwise: Option<bool>) -> Arc<Script> {
        Arc::new(Script {
            asked: Mutex::new(Vec::new()),
            next: Mutex::new(VecDeque::new()),
            otherwise,
            hold: Mutex::new(None),
            hold_every: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn then(&self, answers: &[bool]) {
        self.next
            .lock()
            .unwrap()
            .extend(answers.iter().map(|a| Some(*a)));
    }
    /// The next `n` questions cannot be shown.
    fn then_unshown(&self, n: usize) {
        self.next.lock().unwrap().extend((0..n).map(|_| None));
    }
    fn attach_questions(&self) -> usize {
        self.asked()
            .iter()
            .filter(|q| matches!(q, Question::Attach { .. }))
            .count()
    }
    fn asked(&self) -> Vec<Question> {
        self.asked.lock().unwrap().clone()
    }
    fn hold(&self) {
        *self.hold.lock().unwrap() = Some(Arc::new(Notify::new()));
    }
    fn hold_every(&self) {
        self.hold_every.store(true, Ordering::SeqCst);
        self.hold();
    }
    fn release(&self) {
        self.hold_every.store(false, Ordering::SeqCst);
        if let Some(n) = self.hold.lock().unwrap().take() {
            n.notify_one();
        }
    }
}

impl Confirm for Script {
    fn ask(&self, question: Question) -> Answered {
        let answer = self
            .next
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(self.otherwise);
        let held =
            matches!(question, Question::Attach { .. }) || self.hold_every.load(Ordering::SeqCst);
        self.asked.lock().unwrap().push(question);
        let hold = self.hold.lock().unwrap().clone().filter(|_| held);
        Box::pin(async move {
            if let Some(n) = hold {
                n.notified().await;
            }
            answer
        })
    }
}

/// A Hub in `home`: accounts on or off, the local dev server allowed or not, the account
/// keys in a file of their own (so a test can see exactly where the key is), and the
/// person as scripted (None: nobody to ask).
fn hub_asking(home: &Path, enabled: bool, local: bool, person: Option<Arc<Script>>) -> Hub {
    logged();
    let h = Hub::new(HubConfig {
        home: home.to_path_buf(),
        keys: KeyStore::File(home.join("keys.json")),
        env_receiver_url: None,
        allowed_origins: proxy::default_allowed_origins(None),
        status: StatusFile::new(Some(home.join("status.json")), "test"),
        user_agent: "sp-test/0.8.0".into(),
        account: AccountConfig {
            enabled,
            keys: KeyStore::File(home.join("account-keys.json")),
            allow_local_http: local,
            device: "iPhone".into(),
            version: "0.8.0".into(),
            confirm: person.map(|p| p as Arc<dyn Confirm>),
        },
    });
    // Tests start connects by the dozen; the one about the limit sets its own.
    h.0.acct.start_limit.store(10_000, Ordering::Relaxed);
    h.0.acct.device_ask_limit.store(10_000, Ordering::Relaxed);
    h
}

fn hub_with(home: &Path, enabled: bool, local: bool) -> Hub {
    hub_asking(home, enabled, local, Some(Script::saying(true)))
}

/// Accounts on, the local server allowed, a person who says yes to everything.
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

fn account(h: &Hub, id: &str) -> Option<AccountView> {
    h.account_status().accounts.into_iter().find(|a| a.id == id)
}

/// Connects `h` to the fake, the person saying yes there and here; the account's id.
/// Returns once the Hub has also asked the machines door (so a test counting requests
/// starts from rest).
async fn connected(h: &Hub, fake: &Fake) -> String {
    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("approved", || {
        connect_state(h) == Some(ConnectState::Approved)
    })
    .await;
    let id = fake.id();
    assert!(account(h, &id).is_some());
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

fn said(res: &http::Response<Vec<u8>>) -> (u16, Option<&str>) {
    (res.status().as_u16(), hub_code(res))
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

/// What the key store holds for an account: (the origin it is for, the key).
fn kept(home: &Path, id: &str) -> Option<(String, String)> {
    let all = key_store(home);
    let v: Value = serde_json::from_str(all.get(format!("acct:{id}"))?.as_str()?).ok()?;
    Some((v["origin"].as_str()?.into(), v["key"].as_str()?.into()))
}

fn gz_best(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

fn gz(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// A device key as the signer hands one over.
fn device_key(tag: char) -> Value {
    json!({
        "id": tag.to_string().repeat(43), "alg": -7, "spki": "S".repeat(120),
        "type": "device", "store": "hardware", "uv": "each-use"
    })
}

fn header_names(s: &Seen) -> Vec<String> {
    let mut v: Vec<String> = s
        .head
        .lines()
        .skip(1)
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, _)| k.trim().to_ascii_lowercase())
        })
        .collect();
    v.sort();
    v
}

#[tokio::test]
async fn a_connect_the_person_approves_puts_the_key_in_the_hub_alone() {
    let t = TempDir::new("acct-ok");
    let fake = Fake::start("approved").await;
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    let view = h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(view.digits, "4821");
    assert_eq!(view.state, ConnectState::Pending);
    assert_eq!(view.origin, fake.origin());
    assert!(crate::status::parse_iso_ms(&view.expires_at).is_some());
    // What the page is handed: these four and nothing else. Not the link: it holds the
    // code, and whoever has the code can have any account approve it.
    let v = serde_json::to_value(&view).unwrap();
    let mut names: Vec<&String> = v.as_object().unwrap().keys().collect();
    names.sort();
    assert_eq!(names, vec!["digits", "expiresAt", "origin", "state"]);
    fake.absent_from_page(&v.to_string(), "the connect the page is handed");
    // The link is the Hub's, for the shell to open in the system browser.
    assert_eq!(
        h.account_connect_link(),
        Some(format!(
            "{}/connect/gui?code={}",
            fake.origin(),
            fake.code()
        ))
    );
    // Not spacesheep.dev: the person was asked before anything was sent.
    assert_eq!(
        person.asked(),
        vec![Question::Origin {
            origin: fake.origin(),
            host: fake.host()
        }]
    );
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

    // The Hub polls on its own; pressing Connect again is the same connect, not a second,
    // and the person is not asked again for it.
    until("two polls", || {
        fake.asked("/api/gui/connect/poll").len() >= 2
    })
    .await;
    assert_eq!(connect_state(&h), Some(ConnectState::Pending));
    let again = h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(again, view);
    assert_eq!(fake.starts(), 1);
    assert_eq!(person.asked().len(), 1);
    assert!(h.account_status().accounts.is_empty());
    assert!(h.receivers().is_empty());
    // While it waits, the pending connect is kept beside the keys, and nowhere the page reads.
    assert!(key_store(t.path()).get(PENDING_NAME).is_some());
    fake.absent_from_page(&visible(&h), "what the page sees while pending");

    let mut events = h.subscribe();
    fake.set(|w| w.verdict = Verdict::Approved);
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    // Before it was kept, the person saw whose account it is and where.
    assert_eq!(
        person.asked()[1],
        Question::Attach {
            email: fake.email(),
            origin: fake.origin(),
            host: fake.host()
        }
    );
    assert_eq!(person.asked().len(), 2);
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
    assert_eq!(a.id, fake.id());
    assert_eq!(a.id.len(), 52, "an account's id is a whole digest");
    assert!(st.enabled);
    assert_eq!(
        h.account_connect_link(),
        None,
        "the link ended with the connect"
    );
    let mut told = false;
    while let Ok(e) = events.try_recv() {
        told |= e == HubEvent::Account;
    }
    assert!(told, "the page is told without asking");

    // Every poll proved itself with the poll token, in a header; the URL had the code only.
    for s in &fake.asked("/api/gui/connect/poll") {
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

    // The key: in the key store, under the account's own name, with the origin it is
    // for. The pending connect is gone.
    assert_eq!(kept(t.path(), &a.id), Some((fake.origin(), fake.key())));
    assert_eq!(key_store(t.path()).as_object().unwrap().len(), 1);
    // And nowhere else: not in the list on disk, the status file, a returned value, a log line.
    let disk = files(t.path());
    assert!(disk.contains("spacesheep") && disk.contains(&fake.email()));
    fake.absent(&disk, "a file beside the key store");
    fake.absent_from_page(&visible(&h), "what the page sees");
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
        assert_eq!(h.account_connect_link(), None);
        assert_eq!(key_store(t.path()), json!({}), "no key, no pending connect");
        let n = fake.count();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fake.count(), n, "the poll ended");
        fake.absent_from_page(&visible(&h), "what the page sees");
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
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    // spacesheep is down, then asks to wait, then is itself again: the connect goes on.
    let n = Arc::new(AtomicUsize::new(0));
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
    // The code has run out, the poll goes on a little for an approval in its last second:
    // a connect started now is a new one, and the person is asked about it again. (One
    // test decides both; they cannot disagree.)
    let now = now_ms();
    h.0.acct
        .connect
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .expires_at_ms = now - 1;
    assert_eq!(connect_state(&h), Some(ConnectState::Pending));
    let (starts, asked) = (fake.starts(), person.asked().len());
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(
        (fake.starts(), person.asked().len()),
        (starts + 1, asked + 1)
    );
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
    // An answer this version cannot read ends it too, saying so: an approval with no
    // key, and one for an address that is not plain ASCII (never shown, never kept).
    for bad in [
        json!({ "state": "approved", "email": "a@b.example" }),
        json!({ "state": "approved", "key": fake.key(), "email": "a@b.example\u{202e}moc" }),
        json!({ "state": "approved", "key": fake.key(), "email": "\u{430}@b.example" }),
    ] {
        fake.hook(move |s| {
            s.target()
                .starts_with("/api/gui/connect/poll")
                .then(|| Reply::json(200, bad.to_string()))
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
    assert!(!person
        .asked()
        .iter()
        .any(|q| matches!(q, Question::Attach { .. })));
    assert_eq!(key_store(t.path()), json!({}));
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
    assert_eq!(h.account_connect_link(), None);
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
    // And its client speaks nothing but https, whatever it is handed.
    let plain = release.0.acct.client.get(fake.origin()).send().await;
    assert!(plain.is_err(), "plain http from a release client");
    assert!(hub_in(t.path())
        .0
        .acct
        .client
        .get(fake.origin())
        .send()
        .await
        .is_ok());
    assert_eq!(
        fake.count(),
        1,
        "only the debug client's own request arrived"
    );

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
    // A link to anywhere but the account's own origin is never one the Hub would open:
    // another site, or something that only carries the origin's name (a blob).
    for link in [
        "https://evil.example/connect/gui?code=x".to_string(),
        format!(
            "blob:{}/9b1c0e0e-0000-4000-8000-000000000000",
            fake.origin()
        ),
    ] {
        fake.set(|w| {
            w.hook = None;
            w.link = Some(link.clone());
        });
        let e = h
            .account_connect_start(Some(&fake.origin()))
            .await
            .unwrap_err();
        assert_eq!(e.code, "bad_answer", "{link}");
        assert!(!e.message.contains("evil.example") && !e.message.contains("blob"));
        assert_eq!(h.account_status().connect, None);
        assert_eq!(h.account_connect_link(), None);
    }
    assert_eq!(
        fake.asked("/api/gui/connect/poll").len(),
        0,
        "nothing was polled"
    );
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn connects_started_from_here_are_few() {
    let t = TempDir::new("acct-starts");
    let fake = Fake::start("start-limit").await;
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    assert_eq!(
        (account::START_LIMIT, account::START_WINDOW_S),
        (3, 3600),
        "three an hour: under what spacesheep allows one address"
    );
    h.0.acct.start_limit.store(2, Ordering::Relaxed);
    // Each start is counted, also one spacesheep refuses and one the person turns down.
    fake.hook(|s| (s.target() == "/api/gui/connect").then(|| Reply::json(404, "{}")));
    assert_eq!(
        h.account_connect_start(Some(&fake.origin()))
            .await
            .unwrap_err()
            .code,
        "refused"
    );
    person.then(&[false]);
    assert_eq!(
        h.account_connect_start(Some(&fake.origin()))
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
    let (starts, asked) = (fake.starts(), person.asked().len());
    let e = h
        .account_connect_start(Some(&fake.origin()))
        .await
        .unwrap_err();
    assert_eq!(e.code, "too_many_starts");
    assert!(e.retry_after_s.is_some_and(|s| s >= 1));
    assert_eq!(
        (fake.starts(), person.asked().len()),
        (starts, asked),
        "refused before anyone was asked or anything was sent"
    );
    // The window passes (it is short in tests) and a start is a start again.
    fake.set(|w| w.hook = None);
    // Counted in the Hub's home, so closing and opening the app does not start it again.
    let again = hub_asking(t.path(), true, true, Some(person.clone()));
    again.0.acct.start_limit.store(2, Ordering::Relaxed);
    let e = again
        .account_connect_start(Some(&fake.origin()))
        .await
        .unwrap_err();
    assert_eq!(e.code, "too_many_starts");
    assert_eq!(fake.starts(), starts);
    tokio::time::sleep(Duration::from_millis(START_WINDOW_MS + 100)).await;
    let v = h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(v.state, ConnectState::Pending);
    // Asking again for the connect that is under way is not a start.
    for _ in 0..5 {
        h.account_connect_start(Some(&fake.origin())).await.unwrap();
    }
    assert!(h.account_connect_cancel());
}

#[tokio::test]
async fn the_person_is_asked_before_an_account_is_kept_and_no_means_nothing_changed() {
    let t = TempDir::new("acct-attach");
    let fake = Fake::start("attach").await;
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));

    // Approved on spacesheep, declined here: nothing is kept.
    person.then(&[true, false]);
    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("declined", || {
        connect_state(&h) == Some(ConnectState::Declined)
    })
    .await;
    let c = h.account_status().connect.unwrap();
    assert_eq!((c.receiver, c.email, c.error), (None, None, None));
    // A key was made on spacesheep and is not kept here: the page is told, with where
    // the person revokes it.
    assert_eq!(
        (c.revoke_url, c.note),
        (
            Some(format!("{}/settings/api-keys", fake.origin())),
            Some(account::UNUSED_KEY_NOTE)
        )
    );
    assert!(h.account_status().accounts.is_empty() && h.receivers().is_empty());
    assert_eq!(key_store(t.path()), json!({}));
    assert!(!t.path().join("accounts").exists());
    fake.absent(&files(t.path()), "a file");

    // The account that is here, with its documents; then spacesheep stops taking its key.
    let first = connected(&h, &fake).await;
    h.set_active(&first).unwrap();
    h.account_doc_set(&first, "labels", &json!({ "rev": 1 }))
        .unwrap();
    fake.set(|w| w.revoked = true);
    ask(&h, "GET", &first, RELAY, b"").await;
    assert_eq!(
        account(&h, &first).unwrap().state,
        AccountState::Unauthorized
    );
    let first_key = kept(t.path(), &first).unwrap();

    // A connect at the same origin comes back approved under ANOTHER account (the code
    // went to someone else, or spacesheep says so). While the person has not answered,
    // and when they say no, the account that was here is whole: entry, key, documents.
    fake.set(|w| {
        w.revoked = false;
        w.email = "someone-else@example.com".into();
        w.key = "ss_KEY-attach-of-someone-else-01".into();
    });
    let other = fake.id();
    assert_ne!(other, first);
    person.then(&[true, false]);
    person.hold();
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the question", || {
        person.asked().last()
            == Some(&Question::Attach {
                email: "someone-else@example.com".into(),
                origin: fake.origin(),
                host: fake.host(),
            })
    })
    .await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    let whole = |h: &Hub| {
        assert_eq!(h.account_status().accounts.len(), 1);
        assert_eq!(h.active().unwrap().id, first);
        assert_eq!(kept(t.path(), &first), Some(first_key.clone()));
        assert_eq!(kept(t.path(), &other), None);
        assert_eq!(
            h.account_doc_get(&first, "labels").unwrap(),
            Some(json!({ "rev": 1 }))
        );
    };
    whole(&h);
    assert_eq!(
        connect_state(&h),
        Some(ConnectState::Asking),
        "not approved until the person says so"
    );
    fake.absent_from_page(&visible(&h), "what the page sees while the key is held");
    person.release();
    until("declined", || {
        connect_state(&h) == Some(ConnectState::Declined)
    })
    .await;
    whole(&h);
    assert!(!files(t.path()).contains("someone-else"));

    // They say yes: the new account is saved, and only then does the other one at this
    // origin go, with its key, its documents and its place as the one shown.
    person.then(&[true, true]);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    let st = h.account_status();
    assert_eq!(st.accounts.len(), 1);
    assert_eq!(
        (st.accounts[0].id.as_str(), st.accounts[0].active),
        (other.as_str(), true)
    );
    assert_eq!(kept(t.path(), &first), None);
    assert!(kept(t.path(), &other).is_some());
    assert!(!t.path().join(format!("accounts/{first}")).exists());
    assert_eq!(key_store(t.path()).as_object().unwrap().len(), 1);
    assert!(!files(t.path()).contains(&first));

    // The connect stops being the one while its question is open (here by taking it away
    // without stopping its poll, so only the check itself can save the day): a yes
    // after that keeps nothing.
    fake.set(|w| w.email = "second-thoughts@example.com".into());
    fake.set(|w| w.revoked = true);
    ask(&h, "GET", &other, RELAY, b"").await;
    fake.set(|w| w.revoked = false);
    let asked = person.asked().len();
    person.hold();
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the question", || person.asked().len() == asked + 2).await;
    let taken = h.0.acct.connect.lock().unwrap().take();
    person.release();
    tokio::time::sleep(Duration::from_millis(80)).await;
    drop(taken);
    assert_eq!(h.account_status().accounts.len(), 1);
    assert_eq!(kept(t.path(), &fake.id()), None);
    // (Taken away by hand, so what a cancel would have cleared is cleared by hand too.)
    h.account_keys().delete(PENDING_NAME).unwrap();
    assert_eq!(key_store(t.path()).as_object().unwrap().len(), 1);
    // And when it stops being the one before the approval is even looked at (while the
    // poll that brings it is in flight), the person is not asked at all.
    let h2 = h.clone();
    fake.hook(move |s| {
        if s.target().starts_with("/api/gui/connect/poll") {
            *h2.0.acct.connect.lock().unwrap() = None;
        }
        None
    });
    let asked = person.asked().len();
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the poll", || h.account_status().connect.is_none()).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        person.asked().len(),
        asked + 1,
        "asked about the origin, never about an account"
    );
    assert_eq!(h.account_status().accounts.len(), 1);
    assert_eq!(kept(t.path(), &fake.id()), None);
    fake.set(|w| w.hook = None);

    // Cancelled while the question is open: a yes after that keeps nothing.
    fake.set(|w| {
        w.revoked = true;
        w.email = "third@example.com".into();
    });
    ask(&h, "GET", &other, RELAY, b"").await;
    fake.set(|w| w.revoked = false);
    let asked = person.asked().len();
    person.hold();
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the question", || person.asked().len() == asked + 2).await;
    assert!(h.account_connect_cancel());
    person.release();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(h.account_status().accounts.len(), 1);
    assert_eq!(h.account_status().accounts[0].id, other);
    assert_eq!(kept(t.path(), &fake.id()), None);
    assert_eq!(key_store(t.path()).as_object().unwrap().len(), 1);
    // Its approval had been collected, so the outcome stays to say a key was made.
    let c = h.account_status().connect.unwrap();
    assert_eq!(c.state, ConnectState::Declined);
    assert!(c.revoke_url.is_some() && c.note.is_some());
    assert!(!h.account_connect_cancel(), "an outcome is cleared");
}

#[tokio::test]
async fn one_question_at_a_time_and_none_without_someone_to_ask() {
    let t = TempDir::new("acct-alerts");
    let fake = Fake::start("alerts").await;
    let other = Fake::start("alerts-other").await;
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    let id = connected(&h, &fake).await;
    h.account_doc_set(&id, "labels", &json!(1)).unwrap();

    // A question is open (a connect to another origin): a second one is refused, not
    // queued behind it, whoever asks; and so is a second connect.
    let asked = person.asked().len();
    person.hold_every();
    let h2 = h.clone();
    let origin = other.origin();
    let first = tokio::spawn(async move { h2.account_connect_start(Some(&origin)).await });
    until("the question", || person.asked().len() == asked + 1).await;
    let at_once = Duration::from_secs(2);
    let e = tokio::time::timeout(at_once, h.account_disconnect(&id))
        .await
        .expect("refused at once, not left waiting behind the open question")
        .unwrap_err();
    assert_eq!(e.code, "busy");
    assert!(
        account(&h, &id).is_some() && kept(t.path(), &id).is_some(),
        "refused, so nothing was disconnected"
    );
    let third = Fake::start("alerts-third").await;
    for origin in [third.origin(), other.origin()] {
        let e = tokio::time::timeout(at_once, h.account_connect_start(Some(&origin)))
            .await
            .expect("refused at once")
            .unwrap_err();
        assert_eq!(e.code, "busy");
    }
    assert_eq!((third.count(), other.count()), (0, 0));
    assert_eq!(
        person.asked().len(),
        asked + 1,
        "nothing was queued behind it"
    );
    person.release();
    assert!(first.await.unwrap().is_ok());
    assert_eq!(person.asked().len(), asked + 1);
    assert!(h.account_connect_cancel());

    // Disconnecting an account that has documents is the person's to confirm; no leaves
    // everything where it was.
    person.then(&[false]);
    let e = h.account_disconnect(&id).await.unwrap_err();
    assert_eq!(e.code, "cancelled");
    assert_eq!(
        person.asked().last(),
        Some(&Question::Disconnect {
            email: fake.email(),
            origin: fake.origin(),
            host: fake.host(),
            documents: true
        })
    );
    assert!(account(&h, &id).is_some() && kept(t.path(), &id).is_some());
    assert_eq!(h.account_doc_get(&id, "labels").unwrap(), Some(json!(1)));
    // `rx_remove` is not a way round it: an account is disconnected, not removed.
    assert!(h.remove(&id).is_err());
    assert!(account(&h, &id).is_some() && kept(t.path(), &id).is_some());
    // Deleting the documents one by one first is no way round it either: the person is
    // asked all the same, and told there is nothing kept to lose.
    h.account_doc_delete(&id, "labels").unwrap();
    person.then(&[false]);
    assert_eq!(
        h.account_disconnect(&id).await.unwrap_err().code,
        "cancelled"
    );
    assert_eq!(
        person.asked().last(),
        Some(&Question::Disconnect {
            email: fake.email(),
            origin: fake.origin(),
            host: fake.host(),
            documents: false
        })
    );
    assert!(account(&h, &id).is_some() && kept(t.path(), &id).is_some());
    // A question that cannot be shown is not a yes.
    person.then_unshown(1);
    assert_eq!(
        h.account_disconnect(&id).await.unwrap_err().code,
        "not_asked"
    );
    assert!(account(&h, &id).is_some() && kept(t.path(), &id).is_some());
    h.account_disconnect(&id).await.unwrap();
    assert!(h.account_status().accounts.is_empty());

    // An origin that merely begins like spacesheep.dev is not spacesheep.dev: asked.
    person.then(&[false, false, false]);
    for origin in [
        "https://spacesheep.dev.evil.example",
        "https://spacesheep.dev:8443",
        "https://spacesheep.development",
    ] {
        let asked = person.asked().len();
        let e = h.account_connect_start(Some(origin)).await.unwrap_err();
        assert_eq!(e.code, "cancelled", "{origin}");
        assert_eq!(person.asked().len(), asked + 1, "{origin}");
        assert!(matches!(
            person.asked().last(),
            Some(Question::Origin { origin: o, .. }) if o == origin
        ));
    }

    // A build with nobody to ask answers every question no.
    let t2 = TempDir::new("acct-alerts-nobody");
    let mute = hub_asking(t2.path(), true, true, None);
    let e = mute
        .account_connect_start(Some(&fake.origin()))
        .await
        .unwrap_err();
    assert_eq!(e.code, "not_asked");
    assert_eq!(fake.starts(), 1, "and nothing was sent");
}

#[tokio::test]
async fn every_door_is_forwarded_with_the_key_and_nothing_of_the_pages() {
    let t = TempDir::new("acct-doors");
    let fake = Fake::start("doors").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    h.account_device_ask(&id, &device_key('K')).await.unwrap();
    let jobs = format!("/api/machines/{MACHINE}/jobs");
    let status = format!("/api/gui/device?id={}", "K".repeat(43));
    #[rustfmt::skip]
    let table: Vec<(&str, &str, &[u8], &str, u16)> = vec![
        ("GET", "/api/sessionpipe/v1/relay?since=0&limit=500&wait=0", b"", "/api/sessionpipe/v1/relay?since=0&limit=500&wait=0", 200),
        ("GET", "/api/sessionpipe/v1/relay?wait=1&since=41", b"", "/api/sessionpipe/v1/relay?since=41&wait=1", 200),
        ("GET", "/api/sessionpipe/v1/relay", b"", "/api/sessionpipe/v1/relay", 200),
        ("GET", "/api/sessionpipe/v1/relay/machines", b"", "/api/sessionpipe/v1/relay/machines", 200),
        ("GET", "/api/sessionpipe/v1/relay/jobs?since=6", b"", "/api/sessionpipe/v1/relay/jobs?since=6", 200),
        ("POST", &jobs, SEND, &jobs, 202),
        // Asked with no id; the Hub names this device's key.
        ("GET", "/api/gui/device", b"", &status, 200),
    ];
    let auth = format!("Bearer {}", fake.key());
    for (method, path, body, sent, want) in table {
        let before = fake.count();
        // The page sends headers of its own; none of them is in what goes up.
        let req = http::Request::builder()
            .method(method)
            .uri(format!("rx://localhost/{id}{path}"))
            .header("origin", APP)
            .header("accept", "text/html")
            .header("accept-language", "ru")
            .header("if-match", "\"1\"")
            .header("if-none-match", "\"2\"")
            .header("user-agent", "Mozilla/5.0 (iPhone)")
            .header("x-requested-with", "page")
            .body(body.to_vec())
            .unwrap();
        let res = h.proxy(req).await;
        assert_eq!(res.status(), want, "{method} {path}: {}", text(&res));
        assert_eq!(hub_code(&res), None, "spacesheep's own answer");
        assert_eq!(fake.count(), before + 1, "one request for one request");
        let s = fake.last();
        assert_eq!((s.method(), s.target()), (method, sent), "{method} {path}");
        // Exactly these headers, each the Hub's own.
        let mut want_headers = vec![
            "accept",
            "accept-encoding",
            "authorization",
            "host",
            "user-agent",
        ];
        if method == "POST" {
            want_headers.extend(["content-length", "content-type"]);
            want_headers.sort();
            assert_eq!(s.header("content-type"), Some("application/json"));
        }
        assert_eq!(
            header_names(&s),
            want_headers,
            "{method} {path}: {}",
            s.head
        );
        assert_eq!(s.header("authorization"), Some(auth.as_str()));
        assert_eq!(s.header("accept"), Some("application/json"));
        assert_eq!(s.header("accept-encoding"), Some("gzip"));
        assert_eq!(s.header("host"), Some(fake.host().as_str()));
        assert_eq!(s.header("user-agent"), Some("sp-test/0.8.0"));
        assert_eq!(s.body, body, "the body as the page sent it");
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
    let device_of = format!("/api/gui/device?id={key_id}");
    let enrol = json!({ "key": device_key('E'), "name": "iPhone" }).to_string();
    let unsigned = br#"{"cmd":"{\"v\":1}","csig":null,"grant":null,"confirm":null}"#;
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
        // A key to be trusted is never the page's to send, whatever it says of it.
        ("POST", "/api/gui/device", enrol.as_bytes(), 403, "not_a_door"),
        ("POST", "/api/gui/device", b"{}", 403, "not_a_door"),
        ("PUT", "/api/gui/device", enrol.as_bytes(), 403, "not_a_door"),
        // A cloud box runs a message unsigned: nothing goes to one, signed or not.
        ("POST", "/api/machines/m_box0123456789abcdef/jobs", br#"{"action":"message","session":"s","text":"rm -rf ~"}"#, 403, "not_a_door"),
        ("POST", "/api/machines/m_box0123456789abcdef/jobs", SEND, 403, "not_a_door"),
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
        ("POST", "/api/machines/m_0123456789abcdef%2F..%2F..%2Fkeys/jobs", SEND, 403, "not_a_door"),
        ("POST", "/api/machines/m_0123456789abcdefABCD/../../keys", SEND, 403, "not_a_door"),
        ("POST", "/api/machines/not-a-machine/jobs", SEND, 403, "not_a_door"),
        ("POST", "/api/machines/m_short/jobs", SEND, 403, "not_a_door"),
        // A door, with what it does not take.
        ("GET", "/api/sessionpipe/v1/relay?since=1&token=x", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?wait=3600", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?limit=100000", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?since=-1", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?since=1&since=2", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay?since=%31", b"", 400, "bad_query"),
        ("GET", "/api/sessionpipe/v1/relay/machines?all=1", b"", 400, "bad_query"),
        // Which key the device door is asked about is not the page's to say…
        ("GET", &device_of, b"", 400, "bad_query"),
        ("GET", "/api/gui/device?id=short", b"", 400, "bad_query"),
        // …and until this device asked to be trusted there is none to ask about.
        ("GET", "/api/gui/device", b"", 409, "no_device_key"),
        ("POST", "/api/machines/m_0123456789abcdefABCD/jobs?check_stub=ok", SEND, 400, "bad_query"),
        // Bodies.
        ("GET", RELAY, b"{}", 400, "bad_body"),
        ("POST", &jobs, b"", 400, "bad_body"),
        ("POST", &jobs, b"[1]", 400, "bad_body"),
        ("POST", &jobs, b"cmd=1", 400, "bad_body"),
        ("POST", &jobs, &big, 413, "too_large"),
        // A send that is not a signed command.
        ("POST", &jobs, b"{}", 400, "not_signed"),
        ("POST", &jobs, br#"{"action":"message","session":"s","text":"rm -rf ~"}"#, 400, "not_signed"),
        ("POST", &jobs, br#"{"cmd":"{\"v\":1}"}"#, 400, "not_signed"),
        ("POST", &jobs, unsigned, 400, "not_signed"),
        ("POST", &jobs, br#"{"cmd":"{\"v\":1}","confirm":{"cred":"k","sig":"s"},"action":"message"}"#, 400, "not_signed"),
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
    assert_eq!(account(&h, &id).unwrap().device_key_id, None);
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
async fn this_devices_key_is_asked_about_by_the_hub_and_no_other_key_ever() {
    let t = TempDir::new("acct-device");
    let fake = Fake::start("device").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let rest = fake.count();
    // Before this device asked, there is no key to ask about.
    assert_eq!(
        said(&ask(&h, "GET", &id, "/api/gui/device", b"").await),
        (409, Some("no_device_key"))
    );
    assert_eq!(fake.count(), rest);

    // The shell hands over the signer's own key; the Hub writes the whole request.
    let key = device_key('K');
    let asked = h.account_device_ask(&id, &key).await.unwrap();
    assert_eq!(
        serde_json::to_value(&asked).unwrap(),
        json!({
            "code": "71", "keyId": "K".repeat(43), "trustedOn": [MACHINE],
            "devicesUrl": format!("{}/devices", fake.origin())
        })
    );
    let s = fake.last();
    assert_eq!((s.method(), s.target()), ("POST", "/api/gui/device"));
    assert_eq!(
        serde_json::from_slice::<Value>(&s.body).unwrap(),
        json!({ "key": key, "name": "iPhone" }),
        "the signer's key as it is, and the Hub's own name for this device"
    );
    assert_eq!(
        s.header("authorization"),
        Some(format!("Bearer {}", fake.key()).as_str())
    );
    assert_eq!(
        account(&h, &id).unwrap().device_key_id,
        Some("K".repeat(43))
    );
    // The status door is about that key and no other, whatever the page writes.
    let res = ask(&h, "GET", &id, "/api/gui/device", b"").await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        fake.last().target(),
        format!("/api/gui/device?id={}", "K".repeat(43))
    );
    let other = format!("/api/gui/device?id={}", "Z".repeat(43));
    assert_eq!(
        said(&ask(&h, "GET", &id, &other, b"").await),
        (400, Some("bad_query"))
    );
    // It is remembered across a restart and a reconnect of the same person.
    let again = hub_in(t.path());
    assert_eq!(
        account(&again, &id).unwrap().device_key_id,
        Some("K".repeat(43))
    );
    fake.set(|w| w.revoked = true);
    ask(&again, "GET", &id, RELAY, b"").await;
    fake.set(|w| w.revoked = false);
    assert_eq!(connected(&again, &fake).await, id);
    assert_eq!(
        account(&again, &id).unwrap().device_key_id,
        Some("K".repeat(43))
    );

    // Asked again while the ask is fresh: the same answer and no request (each new one
    // would change the number the person is matching).
    let rest = fake.count();
    let fresh = h.account_device_ask(&id, &key).await.unwrap();
    for _ in 0..30 {
        assert_eq!(h.account_device_ask(&id, &key).await.unwrap(), fresh);
    }
    assert!(
        fake.count() <= rest + 1,
        "thirty asks, at most the one request"
    );
    // And the requests themselves are few, counted across restarts.
    let forget = |h: &Hub| h.0.acct.asked.lock().unwrap().clear();
    tokio::time::sleep(Duration::from_millis(DEVICE_ASK_WINDOW_MS + 100)).await;
    h.0.acct.device_ask_limit.store(2, Ordering::Relaxed);
    let rest = fake.count();
    for _ in 0..2 {
        forget(&h);
        h.account_device_ask(&id, &key).await.unwrap();
    }
    forget(&h);
    let e = h.account_device_ask(&id, &key).await.unwrap_err();
    assert_eq!(e.code, "too_many_asks");
    assert!(e.retry_after_s.is_some_and(|s| s >= 1));
    let reopened = hub_in(t.path());
    reopened.0.acct.device_ask_limit.store(2, Ordering::Relaxed);
    assert_eq!(
        reopened
            .account_device_ask(&id, &key)
            .await
            .unwrap_err()
            .code,
        "too_many_asks"
    );
    assert_eq!(
        fake.count(),
        rest + 2,
        "two requests, and none that was refused"
    );
    tokio::time::sleep(Duration::from_millis(DEVICE_ASK_WINDOW_MS + 100)).await;
    h.0.acct.device_ask_limit.store(10_000, Ordering::Relaxed);
    forget(&h);

    // What is not a device key as the signer makes one is not sent.
    let rest = fake.count();
    let mut passkey = device_key('P');
    passkey["type"] = "passkey".into();
    let mut named = device_key('N');
    named["name"] = "attacker".into();
    for bad in [passkey, named, json!({}), json!("key")] {
        assert_eq!(
            h.account_device_ask(&id, &bad).await.unwrap_err().code,
            "bad_key"
        );
    }
    assert_eq!(
        h.account_device_ask("nobody", &key).await.unwrap_err().code,
        "unknown_account"
    );
    assert_eq!(fake.count(), rest);
    // spacesheep's refusal comes back in its words, cleaned, with its own code.
    fake.hook(|s| {
        (s.target() == "/api/gui/device").then(|| {
            Reply::json(
                403,
                "{\"error\":\"Turn on \u{201c}Talk\u{201d} first.\\u202e\",\"code\":\"talk_off\"}",
            )
        })
    });
    forget(&h);
    let e = h.account_device_ask(&id, &key).await.unwrap_err();
    assert_eq!(
        (e.code, e.upstream.as_deref()),
        ("refused", Some("talk_off"))
    );
    assert_eq!(e.message, "Turn on Talk first.");
    // An answer about another key, or with a link to elsewhere, is not believed.
    fake.hook(|s| {
        (s.target() == "/api/gui/device").then(|| {
            Reply::json(
                200,
                r#"{"key_id":"someone-elses","code":"71","trusted_on":[]}"#,
            )
        })
    });
    forget(&h);
    assert_eq!(
        h.account_device_ask(&id, &key).await.unwrap_err().code,
        "bad_answer"
    );
    forget(&h);
    let k = "K".repeat(43);
    fake.hook(move |s| {
        (s.target() == "/api/gui/device").then(|| {
            Reply::json(
                200,
                json!({ "key_id": k, "code": 71, "trusted_on": ["m_box0123", 7],
                        "devices_url": "https://evil.example/devices" })
                .to_string(),
            )
        })
    });
    let asked = h.account_device_ask(&id, &key).await.unwrap();
    assert_eq!(
        (
            asked.code.as_str(),
            asked.devices_url,
            asked.trusted_on.len()
        ),
        ("71", None, 0)
    );
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
        .header("host", other.host())
        .header("x-forwarded-host", "evil.example")
        .header("x-forwarded-for", "10.0.0.1")
        .header("forwarded", "host=evil.example")
        .header("cookie", "session=abc")
        .header("accept", "text/html")
        .header("accept-encoding", "br")
        .header("content-type", "text/plain")
        .header("user-agent", "Mozilla/5.0 (iPhone)")
        .header("referer", "tauri://localhost/s/claude/abc")
        .header("x-http-method-override", "DELETE")
        .header("x-sessionpipe-hub", "page")
        .header("if-none-match", "\"x\"")
        .body(SEND.to_vec())
        .unwrap();
    let res = h.proxy(req).await;
    assert_eq!(res.status(), 202);
    assert_eq!(hub_code(&res), None);
    assert_eq!(other.count(), 0, "a Host header moves nothing");
    let s = fake.last();
    assert_eq!(
        header_names(&s),
        vec![
            "accept",
            "accept-encoding",
            "authorization",
            "content-length",
            "content-type",
            "host",
            "user-agent"
        ],
        "{}",
        s.head
    );
    assert_eq!(
        s.header("authorization"),
        Some(format!("Bearer {}", fake.key()).as_str())
    );
    assert_eq!(s.header("host"), Some(fake.host().as_str()));
    assert_eq!(s.header("accept"), Some("application/json"));
    assert_eq!(s.header("accept-encoding"), Some("gzip"));
    assert_eq!(s.header("content-type"), Some("application/json"));
    assert_eq!(s.header("user-agent"), Some("sp-test/0.8.0"));
    // And downstream: of spacesheep's headers, the type and a wait. No cookie is set in
    // the webview, no header of spacesheep's can pass as the Hub's.
    fake.hook(|s| {
        s.target().starts_with(RELAY).then(|| {
            Reply::json(200, "{}")
                .header("set-cookie", "sid=1; Path=/")
                .header("x-sessionpipe-hub", "not_a_door")
                .header("location", "https://evil.example/")
                .header("www-authenticate", "Basic realm=\"x\"")
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
                ("POST", format!("/api/machines/{MACHINE}/jobs"), SEND),
            ] {
                let before = fake.count();
                let res = ask(&h, method, &id, &path, body).await;
                assert_eq!(said(&res), (502, Some("redirected")), "{status} {to}");
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
async fn an_answer_is_unpacked_within_its_limit_and_never_holds_the_key() {
    let t = TempDir::new("acct-answers");
    let fake = Fake::start("answers").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let small = account::SMALL_ANSWER_MAX;
    let relay_max = account::RELAY_ANSWER_MAX;
    assert_eq!((small, relay_max), (1 << 20, 8 << 20));

    // A megabyte and a byte from a door whose answers are small: with its length said
    // up front, and without one (the body ends when the connection does).
    for unsized_ in [false, true] {
        fake.hook(move |s| {
            s.target().starts_with(JOBS_DOOR).then(|| {
                let r = Reply::json(200, vec![b' '; small + 1]);
                if unsized_ {
                    r.no_length()
                } else {
                    r
                }
            })
        });
        let res = ask(&h, "GET", &id, JOBS_DOOR, b"").await;
        assert_eq!(said(&res), (502, Some("answer_too_large")), "{unsized_}");
        assert!(res.body().len() < 400);
    }
    // The same size is a relay page like any other; a page over the relay's own limit
    // is not, and the reader asks for fewer events.
    for (size, want) in [(small + 1, (200, None)), (relay_max, (200, None))] {
        fake.hook(move |s| {
            s.target()
                .starts_with(RELAY)
                .then(|| Reply::json(200, vec![b' '; size]).no_length())
        });
        let res = ask(&h, "GET", &id, RELAY, b"").await;
        assert_eq!(said(&res), want, "{size}");
        assert_eq!(res.body().len(), size);
    }
    fake.hook(move |s| {
        s.target()
            .starts_with(RELAY)
            .then(|| Reply::json(200, vec![b' '; relay_max + 1]).no_length())
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(said(&res), (502, Some("answer_too_large")));

    // Packed: the page gets it unpacked, and the limit is on what comes out. Half a
    // megabyte of gzip that is a page of events; a few kilobytes that would be a gigabyte.
    let page = format!(
        r#"{{"events":[{}],"next":500,"oldest":1}}"#,
        vec![r#"{"type":"turn","text":"the same words again and again"}"#; 20_000].join(",")
    );
    let packed = gz(page.as_bytes());
    assert!(packed.len() * 20 < page.len());
    let p2 = packed.clone();
    fake.hook(move |s| {
        s.target()
            .starts_with(RELAY)
            .then(|| Reply::json(200, p2.clone()).header("content-encoding", "gzip"))
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(said(&res), (200, None));
    assert_eq!(text(&res), page, "unpacked, byte for byte");
    assert!(res.headers().get("content-encoding").is_none());
    let bomb = gz(&vec![0u8; 64 << 20]);
    // Small enough on the wire to pass either door's limit there; sixty-four megabytes out.
    assert!(
        bomb.len() < small / 2,
        "64 MiB of nothing is {} bytes",
        bomb.len()
    );
    // Unpacking stops a byte past the limit: the other sixty-three megabytes never exist.
    assert_eq!(unpack(&bomb, small).unwrap().len(), small + 1);
    assert_eq!(unpack(&bomb, relay_max).unwrap().len(), relay_max + 1);
    assert_eq!(unpack(&gz(b"{}"), small).unwrap(), b"{}");
    for (door, max) in [(RELAY, relay_max), (JOBS_DOOR, small)] {
        let b2 = bomb.clone();
        fake.hook(move |s| {
            s.target()
                .starts_with(door)
                .then(|| Reply::json(200, b2.clone()).header("content-encoding", "GZIP"))
        });
        let res = ask(&h, "GET", &id, door, b"").await;
        assert_eq!(
            said(&res),
            (502, Some("answer_too_large")),
            "{door}: stopped at {max}, never unpacked whole"
        );
    }
    // One member and nothing after it: a second one, or bytes that are no gzip, are not
    // part of an answer the Hub asked for.
    let two = [gz(b"{\"a\":1}"), gz(b"{\"b\":2}")].concat();
    let trailed = [gz(b"{\"a\":1}"), b"junk".to_vec()].concat();
    assert!(matches!(unpack(&two, small), Err(Refused::BadEncoding)));
    assert!(matches!(unpack(&trailed, small), Err(Refused::BadEncoding)));
    for body in [two, trailed] {
        fake.hook(move |s| {
            s.target()
                .starts_with(RELAY)
                .then(|| Reply::json(200, body.clone()).header("content-encoding", "gzip"))
        });
        let res = ask(&h, "GET", &id, RELAY, b"").await;
        assert_eq!(said(&res), (502, Some("bad_encoding")));
    }
    // Packed some other way, or not what it says it is.
    for (encoding, body) in [
        ("br", packed.clone()),
        ("deflate", packed),
        ("gzip", b"{}".to_vec()),
    ] {
        fake.hook(move |s| {
            s.target()
                .starts_with(RELAY)
                .then(|| Reply::json(200, body.clone()).header("content-encoding", encoding))
        });
        let res = ask(&h, "GET", &id, RELAY, b"").await;
        assert_eq!(said(&res), (502, Some("bad_encoding")), "{encoding}");
    }

    // An origin that echoes what it was sent: the key does not come back down, plain or
    // packed, small or large, in the body or a header.
    for place in ["body", "packed", "large", "content-type", "retry-after"] {
        fake.hook(move |s| {
            let auth = s.header("authorization").unwrap_or("").to_string();
            let echo = json!({ "you_sent": auth }).to_string();
            Some(match place {
                "body" => Reply::json(200, echo),
                // Packed for real: among enough other text that the key's bytes are not
                // in what goes over the wire, only in what comes out.
                "packed" => {
                    let filler: String = (0..400)
                        .map(|i| format!("{{\"seq\":{i},\"text\":\"turn {i} of the session\"}},"))
                        .collect();
                    let packed = gz_best(format!("[{filler}{echo},{echo}]").as_bytes());
                    let key = auth.trim_start_matches("Bearer ");
                    assert!(
                        !account::holds(&packed, key.as_bytes()),
                        "the key must not be readable in the packed bytes"
                    );
                    Reply::json(200, packed).header("content-encoding", "gzip")
                }
                "large" => Reply::json(200, format!("{}{echo}", " ".repeat(300_000))),
                "content-type" => Reply {
                    status: 200,
                    headers: vec![("content-type".into(), format!("text/plain; x={auth}"))],
                    body: b"{}".to_vec(),
                    delay: None,
                    unsized_body: false,
                },
                _ => Reply::json(429, "{}").header("retry-after", &auth),
            })
        });
        let res = ask(&h, "GET", &id, RELAY, b"").await;
        assert_eq!(said(&res), (502, Some("withheld")), "{place}");
        fake.absent(&dump(&res), "an answer");
    }
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn a_request_that_never_ends_is_cut_off() {
    let t = TempDir::new("acct-timeout");
    let fake = Fake::start("timeout").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    // Past the limit of every door but the relay (fifteen seconds; the test clock runs
    // faster), and past the relay's own for the wait it asked.
    let late = SECOND * (account::REQUEST_TIMEOUT_S as u32 + 10);
    fake.hook(move |s| {
        (!s.target().starts_with("/api/gui/connect")).then(|| Reply::json(200, "{}").after(late))
    });
    let t0 = Instant::now();
    let res = ask(&h, "GET", &id, JOBS_DOOR, b"").await;
    assert_eq!(said(&res), (504, Some("timeout")));
    assert!(t0.elapsed() < late, "cut off, not waited out");
    assert!(!h.is_connected(&id));
    // The relay's limit is its wait and twenty seconds more: the same lateness is in time
    // for a long poll, and too late for one that asked no wait.
    let res = ask(&h, "GET", &id, "/api/sessionpipe/v1/relay?wait=25", b"").await;
    assert_eq!(said(&res), (200, None));
    let late = SECOND * (account::RELAY_GRACE_S as u32 + 5);
    fake.hook(move |s| {
        s.target()
            .starts_with(RELAY)
            .then(|| Reply::json(200, "{}").after(late))
    });
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(said(&res), (504, Some("timeout")));
    // A body that starts and never finishes is cut off the same.
    let res = h.account_device_ask(&id, &device_key('K')).await;
    assert!(res.is_ok(), "the device door answers at once here");
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
    assert_eq!(account(&h, &id).unwrap().state, AccountState::Ok);

    // Pro or Talk off is a 403: the key is alive, the account is not marked.
    fake.hook(|_| Some(Reply::json(403, r#"{"error":"Pro","code":"pro_required"}"#)));
    assert_eq!(ask(&h, "POST", &id, &jobs, SEND).await.status(), 403);
    // A grant that needs unlocking is the signer's 401, not the key's.
    fake.hook(|_| {
        Some(Reply::json(
            401,
            r#"{"error":"Unlock","code":"unlock","refusal":"bad_grant"}"#,
        ))
    });
    let res = ask(&h, "POST", &id, &jobs, SEND).await;
    assert_eq!(said(&res), (401, None));
    assert_eq!(account(&h, &id).unwrap().state, AccountState::Ok);

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
    assert_eq!(account(&h, &id).unwrap().state, AccountState::Unauthorized);
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
    assert_eq!(kept(t.path(), &id), Some((fake.origin(), fake.key())));
    // It is in the list on disk, so the next start knows without asking.
    let again = hub_in(t.path());
    assert_eq!(
        account(&again, &id).unwrap().state,
        AccountState::Unauthorized
    );
    // The jobs door's own 401 for a dead key marks it too.
    assert_eq!(ask(&again, "POST", &id, &jobs, SEND).await.status(), 401);
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
    assert_eq!(account(&again, &id).unwrap().state, AccountState::Ok);
    assert_eq!(
        kept(t.path(), &id).unwrap().1,
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
        account(&again, &id).unwrap().state,
        AccountState::Unauthorized
    );
    fake.set(|w| w.revoked = false);
    assert_eq!(ask(&again, "GET", &id, RELAY, b"").await.status(), 200);
    assert_eq!(account(&again, &id).unwrap().state, AccountState::Ok);
    assert!(again.is_connected(&id));
    fake.absent(&files(t.path()), "a file beside the key store");
    let lines = logged().join("\n");
    fake.absent(&lines, "a log line");
    assert!(!lines.contains("ss_KEY-revoked-second"));
    assert!(lines.contains(&format!("acct {id}: spacesheep refused the key")));
}

#[tokio::test]
async fn each_account_has_its_own_room_and_the_hubs_own_requests_theirs() {
    let t = TempDir::new("acct-busy");
    let fake = Fake::start("busy").await;
    let other = Fake::start("busy-other").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    let id2 = connected(&h, &other).await;
    assert_eq!(h.account_status().accounts.len(), 2);
    let hold = |s: &Seen| {
        (s.target().starts_with(RELAY) && s.target() != MACHINES).then(|| {
            Reply::json(200, r#"{"events":[],"next":1,"oldest":null,"jobs":[]}"#)
                .after(Duration::from_millis(400))
        })
    };
    fake.hook(hold);
    let rest = fake.count();
    let held = |path: &'static str| {
        let (h, id) = (h.clone(), id.clone());
        tokio::spawn(async move { ask(&h, "GET", &id, path, b"").await })
    };
    // Two relay reads at a time: a long poll, and the one that replaces it after a reload.
    let mut tasks: Vec<_> = (0..account::MAX_RELAY_READS)
        .map(|_| held("/api/sessionpipe/v1/relay?wait=5"))
        .collect();
    until("two relay reads", || {
        fake.count() == rest + account::MAX_RELAY_READS
    })
    .await;
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(said(&res), (429, Some("busy")));
    assert_eq!(res.headers()["retry-after"], "1");
    // The other doors still have room, up to the page's six in all.
    for _ in account::MAX_RELAY_READS..account::MAX_PAGE_REQUESTS {
        tasks.push(held("/api/sessionpipe/v1/relay/jobs?since=1"));
    }
    until("six in flight", || {
        fake.count() == rest + account::MAX_PAGE_REQUESTS
    })
    .await;
    let res = ask(&h, "GET", &id, MACHINES, b"").await;
    assert_eq!(said(&res), (429, Some("busy")));
    assert_eq!(
        fake.count(),
        rest + account::MAX_PAGE_REQUESTS,
        "the refused ones reached nobody"
    );
    // The Hub's own questions are not the page's: the signer still learns what it signs
    // for, and this device's key can still be asked about.
    let info: Value = serde_json::from_slice(&h.get(&id, "/api/ui/info").await.unwrap()).unwrap();
    assert_eq!(info["control"]["rpId"], "localhost");
    assert!(h.account_device_ask(&id, &device_key('K')).await.is_ok());
    // Another account is not this one: all its room is its own.
    assert_eq!(ask(&h, "GET", &id2, RELAY, b"").await.status(), 200);
    assert_eq!(ask(&h, "GET", &id2, MACHINES, b"").await.status(), 200);
    for task in tasks {
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
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    // No account, no documents: an id that is not one is not a folder to write in.
    for id in ["", "nobody0000", "../x", "acct", &fake.id()] {
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
    let again = hub_asking(t.path(), true, true, Some(person.clone()));
    assert_eq!(again.account_doc_get(&id, "labels").unwrap(), Some(labels));
    assert_eq!(again.account_doc_get(&id, "marks").unwrap(), Some(marks));
    // A build with accounts off reads none of it.
    let off = hub_with(t.path(), false, true);
    assert_eq!(
        off.account_doc_get(&id, "labels").unwrap_err().code,
        "unknown_account"
    );

    // Disconnect, the person saying yes: the key, the documents and the entry go; the
    // answer says what stays.
    let asked = person.asked().len();
    let d = again.account_disconnect(&id).await.unwrap();
    assert_eq!(person.asked().len(), asked + 1);
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
        again.account_disconnect(&id).await.unwrap_err().code,
        "unknown_account"
    );
    // Nothing is forwarded for an account that is not there, door or not.
    let rest = fake.count();
    let res = ask(&again, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 404);
    assert_eq!(fake.count(), rest);
    let list = std::fs::read_to_string(t.path().join("receivers.json")).unwrap();
    assert!(!list.contains(&id) && !list.contains("spacesheep"));
    fake.absent(&files(t.path()), "a file");
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn an_account_survives_a_restart_of_the_hub() {
    let t = TempDir::new("acct-restart");
    let fake = Fake::start("restart").await;
    // The first start in this home: whatever the account key store held belongs to an
    // install that is gone (an iPhone keeps keychain items when the app is deleted).
    std::fs::write(
        t.path().join("account-keys.json"),
        json!({ "acct:left-behind": account::kept_key(&fake.origin(), "ss_KEY-of-an-old-install") })
            .to_string(),
    )
    .unwrap();
    let id = {
        let h = hub_in(t.path());
        assert_eq!(key_store(t.path()), json!({}), "emptied on a first start");
        assert!(
            t.path().join("receivers.json").is_file(),
            "and the next start is not a first"
        );
        let id = connected(&h, &fake).await;
        h.set_active(&id).unwrap();
        h.account_doc_set(&id, "labels", &json!({ "rev": 1 }))
            .unwrap();
        id
    };
    let h = hub_in(t.path());
    h.start(tokio::runtime::Handle::current());
    assert_eq!(
        kept(t.path(), &id),
        Some((fake.origin(), fake.key())),
        "not a first start: the key is where it was"
    );
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
    assert_eq!(account(&h, &id).unwrap().state, AccountState::NoKey);
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(said(&res), (401, Some("not_connected")));
    assert_eq!(fake.count(), rest + 1);
    // Connecting again is how it gets one.
    assert_eq!(connected(&h, &fake).await, id);
    assert_eq!(account(&h, &id).unwrap().state, AccountState::Ok);
    assert_eq!(
        h.account_doc_get(&id, "labels").unwrap(),
        Some(json!({ "rev": 1 })),
        "the same person keeps their documents"
    );
    fake.absent(&files(t.path()), "a file beside the key store");
    fake.absent_from_page(&visible(&h), "what the page sees");
}

#[tokio::test]
async fn a_pending_connect_goes_on_after_the_app_was_closed() {
    let t = TempDir::new("acct-resume");
    let fake = Fake::start("resume").await;
    let person = Script::saying(true);
    let saved = {
        let h = hub_asking(t.path(), true, true, Some(person.clone()));
        h.account_connect_start(Some(&fake.origin())).await.unwrap();
        let saved = std::fs::read(t.path().join("account-keys.json")).unwrap();
        // The app is closed: its poll stops, and what it kept stays.
        h.account_connect_cancel();
        saved
    };
    std::fs::write(t.path().join("account-keys.json"), &saved).unwrap();
    // The person confirms in the browser while the app is gone.
    fake.set(|w| w.verdict = Verdict::Approved);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    assert_eq!(h.account_status().connect, None, "nothing before it starts");
    h.start(tokio::runtime::Handle::current());
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    assert_eq!(h.account_status().accounts[0].email, fake.email());
    assert!(key_store(t.path()).get(PENDING_NAME).is_none());
    assert_eq!(fake.starts(), 1);
    // Back in the app, the person is still asked whose account this is.
    assert!(matches!(
        person.asked().last(),
        Some(Question::Attach { email, .. }) if *email == fake.email()
    ));

    // What was kept is believed only as far as a fresh answer would be.
    let other = Fake::start("resume-other").await;
    let elsewhere = other.origin();
    type Change = Box<dyn Fn(&mut Value)>;
    let changes: Vec<(&str, Change)> = vec![
        (
            "another origin",
            Box::new(move |v| v["origin"] = json!(&elsewhere)),
        ),
        (
            "an origin that is none",
            Box::new(|v| v["origin"] = json!("http://evil.example")),
        ),
        (
            "a link elsewhere",
            Box::new(|v| v["url"] = json!("https://evil.example/connect/gui")),
        ),
        (
            "long expired",
            Box::new(|v| v["expires_at"] = json!("2020-01-01T00:00:00.000Z")),
        ),
        ("no token", Box::new(|v| v["poll_token"] = json!(""))),
    ];
    for (what, f) in changes {
        let t2 = TempDir::new("acct-resume-bad");
        let mut all: Value = serde_json::from_slice(&saved).unwrap();
        let mut rec: Value = serde_json::from_str(all[PENDING_NAME].as_str().unwrap()).unwrap();
        f(&mut rec);
        all[PENDING_NAME] = json!(rec.to_string());
        // Not a first start (that would empty the store whatever was in it).
        std::fs::write(t2.path().join("receivers.json"), r#"{"receivers":[]}"#).unwrap();
        std::fs::write(t2.path().join("account-keys.json"), all.to_string()).unwrap();
        let h2 = hub_in(t2.path());
        assert!(key_store(t2.path()).get(PENDING_NAME).is_some(), "{what}");
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
        .post_json(&id, &format!("/api/machines/{MACHINE}/jobs"), SEND.to_vec())
        .await
        .is_err());
    assert!(h
        .post_json(&id, "/api/gui/device", b"{}".to_vec())
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
    assert!(fake.seen()[rest..].iter().all(|s| s.target() == MACHINES));

    // A receiver beside it is a receiver still: its cookie, never the account's key.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let port =
        crate::testutil::serve(|_| (200, "application/json", b"{}".to_vec()), Some(tx)).await;
    let mut reg = Registry::load(t.path());
    let (mut r, _) = Receiver::from_url(&format!("http://127.0.0.1:{port}")).unwrap();
    r.local = false;
    r.id = "remote2345".into();
    reg.upsert(r).unwrap();
    let h = hub_in(t.path());
    h.0.cfg.keys.set("remote2345", "uikey").unwrap();
    let res = ask(&h, "GET", "remote2345", "/api/ui/info", b"").await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["access-control-expose-headers"],
        "etag, content-type"
    );
    let seen = rx.recv().await.unwrap();
    assert_eq!(seen.header("cookie"), Some("spgui=uikey"));
    assert_eq!(seen.header("authorization"), None);
    assert_eq!(
        seen.header("accept-encoding"),
        None,
        "a receiver's request is what it was"
    );
    let rows = serde_json::to_value(h.receivers()).unwrap();
    let plain = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "remote2345")
        .unwrap();
    let mut names: Vec<&String> = plain.as_object().unwrap().keys().collect();
    names.sort();
    assert_eq!(
        names,
        vec!["id", "local", "name", "origin"],
        "a receiver's row is what it was"
    );
    assert_eq!(h.account_status().accounts.len(), 1);
    // A receiver is removed as it always was; its key goes from its own store.
    assert!(h.remove("remote2345").unwrap());
    assert_eq!(h.0.cfg.keys.get("remote2345"), None);
}

#[tokio::test]
async fn a_key_is_for_its_account_at_its_origin_whatever_the_list_says() {
    let t = TempDir::new("acct-tamper");
    let fake = Fake::start("tamper").await;
    let thief = Fake::start("tamper-thief").await;
    let id = connected(&hub_in(t.path()), &fake).await;
    let path = t.path().join("receivers.json");
    let list = std::fs::read_to_string(&path).unwrap();
    let rest = (fake.count(), thief.count());

    // The list rewritten on disk to send the account elsewhere, keeping its id: the id
    // is no longer its origin's and email's, and nothing is sent.
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
            ("POST", format!("/api/machines/{MACHINE}/jobs"), SEND),
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
        assert!(h.account_device_ask(&id, &device_key('K')).await.is_err());
    }
    assert_eq!(
        (fake.count(), thief.count()),
        rest,
        "nobody was sent anything"
    );
    // With the id rewritten to match the new origin, there is no key under that name.
    let moved = crate::id::account_id(&thief.origin(), &fake.email());
    let rewritten = list
        .replace(&fake.origin(), &thief.origin())
        .replace(&id, &moved);
    std::fs::write(&path, &rewritten).unwrap();
    let h = hub_in(t.path());
    assert_eq!(account(&h, &moved).unwrap().state, AccountState::NoKey);
    let res = ask(&h, "GET", &moved, RELAY, b"").await;
    assert_eq!(hub_code(&res), Some("not_connected"));
    // And were two ids ever the same (a whole digest: they are not), the key store
    // itself says which origin a key is for. The real key, under the name the rewritten
    // entry looks up: still not sent to the origin that entry names.
    let mut keys = key_store(t.path());
    keys[format!("acct:{moved}")] = keys[format!("acct:{id}")].clone();
    std::fs::write(t.path().join("account-keys.json"), keys.to_string()).unwrap();
    let h = hub_in(t.path());
    assert_eq!(account(&h, &moved).unwrap().state, AccountState::NoKey);
    for (method, door, body) in [
        ("GET", RELAY.to_string(), &b""[..]),
        ("POST", format!("/api/machines/{MACHINE}/jobs"), SEND),
    ] {
        let res = ask(&h, method, &moved, &door, body).await;
        assert_eq!(said(&res), (401, Some("not_connected")), "{method}");
    }
    assert!(h.get(&moved, "/api/ui/info").await.is_err());
    assert_eq!(
        (fake.count(), thief.count()),
        rest,
        "the key went to nobody"
    );
    // A key written before the origin was kept beside it (a bare string) is no key.
    std::fs::write(
        t.path().join("account-keys.json"),
        json!({ format!("acct:{id}"): fake.key() }).to_string(),
    )
    .unwrap();
    std::fs::write(&path, &list).unwrap();
    let h = hub_in(t.path());
    assert_eq!(account(&h, &id).unwrap().state, AccountState::NoKey);
    fake.absent(&logged().join("\n"), "a log line");
}

#[tokio::test]
async fn an_approval_never_takes_an_id_that_is_someone_elses() {
    let t = TempDir::new("acct-collide");
    let fake = Fake::start("collide").await;
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    // The id the approval will have is already an entry's, at another origin (as if an
    // origin had found an email whose id lands on spacesheep.dev's account). The entry
    // that was here first has a key and documents.
    let id = fake.id();
    let mut there =
        Receiver::account("https://spacesheep.dev", "owner@example.com", "then").unwrap();
    there.id = id.clone();
    Registry::load(t.path()).upsert(there).unwrap();
    let theirs = account::kept_key("https://spacesheep.dev", "ss_KEY-of-the-real-account-1");
    h.0.cfg
        .account
        .keys
        .set(&format!("acct:{id}"), &theirs)
        .unwrap();
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    h.set_active(&id).unwrap();
    std::fs::create_dir_all(t.path().join(format!("accounts/{id}"))).unwrap();
    std::fs::write(t.path().join(format!("accounts/{id}/labels.json")), "1").unwrap();

    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("refused", || {
        connect_state(&h) == Some(ConnectState::Failed)
    })
    .await;
    let c = h.account_status().connect.unwrap();
    assert_eq!(c.error.clone().unwrap().code, "conflict");
    assert!(c.revoke_url.is_some() && c.note.is_some(), "a key was made");
    assert!(
        !person
            .asked()
            .iter()
            .any(|q| matches!(q, Question::Attach { .. })),
        "refused before the person was asked, before anything was written"
    );
    // Nothing of the entry that was here changed.
    let reg = Registry::load(t.path());
    assert_eq!(reg.list().len(), 1);
    assert_eq!(reg.list()[0].origin, "https://spacesheep.dev");
    assert_eq!(
        reg.list()[0].account.as_ref().unwrap().email,
        "owner@example.com"
    );
    assert_eq!(reg.active(), Some(id.as_str()));
    assert_eq!(
        key_store(t.path())[format!("acct:{id}")].as_str(),
        Some(theirs.as_str())
    );
    assert!(t
        .path()
        .join(format!("accounts/{id}/labels.json"))
        .is_file());
    fake.absent(&files(t.path()), "a file");
    assert!(!key_store(t.path()).to_string().contains(&fake.key()));
}

#[tokio::test]
async fn a_receivers_key_file_and_a_rewritten_list_send_no_api_key_as_a_cookie() {
    let t = TempDir::new("acct-shared");
    let thief = Fake::start("shared-thief").await;
    let api_key = "ss_KEY-shared-file-0123456789abcdef";
    let acct = "a".repeat(52);
    // The layout this must never rely on: account keys in the receivers' own key file.
    // And a list rewritten so that entries which look like receivers have, as their ids,
    // the names account secrets are kept under, at an origin of the attacker's.
    let keys = json!({
        format!("acct:{acct}"): account::kept_key("https://spacesheep.dev", api_key),
        "acct-connect": json!({ "poll_token": "POLLTOKEN-shared-file-0123456789" }).to_string(),
        &acct: api_key,
    });
    std::fs::write(t.path().join("keys.json"), keys.to_string()).unwrap();
    let entry =
        |id: &str| json!({ "id": id, "name": "x", "origin": thief.origin(), "local": false });
    let list = json!({
        "receivers": [entry(&format!("acct:{acct}")), entry("acct-connect"), entry(&acct)],
        "active": format!("acct:{acct}"),
    });
    std::fs::write(t.path().join("receivers.json"), list.to_string()).unwrap();
    logged();
    let h = Hub::new(HubConfig {
        home: t.path().to_path_buf(),
        keys: KeyStore::File(t.path().join("keys.json")),
        env_receiver_url: None,
        allowed_origins: proxy::default_allowed_origins(None),
        status: StatusFile::new(None, "test"),
        user_agent: "sp-test/0.8.0".into(),
        account: AccountConfig {
            enabled: true,
            keys: KeyStore::File(t.path().join("keys.json")),
            allow_local_http: true,
            ..AccountConfig::default()
        },
    });
    // Given one place for both, the account mode is off altogether.
    assert!(!h.account_status().enabled);
    assert_eq!(
        h.account_connect_start(Some(&thief.origin()))
            .await
            .unwrap_err()
            .code,
        "unsupported"
    );
    // None of those entries is a receiver: not listed, not shown, not selectable.
    assert!(h.receivers().is_empty());
    assert!(h.active().is_none());
    for id in [format!("acct:{acct}"), "acct-connect".into(), acct.clone()] {
        assert!(h.set_active(&id).is_err(), "{id}");
        assert!(h.get(&id, "/api/ui/info").await.is_err(), "{id}");
        assert!(h.view_url(&id, "/x").is_err(), "{id}");
        assert!(h
            .open_stream(&id, "/api/ui/stream", "main", |_| true)
            .is_err());
    }
    // Starting the app opens a stream to every receiver, with its key as a cookie.
    h.start(tokio::runtime::Handle::current());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(thief.count(), 0, "the attacker's origin heard nothing");
    // Even an entry that got into the Hub for a run with such an id gets no key and no
    // request: a receiver's key is looked up only by an id a receiver can have.
    for id in [format!("acct:{acct}"), "acct-connect".into(), acct.clone()] {
        let (mut r, _) = Receiver::from_url(&thief.origin()).unwrap();
        r.local = false;
        r.id = id.clone();
        assert_eq!(h.key_for(&r), None, "{id}");
        h.0.transient.lock().unwrap().push(r);
        assert!(h.get(&id, "/api/ui/info").await.is_err(), "{id}");
        assert!(h.view_url(&id, "/x").is_err());
        h.ensure_tray(&id);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(thief.count(), 0);
    // The list as it was is still on disk: what this version does not read, it keeps.
    h.0.registry.lock().unwrap().save().unwrap();
    let after: Value =
        serde_json::from_slice(&std::fs::read(t.path().join("receivers.json")).unwrap()).unwrap();
    assert_eq!(after["receivers"], list["receivers"]);
    assert!(!logged().join("\n").contains(api_key));
}

#[tokio::test]
async fn an_entry_this_version_does_not_read_is_kept_and_never_a_receiver() {
    let t = TempDir::new("acct-newer");
    let fake = Fake::start("newer").await;
    let id = connected(&hub_in(t.path()), &fake).await;
    let path = t.path().join("receivers.json");
    let mut list: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    // A newer version wrote a kind of its own beside the account, and gave the account's
    // record a field of another shape.
    let newer = json!({
        "id": "teleport2345", "name": "beam", "origin": fake.origin(), "local": false,
        "kind": "teleport", "beam": { "power": 9 }
    });
    let mut reshaped = list["receivers"][0].clone();
    reshaped["account"]["unauthorized"] = json!({ "since": "yesterday" });
    list["receivers"] = json!([newer, reshaped]);
    list["active"] = json!("teleport2345");
    std::fs::write(&path, list.to_string()).unwrap();
    let rest = fake.count();

    let h = hub_in(t.path());
    h.start(tokio::runtime::Handle::current());
    // Neither is an entry here: not listed to the page, not the window's receiver, not
    // selectable, not spoken to.
    assert!(h.receivers().is_empty());
    assert!(h.active().is_none());
    assert!(h.account_status().accounts.is_empty());
    for id in ["teleport2345", id.as_str()] {
        assert!(h.set_active(id).is_err(), "{id}");
        assert!(h.get(id, "/api/ui/info").await.is_err());
        assert!(h
            .open_stream(id, "/api/ui/stream", "main", |_| true)
            .is_err());
        assert_eq!(ask(&h, "GET", id, RELAY, b"").await.status(), 404);
        assert!(h.account_doc_get(id, "labels").is_err());
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.count(), rest);
    // Saves leave both exactly as the newer version wrote them, and the key where it is
    // (this is not a first start: nothing is swept).
    let (r, _) = Receiver::from_url("http://192.168.1.10:7373").unwrap();
    h.0.registry.lock().unwrap().upsert(r.clone()).unwrap();
    h.set_active(&r.id).unwrap();
    assert!(h.remove(&r.id).unwrap());
    let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(after["receivers"], list["receivers"]);
    assert!(kept(t.path(), &id).is_some());
    // An approval for the id that is kept unread does not replace it.
    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the end", || {
        connect_state(&h) == Some(ConnectState::Failed)
    })
    .await;
    let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(after["receivers"], list["receivers"]);

    // A list that is no list at all is copied aside before anything is saved over it.
    std::fs::write(&path, "{ \"receivers\": [ { \"id\": ").unwrap();
    let h = hub_in(t.path());
    assert!(h.receivers().is_empty());
    assert!(
        kept(t.path(), &id).is_some(),
        "an unreadable list is not a first start: no key is swept"
    );
    h.0.registry.lock().unwrap().upsert(r).unwrap();
    assert_eq!(
        std::fs::read_to_string(t.path().join("receivers.json.bad")).unwrap(),
        "{ \"receivers\": [ { \"id\": "
    );
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
    assert_eq!(said(&res), (403, Some("account_off")));
    assert_eq!(
        off.account_device_ask(&id, &device_key('K'))
            .await
            .unwrap_err()
            .code,
        "unknown_account"
    );
    let release = hub_with(t.path(), true, false);
    let res = ask(&release, "GET", &id, RELAY, b"").await;
    assert_eq!(
        said(&res),
        (403, Some("bad_account")),
        "plain http is no origin there"
    );
    assert_eq!(fake.count(), rest);
    // A build with the mode off sweeps nothing and writes no list on its first start.
    let t2 = TempDir::new("acct-off-first");
    std::fs::write(t2.path().join("account-keys.json"), r#"{"x":"y"}"#).unwrap();
    hub_with(t2.path(), false, true);
    assert_eq!(key_store(t2.path()), json!({ "x": "y" }));
    assert!(!t2.path().join("receivers.json").exists());
}

/// The list cannot be written (a full disk, here a folder made read-only): the approved
/// account is not kept, its key is taken back out, and the account that was at that
/// origin before is whole. It goes only once the new one is saved.
#[cfg(unix)]
#[tokio::test]
async fn an_account_that_cannot_be_saved_replaces_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let t = TempDir::new("acct-unsaved");
    let fake = Fake::start("unsaved").await;
    logged();
    // Account keys in memory, so that the list is the only thing that cannot be written.
    let h = Hub::new(HubConfig {
        home: t.path().to_path_buf(),
        keys: KeyStore::File(t.path().join("keys.json")),
        env_receiver_url: None,
        allowed_origins: proxy::default_allowed_origins(None),
        status: StatusFile::new(None, "test"),
        user_agent: "sp-test/0.8.0".into(),
        account: AccountConfig {
            enabled: true,
            keys: KeyStore::memory(),
            allow_local_http: true,
            device: "iPhone".into(),
            version: "0.8.0".into(),
            confirm: Some(Script::saying(true)),
        },
    });
    let keys = &h.0.cfg.account.keys;
    let first = connected(&h, &fake).await;
    h.account_doc_set(&first, "labels", &json!({ "rev": 1 }))
        .unwrap();
    fake.set(|w| w.revoked = true);
    ask(&h, "GET", &first, RELAY, b"").await;
    fake.set(|w| {
        w.revoked = false;
        w.email = "newcomer@example.com".into();
        w.key = "ss_KEY-unsaved-of-the-newcomer-1".into();
    });
    let second = fake.id();
    let theirs = keys.get(&format!("acct:{first}")).unwrap();

    let writable = |on: bool| {
        let mode = if on { 0o755 } else { 0o555 };
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(mode)).unwrap();
    };
    writable(false);
    if std::fs::write(t.path().join("probe"), b"x").is_ok() {
        // Whoever runs this may write anywhere (root): nothing to see here.
        writable(true);
        return;
    }
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the end", || {
        connect_state(&h) == Some(ConnectState::Failed)
    })
    .await;
    writable(true);
    assert_eq!(
        h.account_status().connect.unwrap().error.unwrap().code,
        "io"
    );
    assert_eq!(keys.get(&format!("acct:{second}")), None, "taken back out");
    assert_eq!(
        keys.get(&format!("acct:{first}")),
        Some(theirs),
        "the one that was here keeps its key"
    );
    assert_eq!(
        h.account_doc_get(&first, "labels").unwrap(),
        Some(json!({ "rev": 1 }))
    );
    let on_disk = Registry::load(t.path());
    assert_eq!(on_disk.list().len(), 1);
    assert_eq!(on_disk.list()[0].id, first);
    // And what the Hub holds in memory is what is on disk: no entry that was never saved.
    assert_eq!(h.account_status().accounts.len(), 1);
    assert_eq!(
        account(&h, &first).unwrap().state,
        AccountState::Unauthorized
    );
    assert!(h.receiver(&second).is_none());
    assert!(!keys
        .get(&format!("acct:{first}"))
        .unwrap()
        .contains("newcomer"));
}

/// The approval is collected from spacesheep once, and its record there is gone. So a
/// question that could not be shown is not an answer: the key is held, never where the
/// page reads, and the person is asked again, until they answer.
#[tokio::test]
async fn an_approval_is_held_until_the_person_has_really_answered() {
    let t = TempDir::new("acct-held");
    let fake = Fake::start("held").await;
    // Nothing can be shown on this device for now (another alert is up, there is no
    // window, the app is in the background).
    let person = Script::unshown();
    person.then(&[true]);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the approval, held", || {
        connect_state(&h) == Some(ConnectState::Asking)
    })
    .await;
    until("asked more than once", || person.attach_questions() >= 3).await;
    // Held: not an account yet, nothing the page reads has the key, and it is beside the
    // pending connect in the key store, for a restart.
    let c = h.account_status().connect.unwrap();
    assert_eq!(
        (c.state, c.receiver, c.error),
        (ConnectState::Asking, None, None)
    );
    assert!(h.account_status().accounts.is_empty());
    assert!(kept(t.path(), &fake.id()).is_none());
    assert!(key_store(t.path())[PENDING_NAME]
        .as_str()
        .unwrap()
        .contains(&fake.key()));
    fake.absent_from_page(&visible(&h), "what the page sees while the key is held");
    fake.absent(&files(t.path()), "a file beside the key store");
    assert_eq!(
        h.account_connect_link(),
        None,
        "the link ended with the code"
    );
    // The key was handed over once; nothing more is asked of spacesheep meanwhile.
    let polls = fake.asked("/api/gui/connect/poll").len();
    // Pressing Connect again is the same connect, still asking; another origin waits.
    let again = h.account_connect_start(Some(&fake.origin())).await.unwrap();
    assert_eq!(again.state, ConnectState::Asking);
    let e = h
        .account_connect_start(Some("https://stagesheep.dev"))
        .await
        .unwrap_err();
    assert_eq!(e.code, "busy");
    assert_eq!(
        connect_state(&h),
        Some(ConnectState::Asking),
        "and the key is still held"
    );

    // The app is closed while it waits. Opened again, it asks from what it kept: no new
    // connect, no new poll, and this time the question can be shown.
    let taken = h.0.acct.connect.lock().unwrap().take().unwrap();
    taken.task.as_ref().unwrap().abort();
    let asker = Script::unshown();
    let h = hub_asking(t.path(), true, true, Some(asker.clone()));
    assert_eq!(h.account_status().connect, None, "nothing before it starts");
    h.start(tokio::runtime::Handle::current());
    until("asking again", || asker.attach_questions() >= 2).await;
    assert_eq!(connect_state(&h), Some(ConnectState::Asking));
    assert_eq!(
        asker.asked()[0],
        Question::Attach {
            email: fake.email(),
            origin: fake.origin(),
            host: fake.host()
        }
    );
    // The app comes to the front (a nudge) and the alert can be shown: yes.
    asker.then(&[true]);
    h.account_nudge();
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    assert_eq!(
        kept(t.path(), &fake.id()),
        Some((fake.origin(), fake.key()))
    );
    assert_eq!(account(&h, &fake.id()).unwrap().state, AccountState::Ok);
    assert!(key_store(t.path()).get(PENDING_NAME).is_none());
    assert_eq!(
        (fake.starts(), fake.asked("/api/gui/connect/poll").len()),
        (1, polls)
    );
    let c = h.account_status().connect.unwrap();
    assert_eq!(
        (c.revoke_url, c.note),
        (None, None),
        "the key is kept: nothing to revoke"
    );
    fake.absent(&files(t.path()), "a file beside the key store");
    fake.absent(&logged().join("\n"), "a log line");
}

/// Another question of the Hub's is open when the approval arrives: that is not a no
/// either. The approval waits, and is asked about once the other is answered.
#[tokio::test]
async fn an_approval_that_meets_an_open_question_waits_for_it() {
    let t = TempDir::new("acct-held-busy");
    let fake = Fake::start("held-busy").await;
    let other = Fake::start("held-busy-other").await;
    let person = Script::saying(true);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    let there = connected(&h, &other).await;
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    // The person is looking at "Disconnect …?" for the other account.
    person.hold_every();
    let (h2, id2) = (h.clone(), there.clone());
    let disconnect = tokio::spawn(async move { h2.account_disconnect(&id2).await });
    until("the open question", || {
        matches!(person.asked().last(), Some(Question::Disconnect { .. }))
    })
    .await;
    fake.set(|w| w.verdict = Verdict::Approved);
    until("the approval, held", || {
        connect_state(&h) == Some(ConnectState::Asking)
    })
    .await;
    tokio::time::sleep(ASK_AGAIN * 3).await;
    assert_eq!(
        connect_state(&h),
        Some(ConnectState::Asking),
        "not declined, not failed"
    );
    assert_eq!(
        person.attach_questions(),
        1,
        "the first connect's, long answered"
    );
    // The other question is answered; the approval's turn comes by itself.
    person.release();
    assert!(disconnect.await.unwrap().is_ok());
    until("approved", || {
        connect_state(&h) == Some(ConnectState::Approved)
    })
    .await;
    assert_eq!(
        kept(t.path(), &fake.id()),
        Some((fake.origin(), fake.key()))
    );
    assert!(account(&h, &there).is_none());
}

/// Never answered: the key is held for a time and no longer. Its end, like a no, says
/// that a key was made on spacesheep, and where the person revokes it.
#[tokio::test]
async fn a_held_approval_nobody_answers_ends_and_says_a_key_was_made() {
    let t = TempDir::new("acct-held-expiry");
    let fake = Fake::start("held-expiry").await;
    let person = Script::unshown();
    person.then(&[true]);
    let h = hub_asking(t.path(), true, true, Some(person.clone()));
    fake.set(|w| w.verdict = Verdict::Approved);
    h.account_connect_start(Some(&fake.origin())).await.unwrap();
    until("the approval, held", || {
        connect_state(&h) == Some(ConnectState::Asking)
    })
    .await;
    assert_eq!(account::HELD_MAX_MS, 15 * 60_000, "a quarter of an hour");
    tokio::time::sleep(Duration::from_millis(HELD_MAX_MS / 3)).await;
    assert_eq!(connect_state(&h), Some(ConnectState::Asking), "still held");
    until("its end", || {
        connect_state(&h) == Some(ConnectState::Expired)
    })
    .await;
    let c = h.account_status().connect.unwrap();
    assert_eq!(
        (c.revoke_url, c.note, c.error),
        (
            Some(format!("{}/settings/api-keys", fake.origin())),
            Some(account::UNUSED_KEY_NOTE),
            None
        )
    );
    assert!(h.account_status().accounts.is_empty());
    assert_eq!(key_store(t.path()), json!({}), "the key is dropped with it");
    // What a restart finds of a held approval is believed only as far as a fresh one,
    // and held no longer than a fresh one would be.
    for (what, record) in [
        (
            "another origin's key",
            json!({ "origin": "http://evil.example", "digits": "4821",
            "expires_at": iso_ms(now_ms()), "held": { "key": fake.key(), "email": fake.email(), "until": iso_ms(now_ms() + 60_000) } }),
        ),
        (
            "no key",
            json!({ "origin": fake.origin(), "digits": "4821",
            "expires_at": iso_ms(now_ms()), "held": { "key": "", "email": fake.email(), "until": iso_ms(now_ms() + 60_000) } }),
        ),
        (
            "an address that is none",
            json!({ "origin": fake.origin(), "digits": "4821",
            "expires_at": iso_ms(now_ms()), "held": { "key": fake.key(), "email": "a@b@c", "until": iso_ms(now_ms() + 60_000) } }),
        ),
    ] {
        let t2 = TempDir::new("acct-held-bad");
        std::fs::write(t2.path().join("receivers.json"), r#"{"receivers":[]}"#).unwrap();
        std::fs::write(
            t2.path().join("account-keys.json"),
            json!({ PENDING_NAME: record.to_string() }).to_string(),
        )
        .unwrap();
        let h2 = hub_in(t2.path());
        h2.start(tokio::runtime::Handle::current());
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(h2.account_status().connect, None, "{what}");
        assert!(h2.account_status().accounts.is_empty(), "{what}");
        assert_eq!(key_store(t2.path()), json!({}), "{what}: dropped");
    }
    let t3 = TempDir::new("acct-held-forever");
    std::fs::write(t3.path().join("receivers.json"), r#"{"receivers":[]}"#).unwrap();
    let forever = json!({ "origin": fake.origin(), "digits": "4821", "expires_at": iso_ms(now_ms()),
        "held": { "key": fake.key(), "email": fake.email(), "until": "2099-01-01T00:00:00.000Z" } });
    std::fs::write(
        t3.path().join("account-keys.json"),
        json!({ PENDING_NAME: forever.to_string() }).to_string(),
    )
    .unwrap();
    let h3 = hub_asking(t3.path(), true, true, Some(Script::unshown()));
    h3.start(tokio::runtime::Handle::current());
    until("asking", || {
        connect_state(&h3) == Some(ConnectState::Asking)
    })
    .await;
    until("its end, in the Hub's own time", || {
        connect_state(&h3) == Some(ConnectState::Expired)
    })
    .await;
    fake.absent(&logged().join("\n"), "a log line");
}

/// What could not be written is not said to have happened: no mark, no event, no log
/// line; and a disconnect whose key could not be deleted says so, and changed nothing.
#[cfg(unix)]
#[tokio::test]
async fn what_was_not_saved_is_not_announced() {
    use std::os::unix::fs::PermissionsExt;
    let t = TempDir::new("acct-unsaved-mark");
    let fake = Fake::start("unsaved-mark").await;
    let h = hub_in(t.path());
    let id = connected(&h, &fake).await;
    h.account_doc_set(&id, "labels", &json!(1)).unwrap();
    let writable = |on: bool| {
        let mode = if on { 0o755 } else { 0o555 };
        std::fs::set_permissions(t.path(), std::fs::Permissions::from_mode(mode)).unwrap();
    };
    writable(false);
    if std::fs::write(t.path().join("probe"), b"x").is_ok() {
        writable(true);
        return;
    }
    // spacesheep refuses the key while the list cannot be written.
    fake.set(|w| w.revoked = true);
    let mut events = h.subscribe();
    let res = ask(&h, "GET", &id, RELAY, b"").await;
    assert_eq!(res.status(), 401, "the page still gets spacesheep's answer");
    assert_eq!(
        account(&h, &id).unwrap().state,
        AccountState::Ok,
        "not marked"
    );
    let mut told = false;
    while let Ok(e) = events.try_recv() {
        told |= e == HubEvent::Account;
    }
    assert!(!told, "no event for a mark that was not made");
    assert!(!logged()
        .iter()
        .any(|l| l.contains(&format!("acct {id}: spacesheep refused the key"))));
    // A disconnect whose key cannot be deleted says exactly that, and changed nothing.
    let e = h.account_disconnect(&id).await.unwrap_err();
    assert_eq!(e.code, "io");
    assert_eq!(
        e.message,
        "The key could not be removed from this device. Nothing was changed."
    );
    writable(true);
    assert!(account(&h, &id).is_some() && kept(t.path(), &id).is_some());
    assert_eq!(h.account_doc_get(&id, "labels").unwrap(), Some(json!(1)));
    // Once it can be written, the next refusal is marked and said.
    assert_eq!(ask(&h, "GET", &id, RELAY, b"").await.status(), 401);
    assert_eq!(account(&h, &id).unwrap().state, AccountState::Unauthorized);
    assert!(logged()
        .iter()
        .any(|l| l.contains(&format!("acct {id}: spacesheep refused the key"))));
}
