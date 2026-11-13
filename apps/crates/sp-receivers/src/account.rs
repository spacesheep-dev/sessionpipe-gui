//! A spacesheep account as a kind of receiver (docs/rfcs/08, "The phone on an account"):
//! the pure parts. The Hub (`hub/acct.rs`) does the network.
//!
//! The page has no server in this mode: it reads the account's relay itself, through the
//! Hub, which holds the account's API key and adds it. This file is the boundary between
//! the two, as data and pure functions, so every rule is tested without a socket:
//!
//! - the origin an account may live at (`clean_origin`);
//! - the doors: the only requests the Hub forwards, by method and path, with the query
//!   strings rebuilt from checked values (`open_door`), and what a send must look like
//!   to be one (`check_body`). Anything else is refused here, before any network;
//! - what spacesheep's connect and poll answers must look like to be believed;
//! - the Hub's own answers, told from spacesheep's by a header no upstream can set;
//! - the questions only the person answers, in UI the page cannot draw (`Confirm`).
//!
//! The page is not trusted here. It is the app's own bundle, and it also draws what
//! machines and sessions say; whatever it asks is checked as if anyone had asked.
//!
//! The key is never in a URL, a log line, an error or anything a command returns.

use crate::registry::KeyStore;
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Where an account lives when the page names no origin.
pub const DEFAULT_ORIGIN: &str = "https://spacesheep.dev";

/// The header on every answer the Hub wrote itself (a refusal, a failure to reach
/// spacesheep), holding its code. Response headers from upstream are never passed on by
/// name, so an answer with it is the Hub's and an answer without it is spacesheep's.
pub const HUB_HEADER: &str = "x-sessionpipe-hub";

/// What the page may read of an account answer across origins, beside the safelisted
/// `content-type`: `retry-after` (a 429's wait), and whose answer it is.
pub const EXPOSE_HEADERS: &str = "content-type, retry-after, x-sessionpipe-hub";

/// spacesheep holds an empty relay poll at most this long (its `RELAY_WAIT_MAX_S`).
pub const RELAY_WAIT_MAX_S: u64 = 25;
pub const RELAY_PAGE_MAX: u64 = 500;
/// The Hub's own limit for a relay request is the wait it asked for plus this: the time
/// to reach spacesheep and to read a page of events on a slow network.
pub const RELAY_GRACE_S: u64 = 20;
/// Every other door, and connect and its poll.
pub const REQUEST_TIMEOUT_S: u64 = 15;
/// JavaScript's largest exact integer: a relay cursor or a job id is at most this.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The page's requests to one account in flight at once; one more is answered `busy`.
/// Each account has its own count, so one cannot starve another.
pub const MAX_PAGE_REQUESTS: usize = 6;
/// Of those, relay reads (the only large answers): two, a long poll and the one that
/// replaces it after a reload.
pub const MAX_RELAY_READS: usize = 2;
/// The Hub's own requests to an account (the signer's questions, this device's key):
/// apart from the page's, and they wait their turn instead of being refused, so nothing
/// the page holds open keeps the signer from learning what it signs for.
pub const MAX_OWN_REQUESTS: usize = 2;
/// A relay answer, as the page gets it (after decompression). A page is at most 500
/// events and an event at most 262,144 bytes on the wire (a batch's limit there), though
/// one is a kilobyte or so in practice: 8 MiB holds a full page of events averaging 16 KB.
/// A page over it is refused `answer_too_large` and the reader asks for a smaller
/// `limit`; at `limit=1` the largest event there can be fits thirty times over, so no
/// event is ever unreadable.
pub const RELAY_ANSWER_MAX: usize = 8 * 1024 * 1024;
/// Every other answer.
pub const SMALL_ANSWER_MAX: usize = 1024 * 1024;
/// Connects started from this app in `START_WINDOW_S`: spacesheep counts them per
/// address (ten an hour, thirty a day), and a page must not be able to spend that for
/// everyone behind it. Three an hour, counted across restarts.
pub const START_LIMIT: usize = 3;
pub const START_WINDOW_S: u64 = 3600;
/// Requests to trust this device's key in `DEVICE_ASK_WINDOW_S`: spacesheep counts them
/// for the whole account (twenty an hour, with pairing), and each one made anew changes
/// the number the person is matching.
pub const DEVICE_ASK_LIMIT: usize = 5;
pub const DEVICE_ASK_WINDOW_S: u64 = 3600;
/// While an ask is this fresh, asking again returns it as it was: no request, the same
/// number.
pub const DEVICE_ASK_FRESH_S: u64 = 600;
/// A key that was collected and waits for the person's answer here is held this long.
pub const HELD_MAX_MS: u64 = 15 * 60_000;
/// What a connect says when a key was made on spacesheep and is not kept here: the Hub
/// cannot revoke it, so the person is told where to.
pub const UNUSED_KEY_NOTE: &str = "A key was made for this app on spacesheep and is not kept here. Revoke it there: Settings → API keys.";

/// A question only the person answers, in UI the page cannot draw or click. The shell
/// writes the words (`apps/mobile` `confirm.rs`); Cancel is the default answer of each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Question {
    /// Before a connect to an origin that is not spacesheep.dev: its confirm page is
    /// that server's own, which could say yes to itself.
    Origin { origin: String, host: String },
    /// Before an approved account is kept: whose it is. The page never held the code, but
    /// the person must still see which account this phone is about to show.
    Attach {
        email: String,
        origin: String,
        host: String,
    },
    /// Before an account is disconnected. `documents`: labels and read marks are kept
    /// for it here, and go with it.
    Disconnect {
        email: String,
        origin: String,
        host: String,
        documents: bool,
    },
}

/// The person's answer, once they gave it: yes or no. None when the question could not
/// be shown (another alert is up, there is no window): that is not an answer, and
/// nothing is decided by it.
pub type Answered = Pin<Box<dyn Future<Output = Option<bool>> + Send>>;

/// How the Hub asks. The phone shows a native alert; a test answers from a script.
pub trait Confirm: Send + Sync + 'static {
    fn ask(&self, question: Question) -> Answered;
}

/// How the Hub is told to treat accounts (`HubConfig::account`).
pub struct AccountConfig {
    /// Off: no connect, no door, no document. The desktop app (its server does this job)
    /// and Android until its https verifier is set up.
    pub enabled: bool,
    /// Where account keys live: a store of their own, never the one receiver keys are
    /// in. (A receiver is sent its key as a cookie, to an origin the list names; an API
    /// key must not be findable that way.) The Hub turns the mode off when it is given
    /// the same place twice.
    pub keys: KeyStore,
    /// `http://localhost` and `http://127.0.0.1` as an account's origin: a debug build
    /// against a local spacesheep, and tests. A release build passes false.
    pub allow_local_http: bool,
    /// What this install calls itself on spacesheep's confirm page and in the key's name
    /// there ("iPhone"). The page cannot choose it.
    pub device: String,
    /// The app's version, for the key's name.
    pub version: String,
    /// Who asks the person. None: every question is answered no.
    pub confirm: Option<Arc<dyn Confirm>>,
}

impl Default for AccountConfig {
    fn default() -> Self {
        AccountConfig {
            enabled: false,
            keys: KeyStore::memory(),
            allow_local_http: false,
            device: "sessionpipe".into(),
            version: String::new(),
            confirm: None,
        }
    }
}

/// An account's origin, cleaned: https and nothing but an origin. Plain http only for
/// `localhost` and `127.0.0.1`, and only with `allow_local_http`. No user or password
/// (`https://spacesheep.dev@evil.example` is evil.example), no path, query or fragment.
/// None or blank is the default.
pub fn clean_origin(input: Option<&str>, allow_local_http: bool) -> Option<String> {
    let s = input.map(str::trim).unwrap_or("");
    if s.is_empty() {
        return Some(DEFAULT_ORIGIN.into());
    }
    if s.len() > 255 {
        return None;
    }
    let u = url::Url::parse(s).ok()?;
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    if !matches!(u.path(), "" | "/") || u.query().is_some() || u.fragment().is_some() {
        return None;
    }
    let local = match u.host()? {
        url::Host::Domain(d) => d == "localhost",
        url::Host::Ipv4(ip) => ip == std::net::Ipv4Addr::LOCALHOST,
        url::Host::Ipv6(_) => false,
    };
    match u.scheme() {
        "https" => {}
        "http" if allow_local_http && local => {}
        _ => return None,
    }
    Some(u.origin().ascii_serialization())
}

/// The host of an origin, for the person to read.
pub fn host_of(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| {
            let h = u.host_str()?.to_string();
            Some(match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h,
            })
        })
        .unwrap_or_else(|| "spacesheep".into())
}

