//! The Hub's side of a spacesheep account (docs/rfcs/08, "The phone on an account";
//! the rules themselves are `account.rs`): connecting, with the poll run here until the
//! person answers; the key, kept here and nowhere else; the doors, forwarded with the key
//! added; and the account's documents.
//!
//! What never happens here: the key in a log line, an error, a URL or a returned value;
//! a redirect followed; a page's header sent on; a cookie sent or kept; a request to a
//! path that is not a door.

use super::{describe, Backoff, Hub, HubConfig, HubEvent};
use crate::account::{
    self, AccountRef, AccountState, AccountStatus, AccountView, ConnectState, ConnectView,
    Disconnected, Door, Opened, PollAnswer, Problem, Refused,
};
use crate::docs::Docs;
use crate::proxy;
use crate::registry::{account_key_name, KeyStore, Receiver};
use crate::status::{iso_ms, iso_now, now_ms};
use futures_util::StreamExt;
use http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use http::HeaderValue;
use std::sync::atomic::{AtomicU64, Ordering};
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
/// A connect answer, a poll answer: a few hundred bytes.
const SMALL_ANSWER: usize = 16 * 1024;
const JSON: &str = "application/json";
/// The connect in progress, in the account key store, so the app being closed while the
/// person confirms in the browser does not lose it (`Hub::account_resume`).
const PENDING_NAME: &str = "acct-connect";

fn request_timeout() -> Duration {
    Duration::from_secs(account::REQUEST_TIMEOUT_S)
}

pub(super) struct Accounts {
    /// For spacesheep only: no redirect is followed, and outside a debug build or a test
    /// nothing but https is spoken. reqwest keeps no cookies unless asked to; it is not.
    client: reqwest::Client,
    connect: Mutex<Option<Pending>>,
    /// One connect is started at a time.
    start_gate: tokio::sync::Mutex<()>,
    next_gen: AtomicU64,
    in_flight: Arc<Semaphore>,
    docs: Docs,
    docs_lock: Mutex<()>,
}

impl Accounts {
    pub(super) fn new(cfg: &HubConfig) -> Accounts {
        let client = reqwest::Client::builder()
            .user_agent(cfg.user_agent.clone())
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!cfg.account.allow_local_http)
            .build()
            .expect("http client");
        Accounts {
            client,
            connect: Mutex::new(None),
            start_gate: tokio::sync::Mutex::new(()),
            next_gen: AtomicU64::new(1),
            in_flight: Arc::new(Semaphore::new(account::MAX_IN_FLIGHT)),
            docs: Docs::new(&cfg.home),
            docs_lock: Mutex::new(()),
        }
    }
}

/// A connect the Hub is polling, or the last one's outcome. No `Debug`: it holds the poll
/// token until it ends.
struct Pending {
    gen: u64,
    origin: String,
    code: String,
    poll_token: String,
    digits: String,
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
            url: self.url.clone(),
            expires_at: iso_ms(self.expires_at_ms),
            state: self.state,
            receiver: self.receiver.clone(),
            email: self.email.clone(),
            error: self.error.clone(),
        }
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

/// `Authorization: Bearer …`, marked sensitive so no debug print of a request shows it.
fn bearer(token: &str) -> Option<HeaderValue> {
    let mut v = HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
    v.set_sensitive(true);
    Some(v)
}

fn host_of(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "spacesheep".into())
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

