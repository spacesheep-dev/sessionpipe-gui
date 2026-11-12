//! A spacesheep account as a kind of receiver (docs/rfcs/08, "The phone on an account"):
//! the pure parts. The Hub (`hub/account.rs`) does the network.
//!
//! The page has no server in this mode: it reads the account's relay itself, through the
//! Hub, which holds the account's API key and adds it. This file is the boundary between
//! the two, as data and pure functions, so every rule is tested without a socket:
//!
//! - the origin an account may live at (`clean_origin`);
//! - the doors: the only requests the Hub forwards, by method and path, with the query
//!   strings rebuilt from checked values (`open_door`). Anything else is refused here,
//!   before any network;
//! - what spacesheep's connect and poll answers must look like to be believed;
//! - the Hub's own answers, told from spacesheep's by a header no upstream can set.
//!
//! The key is never in a URL, a log line, an error or anything a command returns.

use crate::registry::KeyStore;
use serde::Serialize;

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
/// to reach spacesheep and to read a page of events on a slow network (the Hub asks for
/// no compression, so a full page is a few hundred kilobytes).
pub const RELAY_GRACE_S: u64 = 20;
/// Every other door, and connect and its poll.
pub const REQUEST_TIMEOUT_S: u64 = 15;
/// JavaScript's largest exact integer: a relay cursor or a job id is at most this.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Requests to one account in flight at once; one more is answered `busy`. Bounds what the
/// Hub buffers whatever the page does (a reload leaves its long poll behind for a while).
pub const MAX_IN_FLIGHT: usize = 8;

/// How the Hub is told to treat accounts (`HubConfig::account`).
pub struct AccountConfig {
    /// Off: no connect, no door, no document. The desktop app (its server does this job)
    /// and Android until its https verifier is set up.
    pub enabled: bool,
    /// Where account keys live. None: in `HubConfig::keys`, under their own names.
    pub keys: Option<KeyStore>,
    /// `http://localhost` and `http://127.0.0.1` as an account's origin: a debug build
    /// against a local spacesheep, and tests. A release build passes false.
    pub allow_local_http: bool,
    /// What this install calls itself on spacesheep's confirm page and in the key's name
    /// there ("iPhone"). The page cannot choose it.
    pub device: String,
    /// The app's version, for the key's name.
    pub version: String,
}

impl Default for AccountConfig {
    fn default() -> Self {
        AccountConfig {
            enabled: false,
            keys: None,
            allow_local_http: false,
            device: "sessionpipe".into(),
            version: String::new(),
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

/// A door: one request the Hub forwards for an account.
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
    /// `POST /api/gui/device`: this app's device key, asked to be trusted.
    DeviceAsk,
    /// `GET /api/gui/device?id=`: where that key stands.
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

    /// The largest body the page may send. A send is the GUI server's own limit for one
    /// (`SEND_BODY_MAX`); a device key is a few hundred bytes.
    pub fn max_request(self) -> usize {
        match self {
            Door::MachineJobs => 256 * 1024,
            Door::DeviceAsk => 16 * 1024,
            _ => 0,
        }
    }

    /// The largest answer handed to the page. A relay page is 500 events, each up to the
    /// wire's own limit, so it keeps the `rx:` protocol's (the page asks for a smaller
    /// `limit` when a page is refused as too large); the rest are small.
    pub fn max_response(self) -> usize {
        match self {
            Door::Relay => crate::proxy::MAX_BODY,
            _ => 1024 * 1024,
        }
    }
}

/// A request that is a door, as the Hub sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub door: Door,
    /// The path and the query, rebuilt: nothing here is the page's own text except a
    /// machine id and a key id that matched their patterns.
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
}

/// An answer the Hub writes itself, with its status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Not on the list: another path, another method, a path that is not written exactly
    /// as a door is.
    NotADoor,
    /// A door, with a parameter it does not take, a value out of range, or one twice.
    BadQuery,
    /// A body where none is taken, or one that is not a JSON object.
    BadBody,
    /// A request body over the door's limit.
    TooLarge,
    /// The request does not come from the bundled page.
    ForbiddenOrigin,
    /// Accounts are off in this build.
    AccountOff,
    /// The entry is not what it says (its id is not its origin's and email's).
    BadAccount,
    /// There is no key here: never connected on this device, or restored from a backup.
    NotConnected,
    /// Too many requests in flight.
    Busy,
    /// spacesheep could not be reached.
    Unreachable,
    /// It did not answer in the Hub's time.
    Timeout,
    /// It answered with a redirect, which is neither followed nor passed on.
    Redirected,
    /// Its answer is over the door's limit.
    AnswerTooLarge,
    /// Its answer held the key, and is not passed on.
    Withheld,
}