/// A link spacesheep handed over, when it is one the person may be sent to: http(s) in
/// the origin's own scheme (a `blob:` or `filesystem:` URL has an origin too, and is not
/// a page), on the account's own origin, with no user or password.
pub fn link_on_origin(link: &str, origin: &str) -> Option<String> {
    if link.len() > 512 {
        return None;
    }
    let (u, o) = (url::Url::parse(link).ok()?, url::Url::parse(origin).ok()?);
    let ok = matches!(o.scheme(), "https" | "http")
        && u.scheme() == o.scheme()
        && u.has_host()
        && u.username().is_empty()
        && u.password().is_none()
        && u.origin().ascii_serialization() == origin;
    ok.then(|| u.into())
}

/// A door: one request the Hub sends for an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Door {
    /// `GET /api/sessionpipe/v1/relay?since=&limit=&wait=`: the account's events.
    Relay,
    /// `GET /api/sessionpipe/v1/relay/machines`: the machines paired there.
    RelayMachines,
    /// `GET /api/sessionpipe/v1/relay/jobs?since=`: how the sends are going.
    RelayJobs,
    /// `POST /api/machines/<id>/jobs`: a signed command for a machine.
    MachineJobs,
    /// `POST /api/gui/device`: this device's own key, asked to be trusted. The Hub's own
    /// request (`Hub::account_device_ask`), with a body the Hub wrote: never the page's.
    DeviceAsk,
    /// `GET /api/gui/device?id=`: where that key stands. The page asks with no id; the
    /// Hub adds this device's.
    DeviceStatus,
}

const RELAY: &str = "/api/sessionpipe/v1/relay";
const RELAY_MACHINES: &str = "/api/sessionpipe/v1/relay/machines";
const RELAY_JOBS: &str = "/api/sessionpipe/v1/relay/jobs";
const DEVICE: &str = "/api/gui/device";

impl Door {
    /// For a log line: never the query, never an id.
    pub fn name(self) -> &'static str {
        match self {
            Door::Relay => "relay",
            Door::RelayMachines => "relay/machines",
            Door::RelayJobs => "relay/jobs",
            Door::MachineJobs => "machines/:id/jobs",
            Door::DeviceAsk => "gui/device (ask)",
            Door::DeviceStatus => "gui/device",
        }
    }

    /// The largest body sent. A send is the GUI server's own limit for one
    /// (`SEND_BODY_MAX`); a device key is a few hundred bytes.
    pub fn max_request(self) -> usize {
        match self {
            Door::MachineJobs => 256 * 1024,
            Door::DeviceAsk => 16 * 1024,
            _ => 0,
        }
    }

    /// The largest answer handed on, after decompression.
    pub fn max_response(self) -> usize {
        match self {
            Door::Relay => RELAY_ANSWER_MAX,
            _ => SMALL_ANSWER_MAX,
        }
    }
}

/// A request that is a door, as the Hub sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub door: Door,
    /// The path and the query, rebuilt: nothing here is the page's own text except a
    /// machine id that matched its pattern.
    pub path_and_query: String,
    /// Seconds spacesheep may hold the request (the relay's `wait`).
    pub wait_s: u64,
}

impl Opened {
    /// The Hub's limit for the whole request.
    pub fn timeout_s(&self) -> u64 {
        match self.door {
            Door::Relay => self.wait_s + RELAY_GRACE_S,
            _ => REQUEST_TIMEOUT_S,
        }
    }

    /// The machines door, for the Hub's own questions.
    pub fn machines() -> Opened {
        Opened {
            door: Door::RelayMachines,
            path_and_query: RELAY_MACHINES.into(),
            wait_s: 0,
        }
    }

    /// The device door, for the Hub's own asking.
    pub fn device_ask() -> Opened {
        Opened {
            door: Door::DeviceAsk,
            path_and_query: DEVICE.into(),
            wait_s: 0,
        }
    }

    /// The device status door about one key: this device's, which the Hub names.
    pub fn about_key(mut self, key_id: &str) -> Option<Opened> {
        (self.door == Door::DeviceStatus && is_key_id(key_id)).then(|| {
            self.path_and_query = format!("{DEVICE}?id={key_id}");
            self
        })
    }
}

/// An answer the Hub writes itself, with its status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Not on the list: another path, another method, a path that is not written exactly
    /// as a door is, a machine that takes commands unsigned (a cloud box).
    NotADoor,
    /// A door, with a parameter it does not take, a value out of range, or one twice.
    BadQuery,
    /// A body where none is taken, or one that is not a JSON object.
    BadBody,
    /// A send that is not a signed command: no `cmd`, no signature beside it, or a field
    /// a signed command does not have.
    NotSigned,
    /// A request body over the door's limit.
    TooLarge,
    /// The request does not come from the bundled page.
    ForbiddenOrigin,
    /// Accounts are off in this build.
    AccountOff,
    /// The entry is not what it says (its id is not its origin's and email's).
    BadAccount,
    /// There is no key here for this account at this origin.
    NotConnected,
    /// This device's key was never asked to be trusted, so there is none to ask about.
    NoDeviceKey,
    /// Too many of the page's requests in flight for this account.
    Busy,
    /// A send that never left this device: no connection to spacesheep was made, so
    /// nothing of the command was sent. Said on the send door alone, and apart from
    /// `Unreachable`, after which nobody knows whether spacesheep took the command.
    NotSent,
    /// spacesheep could not be reached, or its answer stopped on the way.
    Unreachable,
    /// It did not answer in the Hub's time.
    Timeout,
    /// It answered with a redirect, which is neither followed nor passed on.
    Redirected,
    /// Its answer is over the door's limit.
    AnswerTooLarge,
    /// Its answer is packed in a way the Hub did not ask for, or is not what it says.
    BadEncoding,
    /// Its answer held the key, and is not passed on.
    Withheld,
}

impl Refused {
    pub fn code(self) -> &'static str {
        match self {
            Refused::NotADoor => "not_a_door",
            Refused::BadQuery => "bad_query",
            Refused::BadBody => "bad_body",
            Refused::NotSigned => "not_signed",
            Refused::TooLarge => "too_large",
            Refused::ForbiddenOrigin => "forbidden_origin",
            Refused::AccountOff => "account_off",
            Refused::BadAccount => "bad_account",
            Refused::NotConnected => "not_connected",
            Refused::NoDeviceKey => "no_device_key",
            Refused::Busy => "busy",
            Refused::NotSent => "not_sent",
            Refused::Unreachable => "unreachable",
            Refused::Timeout => "timeout",
            Refused::Redirected => "redirected",
            Refused::AnswerTooLarge => "answer_too_large",
            Refused::BadEncoding => "bad_encoding",
            Refused::Withheld => "withheld",
        }
    }

    pub fn status(self) -> http::StatusCode {
        use http::StatusCode as S;
        match self {
            Refused::NotADoor
            | Refused::ForbiddenOrigin
            | Refused::AccountOff
            | Refused::BadAccount => S::FORBIDDEN,
            Refused::BadQuery | Refused::BadBody | Refused::NotSigned => S::BAD_REQUEST,
            Refused::TooLarge => S::PAYLOAD_TOO_LARGE,
            Refused::NotConnected => S::UNAUTHORIZED,
            Refused::NoDeviceKey => S::CONFLICT,
            Refused::Busy => S::TOO_MANY_REQUESTS,
            Refused::Timeout => S::GATEWAY_TIMEOUT,
            Refused::NotSent
            | Refused::Unreachable
            | Refused::Redirected
            | Refused::AnswerTooLarge
            | Refused::BadEncoding
            | Refused::Withheld => S::BAD_GATEWAY,
        }
    }

    pub fn words(self) -> &'static str {
        match self {
            Refused::NotADoor => "The app does not forward this to a spacesheep account.",
            Refused::BadQuery => "That request has a parameter the app does not forward.",
            Refused::BadBody => "That request's body is not one the app forwards.",
            Refused::NotSigned => "The app forwards only a signed command to a machine.",
            Refused::TooLarge => "That is too large to send.",
            Refused::ForbiddenOrigin => "Only the app's own page may ask.",
            Refused::AccountOff => "A spacesheep account is not available in this build.",
            Refused::BadAccount => "This account's entry is damaged. Disconnect and connect again.",
            Refused::NotConnected => "This device holds no key for the account. Connect again.",
            Refused::NoDeviceKey => "This device has not asked to be trusted yet.",
            Refused::Busy => "Too many requests at once.",
            Refused::NotSent | Refused::Unreachable => "spacesheep could not be reached.",
            Refused::Timeout => "spacesheep did not answer in time.",
            Refused::Redirected => {
                "spacesheep answered with a redirect, which the app does not follow."
            }
            Refused::AnswerTooLarge => "spacesheep's answer is too large. Ask for less at once.",
            Refused::BadEncoding => "spacesheep's answer could not be read.",
            Refused::Withheld => "spacesheep's answer was not one the app passes on.",
        }
    }

    /// The answer's body: `{ hub: true, reason, error }`.
    pub fn body(self) -> Vec<u8> {
        serde_json::json!({ "hub": true, "reason": self.code(), "error": self.words() })
            .to_string()
            .into_bytes()
    }
}