/// The whole body, unless it is over `max` (said up front or found on the way).
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

    fn account_keys(&self) -> &KeyStore {
        self.account_cfg().keys.as_ref().unwrap_or(&self.0.cfg.keys)
    }

    /// The account's key, for a request about to be sent. Never returned further.
    fn account_key(&self, id: &str) -> Option<String> {
        self.account_keys()
            .get(&account_key_name(id))
            .filter(|k| account::is_token(k))
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

    fn account_entry(&self, id: &str) -> Option<Receiver> {
        self.account_entries().into_iter().find(|r| r.id == id)
    }

    fn account_state(&self, r: &Receiver) -> AccountState {
        if self.account_key(&r.id).is_none() {
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
    /// may live at, and its id is that origin's and its email's. The key is kept under
    /// the id, so an entry rewritten to point elsewhere finds no key to send there.
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
                })
            })
            .collect();
        AccountStatus {
            enabled: self.account_cfg().enabled,
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

    /// Forgets what is kept for an account outside the list: its key and its documents.
    pub(super) fn account_forget(&self, id: &str) {
        if let Err(e) = self.account_keys().delete(&account_key_name(id)) {
            log::warn!("acct {id}: the key could not be deleted: {e}");
        }
        let _g = self.0.acct.docs_lock.lock().unwrap();
        if let Err(e) = self.0.acct.docs.remove_all(id) {
            log::warn!("acct {id}: its documents could not be removed: {e}");
        }
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
        let a = match self.account_send(&rx, &opened, body).await {
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
    /// headers are the Hub's.
    async fn account_send(
        &self,
        rx: &Receiver,
        opened: &Opened,
        body: Vec<u8>,
    ) -> Result<Answer, Refused> {
        if !self.account_cfg().enabled {
            return Err(Refused::AccountOff);
        }
        let origin = self.account_origin(rx)?;
        let key = self.account_key(&rx.id).ok_or(Refused::NotConnected)?;
        let auth = bearer(&key).ok_or(Refused::NotConnected)?;
        let url = proxy::upstream_url(&origin, &opened.path_and_query)
            .map_err(|_| Refused::BadAccount)?;
        let _permit = self
            .0
            .acct
            .in_flight
            .clone()
            .try_acquire_owned()
            .map_err(|_| Refused::Busy)?;
        let door = opened.door;
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
            .timeout(Duration::from_secs(opened.timeout_s()));
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
        let body = match read_capped(res, door.max_response()).await {
            Ok(b) => b,
            Err(ReadError::TooLarge) => {
                failed("an answer over the size limit");
                return Err(Refused::AnswerTooLarge);
            }
            Err(ReadError::Broken) => {
                failed("the answer stopped");
                self.account_reached(&rx.id, false);
                return Err(Refused::Unreachable);
            }
        };
        // The key goes up, never down: an answer that holds it is not the page's to read.
        let in_header = |v: &Option<HeaderValue>| {
            v.as_ref()
                .is_some_and(|v| account::holds(v.as_bytes(), key.as_bytes()))
        };
        if account::holds(&body, key.as_bytes())
            || in_header(&content_type)
            || in_header(&retry_after)
        {
            failed("an answer that held the key, not passed on");
            return Err(Refused::Withheld);
        }
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
        let opened =
            account::open_door("GET", "/api/sessionpipe/v1/relay/machines").map_err(|_| NO)?;
        let a = self
            .account_send(&rx, &opened, Vec::new())
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

    // ---- connecting ----

    /// The origin a connect would go to, when the shell must ask the person first, in UI
    /// the page cannot draw: any origin but spacesheep.dev. There the confirm page is
    /// spacesheep's own; anywhere else it is that server's, which could say yes to itself
    /// and so put an entry in the list with nobody asked. None for the default origin, for
    /// one that is no origin (the start says so itself), and for a connect already
    /// pending there (the person was asked when it started).
    pub fn account_origin_to_confirm(&self, origin: Option<&str>) -> Option<String> {
        let cfg = self.account_cfg();
        if !cfg.enabled {
            return None;
        }
        let o = account::clean_origin(origin, cfg.allow_local_http)?;
        if o == account::DEFAULT_ORIGIN {
            return None;
        }
        let pending = self
            .0
            .acct
            .connect
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.state == ConnectState::Pending && p.origin == o);
        (!pending).then_some(o)
    }

    /// Asks spacesheep for a connect code and starts polling for the person's answer.
    /// The page gets the digits to show, the link to open in the system browser and when
    /// it expires. A connect already pending for the same origin is returned as it is.
    pub async fn account_connect_start(
        &self,
        origin: Option<&str>,
    ) -> Result<ConnectView, Problem> {
        let cfg = self.account_cfg();
        if !cfg.enabled {
            return Err(Problem::new(
                "unsupported",
                "A spacesheep account is not available in this build.",
            ));
        }
        let origin = account::clean_origin(origin, cfg.allow_local_http)
            .ok_or_else(|| Problem::new("bad_origin", "The origin must be an https address."))?;
        let _gate = self.0.acct.start_gate.lock().await;
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
        {
            let g = self.0.acct.connect.lock().unwrap();
            if let Some(p) = g.as_ref().filter(|p| {
                p.state == ConnectState::Pending && p.origin == origin && now_ms() < p.expires_at_ms
            }) {
                p.kick.notify_one();
                return Ok(p.view());
            }
        }
        let host = host_of(&origin);
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
        if !cfg.enabled || self.0.acct.connect.lock().unwrap().is_some() {
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

    /// The person confirmed: the key is kept (and nowhere but the key store), the account
    /// joins the list, and the page is told its id and email.
    async fn connect_approved(&self, gen: u64, origin: &str, key: &str, email: &str) {
        let fail = |code: &'static str, message: &str| {
            let p = Problem::new(code, message);
            self.connect_finish(gen, ConnectState::Failed, None, None, Some(p));
        };
        let Some(rx) = Receiver::account(origin, email, &iso_now()) else {
            return fail(
                "bad_answer",
                "spacesheep's answer can't be used by this version.",
            );
        };
        // The key first: an entry without a key says so (`no_key`); a key without an
        // entry would be a secret nobody could find to delete.
        if let Err(e) = self.account_keys().set(&account_key_name(&rx.id), key) {
            log::warn!("acct: the key could not be kept: {e}");
            return fail(
                "keystore",
                "The key could not be kept on this device. Connect again, and revoke the unused key on spacesheep (Settings → API keys).",
            );
        }
        // One account per origin: another person's at this origin goes, with its key and
        // its documents. The same person's keeps its documents (the id is the same).
        let active = self.0.registry.lock().unwrap().active().map(str::to_string);
        let older: Vec<String> = self
            .account_entries()
            .into_iter()
            .filter(|r| r.origin == origin && r.id != rx.id)
            .map(|r| r.id)
            .collect();
        let replaced_active = older.iter().any(|id| Some(id) == active.as_ref());
        for id in &older {
            let _ = self.remove(id);
        }
        let saved = {
            let mut reg = self.0.registry.lock().unwrap();
            reg.upsert(rx.clone()).and_then(|()| {
                if replaced_active {
                    reg.set_active(Some(&rx.id))
                } else {
                    Ok(())
                }
            })
        };
        if let Err(e) = saved {
            log::warn!("acct: the account could not be saved: {e}");
            let _ = self.account_keys().delete(&account_key_name(&rx.id));
            return fail(
                "io",
                "The account could not be saved on this device. Connect again, and revoke the unused key on spacesheep (Settings → API keys).",
            );
        }
        log::info!("acct {}: connected at {}", rx.id, host_of(origin));
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
        if let Ok(opened) = account::open_door("GET", "/api/sessionpipe/v1/relay/machines") {
            let _ = self.account_send(&rx, &opened, Vec::new()).await;
        }
    }

    /// Ends the connect `gen` (when it is still the one): the code and the poll token are
    /// dropped, the outcome stays for the page to read.
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

    /// Forgets the account here: its key, its documents, its entry. The key itself keeps
    /// working until it is revoked on spacesheep, and the answer says so.
    pub fn account_disconnect(&self, id: &str) -> Result<Disconnected, Problem> {
        let rx = self
            .account_entry(id)
            .ok_or_else(|| Problem::new("unknown_account", "No such account."))?;
        let email = rx
            .account
            .as_ref()
            .map(|a| a.email.clone())
            .unwrap_or_default();
        self.remove(id).map_err(|e| {
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
        if self.account_cfg().enabled && self.account_entry(id).is_some() {
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