impl Refused {
    pub fn code(self) -> &'static str {
        match self {
            Refused::NotADoor => "not_a_door",
            Refused::BadQuery => "bad_query",
            Refused::BadBody => "bad_body",
            Refused::TooLarge => "too_large",
            Refused::ForbiddenOrigin => "forbidden_origin",
            Refused::AccountOff => "account_off",
            Refused::BadAccount => "bad_account",
            Refused::NotConnected => "not_connected",
            Refused::Busy => "busy",
            Refused::Unreachable => "unreachable",
            Refused::Timeout => "timeout",
            Refused::Redirected => "redirected",
            Refused::AnswerTooLarge => "answer_too_large",
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
            Refused::BadQuery | Refused::BadBody => S::BAD_REQUEST,
            Refused::TooLarge => S::PAYLOAD_TOO_LARGE,
            Refused::NotConnected => S::UNAUTHORIZED,
            Refused::Busy => S::TOO_MANY_REQUESTS,
            Refused::Timeout => S::GATEWAY_TIMEOUT,
            Refused::Unreachable
            | Refused::Redirected
            | Refused::AnswerTooLarge
            | Refused::Withheld => S::BAD_GATEWAY,
        }
    }

    pub fn words(self) -> &'static str {
        match self {
            Refused::NotADoor => "The app does not forward this to a spacesheep account.",
            Refused::BadQuery => "That request has a parameter the app does not forward.",
            Refused::BadBody => "That request's body is not one the app forwards.",
            Refused::TooLarge => "That is too large to send.",
            Refused::ForbiddenOrigin => "Only the app's own page may ask.",
            Refused::AccountOff => "A spacesheep account is not available in this build.",
            Refused::BadAccount => "This account's entry is damaged. Disconnect and connect again.",
            Refused::NotConnected => "This device holds no key for the account. Connect again.",
            Refused::Busy => "Too many requests at once.",
            Refused::Unreachable => "spacesheep could not be reached.",
            Refused::Timeout => "spacesheep did not answer in time.",
            Refused::Redirected => {
                "spacesheep answered with a redirect, which the app does not follow."
            }
            Refused::AnswerTooLarge => "spacesheep's answer is too large. Ask for less at once.",
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

/// Is this request a door? `path_and_query` is what followed the receiver's id in the
/// `rx:` URL, as the page wrote it. A path matches only when it is written exactly as the
/// door is: no `..`, no `//`, no encoded character, no trailing slash, no other case.
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
        ("GET", DEVICE) => {
            let p = pairs(query, &["id"])?;
            let id = p
                .first()
                .map(|(_, v)| *v)
                .filter(|v| is_key_id(v))
                .ok_or(Refused::BadQuery)?;
            opened(Door::DeviceStatus, format!("{DEVICE}?id={id}"), 0)
        }
        ("POST", DEVICE) => {
            pairs(query, &[])?;
            opened(Door::DeviceAsk, DEVICE.into(), 0)
        }
        ("POST", p) => {
            let id = p
                .strip_prefix("/api/machines/")
                .and_then(|r| r.strip_suffix("/jobs"))
                .filter(|id| is_machine_id(id))
                .ok_or(Refused::NotADoor)?;
            pairs(query, &[])?;
            opened(Door::MachineJobs, format!("/api/machines/{id}/jobs"), 0)
        }
        _ => Err(Refused::NotADoor),
    }
}

/// The body a door takes: none for a GET; for a POST a JSON object within the limit.
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
        Ok(serde_json::Value::Object(_)) => Ok(()),
        _ => Err(Refused::BadBody),
    }
}