/// Base64url characters, `min` to `max` of them.
fn is_b64url(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// spacesheep's `isMachineId`: `m_` and 16 to 40 base64url characters.
pub fn is_machine_id(s: &str) -> bool {
    s.strip_prefix("m_").is_some_and(|r| is_b64url(r, 16, 40))
}

/// A cloud box's id, as spacesheep's `isBoxId` has it: `m_box` and exactly sixteen
/// lowercase hex digits. (Not a prefix: an ordinary machine's id is random, and one in a
/// quarter of a million begins `m_box`.) A box is spacesheep's own machine: its jobs
/// route runs a message for it with no signature at all, so the account's key alone
/// would be enough to make it work. The Hub sends nothing to one.
pub fn is_box_id(s: &str) -> bool {
    s.strip_prefix("m_box").is_some_and(|r| {
        r.len() == 16
            && r.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

/// A device key's id: the SHA-256 of its spki, base64url.
pub fn is_key_id(s: &str) -> bool {
    is_b64url(s, 43, 43)
}

/// Plain decimal digits, no sign, no exponent, at most `max`.
fn number(v: &str, max: u64) -> Option<u64> {
    if v.is_empty() || v.len() > 16 || !v.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    v.parse::<u64>().ok().filter(|n| *n <= max)
}

/// A query as `name=value` pairs, each name from `names`, none twice. No percent-encoding
/// is read (no value a door takes needs one), so an encoded name or value is refused.
fn pairs<'a>(query: &'a str, names: &[&str]) -> Result<Vec<(&'a str, &'a str)>, Refused> {
    let mut out: Vec<(&str, &str)> = Vec::new();
    if query.is_empty() {
        return Ok(out);
    }
    for part in query.split('&') {
        let (k, v) = part.split_once('=').ok_or(Refused::BadQuery)?;
        if !names.contains(&k) || out.iter().any(|(seen, _)| *seen == k) {
            return Err(Refused::BadQuery);
        }
        out.push((k, v));
    }
    Ok(out)
}

/// Is this request of the page's a door? `path_and_query` is what followed the
/// receiver's id in the `rx:` URL, as the page wrote it. A path matches only when it is
/// written exactly as the door is: no `..`, no `//`, no encoded character, no trailing
/// slash, no other case.
///
/// Five doors are the page's. The sixth, asking spacesheep to trust a device key, is not:
/// whoever chose that key could sign for the person afterwards, so the Hub asks itself,
/// with this device's own (`Opened::device_ask`).
pub fn open_door(method: &str, path_and_query: &str) -> Result<Opened, Refused> {
    if path_and_query.contains('#') {
        return Err(Refused::NotADoor);
    }
    let (path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_and_query, ""),
    };
    let opened = |door, path_and_query: String, wait_s| {
        Ok(Opened {
            door,
            path_and_query,
            wait_s,
        })
    };
    match (method, path) {
        ("GET", RELAY) => {
            let (mut since, mut limit, mut wait) = (None, None, None);
            for (k, v) in pairs(query, &["since", "limit", "wait"])? {
                match k {
                    "since" => since = Some(number(v, MAX_SAFE_INTEGER).ok_or(Refused::BadQuery)?),
                    "limit" => {
                        limit = Some(
                            number(v, RELAY_PAGE_MAX)
                                .filter(|n| *n >= 1)
                                .ok_or(Refused::BadQuery)?,
                        )
                    }
                    _ => wait = Some(number(v, RELAY_WAIT_MAX_S).ok_or(Refused::BadQuery)?),
                }
            }
            let mut q = Vec::new();
            if let Some(n) = since {
                q.push(format!("since={n}"));
            }
            if let Some(n) = limit {
                q.push(format!("limit={n}"));
            }
            if let Some(n) = wait {
                q.push(format!("wait={n}"));
            }
            let pq = if q.is_empty() {
                RELAY.to_string()
            } else {
                format!("{RELAY}?{}", q.join("&"))
            };
            opened(Door::Relay, pq, wait.unwrap_or(0))
        }
        ("GET", RELAY_MACHINES) => {
            pairs(query, &[])?;
            opened(Door::RelayMachines, RELAY_MACHINES.into(), 0)
        }
        ("GET", RELAY_JOBS) => {
            let mut pq = RELAY_JOBS.to_string();
            if let Some((_, v)) = pairs(query, &["since"])?.first() {
                let n = number(v, MAX_SAFE_INTEGER).ok_or(Refused::BadQuery)?;
                pq = format!("{RELAY_JOBS}?since={n}");
            }
            opened(Door::RelayJobs, pq, 0)
        }
        // Which key is this device's, the Hub knows: the page names none.
        ("GET", DEVICE) => {
            pairs(query, &[])?;
            opened(Door::DeviceStatus, DEVICE.into(), 0)
        }
        ("POST", p) => {
            let id = p
                .strip_prefix("/api/machines/")
                .and_then(|r| r.strip_suffix("/jobs"))
                .filter(|id| is_machine_id(id) && !is_box_id(id))
                .ok_or(Refused::NotADoor)?;
            pairs(query, &[])?;
            opened(Door::MachineJobs, format!("/api/machines/{id}/jobs"), 0)
        }
        _ => Err(Refused::NotADoor),
    }
}

/// Every field a send may have. A closed set: any other name is not a send.
pub const SIGNED_FIELDS: [&str; 5] = ["cmd", "csig", "grant", "confirm", "match"];

/// Is this a signed command as the signer writes one (`sp-identity` `Signer::sign`)?
/// `{ cmd, csig, grant }` under the day's grant, or `{ cmd, confirm }` with a fresh
/// confirmation (and then, for a `key.add`, the `match` number the person compared);
/// `cmd` is the command, as the JSON text that was signed. Nothing else is
/// a send: not spacesheep's own unsigned form for its cloud boxes
/// (`{ action, session, text }`), not a command with nothing signing it, not either of
/// them with a field more.
fn is_signed_command(o: &serde_json::Map<String, serde_json::Value>) -> bool {
    use serde_json::Value;
    if !o.keys().all(|k| SIGNED_FIELDS.contains(&k.as_str())) {
        return false;
    }
    let cmd = o
        .get("cmd")
        .and_then(Value::as_str)
        .is_some_and(|c| matches!(serde_json::from_str(c), Ok(Value::Object(_))));
    let given = |k: &str| o.get(k).filter(|v| !v.is_null());
    let text = |k: &str| given(k).is_none_or(|v| v.as_str().is_some_and(|s| !s.is_empty()));
    let object = |k: &str| given(k).is_none_or(Value::is_object);
    let by_grant = given("csig").is_some() && given("grant").is_some();
    let by_confirm = given("confirm").is_some();
    // The number the person matched, beside a confirmed `key.add` (spacesheep reads it
    // there and nowhere else): one to eight digits, as text or as a number.
    let matched = given("match").is_none_or(|v| {
        by_confirm
            && match v {
                Value::String(s) => {
                    (1..=8).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit())
                }
                Value::Number(n) => n.as_u64().is_some_and(|n| n < 100_000_000),
                _ => false,
            }
    });
    cmd && text("csig")
        && object("grant")
        && object("confirm")
        && matched
        && (by_grant || by_confirm)
}

/// The body a door takes: none for a GET; for a send, a signed command within the limit.
pub fn check_body(door: Door, body: &[u8]) -> Result<(), Refused> {
    let max = door.max_request();
    if max == 0 {
        return if body.is_empty() {
            Ok(())
        } else {
            Err(Refused::BadBody)
        };
    }
    if body.len() > max {
        return Err(Refused::TooLarge);
    }
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(serde_json::Value::Object(o)) => {
            if door == Door::MachineJobs && !is_signed_command(&o) {
                return Err(Refused::NotSigned);
            }
            Ok(())
        }
        _ => Err(Refused::BadBody),
    }
}

/// Why this is not a device key the Hub would ask spacesheep to trust, or None. The key
/// comes from the signer, not the page; this is spacesheep's own `deviceKeyProblem`, so
/// a signer that changed is caught here and not by a refusal the person reads.
pub fn device_key_problem(key: &serde_json::Value) -> Option<&'static str> {
    let Some(o) = key.as_object() else {
        return Some("not a key");
    };
    let s = |k: &str| o.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let word = |k: &str| {
        let v = s(k);
        (1..=32).contains(&v.len())
            && v.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    };
    if !o
        .keys()
        .all(|k| matches!(k.as_str(), "id" | "alg" | "spki" | "type" | "store" | "uv"))
    {
        return Some("a field a device key does not have");
    }
    if s("type") != "device" || o.get("alg").and_then(|v| v.as_i64()) != Some(-7) {
        return Some("not a P-256 device key");
    }
    if !is_b64url(s("spki"), 100, 200) || !is_key_id(s("id")) {
        return Some("no spki or id");
    }
    if !word("store") || !word("uv") {
        return Some("no store or uv");
    }
    None
}

