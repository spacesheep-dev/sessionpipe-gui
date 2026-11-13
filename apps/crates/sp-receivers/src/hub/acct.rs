//! The Hub's side of a spacesheep account (docs/rfcs/08, "The phone on an account";
//! the rules themselves are `account.rs`): connecting, with the poll run here until the
//! person answers; the key, kept here and nowhere else; the doors, forwarded with the key
//! added; this device's own key, asked to be trusted; and the account's documents.
//!
//! What never happens here: the key in a log line, an error, a URL or a returned value;
//! the connect's link or code handed to the page; a redirect followed; a page's header
//! sent on; a cookie sent or kept; a request to a path that is not a door; an account
//! kept, replaced or emptied of its documents without the person saying so in UI the
//! page cannot draw.

use super::{describe, Backoff, Hub, HubConfig, HubEvent};
use crate::account::{
    self, AccountRef, AccountState, AccountStatus, AccountView, ConnectState, ConnectView,
    DeviceAsked, Disconnected, Door, Opened, PollAnswer, Problem, Question, Refused,
};
use crate::docs::Docs;
use crate::needs::NeedsYou;
use crate::proxy;
use crate::registry::{account_key_name, KeyStore, Receiver};
use crate::status::{iso_ms, iso_now, now_ms};
use futures_util::StreamExt;
use http::header::RETRY_AFTER;
use http::header::{ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use http::HeaderValue;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};

/// Between two polls of a connect the person has not answered yet.
const POLL_EVERY: Duration = if cfg!(test) {
    Duration::from_millis(20)
} else {
    Duration::from_secs(2)
};
/// Before the first one: nobody confirms four digits faster.
const POLL_FIRST: Duration = if cfg!(test) {
    Duration::from_millis(5)
} else {
    Duration::from_millis(800)
};
/// The longest wait between polls, whatever spacesheep or the backoff say.
const POLL_SLOWEST: Duration = if cfg!(test) {
    Duration::from_millis(200)
} else {
    Duration::from_secs(60)
};
/// A second of a request's time limit (`Opened::timeout_s`). Tests run the clock 25 times
/// faster, so a request that never ends is seen to be cut off.
const SECOND: Duration = if cfg!(test) {
    Duration::from_millis(40)
} else {
    Duration::from_secs(1)
};
/// The window `account::START_LIMIT` counts in, in milliseconds.
const START_WINDOW_MS: u64 = if cfg!(test) {
    700
} else {
    account::START_WINDOW_S * 1000
};
/// The window `account::DEVICE_ASK_LIMIT` counts in.
const DEVICE_ASK_WINDOW_MS: u64 = if cfg!(test) {
    700
} else {
    account::DEVICE_ASK_WINDOW_S * 1000
};
/// How long an ask is returned as it was instead of being made again.
const DEVICE_ASK_FRESH_MS: u64 = if cfg!(test) {
    300
} else {
    account::DEVICE_ASK_FRESH_S * 1000
};
/// When the question about a held approval could not be shown, it is asked again when
/// the app comes to the front, and in any case after this long.
const ASK_AGAIN: Duration = if cfg!(test) {
    Duration::from_millis(30)
} else {
    Duration::from_secs(15)
};
/// How long a held approval waits for its answer (`account::HELD_MAX_MS`).
const HELD_MAX_MS: u64 = if cfg!(test) {
    1500
} else {
    account::HELD_MAX_MS
};
/// What the Hub counts across restarts (`Counts`), in its home.
const COUNTS_FILE: &str = "account-limits.json";
/// A connect answer, a poll answer: a few hundred bytes.
const SMALL_ANSWER: usize = 16 * 1024;
/// An answer up to this size that came unpacked is looked through where it is; a larger
/// or a packed one on a thread of its own (inflating and searching megabytes is work the
/// runtime's threads are not for).
const INLINE_ANSWER: usize = 64 * 1024;
const JSON: &str = "application/json";
/// The connect in progress, in the account key store, so the app being closed while the
/// person confirms in the browser does not lose it (`Hub::account_resume`).
const PENDING_NAME: &str = "acct-connect";

fn request_timeout() -> Duration {
    SECOND * account::REQUEST_TIMEOUT_S as u32
}

/// What one account may have in flight (`account::MAX_PAGE_REQUESTS` and its siblings).
struct Limits {
    page: Arc<Semaphore>,
    relay: Arc<Semaphore>,
    own: Arc<Semaphore>,
}

/// When connects were started and this device's key was asked about (epoch
/// milliseconds), so that the limits on both hold across a restart of the app.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Counts {
    #[serde(default)]
    starts: Vec<u64>,
    #[serde(default)]
    device_asks: Vec<u64>,
}

#[derive(Clone, Copy)]
enum Counted {
    Start,
    DeviceAsk,
}

/// What the person said, or that they were not asked.
enum Asked {
    Yes,
    No,
    /// The question was not on the screen (another one is open, or it could not be
    /// shown): not an answer, and why.
    Not(Problem),
}

/// An approval collected from spacesheep, waiting for the person's answer here.
#[derive(Clone)]
struct Held {
    key: String,
    email: String,
    until_ms: u64,
}

pub(super) struct Accounts {
    /// On, and with a key store of its own (`AccountConfig::keys`).
    enabled: bool,
    /// For spacesheep only: no redirect is followed, and outside a debug build or a test
    /// nothing but https is spoken. reqwest keeps no cookies unless asked to; it is not.
    client: reqwest::Client,
    connect: Mutex<Option<Pending>>,
    /// One connect is started at a time; a second start meanwhile is refused.
    start_gate: tokio::sync::Mutex<()>,
    /// Counts `account_connect_cancel`: a start that was asking spacesheep meanwhile
    /// sees it moved and ends `cancelled`, instead of leaving a connect nobody waits for.
    cancels: AtomicU64,
    next_gen: AtomicU64,
    limits: Mutex<HashMap<String, Arc<Limits>>>,
    /// `Counts`, as in `counts_path`.
    counts: Mutex<Counts>,
    counts_path: std::path::PathBuf,
    start_limit: AtomicUsize,
    device_ask_limit: AtomicUsize,
    /// The last ask per account and when (`DEVICE_ASK_FRESH_MS`).
    asked: Mutex<HashMap<String, (u64, DeviceAsked)>>,
    /// A question is on the screen: a second one is refused, never queued behind it.
    asking: AtomicBool,
    docs: Docs,
    docs_lock: Mutex<()>,
    /// Each account's needs-you, as its page last handed it over (`Hub::account_needs`).
    needs: Mutex<HashMap<String, NeedsYou>>,
}

impl Accounts {
    pub(super) fn new(cfg: &HubConfig) -> Accounts {
        let apart = !cfg.account.keys.same_place(&cfg.keys);
        if cfg.account.enabled && !apart {
            log::error!(
                "acct: account keys were given the receivers' key store; the account mode is off"
            );
        }
        let client = reqwest::Client::builder()
            .user_agent(cfg.user_agent.clone())
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!cfg.account.allow_local_http)
            .build()
            .expect("http client");
        Accounts {
            enabled: cfg.account.enabled && apart,
            client,
            connect: Mutex::new(None),
            start_gate: tokio::sync::Mutex::new(()),
            cancels: AtomicU64::new(0),
            next_gen: AtomicU64::new(1),
            limits: Mutex::new(HashMap::new()),
            counts: Mutex::new(
                std::fs::read(cfg.home.join(COUNTS_FILE))
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok())
                    .unwrap_or_default(),
            ),
            counts_path: cfg.home.join(COUNTS_FILE),
            start_limit: AtomicUsize::new(account::START_LIMIT),
            device_ask_limit: AtomicUsize::new(account::DEVICE_ASK_LIMIT),
            asked: Mutex::new(HashMap::new()),
            asking: AtomicBool::new(false),
            docs: Docs::new(&cfg.home),
            docs_lock: Mutex::new(()),
            needs: Mutex::new(HashMap::new()),
        }
    }
}