/// A key or a poll token as a header may carry it: visible ASCII, no space, a sane length.
pub fn is_token(s: &str) -> bool {
    (8..=512).contains(&s.len()) && s.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

/// An email for display: one line, no control characters, an `@` in it.
pub fn clean_email(s: &str) -> Option<String> {
    let e = s.trim();
    (e.len() <= 254 && e.contains('@') && !e.chars().any(|c| c.is_control() || c.is_whitespace()))
        .then(|| e.to_string())
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
/// origin (and so https, or the local dev server): the Hub hands the page no link to
/// anywhere else, whatever the answer says.
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
    let u = (url.len() <= 512)
        .then(|| url::Url::parse(url).ok())
        .flatten()
        .ok_or("no link")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.origin().ascii_serialization() != origin
    {
        return Err("the link is not on the account's origin");
    }
    let expires = crate::status::parse_iso_ms(s("expires_at"))
        .unwrap_or(now_ms + CONNECT_DEFAULT_MS)
        .clamp(now_ms + 30_000, now_ms + CONNECT_MAX_MS);
    Ok(ConnectAnswer {
        code: code.into(),
        digits: digits.into(),
        url: u.into(),
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

/// Why a command said no: `code` is stable, `message` is for the person. Never a key, a
/// token or a URL with either.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: &'static str,
    pub message: String,
    /// Seconds spacesheep asked to wait (`rate_limited`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_s: Option<u64>,
}

impl Problem {
    pub fn new(code: &'static str, message: impl Into<String>) -> Problem {
        Problem {
            code,
            message: message.into(),
            retry_after_s: None,
        }
    }
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Problem {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectState {
    Pending,
    Approved,
    Denied,
    Expired,
    Failed,
    Cancelled,
}

/// A connect as the page sees it. The code is in the link (it is what the person's
/// confirm page is found by); the poll token, which collects the key, is not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectView {
    pub origin: String,
    /// What both sides show ("4821").
    pub digits: String,
    /// The page to open in the system browser.
    pub url: String,
    /// RFC 3339, UTC.
    pub expires_at: String,
    pub state: ConnectState,
    /// The account's receiver id, once approved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Why it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Problem>,
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
        let id = "A".repeat(43);
        for (method, path, d, sent) in [
            ("GET", RELAY, Door::Relay, RELAY.to_string()),
            (
                "GET",
                "/api/sessionpipe/v1/relay?since=120&limit=500&wait=25",
                Door::Relay,
                format!("{RELAY}?since=120&limit=500&wait=25"),
            ),
            // In any order, rebuilt in one; leading zeros are not the page's to send on.
            (
                "GET",
                "/api/sessionpipe/v1/relay?wait=010&since=007",
                Door::Relay,
                format!("{RELAY}?since=7&wait=10"),
            ),
            (
                "GET",
                "/api/sessionpipe/v1/relay?",
                Door::Relay,
                RELAY.to_string(),
            ),
            (
                "GET",
                RELAY_MACHINES,
                Door::RelayMachines,
                RELAY_MACHINES.to_string(),
            ),
            ("GET", RELAY_JOBS, Door::RelayJobs, RELAY_JOBS.to_string()),
            (
                "GET",
                "/api/sessionpipe/v1/relay/jobs?since=41",
                Door::RelayJobs,
                format!("{RELAY_JOBS}?since=41"),
            ),
            ("POST", DEVICE, Door::DeviceAsk, DEVICE.to_string()),
        ] {
            assert_eq!(door(method, path), Ok((d, sent)), "{method} {path}");
        }
        assert_eq!(
            door("POST", &format!("/api/machines/{m}/jobs")),
            Ok((Door::MachineJobs, format!("/api/machines/{m}/jobs")))
        );
        assert_eq!(
            door("GET", &format!("/api/gui/device?id={id}")),
            Ok((Door::DeviceStatus, format!("/api/gui/device?id={id}")))
        );
        let o = open_door("GET", "/api/sessionpipe/v1/relay?wait=25").unwrap();
        assert_eq!((o.wait_s, o.timeout_s()), (25, 45));
        assert_eq!(open_door("GET", RELAY_JOBS).unwrap().timeout_s(), 15);
    }

    #[test]
    fn everything_else_is_not_a_door() {
        let m = "m_0123456789abcdefABCD";
        for (method, path) in [
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
        ] {
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
        for (method, path) in [
            ("GET", "/api/sessionpipe/v1/relay?since=-1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=1e3".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since".to_string()),
            (
                "GET",
                "/api/sessionpipe/v1/relay?since=1&since=2".to_string(),
            ),
            (
                "GET",
                "/api/sessionpipe/v1/relay?since=9007199254740992".to_string(),
            ),
            (
                "GET",
                "/api/sessionpipe/v1/relay?since=99999999999999999".to_string(),
            ),
            ("GET", "/api/sessionpipe/v1/relay?limit=0".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?limit=501".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?wait=26".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?wait=3600".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?token=x".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=1&".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?&since=1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?since=%31".to_string()),
            ("GET", "/api/sessionpipe/v1/relay?s%69nce=1".to_string()),
            (
                "GET",
                "/api/sessionpipe/v1/relay?since=1?wait=2".to_string(),
            ),
            ("GET", "/api/sessionpipe/v1/relay/machines?x=1".to_string()),
            ("GET", "/api/sessionpipe/v1/relay/jobs?limit=5".to_string()),
            ("GET", "/api/sessionpipe/v1/relay/jobs?since=a".to_string()),
            ("GET", "/api/gui/device".to_string()),
            ("GET", "/api/gui/device?id=short".to_string()),
            ("GET", format!("/api/gui/device?id={id}&x=1")),
            ("GET", format!("/api/gui/device?id={id}A")),
            ("GET", format!("/api/gui/device?id={}%2F", "A".repeat(40))),
            ("POST", "/api/gui/device?id=1".to_string()),
            (
                "POST",
                "/api/machines/m_0123456789abcdefABCD/jobs?check_stub=ok".to_string(),
            ),
        ] {
            assert_eq!(
                door(method, &path),
                Err(Refused::BadQuery),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn bodies_are_json_objects_within_the_doors_limit() {
        assert_eq!(check_body(Door::Relay, b""), Ok(()));
        assert_eq!(check_body(Door::Relay, b"{}"), Err(Refused::BadBody));
        assert_eq!(check_body(Door::DeviceStatus, b"x"), Err(Refused::BadBody));
        assert_eq!(check_body(Door::MachineJobs, br#"{"cmd":"{}"}"#), Ok(()));
        for bad in [&b""[..], b"[]", b"\"x\"", b"1", b"{", b"cmd=1", b"null"] {
            assert_eq!(check_body(Door::MachineJobs, bad), Err(Refused::BadBody));
        }
        let pad = |n: usize| format!(r#"{{"cmd":"{}"}}"#, "a".repeat(n - 10)).into_bytes();
        assert_eq!(check_body(Door::MachineJobs, &pad(256 * 1024)), Ok(()));
        assert_eq!(
            check_body(Door::MachineJobs, &pad(256 * 1024 + 1)),
            Err(Refused::TooLarge)
        );
        assert_eq!(check_body(Door::DeviceAsk, &pad(16 * 1024)), Ok(()));
        assert_eq!(
            check_body(Door::DeviceAsk, &pad(16 * 1024 + 1)),
            Err(Refused::TooLarge)
        );
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
        assert_eq!(clean_email(" A@B.example ").as_deref(), Some("A@B.example"));
        assert_eq!(clean_email("a@b\n.example"), None);
    }

    #[test]
    fn what_the_page_sees_of_a_connect_has_no_poll_token() {
        let v = serde_json::to_value(ConnectView {
            origin: ORIGIN.into(),
            digits: "4821".into(),
            url: "https://spacesheep.dev/connect/gui?code=abc".into(),
            expires_at: "2026-11-12T08:10:00.000Z".into(),
            state: ConnectState::Pending,
            receiver: None,
            email: None,
            error: None,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "origin": ORIGIN, "digits": "4821",
                "url": "https://spacesheep.dev/connect/gui?code=abc",
                "expiresAt": "2026-11-12T08:10:00.000Z", "state": "pending"
            })
        );
        assert_eq!(
            serde_json::to_value(AccountState::NoKey).unwrap(),
            serde_json::json!("no_key")
        );
    }
}