/// A key or a poll token as a header may carry it: visible ASCII, no space, a sane length.
pub fn is_token(s: &str) -> bool {
    (8..=512).contains(&s.len()) && s.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

/// An email as the origin gave it, when it is one the person can be shown and an id can
/// be made of: printable ASCII and nothing else (no space, no control, no character that
/// reorders or hides its neighbours when drawn), exactly one `@`, at most 64 characters
/// before it and 190 after. (Several `@` let a sentence pose as an address:
/// `misha@example.com.on.spacesheep.dev.Tap.Use.it@evil.example`.) An address outside
/// that is refused whole, never trimmed into another one.
pub fn clean_email(s: &str) -> Option<String> {
    let (local, domain) = s.split_once('@')?;
    let ok = s.bytes().all(|c| (0x21..=0x7e).contains(&c))
        && !domain.contains('@')
        && (1..=64).contains(&local.len())
        && (1..=190).contains(&domain.len());
    ok.then(|| s.to_string())
}

/// An email as an alert shows it: whole up to sixty characters, else its first 29 and
/// last 30 around an ellipsis, so its beginning and its domain's end are both read and
/// the line it is on stays one line.
pub fn shown_email(email: &str) -> String {
    let n = email.chars().count();
    if n <= 60 {
        return email.to_string();
    }
    let head: String = email.chars().take(29).collect();
    let tail: String = email.chars().skip(n - 30).collect();
    format!("{head}…{tail}")
}

/// What the key store keeps for an account: the key, and the origin it is for. An entry
/// of the list that says another origin does not get it, whatever its id.
pub fn kept_key(origin: &str, key: &str) -> String {
    serde_json::json!({ "origin": origin, "key": key }).to_string()
}

/// The key out of what `kept_key` wrote, when it is for `origin`.
pub fn read_kept_key(kept: &str, origin: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(kept).ok()?;
    if v.get("origin")?.as_str()? != origin {
        return None;
    }
    let key = v.get("key")?.as_str()?;
    is_token(key).then(|| key.to_string())
}

/// spacesheep's answer to `POST /api/gui/connect`, believed.
#[derive(Clone, PartialEq, Eq)]
pub struct ConnectAnswer {
    pub code: String,
    pub digits: String,
    pub url: String,
    pub poll_token: String,
    /// Epoch milliseconds.
    pub expires_at_ms: u64,
}

/// How long a connect may stay open whatever the answer says, and its shortest.
pub const CONNECT_MAX_MS: u64 = 15 * 60_000;
const CONNECT_DEFAULT_MS: u64 = 10 * 60_000;
/// Once approved, spacesheep keeps the key for the poll this long (`GUI_CONNECT_KEY_TTL_S`):
/// the poll goes on that much past the code's expiry, so an approval in its last second
/// is still collected.
pub const CONNECT_COLLECT_MS: u64 = 125_000;

/// Reads the connect answer. The link the person is sent to must be on the account's own
/// origin (`link_on_origin`): the Hub opens no link to anywhere else, whatever the
/// answer says.
pub fn parse_connect_answer(
    body: &[u8],
    origin: &str,
    now_ms: u64,
) -> Result<ConnectAnswer, &'static str> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| "not JSON")?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let (code, digits, url, token) = (s("code"), s("digits"), s("url"), s("poll_token"));
    if !is_b64url(code, 16, 64) {
        return Err("no code");
    }
    if !(4..=8).contains(&digits.len()) || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err("no digits");
    }
    if !is_b64url(token, 16, 256) {
        return Err("no poll token");
    }
    let url = link_on_origin(url, origin).ok_or("the link is not on the account's origin")?;
    let expires = crate::status::parse_iso_ms(s("expires_at"))
        .unwrap_or(now_ms + CONNECT_DEFAULT_MS)
        .clamp(now_ms + 30_000, now_ms + CONNECT_MAX_MS);
    Ok(ConnectAnswer {
        code: code.into(),
        digits: digits.into(),
        url,
        poll_token: token.into(),
        expires_at_ms: expires,
    })
}

/// What one poll said.
#[derive(Clone, PartialEq, Eq)]
pub enum PollAnswer {
    Pending,
    Approved {
        key: String,
        email: String,
    },
    Denied,
    Expired,
    /// Ask again later (a 429 with its wait in seconds, a 5xx).
    Retry {
        after_s: Option<u64>,
    },
    /// An answer this version cannot read.
    Unreadable,
}

/// Reads `GET /api/gui/connect/poll`: 204 pending; 200 `{ state: "approved", key, email }`;
/// 410 `{ state: "denied" | "expired" }`; 401 when the poll token is not this code's.
pub fn parse_poll(status: u16, body: &[u8], retry_after_s: Option<u64>) -> PollAnswer {
    let v: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("");
    match status {
        204 => PollAnswer::Pending,
        200 => {
            let key = v.get("key").and_then(|s| s.as_str()).unwrap_or("");
            let email = v
                .get("email")
                .and_then(|s| s.as_str())
                .and_then(clean_email);
            match (state, is_token(key), email) {
                ("approved", true, Some(email)) => PollAnswer::Approved {
                    key: key.into(),
                    email,
                },
                _ => PollAnswer::Unreadable,
            }
        }
        401 | 404 | 410 => {
            if state == "denied" {
                PollAnswer::Denied
            } else {
                PollAnswer::Expired
            }
        }
        429 => PollAnswer::Retry {
            after_s: retry_after_s,
        },
        s if s >= 500 => PollAnswer::Retry { after_s: None },
        _ => PollAnswer::Unreadable,
    }
}

/// Does a 401 on this door mean the key is dead? On the jobs door spacesheep also answers
/// 401 for a grant that needs unlocking (`code: "unlock"`), which is the signer's matter
/// and not the key's; only its `code: "unauthorized"` is. On the other doors a 401 is
/// always the key.
pub fn key_refused(door: Door, status: u16, body: &[u8]) -> bool {
    if status != 401 {
        return false;
    }
    if door != Door::MachineJobs {
        return true;
    }
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string))
        .as_deref()
        == Some("unauthorized")
}

/// The rp id in the machines door's answer, when it is a well-formed one (a DNS name in
/// lower case). The signer still checks it against the account's origin before signing.
pub fn rp_id_in(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let rp = v.get("rp_id")?.as_str()?;
    let ok = !rp.is_empty()
        && rp.len() <= 253
        && !rp.starts_with('.')
        && !rp.ends_with('.')
        && rp
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.');
    ok.then(|| rp.to_string())
}

/// Is `needle` anywhere in `hay`? (The key in an answer.)
pub fn holds(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && hay.len() >= needle.len()
        && hay.windows(needle.len()).any(|w| w == needle)
}

/// One line of printable ASCII out of something spacesheep said, for the person to read.
pub fn plain_words(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| c.is_ascii() && !c.is_ascii_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Why a command said no: `code` is stable, `message` is for the person. Never a key, a
/// token or a URL with either.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: &'static str,
    pub message: String,
    /// Seconds to wait (`rate_limited`, `too_many_starts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_s: Option<u64>,
    /// spacesheep's own code for its refusal, when it gave one (`pro_required`,
    /// `talk_off`…): lowercase letters and underscores only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

impl Problem {
    pub fn new(code: &'static str, message: impl Into<String>) -> Problem {
        Problem {
            code,
            message: message.into(),
            retry_after_s: None,
            upstream: None,
        }
    }
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Problem {}

/// A connect's `error` as the page reads it: the code, as text.
fn problem_code<S: serde::Serializer>(p: &Option<Problem>, s: S) -> Result<S::Ok, S::Error> {
    match p {
        Some(p) => s.serialize_str(p.code),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectState {
    Pending,
    Approved,
    /// The person said no on spacesheep.
    Denied,
    Expired,
    /// Approved on spacesheep, and the key is held here until the person answers whose
    /// account this is (the question is asked again whenever the app comes to the front).
    Asking,
    /// The person said no here, when asked whether to use the account that was approved.
    Declined,
    /// With `ConnectView::error`. (A connect the page cancelled is simply gone.)
    Failed,
}

/// A connect as the page sees it: the digits to show beside spacesheep's, and how it
/// stands. Not the link (the Hub opens it itself, `Hub::account_connect_link`): the link
/// holds the code, and whoever holds the code can have any account approve it. Not the
/// poll token, which collects the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectView {
    pub origin: String,
    /// What both sides show ("4821").
    pub digits: String,
    /// RFC 3339, UTC.
    pub expires_at: String,
    pub state: ConnectState,
    /// The account's receiver id, once approved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Why it failed. The page gets the code alone, as text (`"bad_answer"`,
    /// `"conflict"`, `"keystore"`, `"io"`): that is what it reads, and what it chooses
    /// its own words by.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "problem_code"
    )]
    pub error: Option<Problem>,
    /// The Hub's own words for `error`, beside it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Set, with `note`, when spacesheep made a key for this connect and it is not kept
    /// here (declined, a conflict, never answered, not saved): where the person revokes
    /// it, Settings → API keys on the account's own origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoke_url: Option<String>,
    /// `UNUSED_KEY_NOTE`, with `revoke_url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountState {
    /// A key is here and spacesheep has not refused it.
    Ok,
    /// spacesheep answered 401 to the key (revoked there), and nothing has succeeded since.
    Unauthorized,
    /// The entry is here and its key is not (a backup restored on another phone).
    NoKey,
}

impl AccountState {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountState::Ok => "ok",
            AccountState::Unauthorized => "unauthorized",
            AccountState::NoKey => "no_key",
        }
    }
}