/// A connect the Hub is polling, or the last one's outcome. No `Debug`: it holds the poll
/// token and the link until it ends.
struct Pending {
    gen: u64,
    origin: String,
    code: String,
    poll_token: String,
    digits: String,
    /// The page to open, for the Hub to open: never the page's to read (it holds the code).
    url: String,
    expires_at_ms: u64,
    state: ConnectState,
    receiver: Option<String>,
    email: Option<String>,
    error: Option<Problem>,
    /// The approval, once collected, until the person answers (`ConnectState::Asking`).
    held: Option<Held>,
    /// spacesheep made a key for this connect and it is not kept here.
    unused_key: bool,
    task: Option<tokio::task::AbortHandle>,
    kick: Arc<Notify>,
}

impl Pending {
    fn view(&self) -> ConnectView {
        ConnectView {
            origin: self.origin.clone(),
            digits: self.digits.clone(),
            expires_at: iso_ms(self.expires_at_ms),
            state: self.state,
            receiver: self.receiver.clone(),
            email: self.email.clone(),
            error: self.error.clone(),
            error_message: self.error.as_ref().map(|p| p.message.clone()),
            revoke_url: self
                .unused_key
                .then(|| format!("{}/settings/api-keys", self.origin)),
            note: self.unused_key.then_some(account::UNUSED_KEY_NOTE),
        }
    }

    /// Under way: waiting for the person on spacesheep with a code that is still good,
    /// or holding their approval until they answer here.
    fn live(&self) -> bool {
        (self.state == ConnectState::Pending && now_ms() < self.expires_at_ms)
            || self.state == ConnectState::Asking
    }

    /// As it is kept while under way, in the account key store: spacesheep's own answer
    /// and the origin it came from, so `account_resume` believes it only as far as it
    /// would a fresh one; or, once the approval was collected, the key and whose it is,
    /// so the question is asked again after the app was closed.
    fn kept(&self) -> String {
        match &self.held {
            Some(h) => serde_json::json!({
                "origin": self.origin, "digits": self.digits,
                "expires_at": iso_ms(self.expires_at_ms),
                "held": { "key": h.key, "email": h.email, "until": iso_ms(h.until_ms) },
            }),
            None => serde_json::json!({
                "origin": self.origin, "code": self.code, "poll_token": self.poll_token,
                "digits": self.digits, "url": self.url, "expires_at": iso_ms(self.expires_at_ms),
            }),
        }
        .to_string()
    }
}

/// What one poll needs, cloned out of the lock.
struct Live {
    origin: String,
    code: String,
    poll_token: String,
    deadline_ms: u64,
    kick: Arc<Notify>,
}

/// spacesheep's answer to a door, as much of it as the page gets.
pub(super) struct Answer {
    status: u16,
    content_type: Option<HeaderValue>,
    retry_after: Option<HeaderValue>,
    body: Vec<u8>,
}

/// The question on the screen; closing it (answered or not) lets the next one be asked.
struct Asking<'a>(&'a AtomicBool);

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `Authorization: Bearer …`, marked sensitive so no debug print of a request shows it.
fn bearer(token: &str) -> Option<HeaderValue> {
    let mut v = HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
    v.set_sensitive(true);
    Some(v)
}

/// `Retry-After` in seconds, when it is seconds (never more than an hour).
fn retry_after_s(h: &http::HeaderMap) -> Option<u64> {
    let v = h.get(RETRY_AFTER)?.to_str().ok()?.trim();
    (!v.is_empty() && v.len() <= 5 && v.bytes().all(|c| c.is_ascii_digit()))
        .then(|| v.parse::<u64>().ok())
        .flatten()
        .map(|s| s.min(3600))
}

enum ReadError {
    TooLarge,
    Broken,
}

/// The whole body as it came over the wire, unless it is over `max` (said up front, or
/// found on the way when no length was given).
async fn read_capped(res: reqwest::Response, max: usize) -> Result<Vec<u8>, ReadError> {
    if res.content_length().is_some_and(|n| n > max as u64) {
        return Err(ReadError::TooLarge);
    }
    let mut body = Vec::new();
    let mut s = res.bytes_stream();
    while let Some(chunk) = s.next().await {
        let c = chunk.map_err(|_| ReadError::Broken)?;
        if body.len() + c.len() > max {
            return Err(ReadError::TooLarge);
        }
        body.extend_from_slice(&c);
    }
    Ok(body)
}

/// How an answer's body is packed: plainly, or gzip (the one packing the Hub asks for).
fn is_gzip(h: &http::HeaderMap) -> Result<bool, Refused> {
    let Some(v) = h.get(CONTENT_ENCODING) else {
        return Ok(false);
    };
    match v
        .to_str()
        .unwrap_or("?")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "identity" => Ok(false),
        "gzip" | "x-gzip" => Ok(true),
        _ => Err(Refused::BadEncoding),
    }
}

/// Unpacks gzip: one member, and nothing after it (a second member, or bytes that are
/// no gzip at all, are not part of an answer the Hub asked for). Stops one byte past
/// `max` however much more there is: a few kilobytes can unpack to gigabytes, and none
/// of that is ever held.
fn unpack(wire: &[u8], max: usize) -> Result<Vec<u8>, Refused> {
    use std::io::Read;
    let mut out = Vec::new();
    let mut d = flate2::bufread::GzDecoder::new(wire).take(max as u64 + 1);
    d.read_to_end(&mut out).map_err(|_| Refused::BadEncoding)?;
    if out.len() <= max && !d.into_inner().into_inner().is_empty() {
        return Err(Refused::BadEncoding);
    }
    Ok(out)
}

/// The body the page gets: unpacked, never more than `max` of it however little came
/// over the wire, and never holding the key.
fn settle(wire: Vec<u8>, gzip: bool, max: usize, key: &str) -> Result<Vec<u8>, Refused> {
    let body = if gzip {
        let out = unpack(&wire, max)?;
        if out.len() > max {
            return Err(Refused::AnswerTooLarge);
        }
        out
    } else {
        wire
    };
    if account::holds(&body, key.as_bytes()) {
        return Err(Refused::Withheld);
    }
    Ok(body)
}

/// An answer the Hub wrote itself: JSON, its code in `account::HUB_HEADER`, never cached.
/// `here`: what this device is called in its words (`AccountConfig::here`).
fn refusal(
    r: Refused,
    here: &str,
    origin: Option<&str>,
    allowed: &[String],
) -> http::Response<Vec<u8>> {
    let mut b = http::Response::builder()
        .status(r.status())
        .header("content-type", JSON)
        .header("cache-control", "no-store")
        .header(account::HUB_HEADER, r.code());
    if r == Refused::Busy {
        b = b.header("retry-after", "1");
    }
    proxy::finish_exposing(
        b.body(r.body(here)).expect("response"),
        origin,
        allowed,
        account::EXPOSE_HEADERS,
    )
}

impl Hub {
    /// An `rx:` request to an id only an account has, with no such account in the list
    /// (it was disconnected a moment ago, say, and its page has not gone yet). That page
    /// tells the Hub's answers from spacesheep's by their header, so this one is the
    /// Hub's own too, in the same shape: never a bare 404 to be taken for spacesheep's.
    pub(super) fn account_gone(&self, origin: Option<&str>) -> http::Response<Vec<u8>> {
        let allowed = &self.0.cfg.allowed_origins;
        let r = if proxy::allow_origin(origin, allowed).is_none() {
            Refused::ForbiddenOrigin
        } else {
            Refused::NotADoor
        };
        refusal(r, self.here(), origin, allowed)
    }

    /// What this device is called in a sentence ("this iPhone").
    fn here(&self) -> &str {
        &self.0.cfg.account.here
    }

    fn account_cfg(&self) -> &account::AccountConfig {
        &self.0.cfg.account
    }

    fn account_on(&self) -> bool {
        self.0.acct.enabled
    }

    fn account_keys(&self) -> &KeyStore {
        &self.account_cfg().keys
    }

    /// The first start in this home: whatever the account key store holds belongs to an
    /// install that is gone (an iPhone keeps keychain items when an app is deleted), so
    /// it is emptied. Called by `Hub::new` before anything reads a key.
    pub(super) fn account_first_start(cfg: &HubConfig) {
        if cfg.account.enabled && !cfg.account.keys.same_place(&cfg.keys) {
            if let Err(e) = cfg.account.keys.clear_all() {
                log::warn!("acct: keys of an earlier install could not be removed: {e}");
            }
        }
    }

