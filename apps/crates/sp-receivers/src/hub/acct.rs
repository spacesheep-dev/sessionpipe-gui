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
use std::time::{Duration, Instant};
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
/// The window `account::START_LIMIT` counts in.
const START_WINDOW: Duration = if cfg!(test) {
    Duration::from_millis(700)
} else {
    Duration::from_secs(account::START_WINDOW_S)
};
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

pub(super) struct Accounts {
    /// On, and with a key store of its own (`AccountConfig::keys`).
    enabled: bool,
    /// For spacesheep only: no redirect is followed, and outside a debug build or a test
    /// nothing but https is spoken. reqwest keeps no cookies unless asked to; it is not.
    client: reqwest::Client,
    connect: Mutex<Option<Pending>>,
    /// One connect is started at a time; a second start meanwhile is refused.
    start_gate: tokio::sync::Mutex<()>,
    next_gen: AtomicU64,
    limits: Mutex<HashMap<String, Arc<Limits>>>,
    /// When the last connects were started (`account::START_LIMIT`).
    starts: Mutex<Vec<Instant>>,
    start_limit: AtomicUsize,
    /// A question is on the screen: a second one is refused, never queued behind it.
    asking: AtomicBool,
    docs: Docs,
    docs_lock: Mutex<()>,
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
            next_gen: AtomicU64::new(1),
            limits: Mutex::new(HashMap::new()),
            starts: Mutex::new(Vec::new()),
            start_limit: AtomicUsize::new(account::START_LIMIT),
            asking: AtomicBool::new(false),
            docs: Docs::new(&cfg.home),
            docs_lock: Mutex::new(()),
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
        }
    }

    /// Still waiting for the person, with a code that is still good.
    fn live(&self) -> bool {
        self.state == ConnectState::Pending && now_ms() < self.expires_at_ms
    }

    /// As it is kept while pending: spacesheep's own answer and the origin it came from,
    /// so `account_resume` believes it only as far as it would a fresh one.
    fn kept(&self) -> String {
        serde_json::json!({
            "origin": self.origin, "code": self.code, "poll_token": self.poll_token,
            "digits": self.digits, "url": self.url, "expires_at": iso_ms(self.expires_at_ms),
        })
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

/// Unpacks gzip, and stops one byte past `max` however much more there is: a few
/// kilobytes can unpack to gigabytes, and none of that is ever held.
fn unpack(wire: &[u8], max: usize) -> Result<Vec<u8>, Refused> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(wire)
        .take(max as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| Refused::BadEncoding)?;
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
fn refusal(r: Refused, origin: Option<&str>, allowed: &[String]) -> http::Response<Vec<u8>> {
    let mut b = http::Response::builder()
        .status(r.status())
        .header("content-type", JSON)
        .header("cache-control", "no-store")
        .header(account::HUB_HEADER, r.code());
    if r == Refused::Busy {
        b = b.header("retry-after", "1");
    }
    proxy::finish_exposing(
        b.body(r.body()).expect("response"),
        origin,
        allowed,
        account::EXPOSE_HEADERS,
    )
}

impl Hub {
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

    /// Asks the person, when nothing else is being asked. `Err` when a question is
    /// already open (this one is not queued behind it); `Ok(false)` when they said no,
    /// or when this build has nobody to ask.
    async fn account_ask(&self, question: Question) -> Result<bool, Problem> {
        let Some(confirm) = self.account_cfg().confirm.clone() else {
            return Ok(false);
        };
        if self.0.acct.asking.swap(true, Ordering::SeqCst) {
            return Err(Problem::new(
                "busy",
                "Another question is open on this device. Answer it first.",
            ));
        }
        let _open = Asking(&self.0.acct.asking);
        Ok(confirm.ask(question).await)
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
    /// knows at its next start without asking.
    fn account_mark(&self, id: &str, unauthorized: bool) {
        let mut changed = false;
        let _ = self.0.registry.lock().unwrap().update(id, |r| {
            if let Some(a) = r
                .account
                .as_mut()
                .filter(|a| a.unauthorized != unauthorized)
            {
                a.unauthorized = unauthorized;
                changed = true;
            }
        });
        if changed {
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
        let _ = self.0.registry.lock().unwrap().update(id, |r| {
            if let Some(a) = r
                .account
                .as_mut()
                .filter(|a| a.rp_id.as_deref() != Some(rp.as_str()))
            {
                a.rp_id = Some(rp);
                changed = true;
            }
        });
        if changed {
            self.emit(HubEvent::Receivers);
        }
    }

    /// Removes an account whole: its key and documents first, then its entry. If the list
    /// then can't be saved, what is left is an entry without a key, never a key without
    /// an entry.
    fn account_remove(&self, id: &str) -> Result<bool, String> {
        if let Err(e) = self.account_keys().delete(&account_key_name(id)) {
            log::warn!("acct {id}: the key could not be deleted: {e}");
        }
        {
            let _g = self.0.acct.docs_lock.lock().unwrap();
            if let Err(e) = self.0.acct.docs.remove_all(id) {
                log::warn!("acct {id}: its documents could not be removed: {e}");
            }
        }
        self.0.acct.limits.lock().unwrap().remove(id);
        let removed = self.remove_entry(id)?;
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
            refusal(r, origin, allowed)
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
            Err(r) => return refusal(r, origin, allowed),
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
                let r = if e.is_timeout() {
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
            .map_err(|r| r.words().to_string())?;
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
                "This device's key can't be used with a spacesheep account.",
            ));
        }
        let key_id = key["id"].as_str().unwrap_or_default().to_string();
        let body = serde_json::json!({ "key": key, "name": self.account_cfg().device })
            .to_string()
            .into_bytes();
        let opened = Opened::device_ask();
        account::check_body(opened.door, &body).map_err(|r| Problem::new(r.code(), r.words()))?;
        let a = self
            .account_send(&rx, opened, body, true)
            .await
            .map_err(|r| Problem::new(r.code(), r.words()))?;
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
        let _ = self.0.registry.lock().unwrap().update(id, |r| {
            if let Some(a) = r.account.as_mut() {
                a.device_key_id = Some(key_id.clone());
            }
        });
        self.emit(HubEvent::Account);
        Ok(DeviceAsked {
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
        })
    }

    // ---- connecting ----

    /// May another connect start now? Counted before anything is asked or sent.
    fn connect_start_allowed(&self) -> Result<(), Problem> {
        let mut starts = self.0.acct.starts.lock().unwrap();
        let now = Instant::now();
        starts.retain(|t| now.duration_since(*t) < START_WINDOW);
        if starts.len() >= self.0.acct.start_limit.load(Ordering::Relaxed) {
            let wait = START_WINDOW.saturating_sub(now.duration_since(starts[0]));
            return Err(Problem {
                code: "too_many_starts",
                message: "Too many tries. Wait a few minutes, then connect again.".into(),
                retry_after_s: Some(wait.as_secs().max(1)),
                upstream: None,
            });
        }
        starts.push(now);
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
        }
        self.connect_start_allowed()?;
        let host = account::host_of(&origin);
        // spacesheep.dev confirms a connect on its own page. Another origin's confirm page
        // is that server's, which could say yes to itself: the person says so here first.
        if origin != account::DEFAULT_ORIGIN {
            let q = Question::Origin {
                origin: origin.clone(),
                host: host.clone(),
            };
            if !self.account_ask(q).await? {
                return Err(Problem::new("cancelled", "Cancelled."));
            }
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
            task: None,
            kick: Arc::new(Notify::new()),
        };
        let view = pending.view();
        if let Err(e) = self.account_keys().set(PENDING_NAME, &pending.kept()) {
            // Not fatal: the connect works while the app stays open.
            log::warn!("acct: the pending connect could not be kept: {e}");
        }
        self.connect_install(pending)?;
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
        if let Some(old) = self.0.acct.connect.lock().unwrap().replace(pending) {
            if let Some(t) = old.task {
                t.abort();
            }
        }
        let hub = self.clone();
        let Some(task) = self.spawn(async move { hub.connect_poll(gen).await }) else {
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

    /// A connect that was pending when the app was last closed goes on, if it still can.
    pub(super) fn account_resume(&self) {
        let cfg = self.account_cfg();
        if !self.account_on() || self.0.acct.connect.lock().unwrap().is_some() {
            return;
        }
        let Some(kept) = self.account_keys().get(PENDING_NAME) else {
            return;
        };
        let v: serde_json::Value = serde_json::from_str(&kept).unwrap_or_default();
        let origin = v["origin"].as_str().unwrap_or("").to_string();
        let now = now_ms();
        let in_time = crate::status::parse_iso_ms(v["expires_at"].as_str().unwrap_or(""))
            .is_some_and(|t| t.saturating_add(account::CONNECT_COLLECT_MS) > now);
        let same = !origin.is_empty()
            && account::clean_origin(Some(&origin), cfg.allow_local_http).as_deref()
                == Some(origin.as_str());
        let answer = (in_time && same)
            .then(|| account::parse_connect_answer(kept.as_bytes(), &origin, now).ok())
            .flatten();
        let Some(a) = answer else {
            let _ = self.account_keys().delete(PENDING_NAME);
            return;
        };
        let pending = Pending {
            gen: self.0.acct.next_gen.fetch_add(1, Ordering::Relaxed),
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
            task: None,
            kick: Arc::new(Notify::new()),
        };
        if self.connect_install(pending).is_ok() {
            log::info!("acct: a connect that was pending goes on");
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
                self.connect_finish(gen, ConnectState::Expired, None, None, None);
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
                    self.connect_approved(gen, &live.origin, &key, &email).await;
                    return;
                }
                PollAnswer::Denied => {
                    self.connect_finish(gen, ConnectState::Denied, None, None, None);
                    return;
                }
                PollAnswer::Expired => {
                    self.connect_finish(gen, ConnectState::Expired, None, None, None);
                    return;
                }
                PollAnswer::Unreadable => {
                    let p = Problem::new(
                        "bad_answer",
                        "spacesheep's answer can't be used by this version.",
                    );
                    self.connect_finish(gen, ConnectState::Failed, None, None, Some(p));
                    return;
                }
            }
        }
    }

    /// spacesheep says someone approved the code. Whose account it is, is for the person
    /// to see and accept here before anything is kept: until they do, nothing is written
    /// and nothing of an account already here is touched. In order: the connect must
    /// still be the one; the id must be free or this same account's; the person says
    /// yes; then the key, then the entry; and only then does an older account at the
    /// same origin go.
    async fn connect_approved(&self, gen: u64, origin: &str, key: &str, email: &str) {
        let fail = |code: &'static str, message: &str| {
            let p = Problem::new(code, message);
            self.connect_finish(gen, ConnectState::Failed, None, None, Some(p));
        };
        const UNUSABLE: &str = "spacesheep's answer can't be used by this version.";
        const REVOKE: &str =
            "Connect again, and revoke the unused key on spacesheep (Settings → API keys).";
        if self.connect_live(gen).is_none() {
            return;
        }
        let Some(mut rx) = Receiver::account(origin, email, &iso_now()) else {
            return fail("bad_answer", UNUSABLE);
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
            return fail(
                "conflict",
                "That account can't be kept beside the ones already here.",
            );
        }
        let question = Question::Attach {
            email: email.to_string(),
            origin: origin.to_string(),
            host: account::host_of(origin),
        };
        match self.account_ask(question).await {
            Ok(true) => {}
            Ok(false) => {
                log::info!("acct: the person declined the approved account");
                return self.connect_finish(gen, ConnectState::Declined, None, None, None);
            }
            Err(p) => return self.connect_finish(gen, ConnectState::Failed, None, None, Some(p)),
        }
        // Cancelled, or replaced by another connect, while the question was open.
        if self.connect_live(gen).is_none() {
            return;
        }
        // The same person connecting again keeps what the Hub had learnt about them.
        if let (Some(old), Some(new)) = (taken.and_then(|r| r.account), rx.account.as_mut()) {
            new.rp_id = old.rp_id;
            new.device_key_id = old.device_key_id;
        }
        let name = account_key_name(&rx.id);
        let before = self.account_keys().get(&name);
        if let Err(e) = self
            .account_keys()
            .set(&name, &account::kept_key(origin, key))
        {
            log::warn!("acct: the key could not be kept: {e}");
            return fail(
                "keystore",
                &format!("The key could not be kept on this device. {REVOKE}"),
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
                &format!("The account could not be saved on this device. {REVOKE}"),
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
            Some(email.to_string()),
            None,
        );
        self.emit(HubEvent::Receivers);
        // The rp id the signer needs, learnt now rather than at the first send. A failure
        // here is nothing: the page's own read of the machines door teaches it too.
        let _ = self
            .account_send(&rx, Opened::machines(), Vec::new(), true)
            .await;
    }

    /// Ends the connect `gen` (when it is still the one): the code, the link and the poll
    /// token are dropped, the outcome stays for the page to read.
    fn connect_finish(
        &self,
        gen: u64,
        state: ConnectState,
        receiver: Option<String>,
        email: Option<String>,
        error: Option<Problem>,
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

    /// Stops a pending connect (true), or clears a finished one's outcome (false). The
    /// code stays good on spacesheep until it expires: a person who confirms it after
    /// this makes a key nobody collects, which is theirs to revoke there.
    pub fn account_connect_cancel(&self) -> bool {
        let old = self.0.acct.connect.lock().unwrap().take();
        let _ = self.account_keys().delete(PENDING_NAME);
        let Some(old) = old else {
            return false;
        };
        if let Some(t) = &old.task {
            t.abort();
        }
        self.emit(HubEvent::Account);
        old.state == ConnectState::Pending
    }

    /// Polls a pending connect now (the app came back to the front).
    pub fn account_nudge(&self) {
        if let Some(p) = self.0.acct.connect.lock().unwrap().as_ref() {
            p.kick.notify_one();
        }
    }

    /// Forgets the account here: its key, its documents, its entry. When documents are
    /// kept for it, the person is asked first (they are theirs, and gone for good). The
    /// key itself keeps working until it is revoked on spacesheep, and the answer says so.
    pub async fn account_disconnect(&self, id: &str) -> Result<Disconnected, Problem> {
        let rx = self
            .account_entry(id)
            .ok_or_else(|| Problem::new("unknown_account", "No such account."))?;
        let email = rx
            .account
            .as_ref()
            .map(|a| a.email.clone())
            .unwrap_or_default();
        let has_documents = {
            let _g = self.0.acct.docs_lock.lock().unwrap();
            !self.0.acct.docs.names(id).is_empty()
        };
        if has_documents {
            let q = Question::Disconnect {
                email: email.clone(),
                origin: rx.origin.clone(),
                host: account::host_of(&rx.origin),
            };
            if !self.account_ask(q).await? {
                return Err(Problem::new("cancelled", "Cancelled."));
            }
        }
        self.account_remove(id).map_err(|e| {
            Problem::new(
                "io",
                format!("The key is forgotten, but the entry could not be removed: {e}"),
            )
        })?;
        {
            // A finished connect that named it is no longer news.
            let mut g = self.0.acct.connect.lock().unwrap();
            if g.as_ref().is_some_and(|p| {
                p.state != ConnectState::Pending && p.receiver.as_deref() == Some(id)
            }) {
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
            note: "The key is forgotten on this device. It keeps working until you revoke it on spacesheep: Settings → API keys.".into(),
        })
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