/// What a receiver that is an account adds to its row (`ReceiverRef`, the shell contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRef {
    /// Always `"spacesheep"`.
    pub kind: &'static str,
    pub email: String,
    pub state: AccountState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub origin: String,
    pub email: String,
    pub state: AccountState,
    pub connected_at: String,
    pub active: bool,
    /// The id of this device's key, once it was asked to be trusted (`acct_device_ask`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_key_id: Option<String>,
}

/// `acct_status`: everything the page may know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    /// false: this build has no account mode.
    pub enabled: bool,
    pub accounts: Vec<AccountView>,
    /// The connect in progress, or the last one's outcome until the next starts.
    pub connect: Option<ConnectView>,
}

/// `acct_disconnect`: what was done, and what was not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disconnected {
    pub id: String,
    pub origin: String,
    pub email: String,
    /// The key is gone from this device, with the documents kept for the account.
    pub forgotten: bool,
    /// The key still works for anyone who has a copy, until it is revoked on spacesheep.
    pub revoked: bool,
    /// Where it is revoked: Settings → API keys.
    pub revoke_url: String,
    pub note: String,
}

/// `acct_device_ask`: spacesheep took this device's key and waits for the person to
/// approve it on its Devices page, where the same number is shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAsked {
    /// The number to match ("71").
    pub code: String,
    pub key_id: String,
    /// The machines that trust the key already.
    pub trusted_on: Vec<String>,
    /// spacesheep's Devices page, when its link is on the account's own origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub devices_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_https_and_nothing_but_an_origin() {
        let ok = |s: &str| clean_origin(Some(s), false);
        assert_eq!(clean_origin(None, false).as_deref(), Some(DEFAULT_ORIGIN));
        assert_eq!(ok("  ").as_deref(), Some(DEFAULT_ORIGIN));
        assert_eq!(
            ok("https://Spacesheep.dev/").as_deref(),
            Some("https://spacesheep.dev")
        );
        assert_eq!(
            ok("https://stagesheep.dev:8443").as_deref(),
            Some("https://stagesheep.dev:8443")
        );
        for bad in [
            "http://spacesheep.dev",
            "http://localhost:8841",
            "http://127.0.0.1:8841",
            "https://spacesheep.dev@evil.example",
            "https://user:pw@spacesheep.dev",
            "https://spacesheep.dev/path",
            "https://spacesheep.dev/?x=1",
            "https://spacesheep.dev/#f",
            "ftp://spacesheep.dev",
            "javascript:alert(1)",
            "rx://localhost/abc",
            "spacesheep.dev",
            "https://",
        ] {
            assert_eq!(ok(bad), None, "{bad}");
        }
        assert_eq!(ok(&format!("https://{}.dev", "a".repeat(300))), None);
    }

    #[test]
    fn plain_http_is_for_a_local_dev_server_and_only_when_allowed() {
        let dev = |s: &str| clean_origin(Some(s), true);
        assert_eq!(
            dev("http://localhost:8841").as_deref(),
            Some("http://localhost:8841")
        );
        assert_eq!(
            dev("http://127.0.0.1:8841/").as_deref(),
            Some("http://127.0.0.1:8841")
        );
        for bad in [
            "http://spacesheep.dev",
            "http://192.168.1.4:8841",
            "http://localhost.evil.example",
            "http://127.0.0.2:8841",
            "http://[::1]:8841",
            "http://0.0.0.0:8841",
        ] {
            assert_eq!(dev(bad), None, "{bad}");
        }
    }

    fn door(method: &str, path: &str) -> Result<(Door, String), Refused> {
        open_door(method, path).map(|o| (o.door, o.path_and_query))
    }

    #[test]
    fn every_door_and_its_query() {
        let m = "m_0123456789abcdefABCD-_";
        #[rustfmt::skip]
        let table = [
            ("GET", RELAY, Door::Relay, RELAY.to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=120&limit=500&wait=25", Door::Relay, format!("{RELAY}?since=120&limit=500&wait=25")),
            // In any order, rebuilt in one; leading zeros are not the page's to send on.
            ("GET", "/api/sessionpipe/v1/relay?wait=010&since=007", Door::Relay, format!("{RELAY}?since=7&wait=10")),
            ("GET", "/api/sessionpipe/v1/relay?", Door::Relay, RELAY.to_string()),
            ("GET", RELAY_MACHINES, Door::RelayMachines, RELAY_MACHINES.to_string()),
            ("GET", RELAY_JOBS, Door::RelayJobs, RELAY_JOBS.to_string()),
            ("GET", "/api/sessionpipe/v1/relay/jobs?since=41", Door::RelayJobs, format!("{RELAY_JOBS}?since=41")),
            // Where this device's key stands: asked with no id, the Hub adds its own.
            ("GET", DEVICE, Door::DeviceStatus, DEVICE.to_string()),
        ];
        for (method, path, d, sent) in table {
            assert_eq!(door(method, path), Ok((d, sent)), "{method} {path}");
        }
        assert_eq!(
            door("POST", &format!("/api/machines/{m}/jobs")),
            Ok((Door::MachineJobs, format!("/api/machines/{m}/jobs")))
        );
        let o = open_door("GET", "/api/sessionpipe/v1/relay?wait=25").unwrap();
        assert_eq!((o.wait_s, o.timeout_s()), (25, 45));
        assert_eq!(open_door("GET", RELAY_JOBS).unwrap().timeout_s(), 15);
        // The Hub's own: the machines door, the device door with a body it wrote, and the
        // status door about one key.
        assert_eq!(Opened::machines().path_and_query, RELAY_MACHINES);
        let ask = Opened::device_ask();
        assert_eq!(
            (ask.door, ask.path_and_query.as_str()),
            (Door::DeviceAsk, DEVICE)
        );
        let id = "A".repeat(43);
        let status = open_door("GET", DEVICE).unwrap();
        assert_eq!(
            status.clone().about_key(&id).unwrap().path_and_query,
            format!("/api/gui/device?id={id}")
        );
        assert_eq!(status.about_key("short"), None);
        assert_eq!(Opened::machines().about_key(&id), None);
    }

    /// The device door is not the page's: whoever chooses the key that is enrolled can
    /// sign for the person afterwards. And a cloud box takes a message with no signature
    /// at all, so the Hub sends none there.
    #[test]
    fn the_page_cannot_enrol_a_key_or_reach_a_cloud_box() {
        let id = "A".repeat(43);
        #[rustfmt::skip]
        let table = [
            ("POST", "/api/gui/device".to_string()),
            ("POST", "/api/gui/device?id=1".to_string()),
            ("PUT", "/api/gui/device".to_string()),
            ("POST", "/api/machines/m_box0123456789abcdef/jobs".to_string()),
            ("POST", "/api/machines/m_boxffffffffffffffff/jobs".to_string()),
        ];
        for (method, path) in table {
            assert_eq!(
                door(method, &path),
                Err(Refused::NotADoor),
                "{method} {path}"
            );
        }
        // Which key the status is about is not the page's to say.
        for q in [format!("?id={id}"), "?id=short".into(), "?x=1".into()] {
            assert_eq!(
                door("GET", &format!("{DEVICE}{q}")),
                Err(Refused::BadQuery),
                "{q}"
            );
        }
        assert!(is_box_id("m_box0123456789abcdef") && !is_box_id("m_0123456789abcdefABCD"));
        // A box's id is `m_box` and sixteen lowercase hex digits, exactly. A machine's id
        // is random, and one that happens to begin `m_box` is a machine like any other.
        for machine in [
            "m_bo0123456789abcdefAB",
            "m_box0123456789ABCDEF",
            "m_box0123456789abcde",
            "m_box0123456789abcdef0",
            "m_box0123456789abcdeg",
            "m_boxQ7x-_kPz0123456789ab",
        ] {
            assert!(!is_box_id(machine), "{machine}");
            assert!(
                door("POST", &format!("/api/machines/{machine}/jobs")).is_ok(),
                "{machine}"
            );
        }
    }

    #[test]
    fn everything_else_is_not_a_door() {
        let m = "m_0123456789abcdefABCD";
        #[rustfmt::skip]
        let table = [
            // Other paths.
            ("GET", "/"),
            ("GET", "/api/ui/info"),
            ("GET", "/api/ui/stream"),
            ("GET", "/api/machines"),
            ("GET", "/api/keys"),
            ("POST", "/api/keys"),
            ("GET", "/api/sessionpipe/v1/events"),
            ("POST", "/api/sessionpipe/v1/events"),
            ("POST", "/api/machines/files"),
            ("GET", "/api/gui/connect/poll"),
            ("POST", "/api/gui/connect"),
            ("POST", "/api/gui/connect/approve"),
            ("GET", "/settings/api-keys"),
            // Other methods on a door's path.
            ("POST", RELAY),
            ("PUT", RELAY),
            ("DELETE", RELAY),
            ("HEAD", RELAY),
            ("PATCH", RELAY_JOBS),
            ("POST", RELAY_MACHINES),
            ("DELETE", "/api/gui/device"),
            ("PUT", "/api/gui/device"),
            ("get", RELAY),
            // A machine's other routes, and ids that are not ids.
            ("GET", "/api/machines/m_0123456789abcdefABCD/jobs"),
            ("DELETE", "/api/machines/m_0123456789abcdefABCD/jobs"),
            ("POST", "/api/machines/m_0123456789abcdefABCD"),
            ("POST", "/api/machines/m_0123456789abcdefABCD/jobs/1"),
            ("POST", "/api/machines/m_0123456789abcdefABCD/keys"),
            ("POST", "/api/machines/m_short/jobs"),
            ("POST", "/api/machines/x_0123456789abcdefABCD/jobs"),
            ("POST", "/api/machines//jobs"),
            ("POST", "/api/machines/m_0123456789abcdef%2F../jobs"),
            ("POST", "/api/machines/m_0123456789abcdef/../jobs"),
            ("POST", "/api/machines/m_0123456789abcdefABCD?/jobs"),
            // Path tricks.
            ("GET", "/api/sessionpipe/v1/relay/"),
            ("GET", "/api/sessionpipe/v1/relay/../relay"),
            ("GET", "/api/sessionpipe/v1/./relay"),
            ("GET", "/api/ui/../sessionpipe/v1/relay"),
            ("GET", "//api/sessionpipe/v1/relay"),
            ("GET", "/api//sessionpipe/v1/relay"),
            ("GET", "/api/sessionpipe/v1/relay%2Fmachines"),
            ("GET", "/api/sessionpipe/v1/relay%2fjobs"),
            ("GET", "/api%2Fsessionpipe/v1/relay"),
            ("GET", "/api/sessionpipe/v1/%72elay"),
            ("GET", "/API/sessionpipe/v1/relay"),
            ("GET", "/api/sessionpipe/v1/relay;x=1"),
            ("GET", "/api/sessionpipe/v1/relay\\machines"),
            ("GET", "/api/sessionpipe/v1/relay#x"),
            ("GET", "/api/sessionpipe/v1/relay?since=1#x"),
            ("GET", "/https://evil.example/api/sessionpipe/v1/relay"),
            ("GET", "https://evil.example/api/sessionpipe/v1/relay"),
            ("GET", "/@evil.example/api/sessionpipe/v1/relay"),
            ("GET", "@evil.example/api/sessionpipe/v1/relay"),
            ("GET", ""),
        ];
        for (method, path) in table {
            assert_eq!(
                door(method, path),
                Err(Refused::NotADoor),
                "{method} {path}"
            );
        }
        assert!(door("POST", &format!("/api/machines/{m}/jobs")).is_ok());
    }

    #[test]
    fn a_door_takes_only_its_own_parameters() {
        let id = "A".repeat(43);
        #[rustfmt::skip]
        let table = [
            ("GET", "/api/sessionpipe/v1/relay?since=-1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=1e3".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=1&since=2".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=9007199254740992".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=99999999999999999".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?limit=0".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?limit=501".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?wait=26".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?wait=3600".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?token=x".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=1&".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?&since=1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=%31".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?s%69nce=1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=1?wait=2".to_string()),
            ("GET", "/api/sessionpipe/v1/relay/machines?x=1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay/jobs?limit=5".to_string()),
            ("GET", "/api/sessionpipe/v1/relay/jobs?since=a".to_string()),
            ("GET", "/api/gui/device?id=short".to_string()),
            ("GET", format!("/api/gui/device?id={id}&x=1")),
            ("GET", format!("/api/gui/device?id={id}A")),
            ("GET", format!("/api/gui/device?id={}%2F", "A".repeat(40))),
            ("POST", "/api/machines/m_0123456789abcdefABCD/jobs?check_stub=ok".to_string()),
        ];
        for (method, path) in table {
            assert_eq!(
                door(method, &path),
                Err(Refused::BadQuery),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn a_send_is_a_signed_command_and_nothing_else() {
        let cmd = r#"{\"v\":1,\"t\":\"sessionpipe.cmd\",\"machine\":\"m_0123456789abcdefABCD\",\"kind\":\"prompt\"}"#;
        let by_grant = format!(
            r#"{{"cmd":"{cmd}","csig":"c2ln","grant":{{"cred":"k","sig":"s","str":"g"}}}}"#
        );
        let by_confirm = format!(r#"{{"cmd":"{cmd}","confirm":{{"cred":"k","sig":"s"}}}}"#);
        // As the GUI's own server sends one on: the four fields, the unused ones null.
        let with_nulls = format!(
            r#"{{"cmd":"{cmd}","csig":null,"grant":null,"confirm":{{"cred":"k","sig":"s"}}}}"#
        );
        // Beside a confirmed `key.add`: the number the person matched, as spacesheep reads it.
        let signed = r#""confirm":{"cred":"k","sig":"s"}"#;
        let matched = |m: &str| format!(r#"{{"cmd":"{cmd}",{signed},"match":{m}}}"#);
        for ok in [
            by_grant.clone(),
            by_confirm.clone(),
            with_nulls,
            matched("\"71\""),
            matched("71"),
            matched("\"0\""),
            matched("\"12345678\""),
            matched("null"),
        ] {
            assert_eq!(check_body(Door::MachineJobs, ok.as_bytes()), Ok(()), "{ok}");
        }
        for bad in [
            matched("\"\""),
            matched("\"123456789\""),
            matched("\"7a\""),
            matched("\" 71\""),
            matched("-1"),
            matched("7.5"),
            matched("100000000"),
            matched("[71]"),
            matched("true"),
            // With the day's grant there is nothing to match.
            format!(r#"{{"cmd":"{cmd}","csig":"c2ln","grant":{{"cred":"k"}},"match":"71"}}"#),
            format!(r#"{{"cmd":"{cmd}","match":"71"}}"#),
        ] {
            assert_eq!(
                check_body(Door::MachineJobs, bad.as_bytes()),
                Err(Refused::NotSigned),
                "{bad}"
            );
        }
        // The fields are a closed set. Every other name beside a signed command is
        // refused: every one a daemon, spacesheep or a page has for anything, every
        // single letter and digit pair, and each allowed name spelt almost right.
        assert_eq!(SIGNED_FIELDS, ["cmd", "csig", "grant", "confirm", "match"]);
        let mut names: Vec<String> = [
            "action",
            "session",
            "text",
            "check_stub",
            "from",
            "machine",
            "machineId",
            "kind",
            "source",
            "cwd",
            "files",
            "nonce",
            "iat",
            "v",
            "t",
            "for",
            "decision",
            "reply_to",
            "expires_in_s",
            "key",
            "name",
            "proof",
            "by",
            "id",
            "code",
            "token",
            "origin",
            "__proto__",
            "constructor",
            "",
            " ",
            "cmd ",
            " cmd",
            "Cmd",
            "CMD",
            "cmd\u{0}",
            "c\u{6d}d2",
        ]
        .iter()
        .map(|n| n.to_string())
        .collect();
        for allowed in SIGNED_FIELDS {
            names.push(allowed.to_uppercase());
            names.push(format!("{allowed}_"));
            names.push(format!("_{allowed}"));
            names.push(format!("{allowed}s"));
            names.push(allowed[..allowed.len() - 1].to_string());
        }
        for a in b'a'..=b'z' {
            names.push((a as char).to_string());
            for b in *b"amz0_" {
                names.push(format!("{}{}", a as char, b as char));
            }
        }
        names.retain(|n| !SIGNED_FIELDS.contains(&n.as_str()));
        assert!(names.len() > 200);
        for name in &names {
            for form in [&by_grant, &by_confirm] {
                let mut v: serde_json::Value = serde_json::from_str(form).unwrap();
                v[name.as_str()] = serde_json::json!("x");
                assert_eq!(
                    check_body(Door::MachineJobs, v.to_string().as_bytes()),
                    Err(Refused::NotSigned),
                    "{name:?}"
                );
            }
        }
        #[rustfmt::skip]
        let unsigned = [
            // spacesheep's own unsigned form for a cloud box, alone and beside a command.
            r#"{"action":"message","session":"s","text":"rm -rf ~"}"#.to_string(),
            format!(r#"{{"cmd":"{cmd}",{signed},"action":"message","text":"x"}}"#),
            // A command with nothing signing it, or half of what does.
            format!(r#"{{"cmd":"{cmd}"}}"#),
            format!(r#"{{"cmd":"{cmd}","csig":null,"grant":null,"confirm":null}}"#),
            format!(r#"{{"cmd":"{cmd}","csig":"c2ln"}}"#),
            format!(r#"{{"cmd":"{cmd}","grant":{{"cred":"k"}}}}"#),
            format!(r#"{{"cmd":"{cmd}","csig":"","grant":{{"cred":"k"}}}}"#),
            format!(r#"{{"cmd":"{cmd}","csig":7,"grant":{{"cred":"k"}}}}"#),
            format!(r#"{{"cmd":"{cmd}","confirm":"yes"}}"#),
            format!(r#"{{"cmd":"{cmd}","confirm":true}}"#),
            // A field a signed command does not have (the local dev stand-in among them).
            format!(r#"{{"cmd":"{cmd}",{signed},"check_stub":"ok"}}"#),
            format!(r#"{{"cmd":"{cmd}",{signed},"from":"x"}}"#),
            // No command, or one that is not the text of a JSON object.
            format!(r#"{{{signed}}}"#),
            format!(r#"{{"cmd":{{"v":1}},{signed}}}"#),
            format!(r#"{{"cmd":"",{signed}}}"#),
            format!(r#"{{"cmd":"not json",{signed}}}"#),
            format!(r#"{{"cmd":"[1]",{signed}}}"#),
            "{}".to_string(),
        ];
        for bad in &unsigned {
            assert_eq!(
                check_body(Door::MachineJobs, bad.as_bytes()),
                Err(Refused::NotSigned),
                "{bad}"
            );
        }
        assert_eq!(Refused::NotSigned.status(), 400);
        assert_eq!(Refused::NotSigned.code(), "not_signed");
    }

    #[test]
    fn bodies_are_json_objects_within_the_doors_limit() {
        assert_eq!(check_body(Door::Relay, b""), Ok(()));
        assert_eq!(check_body(Door::Relay, b"{}"), Err(Refused::BadBody));
        assert_eq!(check_body(Door::DeviceStatus, b"x"), Err(Refused::BadBody));
        for bad in [&b""[..], b"[]", b"\"x\"", b"1", b"{", b"cmd=1", b"null"] {
            assert_eq!(check_body(Door::MachineJobs, bad), Err(Refused::BadBody));
            assert_eq!(check_body(Door::DeviceAsk, bad), Err(Refused::BadBody));
        }
        let send = |n: usize| {
            let head = r#"{"confirm":{"cred":"k","sig":"s"},"cmd":"{\"text\":\""#;
            let tail = r#"\"}"}"#;
            format!("{head}{}{tail}", "a".repeat(n - head.len() - tail.len())).into_bytes()
        };
        assert_eq!(send(1000).len(), 1000);
        assert_eq!(check_body(Door::MachineJobs, &send(256 * 1024)), Ok(()));
        assert_eq!(
            check_body(Door::MachineJobs, &send(256 * 1024 + 1)),
            Err(Refused::TooLarge)
        );
        // The Hub's own body for the device door is held to a size too.
        let pad = |n: usize| format!(r#"{{"key":"{}"}}"#, "a".repeat(n - 10)).into_bytes();
        assert_eq!(check_body(Door::DeviceAsk, &pad(16 * 1024)), Ok(()));
        assert_eq!(
            check_body(Door::DeviceAsk, &pad(16 * 1024 + 1)),
            Err(Refused::TooLarge)
        );
    }

    #[test]
    fn a_device_key_is_the_signers_shape() {
        let key = |f: &dyn Fn(&mut serde_json::Value)| {
            let mut k = serde_json::json!({
                "id": "A".repeat(43), "alg": -7, "spki": "B".repeat(120),
                "type": "device", "store": "hardware", "uv": "each-use"
            });
            f(&mut k);
            k
        };
        assert_eq!(device_key_problem(&key(&|_| {})), None);
        assert!(device_key_problem(&key(&|k| k["type"] = "passkey".into())).is_some());
        assert!(device_key_problem(&key(&|k| k["alg"] = (-257).into())).is_some());
        assert!(device_key_problem(&key(&|k| k["spki"] = "short".into())).is_some());
        assert!(device_key_problem(&key(&|k| k["id"] = "short".into())).is_some());
        assert!(device_key_problem(&key(&|k| k["store"] = "".into())).is_some());
        assert!(device_key_problem(&key(&|k| k["uv"] = serde_json::Value::Null)).is_some());
        assert!(device_key_problem(&key(&|k| k["name"] = "x".into())).is_some());
        assert!(device_key_problem(&serde_json::json!({})).is_some());
        assert!(device_key_problem(&serde_json::json!("a key")).is_some());
    }

    #[test]
    fn a_kept_key_is_for_one_origin() {
        let (o, k) = ("https://spacesheep.dev", "ss_0123456789abcdef");
        let kept = kept_key(o, k);
        assert_eq!(read_kept_key(&kept, o).as_deref(), Some(k));
        assert_eq!(read_kept_key(&kept, "https://evil.example"), None);
        assert_eq!(read_kept_key(&kept, "https://spacesheep.dev."), None);
        // A bare key (no origin beside it) is for nobody.
        assert_eq!(read_kept_key(k, o), None);
        assert_eq!(read_kept_key(r#"{"key":"ss_0123456789abcdef"}"#, o), None);
        assert_eq!(read_kept_key(&kept_key(o, "has space 1234"), o), None);
    }

    #[test]
    fn a_refusal_says_whose_it_is() {
        let v: serde_json::Value = serde_json::from_slice(&Refused::NotADoor.body()).unwrap();
        assert_eq!(v["hub"], true);
        assert_eq!(v["reason"], "not_a_door");
        assert!(v["error"].as_str().unwrap().ends_with('.'));
        assert_eq!(Refused::NotADoor.status(), 403);
        assert_eq!(Refused::NotConnected.status(), 401);
        assert_eq!(Refused::Busy.status(), 429);
        assert_eq!(Refused::Redirected.status(), 502);
        assert_eq!(Refused::Timeout.status(), 504);
        assert_eq!(Refused::TooLarge.status(), 413);
    }

    const ORIGIN: &str = "https://spacesheep.dev";

    fn answer(url: &str) -> Vec<u8> {
        serde_json::json!({
            "code": "abcdefghijklmnopqrstuvwx", "digits": "4821", "url": url,
            "poll_token": "p".repeat(48), "expires_at": "2026-11-12T08:10:00.000Z",
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn a_connect_answer_is_believed_only_whole_and_on_its_own_origin() {
        // 2026-11-12T08:00:00Z.
        let now = 1_794_470_400_000;
        let a = parse_connect_answer(
            &answer("https://spacesheep.dev/connect/gui?code=abcdefghijklmnopqrstuvwx"),
            ORIGIN,
            now,
        )
        .unwrap();
        assert_eq!(a.digits, "4821");
        assert_eq!(a.expires_at_ms, now + 600_000);
        assert!(a
            .url
            .starts_with("https://spacesheep.dev/connect/gui?code="));
        for bad in [
            "https://evil.example/connect/gui?code=x",
            "https://spacesheep.dev.evil.example/connect/gui",
            "https://spacesheep.dev@evil.example/connect/gui",
            "https://user@spacesheep.dev/connect/gui",
            "http://spacesheep.dev/connect/gui",
            "https://spacesheep.dev:8443/connect/gui",
            "blob:https://spacesheep.dev/9b1c0e0e-0000-4000-8000-000000000000",
            "filesystem:https://spacesheep.dev/temporary/x",
            "javascript:alert(1)",
            "app-settings:",
            "tel:+15550100",
            "/connect/gui?code=x",
            "",
        ] {
            assert!(
                parse_connect_answer(&answer(bad), ORIGIN, now).is_err(),
                "{bad}"
            );
        }
        // A field missing or of another shape.
        for (k, v) in [
            ("code", serde_json::json!("short")),
            ("code", serde_json::json!("has space in it, 24 long")),
            ("digits", serde_json::json!("48 21")),
            ("digits", serde_json::json!(4821)),
            ("poll_token", serde_json::Value::Null),
            ("poll_token", serde_json::json!("tok en with a space 12345")),
        ] {
            let mut j: serde_json::Value =
                serde_json::from_slice(&answer("https://spacesheep.dev/connect/gui")).unwrap();
            j[k] = v;
            assert!(
                parse_connect_answer(j.to_string().as_bytes(), ORIGIN, now).is_err(),
                "{k}"
            );
        }
        assert!(parse_connect_answer(b"<html>", ORIGIN, now).is_err());
        // An expiry far away, long past or unreadable is brought inside the Hub's own limits.
        let with = |exp: &str| {
            let mut j: serde_json::Value =
                serde_json::from_slice(&answer("https://spacesheep.dev/connect/gui")).unwrap();
            j["expires_at"] = serde_json::json!(exp);
            parse_connect_answer(j.to_string().as_bytes(), ORIGIN, now)
                .unwrap()
                .expires_at_ms
        };
        assert_eq!(with("2036-01-01T00:00:00.000Z"), now + CONNECT_MAX_MS);
        assert_eq!(with("2020-01-01T00:00:00.000Z"), now + 30_000);
        assert_eq!(with("soon"), now + 600_000);
    }

    #[test]
    fn a_poll_answer_is_one_of_six() {
        let key = "ss_0123456789abcdef";
        let ok = serde_json::json!({ "state": "approved", "key": key, "email": "a@b.example" })
            .to_string();
        assert!(parse_poll(204, b"", None) == PollAnswer::Pending);
        assert!(
            parse_poll(200, ok.as_bytes(), None)
                == PollAnswer::Approved {
                    key: key.into(),
                    email: "a@b.example".into()
                }
        );
        assert!(parse_poll(410, br#"{"state":"denied"}"#, None) == PollAnswer::Denied);
        assert!(parse_poll(410, br#"{"state":"expired"}"#, None) == PollAnswer::Expired);
        assert!(parse_poll(410, b"", None) == PollAnswer::Expired);
        assert!(parse_poll(401, br#"{"state":"unauthorized"}"#, None) == PollAnswer::Expired);
        assert!(parse_poll(429, b"", Some(7)) == PollAnswer::Retry { after_s: Some(7) });
        assert!(parse_poll(503, b"", None) == PollAnswer::Retry { after_s: None });
        // Approved, but not whole: never half a link.
        for bad in [
            r#"{"state":"approved","email":"a@b.example"}"#,
            r#"{"state":"approved","key":"ss_0123456789abcdef"}"#,
            r#"{"state":"approved","key":"has a space 12345","email":"a@b.example"}"#,
            r#"{"state":"approved","key":"ss_0123456789abcdef","email":"no-at"}"#,
            r#"{"state":"pending","key":"ss_0123456789abcdef","email":"a@b.example"}"#,
            "<html>",
        ] {
            assert!(
                parse_poll(200, bad.as_bytes(), None) == PollAnswer::Unreadable,
                "{bad}"
            );
        }
        assert!(parse_poll(302, b"", None) == PollAnswer::Unreadable);
        assert!(parse_poll(400, b"", None) == PollAnswer::Unreadable);
    }

    #[test]
    fn a_401_is_the_key_except_a_grant_that_needs_unlocking() {
        let unauthorized = br#"{"error":"Unknown or revoked API key.","code":"unauthorized"}"#;
        let unlock = br#"{"error":"Unlock first.","code":"unlock","refusal":"bad_grant"}"#;
        assert!(key_refused(Door::Relay, 401, unauthorized));
        assert!(key_refused(Door::Relay, 401, b""));
        assert!(key_refused(Door::DeviceStatus, 401, b"<html>"));
        assert!(key_refused(Door::MachineJobs, 401, unauthorized));
        assert!(!key_refused(Door::MachineJobs, 401, unlock));
        assert!(!key_refused(Door::MachineJobs, 401, b""));
        // A 403 is Pro or Talk being off, or the key's scope: the key itself is alive.
        assert!(!key_refused(Door::Relay, 403, unauthorized));
        assert!(!key_refused(Door::Relay, 200, unauthorized));
    }

    #[test]
    fn small_readers() {
        assert_eq!(
            rp_id_in(br#"{"machines":[],"rp_id":"spacesheep.dev"}"#).as_deref(),
            Some("spacesheep.dev")
        );
        for bad in [
            &br#"{"rp_id":"Spacesheep.dev"}"#[..],
            br#"{"rp_id":"https://spacesheep.dev"}"#,
            br#"{"rp_id":""}"#,
            br#"{"rp_id":7}"#,
            b"{}",
            b"x",
        ] {
            assert_eq!(rp_id_in(bad), None);
        }
        assert!(holds(b"xx ss_key yy", b"ss_key"));
        assert!(!holds(b"xx ss_ke", b"ss_key"));
        assert!(!holds(b"anything", b""));
        assert!(is_machine_id("m_0123456789abcdef"));
        assert!(!is_machine_id("m_0123456789abcde"));
        assert!(!is_machine_id(&format!("m_{}", "a".repeat(41))));
        assert!(is_token("ss_0123456789"));
        assert!(!is_token("short"));
        assert!(!is_token("has\nnewline12345"));
        assert_eq!(clean_email("A@B.example").as_deref(), Some("A@B.example"));
        // Refused whole, never trimmed into another address; nothing that is not
        // printable ASCII (a space, a newline, a mark that reorders or hides what is
        // drawn beside it, a letter of another alphabet that looks like one of these).
        for bad in [
            " a@b.example",
            "a@b.example ",
            "a@b\n.example",
            "a b@c.example",
            "a@b.example\u{202e}moc.live",
            "a\u{200b}@b.example",
            "\u{2066}a@b.example\u{2069}",
            "\u{430}@b.example",
            "\u{e9}@b.example",
            "@b.example",
            "a@",
            "ab",
            "",
            // One `@`, or a sentence can pose as an address.
            "misha@example.com.on.spacesheep.dev.Tap.Use.it@evil.example",
            "a@b@c.example",
            "a@@b.example",
        ] {
            assert_eq!(clean_email(bad), None, "{bad:?}");
        }
        // Sixty-four before the `@`, a hundred and ninety after.
        let long = |l: usize, d: usize| format!("{}@{}", "a".repeat(l), "d".repeat(d));
        assert!(clean_email(&long(64, 190)).is_some());
        assert_eq!(clean_email(&long(65, 10)), None);
        assert_eq!(clean_email(&long(10, 191)), None);
        // As an alert shows one: whole when short, its two ends when long, one line.
        assert_eq!(shown_email("misha@example.com"), "misha@example.com");
        let shown = shown_email(&long(64, 190));
        assert_eq!(shown.chars().count(), 60);
        assert!(shown.starts_with(&"a".repeat(29)) && shown.ends_with(&"d".repeat(30)));
        assert!(shown.contains('…') && !shown.contains('\n'));
        assert_eq!(shown_email(&long(30, 29)).chars().count(), 60);
        assert_eq!(clean_email(&format!("{}@b.example", "a".repeat(250))), None);
        assert_eq!(
            plain_words("  Too many tries.\u{202e}\n ", 40),
            "Too many tries."
        );
        assert_eq!(host_of("https://spacesheep.dev"), "spacesheep.dev");
        assert_eq!(host_of("http://localhost:8841"), "localhost:8841");
        let o = "https://spacesheep.dev";
        assert_eq!(
            link_on_origin("https://spacesheep.dev/devices", o).as_deref(),
            Some("https://spacesheep.dev/devices")
        );
        assert_eq!(link_on_origin("blob:https://spacesheep.dev/x", o), None);
        assert_eq!(link_on_origin("https://evil.example/devices", o), None);
    }

    #[test]
    fn what_the_page_sees_of_a_connect_has_no_link_and_no_token() {
        let v = serde_json::to_value(ConnectView {
            origin: ORIGIN.into(),
            digits: "4821".into(),
            expires_at: "2026-11-12T08:10:00.000Z".into(),
            state: ConnectState::Pending,
            receiver: None,
            email: None,
            error: None,
            error_message: None,
            revoke_url: None,
            note: None,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "origin": ORIGIN, "digits": "4821",
                "expiresAt": "2026-11-12T08:10:00.000Z", "state": "pending"
            })
        );
        // A connect that failed after spacesheep made a key: the page reads `error` as
        // one of four words and chooses its screen by it, so it is the code, as text.
        let words = "The key could not be kept on this device.";
        let failed = serde_json::to_value(ConnectView {
            origin: ORIGIN.into(),
            digits: "4821".into(),
            expires_at: "2026-11-12T08:10:00.000Z".into(),
            state: ConnectState::Failed,
            receiver: None,
            email: None,
            error: Some(Problem::new("keystore", words)),
            error_message: Some(words.into()),
            revoke_url: Some(format!("{ORIGIN}/settings/api-keys")),
            note: Some(UNUSED_KEY_NOTE),
        })
        .unwrap();
        assert_eq!(
            failed,
            serde_json::json!({
                "origin": ORIGIN, "digits": "4821",
                "expiresAt": "2026-11-12T08:10:00.000Z", "state": "failed",
                "error": "keystore", "errorMessage": words,
                "revokeUrl": format!("{ORIGIN}/settings/api-keys"), "note": UNUSED_KEY_NOTE
            })
        );
        assert_eq!(
            serde_json::to_value(AccountState::NoKey).unwrap(),
            serde_json::json!("no_key")
        );
        assert_eq!(
            serde_json::to_value(ConnectState::Declined).unwrap(),
            serde_json::json!("declined")
        );
        assert_eq!(
            serde_json::to_value(ConnectState::Asking).unwrap(),
            serde_json::json!("asking")
        );
        assert!(UNUSED_KEY_NOTE.contains("Revoke it there: Settings → API keys."));
    }
}