    /// The account's key, for a request about to be sent to `origin`: the key store says
    /// which origin a key is for, and gives it for no other. Never returned further.
    fn account_key(&self, id: &str, origin: &str) -> Option<String> {
        let kept = self.account_keys().get(&account_key_name(id))?;
        account::read_kept_key(&kept, origin)
    }

    /// The accounts in the list (never a transient entry: an account is always saved).
    fn account_entries(&self) -> Vec<Receiver> {
        self.0
            .registry
            .lock()
            .unwrap()
            .list()
            .iter()
            .filter(|r| r.is_account())
            .cloned()
            .collect()
    }

    pub(super) fn account_entry(&self, id: &str) -> Option<Receiver> {
        self.account_entries().into_iter().find(|r| r.id == id)
    }

    fn account_state(&self, r: &Receiver) -> AccountState {
        if self.account_key(&r.id, &r.origin).is_none() {
            AccountState::NoKey
        } else if r.account.as_ref().is_some_and(|a| a.unauthorized) {
            AccountState::Unauthorized
        } else {
            AccountState::Ok
        }
    }

    /// What an account adds to its row in the receiver list and the shell contract.
    pub(super) fn account_ref(&self, r: &Receiver) -> Option<AccountRef> {
        let a = r.account.as_ref().filter(|_| r.is_account())?;
        Some(AccountRef {
            kind: "spacesheep",
            email: a.email.clone(),
            state: self.account_state(r),
        })
    }

    /// The entry's origin, when the entry is what it says: its origin is one an account
    /// may live at, and its id is that origin's and its email's.
    fn account_origin(&self, rx: &Receiver) -> Result<String, Refused> {
        let a = rx
            .account
            .as_ref()
            .filter(|_| rx.is_account())
            .ok_or(Refused::BadAccount)?;
        let origin = account::clean_origin(Some(&rx.origin), self.account_cfg().allow_local_http)
            .filter(|o| *o == rx.origin)
            .ok_or(Refused::BadAccount)?;
        if crate::id::account_id(&origin, &a.email) != rx.id {
            return Err(Refused::BadAccount);
        }
        Ok(origin)
    }

    fn account_limits(&self, id: &str) -> Arc<Limits> {
        self.0
            .acct
            .limits
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| {
                Arc::new(Limits {
                    page: Arc::new(Semaphore::new(account::MAX_PAGE_REQUESTS)),
                    relay: Arc::new(Semaphore::new(account::MAX_RELAY_READS)),
                    own: Arc::new(Semaphore::new(account::MAX_OWN_REQUESTS)),
                })
            })
            .clone()
    }

    /// Asks the person, when nothing else is being asked. `Asked::Not` when a question
    /// is already open (this one is not queued behind it), when this build has nobody
    /// to ask, and when the question could not be put on the screen: none of those is
    /// an answer.
    async fn account_ask(&self, question: Question) -> Asked {
        let Some(confirm) = self.account_cfg().confirm.clone() else {
            return Asked::Not(Problem::new(
                "not_asked",
                format!(
                    "{} can't ask that just now. Try again.",
                    account::sentence_start(self.here())
                ),
            ));
        };
        if self.0.acct.asking.swap(true, Ordering::SeqCst) {
            return Asked::Not(Problem::new(
                "busy",
                format!(
                    "Another question is open on {}. Answer it first.",
                    self.here()
                ),
            ));
        }
        let _open = Asking(&self.0.acct.asking);
        match confirm.ask(question).await {
            Some(true) => Asked::Yes,
            Some(false) => Asked::No,
            None => Asked::Not(Problem::new(
                "not_asked",
                "The question could not be shown. Try again.",
            )),
        }
    }

    // ---- status ----

    /// Everything the page may know about accounts here.
    pub fn account_status(&self) -> AccountStatus {
        let active = self.active().map(|a| a.id);
        let accounts = self
            .account_entries()
            .iter()
            .filter_map(|r| {
                let a = r.account.as_ref()?;
                Some(AccountView {
                    id: r.id.clone(),
                    origin: r.origin.clone(),
                    email: a.email.clone(),
                    state: self.account_state(r),
                    connected_at: a.connected_at.clone(),
                    active: active.as_deref() == Some(r.id.as_str()),
                    device_key_id: a.device_key_id.clone(),
                })
            })
            .collect();
        AccountStatus {
            enabled: self.account_on(),
            accounts,
            connect: self
                .0
                .acct
                .connect
                .lock()
                .unwrap()
                .as_ref()
                .map(Pending::view),
        }
    }

    /// spacesheep refused the key (true) or took it (false): kept in the list, so the app
    /// knows at its next start without asking. Said (the log line, the events) only once
    /// it is saved: a mark that could not be written was not made.
    fn account_mark(&self, id: &str, unauthorized: bool) {
        let mut changed = false;
        let saved = self.0.registry.lock().unwrap().update(id, |r| {
            if let Some(a) = r
                .account
                .as_mut()
                .filter(|a| a.unauthorized != unauthorized)
            {
                a.unauthorized = unauthorized;
                changed = true;
            }
        });
        if changed && saved.is_ok() {
            if unauthorized {
                log::warn!("acct {id}: spacesheep refused the key (revoked there?)");
            } else {
                log::info!("acct {id}: spacesheep takes the key again");
            }
            self.emit(HubEvent::Receivers);
            self.emit(HubEvent::Account);
        }
    }

    /// "Connected", for an account: spacesheep answered the last door and took the key.
    fn account_reached(&self, id: &str, ok: bool) {
        let was = self.is_connected(id);
        self.set_connected(id, ok);
        if was && !ok {
            self.emit(HubEvent::Disconnected {
                id: id.into(),
                retry_in_ms: 0,
            });
        }
    }

    fn account_rp(&self, id: &str, rp: String) {
        let mut changed = false;
        let saved = self.0.registry.lock().unwrap().update(id, |r| {
            if let Some(a) = r
                .account
                .as_mut()
                .filter(|a| a.rp_id.as_deref() != Some(rp.as_str()))
            {
                a.rp_id = Some(rp);
                changed = true;
            }
        });
        if changed && saved.is_ok() {
            self.emit(HubEvent::Receivers);
        }
    }

    /// Removes an account whole: its key first, then its documents, then its entry. If
    /// the key can't be deleted nothing else is touched; if the list then can't be
    /// saved, what is left is an entry without a key, never a key without an entry. The
    /// error says which, as it is.
    fn account_remove(&self, id: &str) -> Result<bool, Problem> {
        if let Err(e) = self.account_keys().delete(&account_key_name(id)) {
            log::warn!("acct {id}: the key could not be deleted: {e}");
            return Err(Problem::new(
                "io",
                format!(
                    "The key could not be removed from {}. Nothing was changed.",
                    self.here()
                ),
            ));
        }
        {
            let _g = self.0.acct.docs_lock.lock().unwrap();
            if let Err(e) = self.0.acct.docs.remove_all(id) {
                log::warn!("acct {id}: its documents could not be removed: {e}");
            }
        }
        self.0.acct.limits.lock().unwrap().remove(id);
        self.0.acct.asked.lock().unwrap().remove(id);
        self.0.acct.needs.lock().unwrap().remove(id);
        let removed = self.remove_entry(id).map_err(|e| {
            // The system's own text is for the log, not for a sentence.
            log::warn!("acct {id}: its entry could not be removed: {e}");
            Problem::new(
                "io",
                format!("The key is removed from {}, but its entry could not be. It shows as having no key: connect again or disconnect again.", self.here()),
            )
        })?;
        self.emit(HubEvent::Account);
        Ok(removed)
    }

    // ---- the doors ----

    /// An `rx:` request for an account: forwarded when it is a door, refused here when
    /// it is not. Each refusal comes before the next step, and all of them before any
    /// network.
    pub(super) async fn account_proxy(
        &self,
        rx: Receiver,
        req: http::Request<Vec<u8>>,
        path: &str,
        origin: Option<&str>,
    ) -> http::Response<Vec<u8>> {
        let allowed = &self.0.cfg.allowed_origins;
        let method = req.method().as_str().to_string();
        let refuse = |r: Refused| {
            self.proxy_failed(&rx.id, &method, "(account)", r.code());
            refusal(r, self.here(), origin, allowed)
        };
        // Only the bundled page: a frame or a page from anywhere else could not read the
        // answer, and must not cause the request either.
        if proxy::allow_origin(origin, allowed).is_none() {
            return refuse(Refused::ForbiddenOrigin);
        }
        let opened = match account::open_door(&method, path) {
            Ok(o) => o,
            Err(r) => return refuse(r),
        };
        let body = req.into_body();
        if let Err(r) = account::check_body(opened.door, &body) {
            return refuse(r);
        }
        let a = match self.account_send(&rx, opened, body, false).await {
            Ok(a) => a,
            Err(r) => return refusal(r, self.here(), origin, allowed),
        };
        // spacesheep's status and body as they are; of its headers only the type and a
        // wait. No `Set-Cookie`, no `Location`, nothing the webview would act on.
        let mut out = http::Response::builder()
            .status(a.status)
            .header("cache-control", "no-store")
            .header("x-content-type-options", "nosniff");
        if let Some(v) = a.content_type {
            out = out.header("content-type", v);
        }
        if let Some(v) = a.retry_after {
            out = out.header("retry-after", v);
        }
        proxy::finish_exposing(
            out.body(a.body).expect("response"),
            origin,
            allowed,
            account::EXPOSE_HEADERS,
        )
    }

    /// Sends one door's request with the key and reads what the answer says about the
    /// account. The URL is the entry's own origin and the door's rebuilt path; the only
    /// headers are the Hub's. `own`: the Hub's own request (not the page's), which waits
    /// for its turn instead of being refused.
    async fn account_send(
        &self,
        rx: &Receiver,
        opened: Opened,
        body: Vec<u8>,
        own: bool,
    ) -> Result<Answer, Refused> {
        if !self.account_on() {
            return Err(Refused::AccountOff);
        }
        let origin = self.account_origin(rx)?;
        let key = self
            .account_key(&rx.id, &origin)
            .ok_or(Refused::NotConnected)?;
        let auth = bearer(&key).ok_or(Refused::NotConnected)?;
        let door = opened.door;
        // Where this device's key stands: the Hub says which key, from what it asked.
        let opened = if door == Door::DeviceStatus {
            let key_id = self
                .account_entry(&rx.id)
                .and_then(|r| r.account.and_then(|a| a.device_key_id))
                .ok_or(Refused::NoDeviceKey)?;
            opened.about_key(&key_id).ok_or(Refused::NoDeviceKey)?
        } else {
            opened
        };
        let url = proxy::upstream_url(&origin, &opened.path_and_query)
            .map_err(|_| Refused::BadAccount)?;
        let limits = self.account_limits(&rx.id);
        let _permits = if own {
            let p = limits.own.clone().acquire_owned().await;
            (p.map_err(|_| Refused::Busy)?, None)
        } else {
            let page = limits.page.clone().try_acquire_owned();
            let relay = match door {
                Door::Relay => Some(
                    limits
                        .relay
                        .clone()
                        .try_acquire_owned()
                        .map_err(|_| Refused::Busy)?,
                ),
                _ => None,
            };
            (page.map_err(|_| Refused::Busy)?, relay)
        };
        let method = if door.max_request() > 0 {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        let mut b = self
            .0
            .acct
            .client
            .request(method.clone(), url)
            .header(AUTHORIZATION, auth)
            .header(ACCEPT, JSON)
            .header(ACCEPT_ENCODING, "gzip")
            .timeout(SECOND * opened.timeout_s() as u32);
        if method == reqwest::Method::POST {
            b = b.header(CONTENT_TYPE, JSON).body(body);
        }
        let failed = |why: &str| self.proxy_failed(&rx.id, method.as_str(), door.name(), why);
        let res = match b.send().await {
            Ok(r) => r,
            Err(e) => {
                // A send for which no connection was made (no network, no name, no
                // handshake) never left this device: said apart, so the page can say
                // "not sent" and mean it. Checked before the time limit: a connection
                // that timed out being made sent nothing either. Any other failure of a
                // send, and every failure of the time limit as a whole, leaves it unknown
                // whether spacesheep took the command.
                let r = if door == Door::MachineJobs && e.is_connect() {
                    Refused::NotSent
                } else if e.is_timeout() {
                    Refused::Timeout
                } else {
                    Refused::Unreachable
                };
                failed(&describe(e));
                self.account_reached(&rx.id, false);
                return Err(r);
            }
        };
        let status = res.status().as_u16();
        if (300..400).contains(&status) {
            failed("a redirect, not followed");
            return Err(Refused::Redirected);
        }
        let content_type = res.headers().get(CONTENT_TYPE).cloned();
        let retry_after = res
            .headers()
            .get(RETRY_AFTER)
            .filter(|v| v.len() <= 64)
            .cloned();
        let gzip = is_gzip(res.headers()).inspect_err(|_| failed("an answer packed unasked"))?;
        let max = door.max_response();
        let wire = match read_capped(res, max).await {
            Ok(b) => b,
            Err(ReadError::TooLarge) => {
                failed("an answer over the size limit");
                return Err(Refused::AnswerTooLarge);
            }
            Err(ReadError::Broken) => {
                let timed_out = "the answer stopped or ran out of time";
                failed(timed_out);
                self.account_reached(&rx.id, false);
                return Err(Refused::Unreachable);
            }
        };
        // The key goes up, never down: an answer that holds it is not the page's to read.
        let in_header = |v: &Option<HeaderValue>| {
            v.as_ref()
                .is_some_and(|v| account::holds(v.as_bytes(), key.as_bytes()))
        };
        let settled = if in_header(&content_type) || in_header(&retry_after) {
            Err(Refused::Withheld)
        } else if !gzip && wire.len() <= INLINE_ANSWER {
            settle(wire, false, max, &key)
        } else {
            let key = key.clone();
            tokio::task::spawn_blocking(move || settle(wire, gzip, max, &key))
                .await
                .unwrap_or(Err(Refused::Unreachable))
        };
        let body = settled.inspect_err(|r| match r {
            Refused::Withheld => failed("an answer that held the key, not passed on"),
            Refused::AnswerTooLarge => failed("an answer over the size limit once unpacked"),
            _ => failed("an answer that could not be unpacked"),
        })?;
        let refused = account::key_refused(door, status, &body);
        if refused {
            self.account_mark(&rx.id, true);
        } else if (200..300).contains(&status) {
            self.account_mark(&rx.id, false);
        }
        self.account_reached(&rx.id, status < 500 && !refused);
        if (200..300).contains(&status) {
            if door == Door::Relay {
                self.0.cfg.status.frame(&rx.id);
            }
            if door == Door::RelayMachines {
                if let Some(rp) = account::rp_id_in(&body) {
                    self.account_rp(&rx.id, rp);
                }
            }
        }
        Ok(Answer {
            status,
            content_type,
            retry_after,
            body,
        })
    }

    /// What the signer asks of a receiver (`Hub::get`), answered for an account from its
    /// machines door: the rp id it signs for, and the machines' names for a prompt.
    /// Nothing else a receiver is asked exists for an account, and nothing is posted.
    pub(super) async fn account_asked_as_receiver(
        &self,
        id: &str,
        method: &reqwest::Method,
        path: &str,
    ) -> Result<(u16, Vec<u8>), String> {
        const NO: &str = "not available for a spacesheep account";
        let rx = self.account_entry(id).ok_or(NO)?;
        if method != reqwest::Method::GET
            || !matches!(path, "/api/ui/info" | "/api/ui/control/machines")
        {
            return Err(NO.into());
        }
        let a = self
            .account_send(&rx, Opened::machines(), Vec::new(), true)
            .await
            .map_err(|r| r.words(self.here()))?;
        if a.status != 200 {
            return Ok((a.status, Vec::new()));
        }
        let v: serde_json::Value =
            serde_json::from_slice(&a.body).map_err(|_| "spacesheep sent something unreadable")?;
        let out = if path == "/api/ui/info" {
            serde_json::json!({
                "name": "sessionpipe-gui",
                "control": { "rpId": account::rp_id_in(&a.body) },
            })
        } else {
            let machines: Vec<serde_json::Value> = v["machines"]
                .as_array()
                .map(|ms| {
                    ms.iter()
                        .filter_map(|m| {
                            Some(serde_json::json!({
                                "machineId": m.get("id")?.as_str()?,
                                "name": m.get("name")?.as_str()?,
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            serde_json::json!({ "machines": machines })
        };
        Ok((200, out.to_string().into_bytes()))
    }

    /// Asks spacesheep to trust this device's own key (its `POST /api/gui/device`), for
    /// the person to approve on its Devices page. `key` is the device key as the signer
    /// gave it to the shell, natively: nothing in the request is the page's. The name is
    /// the Hub's own for this device. The key's id is kept, and the status door answers
    /// about that key only.
    pub async fn account_device_ask(
        &self,
        id: &str,
        key: &serde_json::Value,
    ) -> Result<DeviceAsked, Problem> {
        let rx = self
            .account_entry(id)
            .filter(|_| self.account_on())
            .ok_or_else(|| Problem::new("unknown_account", "No such account."))?;
        if let Some(why) = account::device_key_problem(key) {
            log::warn!("acct {id}: the signer's key is not one to ask about: {why}");
            return Err(Problem::new(
                "bad_key",
                format!(
                    "{}'s key can't be used with a spacesheep account.",
                    account::sentence_start(self.here())
                ),
            ));
        }
        let key_id = key["id"].as_str().unwrap_or_default().to_string();
        // Asked a moment ago for this same key: the answer it got then, and no request.
        // (Each request made anew changes the number the person is matching, and they
        // are counted for the whole account on spacesheep.)
        let now = now_ms();
        if let Some((at, asked)) = self.0.acct.asked.lock().unwrap().get(id) {
            if asked.key_id == key_id && now.saturating_sub(*at) < DEVICE_ASK_FRESH_MS {
                return Ok(asked.clone());
            }
        }
        self.account_count(Counted::DeviceAsk)?;
        let body = serde_json::json!({ "key": key, "name": self.account_cfg().device })
            .to_string()
            .into_bytes();
        let opened = Opened::device_ask();
        account::check_body(opened.door, &body)
            .map_err(|r| Problem::new(r.code(), r.words(self.here())))?;
        let a = self
            .account_send(&rx, opened, body, true)
            .await
            .map_err(|r| Problem::new(r.code(), r.words(self.here())))?;
        let v: serde_json::Value = serde_json::from_slice(&a.body).unwrap_or_default();
        let said = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
        if !(200..300).contains(&a.status) {
            let upstream: String = said("code")
                .chars()
                .filter(|c| c.is_ascii_lowercase() || *c == '_')
                .take(40)
                .collect();
            let words = account::plain_words(said("error"), 300);
            return Err(Problem {
                code: match a.status {
                    401 => "unauthorized",
                    429 => "rate_limited",
                    _ => "refused",
                },
                message: if words.is_empty() {
                    format!("spacesheep answered {}.", a.status)
                } else {
                    words
                },
                retry_after_s: None,
                upstream: (!upstream.is_empty()).then_some(upstream),
            });
        }
        // The number to match: digits, as a string or a number.
        let code = match &v["code"] {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        if said("key_id") != key_id
            || !(1..=8).contains(&code.len())
            || !code.bytes().all(|c| c.is_ascii_digit())
        {
            return Err(Problem::new(
                "bad_answer",
                "spacesheep's answer can't be used by this version.",
            ));
        }
        let saved = self.0.registry.lock().unwrap().update(id, |r| {
            if let Some(a) = r.account.as_mut() {
                a.device_key_id = Some(key_id.clone());
            }
        });
        if saved.is_ok() {
            self.emit(HubEvent::Account);
        }
        let asked = DeviceAsked {
            code,
            key_id,
            trusted_on: v["trusted_on"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.as_str())
                        .filter(|m| account::is_machine_id(m))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            devices_url: account::link_on_origin(said("devices_url"), &rx.origin),
        };
        self.0
            .acct
            .asked
            .lock()
            .unwrap()
            .insert(id.to_string(), (now, asked.clone()));
        Ok(asked)
    }

    // ---- connecting ----

    /// May another connect start, or this device's key be asked about again, now? Counted
    /// here before anything is asked or sent, by the wall clock, and written down so a
    /// restart of the app does not start the count again.
    fn account_count(&self, what: Counted) -> Result<(), Problem> {
        let acct = &self.0.acct;
        let mut counts = acct.counts.lock().unwrap();
        let now = now_ms();
        let (times, limit, window, code, message) = match what {
            Counted::Start => (
                &mut counts.starts,
                acct.start_limit.load(Ordering::Relaxed),
                START_WINDOW_MS,
                "too_many_starts",
                "Too many tries. Wait a while, then connect again.",
            ),
            Counted::DeviceAsk => (
                &mut counts.device_asks,
                acct.device_ask_limit.load(Ordering::Relaxed),
                DEVICE_ASK_WINDOW_MS,
                "too_many_asks",
                "Too many tries. Wait a while, then ask again.",
            ),
        };
        // A clock set back does not lock anyone out: times from the future are dropped.
        times.retain(|t| *t <= now && now - *t < window);
        if times.len() >= limit {
            let wait_ms = window - (now - times[0]);
            return Err(Problem {
                code,
                message: message.into(),
                retry_after_s: Some(wait_ms.div_ceil(1000).max(1)),
                upstream: None,
            });
        }
        times.push(now);
        let bytes = serde_json::to_vec(&*counts).expect("json");
        if let Err(e) = crate::registry::write_atomic(&acct.counts_path, &bytes) {
            log::warn!("acct: the limits could not be written: {e}");
        }
        Ok(())
    }

    /// Asks spacesheep for a connect code and starts polling for the person's answer.
    /// The page gets the digits to show and when they expire; the link is the Hub's to
    /// open (`account_connect_link`). A connect still live for the same origin is
    /// returned as it is. For any origin but spacesheep.dev the person is asked first.
    pub async fn account_connect_start(
        &self,
        origin: Option<&str>,
    ) -> Result<ConnectView, Problem> {
        let cfg = self.account_cfg();
        if !self.account_on() {
            return Err(Problem::new(
                "unsupported",
                "A spacesheep account is not available in this build.",
            ));
        }
        let origin = account::clean_origin(origin, cfg.allow_local_http)
            .ok_or_else(|| Problem::new("bad_origin", "The origin must be an https address."))?;
        // One start at a time, and no line behind it: a start may be waiting for the
        // person's answer, and what a page asks meanwhile is refused, not saved up.
        let Ok(_gate) = self.0.acct.start_gate.try_lock() else {
            return Err(Problem::new("busy", "A connect is already being started."));
        };
        // Cancelled while this start is on its way (the person left the screen that
        // waits for the number): it ends here, and no connect is left polling.
        let cancels = self.0.acct.cancels.load(Ordering::SeqCst);
        let cancelled = || {
            (self.0.acct.cancels.load(Ordering::SeqCst) != cancels)
                .then(|| Problem::new("cancelled", "Cancelled."))
        };
        if self
            .account_entries()
            .iter()
            .any(|r| r.origin == origin && self.account_state(r) == AccountState::Ok)
        {
            return Err(Problem::new(
                "already_connected",
                "Already connected. Disconnect first.",
            ));
        }
        // The one test of "a connect is under way there": this, and nothing else, decides
        // both that no new connect starts and that the person is not asked again.
        {
            let g = self.0.acct.connect.lock().unwrap();
            if let Some(p) = g.as_ref().filter(|p| p.live() && p.origin == origin) {
                p.kick.notify_one();
                return Ok(p.view());
            }
            // An approval is held for another origin: a new connect would throw its key
            // away unanswered.
            if g.as_ref().is_some_and(|p| p.state == ConnectState::Asking) {
                return Err(Problem::new(
                    "busy",
                    format!(
                        "An account was approved and waits for your answer on {}.",
                        self.here()
                    ),
                ));
            }
        }
        self.account_count(Counted::Start)?;
        let host = account::host_of(&origin);
        // spacesheep.dev confirms a connect on its own page. Another origin's confirm page
        // is that server's, which could say yes to itself: the person says so here first.
        if origin != account::DEFAULT_ORIGIN {
            let q = Question::Origin {
                origin: origin.clone(),
                host: host.clone(),
            };
            match self.account_ask(q).await {
                Asked::Yes => {}
                Asked::No => return Err(Problem::new("cancelled", "Cancelled.")),
                Asked::Not(why) => return Err(why),
            }
        }
        if let Some(p) = cancelled() {
            return Err(p);
        }
        let res = self
            .0
            .acct
            .client
            .post(format!("{origin}/api/gui/connect"))
            .header(ACCEPT, JSON)
            .json(&serde_json::json!({ "device": cfg.device, "version": cfg.version }))
            .timeout(request_timeout())
            .send()
            .await
            .map_err(|e| {
                Problem::new(
                    "unreachable",
                    format!("Couldn't reach {host}: {}", describe(e)),
                )
            })?;
        let status = res.status().as_u16();
        if status == 429 {
            return Err(Problem {
                code: "rate_limited",
                message: "spacesheep asked to wait a bit. Try again in a minute.".into(),
                retry_after_s: retry_after_s(res.headers()),
                upstream: None,
            });
        }
        if status != 201 {
            return Err(Problem::new(
                "refused",
                format!("{host} answered {status}. Is it a spacesheep this version knows?"),
            ));
        }
        let unusable = |why: &str| {
            Problem::new(
                "bad_answer",
                format!("{host}'s answer can't be used: {why}."),
            )
        };
        let body = read_capped(res, SMALL_ANSWER)
            .await
            .map_err(|_| unusable("it is too long or was cut off"))?;
        let a = account::parse_connect_answer(&body, &origin, now_ms()).map_err(unusable)?;
        // The code spacesheep just made is dropped unused: nobody was shown its number
        // or its link, and it runs out by itself.
        if let Some(p) = cancelled() {
            return Err(p);
        }
        let gen = self.0.acct.next_gen.fetch_add(1, Ordering::Relaxed);
        let pending = Pending {
            gen,
            origin,
            code: a.code,
            poll_token: a.poll_token,
            digits: a.digits,
            url: a.url,
            expires_at_ms: a.expires_at_ms,
            state: ConnectState::Pending,
            receiver: None,
            email: None,
            error: None,
            held: None,
            unused_key: false,
            task: None,
            kick: Arc::new(Notify::new()),
        };
        let view = pending.view();
        if let Err(e) = self.account_keys().set(PENDING_NAME, &pending.kept()) {
            // Not fatal: the connect works while the app stays open.
            log::warn!("acct: the pending connect could not be kept: {e}");
        }
        self.connect_install(pending)?;
        // A cancel that came between the look above and the connect being there.
        if let Some(p) = cancelled() {
            self.account_connect_cancel();
            return Err(p);
        }
        log::info!("acct: connect started at {host}");
        Ok(view)
    }

    /// The page to open in the system browser for the connect that is pending: for the
    /// shell to open, never to hand to the page. None once the connect ended.
    pub fn account_connect_link(&self) -> Option<String> {
        let g = self.0.acct.connect.lock().unwrap();
        g.as_ref()
            .filter(|p| p.state == ConnectState::Pending)
            .map(|p| p.url.clone())
    }

    /// Makes `pending` the connect and starts its poll; an older one ends.
    fn connect_install(&self, pending: Pending) -> Result<(), Problem> {
        let gen = pending.gen;
        let pending_is_held = pending.held.is_some();
        if let Some(old) = self.0.acct.connect.lock().unwrap().replace(pending) {
            if let Some(t) = old.task {
                t.abort();
            }
        }
        let hub = self.clone();
        let held = pending_is_held;
        let run = async move {
            if held {
                hub.connect_hold(gen).await
            } else {
                hub.connect_poll(gen).await
            }
        };
        let Some(task) = self.spawn(run) else {
            *self.0.acct.connect.lock().unwrap() = None;
            let _ = self.account_keys().delete(PENDING_NAME);
            return Err(Problem::new("failed", "The app is not ready yet."));
        };
        if let Some(p) = self
            .0
            .acct
            .connect
            .lock()
            .unwrap()
            .as_mut()
            .filter(|p| p.gen == gen)
        {
            p.task = Some(task.abort_handle());
        }
        self.emit(HubEvent::Account);
        Ok(())
    }

    /// A connect that was under way when the app was last closed goes on, if it still
    /// can: the poll for the person's answer on spacesheep, or, when their approval was
    /// already collected, the question here (the key was kept for exactly this).
    pub(super) fn account_resume(&self) {
        let cfg = self.account_cfg();
        if !self.account_on() || self.0.acct.connect.lock().unwrap().is_some() {
            return;
        }
        let Some(kept) = self.account_keys().get(PENDING_NAME) else {
            return;
        };
        let v: serde_json::Value = serde_json::from_str(&kept).unwrap_or_default();
        let text = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or("").to_string();
        let origin = text(&v, "origin");
        let now = now_ms();
        let same = !origin.is_empty()
            && account::clean_origin(Some(&origin), cfg.allow_local_http).as_deref()
                == Some(origin.as_str());
        let mut pending = Pending {
            gen: self.0.acct.next_gen.fetch_add(1, Ordering::Relaxed),
            origin: origin.clone(),
            code: String::new(),
            poll_token: String::new(),
            digits: text(&v, "digits"),
            url: String::new(),
            expires_at_ms: crate::status::parse_iso_ms(&text(&v, "expires_at")).unwrap_or(0),
            state: ConnectState::Pending,
            receiver: None,
            email: None,
            error: None,
            held: None,
            unused_key: false,
            task: None,
            kick: Arc::new(Notify::new()),
        };
        // Believed only as far as a fresh answer would be: its own origin, its own shapes.
        let whole = if v["held"].is_object() {
            let h = &v["held"];
            let held = Held {
                key: text(h, "key"),
                email: text(h, "email"),
                // Never longer than a fresh one would be held.
                until_ms: crate::status::parse_iso_ms(&text(h, "until"))
                    .unwrap_or(0)
                    .min(now + HELD_MAX_MS),
            };
            let ok = same
                && account::is_token(&held.key)
                && account::clean_email(&held.email).is_some()
                && pending.digits.bytes().all(|c| c.is_ascii_digit());
            pending.state = ConnectState::Asking;
            pending.held = Some(held);
            ok
        } else {
            let in_time = pending
                .expires_at_ms
                .saturating_add(account::CONNECT_COLLECT_MS)
                > now;
            match (in_time && same)
                .then(|| account::parse_connect_answer(kept.as_bytes(), &origin, now).ok())
                .flatten()
            {
                Some(a) => {
                    pending.code = a.code;
                    pending.poll_token = a.poll_token;
                    pending.digits = a.digits;
                    pending.url = a.url;
                    pending.expires_at_ms = a.expires_at_ms;
                    true
                }
                None => false,
            }
        };
        if !whole {
            let _ = self.account_keys().delete(PENDING_NAME);
            return;
        }
        if self.connect_install(pending).is_ok() {
            log::info!("acct: a connect that was under way goes on");
        }
    }

    /// The connect `gen`, while it is the one and still pending.
    fn connect_live(&self, gen: u64) -> Option<Live> {
        let g = self.0.acct.connect.lock().unwrap();
        let p = g
            .as_ref()
            .filter(|p| p.gen == gen && p.state == ConnectState::Pending)?;
        Some(Live {
            origin: p.origin.clone(),
            code: p.code.clone(),
            poll_token: p.poll_token.clone(),
            deadline_ms: p.expires_at_ms + account::CONNECT_COLLECT_MS,
            kick: p.kick.clone(),
        })
    }

    /// The poll: until approved, denied or expired, never past the code's own end. A
    /// failure to reach spacesheep backs off and tries again; so does coming back from
    /// the background, where the wait simply ends late.
    async fn connect_poll(self, gen: u64) {
        let mut backoff = Backoff::new();
        let mut delay = POLL_FIRST;
        loop {
            let Some(live) = self.connect_live(gen) else {
                return;
            };
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = live.kick.notified() => {}
            }
            if self.connect_live(gen).is_none() {
                return;
            }
            // By the wall clock: a phone asleep does not stop the code from expiring.
            if now_ms() > live.deadline_ms {
                self.connect_finish(gen, ConnectState::Expired, None, None, None, false);
                return;
            }
            let Some(auth) = bearer(&live.poll_token) else {
                return;
            };
            // The code is base64url (checked when the answer was read): nothing to encode.
            let url = format!("{}/api/gui/connect/poll?code={}", live.origin, live.code);
            let sent = self
                .0
                .acct
                .client
                .get(url)
                .header(AUTHORIZATION, auth)
                .header(ACCEPT, JSON)
                .timeout(request_timeout())
                .send()
                .await;
            let answer = match sent {
                Err(_) => PollAnswer::Retry { after_s: None },
                Ok(res) => {
                    let status = res.status().as_u16();
                    let after = retry_after_s(res.headers());
                    match read_capped(res, SMALL_ANSWER).await {
                        Ok(body) => account::parse_poll(status, &body, after),
                        Err(ReadError::Broken) => PollAnswer::Retry { after_s: None },
                        Err(ReadError::TooLarge) => PollAnswer::Unreadable,
                    }
                }
            };
            match answer {
                PollAnswer::Pending => {
                    backoff.reset();
                    delay = POLL_EVERY;
                }
                PollAnswer::Retry { after_s } => {
                    let ms = after_s.map_or_else(|| backoff.next_delay(), |s| s * 1000);
                    delay = Duration::from_millis(ms).clamp(POLL_EVERY, POLL_SLOWEST);
                }
                PollAnswer::Approved { key, email } => {
                    self.connect_collected(gen, &live.origin, key, email).await;
                    return;
                }
                PollAnswer::Denied => {
                    self.connect_finish(gen, ConnectState::Denied, None, None, None, false);
                    return;
                }
                PollAnswer::Expired => {
                    self.connect_finish(gen, ConnectState::Expired, None, None, None, false);
                    return;
                }
                PollAnswer::Unreadable => {
                    let p = Problem::new(
                        "bad_answer",
                        "spacesheep's answer can't be used by this version.",
                    );
                    self.connect_finish(gen, ConnectState::Failed, None, None, Some(p), false);
                    return;
                }
            }
        }
    }

    /// spacesheep says someone approved the code, and handed the key over: once, and its
    /// record of it is gone. So from here the key is held (in the account key store, with
    /// the connect, never anywhere the page reads) until the person has answered whose
    /// account this is, however long the app is away meanwhile. Checked first, before
    /// anything is held: the connect must still be the one, and the account's id must
    /// be free or this same account's.
    async fn connect_collected(&self, gen: u64, origin: &str, key: String, email: String) {
        if self.connect_live(gen).is_none() {
            return;
        }
        const UNUSABLE: &str = "spacesheep's answer can't be used by this version.";
        let Some(rx) = Receiver::account(origin, &email, &iso_now()) else {
            let p = Problem::new("bad_answer", UNUSABLE);
            return self.connect_finish(gen, ConnectState::Failed, None, None, Some(p), true);
        };
        // An id is a whole digest, so this never happens by chance; if it happens at
        // all, the account that was here first stays as it is.
        let taken = self.find(&rx.id);
        let kept_unread = self.0.registry.lock().unwrap().kept_under(&rx.id);
        if kept_unread
            || taken
                .as_ref()
                .is_some_and(|r| !r.is_account() || r.origin != origin)
        {
            log::warn!("acct: an approved account's id is another entry's; not kept");
            let p = Problem::new(
                "conflict",
                "That account can't be kept beside the ones already here.",
            );
            return self.connect_finish(gen, ConnectState::Failed, None, None, Some(p), true);
        }
        {
            let mut g = self.0.acct.connect.lock().unwrap();
            let Some(p) = g.as_mut().filter(|p| p.gen == gen) else {
                return;
            };
            p.state = ConnectState::Asking;
            p.held = Some(Held {
                key,
                email,
                until_ms: now_ms() + HELD_MAX_MS,
            });
            // The code did its work; the link and the poll token have no further use.
            p.code.clear();
            p.poll_token.clear();
            p.url.clear();
            if let Err(e) = self.account_keys().set(PENDING_NAME, &p.kept()) {
                // Held in memory then: the question still comes, while the app stays open.
                log::warn!("acct: the approval could not be kept for a restart: {e}");
            }
        }
        self.emit(HubEvent::Account);
        self.connect_hold(gen).await
    }

    /// The approval `gen` holds, while it is the one and still unanswered.
    fn connect_held(&self, gen: u64) -> Option<(String, Held, Arc<Notify>)> {
        let g = self.0.acct.connect.lock().unwrap();
        let p = g
            .as_ref()
            .filter(|p| p.gen == gen && p.state == ConnectState::Asking)?;
        Some((p.origin.clone(), p.held.clone()?, p.kick.clone()))
    }

    /// Asks whose account this phone is about to show, until there is an answer. A
    /// question that could not be shown (another alert is up, another question of the
    /// Hub's is open, there is no window) is not an answer: it is asked again when the
    /// app comes to the front and now and then, and after a restart. Only a real no
    /// discards the key, or the end of the time it is held for; either way the person
    /// is told a key was made that is theirs to revoke.
    async fn connect_hold(&self, gen: u64) {
        loop {
            let Some((origin, held, kick)) = self.connect_held(gen) else {
                return;
            };
            if now_ms() > held.until_ms {
                log::info!("acct: an approved account was never answered for; its key is dropped");
                return self.connect_finish(gen, ConnectState::Expired, None, None, None, true);
            }
            let question = Question::Attach {
                email: held.email.clone(),
                origin: origin.clone(),
                host: account::host_of(&origin),
            };
            match self.account_ask(question).await {
                Asked::Yes => return self.connect_keep(gen, &origin, &held).await,
                Asked::No => {
                    log::info!("acct: the person declined the approved account");
                    return self.connect_finish(
                        gen,
                        ConnectState::Declined,
                        None,
                        None,
                        None,
                        true,
                    );
                }
                Asked::Not(_) => {
                    tokio::select! {
                        _ = kick.notified() => {}
                        _ = tokio::time::sleep(ASK_AGAIN) => {}
                    }
                }
            }
        }
    }

    /// The person said yes. In order: the connect must still be the one; then the key,
    /// then the entry; and only then does an older account at the same origin go.
    async fn connect_keep(&self, gen: u64, origin: &str, held: &Held) {
        let fail = |code: &'static str, message: &str| {
            let p = Problem::new(code, message);
            self.connect_finish(gen, ConnectState::Failed, None, None, Some(p), true);
        };
        const REVOKE: &str =
            "Connect again, and revoke the unused key on spacesheep (Settings → API keys).";
        // Cancelled, or replaced by another connect, while the question was open.
        if self.connect_held(gen).is_none() {
            return;
        }
        let Some(mut rx) = Receiver::account(origin, &held.email, &iso_now()) else {
            return fail(
                "bad_answer",
                "spacesheep's answer can't be used by this version.",
            );
        };
        let taken = self.find(&rx.id);
        if self.0.registry.lock().unwrap().kept_under(&rx.id)
            || taken
                .as_ref()
                .is_some_and(|r| !r.is_account() || r.origin != origin)
        {
            return fail(
                "conflict",
                "That account can't be kept beside the ones already here.",
            );
        }
        // The same person connecting again keeps what the Hub had learnt about them.
        if let (Some(old), Some(new)) = (taken.and_then(|r| r.account), rx.account.as_mut()) {
            new.rp_id = old.rp_id;
            new.device_key_id = old.device_key_id;
            new.extra = old.extra;
        }
        let name = account_key_name(&rx.id);
        let before = self.account_keys().get(&name);
        if let Err(e) = self
            .account_keys()
            .set(&name, &account::kept_key(origin, &held.key))
        {
            log::warn!("acct: the key could not be kept: {e}");
            return fail(
                "keystore",
                &format!("The key could not be kept on {}. {REVOKE}", self.here()),
            );
        }
        let saved = self.0.registry.lock().unwrap().upsert(rx.clone());
        if let Err(e) = saved {
            log::warn!("acct: the account could not be saved: {e}");
            // Back to what the key store held: the same account's older key, or nothing.
            let _ = match before {
                Some(old) => self.account_keys().set(&name, &old),
                None => self.account_keys().delete(&name),
            };
            return fail(
                "io",
                &format!(
                    "The account could not be saved on {}. {REVOKE}",
                    self.here()
                ),
            );
        }
        // Saved and confirmed. One account per origin: another person's at this origin
        // goes now, with its key and its documents, and its place as the one shown.
        let active = self.0.registry.lock().unwrap().active().map(str::to_string);
        for old in self
            .account_entries()
            .into_iter()
            .filter(|r| r.origin == origin && r.id != rx.id)
        {
            let was_active = active.as_deref() == Some(old.id.as_str());
            let _ = self.account_remove(&old.id);
            if was_active {
                let _ = self.0.registry.lock().unwrap().set_active(Some(&rx.id));
            }
        }
        log::info!("acct {}: connected at {}", rx.id, account::host_of(origin));
        self.connect_finish(
            gen,
            ConnectState::Approved,
            Some(rx.id.clone()),
            Some(held.email.clone()),
            None,
            false,
        );
        self.emit(HubEvent::Receivers);
        // The rp id the signer needs, learnt now rather than at the first send. A failure
        // here is nothing: the page's own read of the machines door teaches it too.
        let _ = self
            .account_send(&rx, Opened::machines(), Vec::new(), true)
            .await;
    }

    /// Ends the connect `gen` (when it is still the one): the code, the link, the poll
    /// token and a held key are dropped, the outcome stays for the page to read.
    /// `unused_key`: spacesheep made a key for it that is not kept here, and the outcome
    /// says so, with where to revoke it.
    fn connect_finish(
        &self,
        gen: u64,
        state: ConnectState,
        receiver: Option<String>,
        email: Option<String>,
        error: Option<Problem>,
        unused_key: bool,
    ) {
        {
            let mut g = self.0.acct.connect.lock().unwrap();
            let Some(p) = g.as_mut().filter(|p| p.gen == gen) else {
                return;
            };
            p.state = state;
            p.code.clear();
            p.poll_token.clear();
            p.url.clear();
            p.held = None;
            p.unused_key = unused_key;
            p.receiver = receiver;
            p.email = email;
            p.error = error;
            p.task = None;
        }
        let _ = self.account_keys().delete(PENDING_NAME);
        if state != ConnectState::Approved {
            log::info!("acct: connect ended: {state:?}");
        }
        self.emit(HubEvent::Account);
    }

    /// Stops a connect that is under way (true), or clears a finished one's outcome
    /// (false). The code stays good on spacesheep until it expires: a person who confirms
    /// it after this makes a key nobody collects, which is theirs to revoke there. A
    /// connect whose approval was already collected ends as `declined`, and its outcome
    /// stays to say that a key was made.
    pub fn account_connect_cancel(&self) -> bool {
        self.0.acct.cancels.fetch_add(1, Ordering::SeqCst);
        let mut g = self.0.acct.connect.lock().unwrap();
        let _ = self.account_keys().delete(PENDING_NAME);
        let was = g.as_ref().map(|p| p.state);
        if let Some(t) = g.as_mut().and_then(|p| p.task.take()) {
            t.abort();
        }
        match (was, g.as_mut()) {
            (Some(ConnectState::Asking), Some(p)) => {
                p.state = ConnectState::Declined;
                p.held = None;
                p.unused_key = true;
            }
            _ => *g = None,
        }
        drop(g);
        if was.is_some() {
            self.emit(HubEvent::Account);
        }
        matches!(was, Some(ConnectState::Pending | ConnectState::Asking))
    }

    /// Polls a pending connect now (the app came back to the front).
    pub fn account_nudge(&self) {
        if let Some(p) = self.0.acct.connect.lock().unwrap().as_ref() {
            p.kick.notify_one();
        }
    }

    /// Forgets the account here: its key, its documents, its entry. The person is always
    /// asked first (and told when labels and read marks go with it): a page cannot empty
    /// an account by itself, in one step or in several. The key itself keeps working
    /// until it is revoked on spacesheep, and the answer says so.
    pub async fn account_disconnect(&self, id: &str) -> Result<Disconnected, Problem> {
        let rx = self
            .account_entry(id)
            .ok_or_else(|| Problem::new("unknown_account", "No such account."))?;
        let email = rx
            .account
            .as_ref()
            .map(|a| a.email.clone())
            .unwrap_or_default();
        let documents = {
            let _g = self.0.acct.docs_lock.lock().unwrap();
            !self.0.acct.docs.names(id).is_empty()
        };
        let q = Question::Disconnect {
            email: email.clone(),
            origin: rx.origin.clone(),
            host: account::host_of(&rx.origin),
            documents,
        };
        match self.account_ask(q).await {
            Asked::Yes => {}
            Asked::No => return Err(Problem::new("cancelled", "Cancelled.")),
            Asked::Not(why) => return Err(why),
        }
        self.account_remove(id)?;
        {
            // A finished connect that named it is no longer news.
            let mut g = self.0.acct.connect.lock().unwrap();
            if g.as_ref()
                .is_some_and(|p| !p.live() && p.receiver.as_deref() == Some(id))
            {
                *g = None;
            }
        }
        log::info!("acct {id}: disconnected");
        Ok(Disconnected {
            id: id.to_string(),
            revoke_url: format!("{}/settings/api-keys", rx.origin),
            origin: rx.origin,
            email,
            forgotten: true,
            revoked: false,
            note: format!("The key is forgotten on {}. It keeps working until you revoke it on spacesheep: Settings → API keys.", self.here()),
        })
    }

    // ---- needs-you ----

    /// The account's sessions that need the person, handed over whole by its page. A
    /// receiver's are read by the Hub from its stream; an account has no stream (its
    /// page reads the relay and carries the board), so the page says the list: once
    /// after its first board, then whenever it changed, empty when the last one clears.
    /// It is applied as a stream's `snapshot` is, and said as a receiver's is said (the
    /// same `NeedsYou` and `AttentionClosed` events, the same count in the status file),
    /// so whatever posts a notification for a receiver's session does so for these.
    /// The first list only seeds: nothing in it counts as having just opened.
    ///
    /// The page is not trusted with more than that: the account must be one in the list,
    /// the list is at most `needs::LIST_MAX_SESSIONS` long, and every text in it is cut
    /// to size. The answer is how many sessions need the person now.
    pub fn account_needs(&self, id: &str, sessions: serde_json::Value) -> Result<usize, Problem> {
        if !self.account_on() || self.account_entry(id).is_none() {
            return Err(Problem::new("unknown_account", "No such account."));
        }
        let (change, items) = {
            let mut all = self.0.acct.needs.lock().unwrap();
            let needs = all
                .entry(id.to_string())
                .or_insert_with(|| NeedsYou::new(id));
            let change = needs
                .apply_sessions(sessions)
                .ok_or_else(|| Problem::new("bad_request", "That is not a list of sessions."))?;
            (change, needs.items())
        };
        for a in change.closed {
            self.emit(HubEvent::AttentionClosed {
                id: id.to_string(),
                attention_id: a,
            });
        }
        let n = items.len();
        if change.items_changed {
            self.0.cfg.status.set_needs_you(id, n);
            self.0
                .needs
                .lock()
                .unwrap()
                .insert(id.to_string(), items.clone());
            self.emit(HubEvent::NeedsYou {
                id: id.to_string(),
                items,
            });
        }
        Ok(n)
    }

    // ---- the account's documents ----

    fn account_for_docs(&self, id: &str) -> Result<(), Problem> {
        if self.account_on() && self.account_entry(id).is_some() {
            Ok(())
        } else {
            Err(Problem::new("unknown_account", "No such account."))
        }
    }

    /// One of the account's documents (`docs.rs`), or None.
    pub fn account_doc_get(
        &self,
        id: &str,
        name: &str,
    ) -> Result<Option<serde_json::Value>, Problem> {
        self.account_for_docs(id)?;
        let _g = self.0.acct.docs_lock.lock().unwrap();
        self.0.acct.docs.get(id, name)
    }

    /// Writes one whole; its size in bytes.
    pub fn account_doc_set(
        &self,
        id: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> Result<usize, Problem> {
        self.account_for_docs(id)?;
        let _g = self.0.acct.docs_lock.lock().unwrap();
        self.0.acct.docs.set(id, name, value)
    }

    pub fn account_doc_delete(&self, id: &str, name: &str) -> Result<bool, Problem> {
        self.account_for_docs(id)?;
        let _g = self.0.acct.docs_lock.lock().unwrap();
        self.0.acct.docs.delete(id, name)
    }
}

#[cfg(test)]
mod tests;
