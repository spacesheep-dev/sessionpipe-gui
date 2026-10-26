//! The Hub: every receiver the app knows, their clients, the page's `rx:` requests and
//! streams, and one long-lived menu-bar stream per receiver feeding needs-you.

use crate::needs::{NeedsYou, NeedsYouItem};
use crate::proxy::{self, Refusal};
use crate::registry::{KeyStore, Receiver, Registry};
use crate::sse::{SseItem, SseParser};
use crate::status::StatusFile;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, Notify};

/// The header the menu-bar stream sends so the receiver leaves it out of the viewers.
pub const SHELL_CLIENT_HEADER: (&str, &str) = ("x-sessionpipe-client", "shell");

/// Read-idle limit for a stream: the receiver pings every 15 s, so 45 s of silence means
/// a half-dead connection (after sleep, a network change).
const IDLE_LIMIT: Duration = Duration::from_secs(45);

/// What the shell, identity and packaging need to know about a receiver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverRef {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub local: bool,
    /// `Info.control.rpId`, once the receiver answered `/api/ui/info`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rp_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HubEvent {
    Connected {
        id: String,
    },
    Disconnected {
        id: String,
        retry_in_ms: u64,
    },
    NeedsYou {
        id: String,
        items: Vec<NeedsYouItem>,
    },
    AttentionClosed {
        id: String,
        attention_id: String,
    },
    /// The receiver list changed (added, removed, renamed from its info).
    Receivers,
}

/// A page-stream frame for the IPC channel: `{ event, data?, retryInMs? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFrame {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_ms: Option<u64>,
}

pub struct HubConfig {
    /// The app's config dir, or SP_SHELL_HOME.
    pub home: PathBuf,
    pub keys: KeyStore,
    /// SP_RECEIVER_URL: the one receiver a dev run uses (its `?k=` is its key).
    pub env_receiver_url: Option<String>,
    /// Origins that may read `rx:` responses (proxy::default_allowed_origins).
    pub allowed_origins: Vec<String>,
    pub status: StatusFile,
    pub user_agent: String,
}

/// 0.5 s doubling to 30 s, ±20 % jitter.
#[derive(Debug, Clone)]
pub struct Backoff {
    next_ms: u64,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub const START_MS: u64 = 500;
    pub const MAX_MS: u64 = 30_000;
    pub fn new() -> Self {
        Backoff {
            next_ms: Self::START_MS,
        }
    }
    pub fn reset(&mut self) {
        self.next_ms = Self::START_MS;
    }
    /// The next delay, with jitter from `rand01` in [0, 1).
    pub fn next_with(&mut self, rand01: f64) -> u64 {
        let base = self.next_ms;
        self.next_ms = (self.next_ms * 2).min(Self::MAX_MS);
        let j = 0.8 + 0.4 * rand01.clamp(0.0, 1.0);
        (base as f64 * j).round() as u64
    }
    /// The next delay, jittered.
    pub fn next_delay(&mut self) -> u64 {
        self.next_with(rand01())
    }
}

fn rand01() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    (h.finish() >> 11) as f64 / (1u64 << 53) as f64
}

#[derive(Default)]
struct TrayCtl {
    paused: AtomicBool,
    stop: AtomicBool,
    kick: Notify,
}

#[derive(Default, Clone)]
struct Info {
    hostname: Option<String>,
    rp_id: Option<String>,
}

struct PageStream {
    owner: String,
    task: tokio::task::AbortHandle,
}

struct Inner {
    cfg: HubConfig,
    registry: Mutex<Registry>,
    /// Receivers not in receivers.json: SP_RECEIVER_URL, the discovered local one.
    transient: Mutex<Vec<Receiver>>,
    /// Keys that live only for this run (SP_RECEIVER_URL's `?k=`).
    transient_keys: Mutex<HashMap<String, String>>,
    clients: Mutex<HashMap<String, reqwest::Client>>,
    default_client: reqwest::Client,
    tx: broadcast::Sender<HubEvent>,
    trays: Mutex<HashMap<String, Arc<TrayCtl>>>,
    needs: Mutex<HashMap<String, Vec<NeedsYouItem>>>,
    connected: Mutex<HashMap<String, bool>>,
    info: Mutex<HashMap<String, Info>>,
    streams: Mutex<HashMap<u64, PageStream>>,
    next_stream: AtomicU64,
    rt: Mutex<Option<tokio::runtime::Handle>>,
}

#[derive(Clone)]
pub struct Hub(Arc<Inner>);

impl Hub {
    pub fn new(cfg: HubConfig) -> Hub {
        crate::ensure_crypto();
        let registry = Registry::load(&cfg.home);
        let default_client = reqwest::Client::builder()
            .user_agent(cfg.user_agent.clone())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("http client");
        let mut transient = Vec::new();
        let mut transient_keys = HashMap::new();
        if let Some(u) = cfg
            .env_receiver_url
            .as_deref()
            .filter(|u| !u.trim().is_empty())
        {
            match Receiver::from_url(u) {
                Some((r, key)) => {
                    if let Some(k) = key {
                        transient_keys.insert(r.id.clone(), k);
                    }
                    transient.push(r);
                }
                None => log::warn!("SP_RECEIVER_URL is not an http(s) URL; ignored"),
            }
        }
        let (tx, _) = broadcast::channel(64);
        Hub(Arc::new(Inner {
            cfg,
            registry: Mutex::new(registry),
            transient: Mutex::new(transient),
            transient_keys: Mutex::new(transient_keys),
            clients: Mutex::new(HashMap::new()),
            default_client,
            tx,
            trays: Mutex::new(HashMap::new()),
            needs: Mutex::new(HashMap::new()),
            connected: Mutex::new(HashMap::new()),
            info: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            next_stream: AtomicU64::new(1),
            rt: Mutex::new(None),
        }))
    }

    /// Starts the menu-bar streams on this runtime.
    pub fn start(&self, rt: tokio::runtime::Handle) {
        *self.0.rt.lock().unwrap() = Some(rt);
        for r in self.all() {
            self.ensure_tray(&r.id);
        }
    }

    pub fn status(&self) -> &StatusFile {
        &self.0.cfg.status
    }

    pub fn home(&self) -> &std::path::Path {
        &self.0.cfg.home
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        self.0.tx.subscribe()
    }

    fn emit(&self, e: HubEvent) {
        let _ = self.0.tx.send(e);
    }

    fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(
        &self,
        f: F,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let rt = self.0.rt.lock().unwrap().clone();
        match rt {
            Some(rt) => Some(rt.spawn(f)),
            None => tokio::runtime::Handle::try_current()
                .ok()
                .map(|h| h.spawn(f)),
        }
    }

    // ---- the receiver list ----

    fn all(&self) -> Vec<Receiver> {
        let mut v: Vec<Receiver> = self.0.transient.lock().unwrap().clone();
        for r in self.0.registry.lock().unwrap().list() {
            if !v.iter().any(|x| x.id == r.id) {
                v.push(r.clone());
            }
        }
        v
    }

    fn find(&self, id: &str) -> Option<Receiver> {
        self.all().into_iter().find(|r| r.id == id)
    }

    fn to_ref(&self, r: &Receiver) -> ReceiverRef {
        let info = self
            .0
            .info
            .lock()
            .unwrap()
            .get(&r.id)
            .cloned()
            .unwrap_or_default();
        ReceiverRef {
            id: r.id.clone(),
            name: info.hostname.unwrap_or_else(|| r.name.clone()),
            origin: r.origin.clone(),
            local: r.local,
            rp_id: info.rp_id,
        }
    }

    pub fn receivers(&self) -> Vec<ReceiverRef> {
        self.all().iter().map(|r| self.to_ref(r)).collect()
    }

    pub fn receiver(&self, id: &str) -> Option<ReceiverRef> {
        self.find(id).map(|r| self.to_ref(&r))
    }

    /// The receiver the window shows: the chosen one, else SP_RECEIVER_URL / the
    /// discovered local one, else the first added.
    pub fn active(&self) -> Option<ReceiverRef> {
        let chosen = self.0.registry.lock().unwrap().active().map(str::to_string);
        if let Some(r) = chosen.and_then(|id| self.find(&id)) {
            return Some(self.to_ref(&r));
        }
        self.all().first().map(|r| self.to_ref(r))
    }

    pub fn set_active(&self, id: &str) -> Result<ReceiverRef, String> {
        let r = self.find(id).ok_or("unknown receiver")?;
        self.0
            .registry
            .lock()
            .unwrap()
            .set_active(Some(id))
            .map_err(|e| e.to_string())?;
        Ok(self.to_ref(&r))
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.0
            .connected
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(false)
    }

    /// Not connected, and at least one attempt failed since the last success (a receiver
    /// still on its first try is not "unreachable" yet).
    pub fn is_unreachable(&self, id: &str) -> bool {
        self.0.connected.lock().unwrap().get(id) == Some(&false)
    }

    pub fn any_connected(&self) -> bool {
        self.0.connected.lock().unwrap().values().any(|c| *c)
    }

    /// The discovered local receiver joins the list for this run (not saved).
    pub fn add_transient(&self, origin: &str) -> Option<ReceiverRef> {
        let (r, _) = Receiver::from_url(origin)?;
        {
            let mut t = self.0.transient.lock().unwrap();
            if !t.iter().any(|x| x.id == r.id) {
                t.push(r.clone());
            }
        }
        self.ensure_tray(&r.id);
        self.emit(HubEvent::Receivers);
        Some(self.to_ref(&r))
    }

    /// Adds a receiver the person confirmed (the caller showed the native sheet).
    /// `key` overrides a `?k=` in the URL; `ca` is the CA's SHA-256 (hex, colons allowed).
    pub async fn add(
        &self,
        url: &str,
        key: Option<&str>,
        ca: Option<&str>,
    ) -> Result<ReceiverRef, String> {
        let (mut r, url_key) =
            Receiver::from_url(url).ok_or("That isn't an http or https address.")?;
        let key = key.map(str::to_string).or(url_key);
        if let Some(ca) = ca {
            let hex = normalise_sha256(ca).ok_or("The certificate fingerprint isn't a SHA-256.")?;
            r.ca_sha256 = Some(hex);
        }
        if let Some(k) = &key {
            self.0
                .cfg
                .keys
                .set(&r.id, k)
                .map_err(|e| format!("Couldn't save the key: {e}"))?;
        }
        self.0
            .registry
            .lock()
            .unwrap()
            .upsert(r.clone())
            .map_err(|e| e.to_string())?;
        self.0.clients.lock().unwrap().remove(&r.id);
        // Learn its name now when it answers; adding never fails because it is asleep.
        let _ = self.fetch_info(&r).await;
        self.ensure_tray(&r.id);
        self.emit(HubEvent::Receivers);
        Ok(self.to_ref(&r))
    }

    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let removed = self
            .0
            .registry
            .lock()
            .unwrap()
            .remove(id)
            .map_err(|e| e.to_string())?;
        self.0.transient.lock().unwrap().retain(|r| r.id != id);
        let _ = self.0.cfg.keys.delete(id);
        if let Some(ctl) = self.0.trays.lock().unwrap().remove(id) {
            ctl.stop.store(true, Ordering::SeqCst);
            ctl.kick.notify_one();
        }
        self.0.needs.lock().unwrap().remove(id);
        self.0.connected.lock().unwrap().remove(id);
        self.0.cfg.status.remove_receiver(id);
        self.emit(HubEvent::NeedsYou {
            id: id.into(),
            items: vec![],
        });
        self.emit(HubEvent::Receivers);
        Ok(removed)
    }

    fn key_for(&self, r: &Receiver) -> Option<String> {
        if r.local {
            return None;
        }
        if let Some(k) = self.0.transient_keys.lock().unwrap().get(&r.id) {
            return Some(k.clone());
        }
        self.0.cfg.keys.get(&r.id)
    }

    /// A URL for a view window on the receiver's own origin, with `?k=` for a remote one.
    pub fn view_url(&self, id: &str, path: &str) -> Result<url::Url, String> {
        let r = self.find(id).ok_or("unknown receiver")?;
        proxy::check_path(path).map_err(|_| "bad path")?;
        let mut u = proxy::upstream_url(&r.origin, path).map_err(|_| "bad path")?;
        if let Some(k) = self.key_for(&r) {
            u.query_pairs_mut().append_pair("k", &k);
        }
        Ok(u)
    }

    // ---- clients ----

    async fn client_for(&self, r: &Receiver) -> Result<reqwest::Client, String> {
        let Some(pin) = r.ca_sha256.clone() else {
            return Ok(self.0.default_client.clone());
        };
        if let Some(c) = self.0.clients.lock().unwrap().get(&r.id) {
            return Ok(c.clone());
        }
        let der = self.pinned_ca(r, &pin).await?;
        let cert = reqwest::Certificate::from_der(&der).map_err(|e| e.to_string())?;
        let c = reqwest::Client::builder()
            .user_agent(self.0.cfg.user_agent.clone())
            .connect_timeout(Duration::from_secs(5))
            .tls_certs_only([cert])
            .build()
            .map_err(|e| e.to_string())?;
        self.0
            .clients
            .lock()
            .unwrap()
            .insert(r.id.clone(), c.clone());
        Ok(c)
    }

    /// The receiver's CA (DER), cached in `<home>/ca/<id>.der`, fetched once from
    /// `/ca.crt` and accepted only when its SHA-256 is the pinned one.
    async fn pinned_ca(&self, r: &Receiver, pin: &str) -> Result<Vec<u8>, String> {
        let path = self.0.cfg.home.join("ca").join(format!("{}.der", r.id));
        if let Ok(der) = std::fs::read(&path) {
            if sha256_hex(&der) == pin {
                return Ok(der);
            }
        }
        // Fetched over an unverified TLS connection: the pin, not the channel, is what
        // makes it trustworthy.
        let c = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = c
            .get(format!("{}/ca.crt", r.origin))
            .timeout(Duration::from_secs(10));
        if let Some(k) = self.key_for(r) {
            req = req.header("cookie", format!("spgui={k}"));
        }
        let body = req
            .send()
            .await
            .map_err(|e| e.to_string())?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;
        let der = pem_to_der(&body).unwrap_or_else(|| body.to_vec());
        if sha256_hex(&der) != pin {
            return Err("The receiver's certificate doesn't match the one in the link.".into());
        }
        let _ = crate::registry::write_atomic(&path, &der);
        Ok(der)
    }

    fn request(
        &self,
        client: &reqwest::Client,
        r: &Receiver,
        method: reqwest::Method,
        url: url::Url,
    ) -> reqwest::RequestBuilder {
        let mut b = client.request(method, url);
        if let Some(k) = self.key_for(r) {
            b = b.header("cookie", format!("spgui={k}"));
        }
        b
    }

    async fn fetch_info(&self, r: &Receiver) -> Result<(), String> {
        let client = self.client_for(r).await?;
        let url = proxy::upstream_url(&r.origin, "/api/ui/info").map_err(|_| "bad origin")?;
        let res = self
            .request(&client, r, reqwest::Method::GET, url)
            .header("accept", "application/json")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if v.get("name").and_then(|n| n.as_str()) != Some("sessionpipe-gui") {
            return Err("not a sessionpipe-gui receiver".into());
        }
        let info = Info {
            hostname: v
                .get("hostname")
                .and_then(|h| h.as_str())
                .filter(|h| !h.is_empty())
                .map(str::to_string),
            rp_id: v
                .pointer("/control/rpId")
                .and_then(|h| h.as_str())
                .map(str::to_string),
        };
        self.0.info.lock().unwrap().insert(r.id.clone(), info);
        Ok(())
    }

    // ---- requests for identity and the shell ----

    pub async fn get(&self, id: &str, path: &str) -> Result<Vec<u8>, String> {
        let (status, body) = self.send(id, reqwest::Method::GET, path, None).await?;
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        Ok(body)
    }

    pub async fn post_json(
        &self,
        id: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), String> {
        self.send(id, reqwest::Method::POST, path, Some(body)).await
    }

    async fn send(
        &self,
        id: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<(u16, Vec<u8>), String> {
        let r = self.find(id).ok_or("unknown receiver")?;
        proxy::check_path(path).map_err(|_| "bad path")?;
        let url = proxy::upstream_url(&r.origin, path).map_err(|_| "bad path")?;
        let client = self.client_for(&r).await?;
        let mut b = self
            .request(&client, &r, method, url)
            .header("accept", "application/json")
            .timeout(Duration::from_secs(proxy::TIMEOUT_SECS));
        if let Some(body) = body {
            b = b.header("content-type", "application/json").body(body);
        }
        let res = b.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        Ok((status, bytes.to_vec()))
    }

    // ---- the rx: protocol ----

    pub fn allowed_origins(&self) -> &[String] {
        &self.0.cfg.allowed_origins
    }

    pub async fn proxy(&self, req: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        let allowed = &self.0.cfg.allowed_origins;
        let origin = req
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let origin = origin.as_deref();
        if proxy::is_preflight(req.method()) {
            return proxy::preflight(origin, allowed);
        }
        let refuse = |r: Refusal, msg: &str| proxy::refusal(r.status(), msg, origin, allowed);
        let (id, path) = match proxy::parse_rx_uri(&req.uri().to_string()) {
            Ok(x) => x,
            Err(r) => return refuse(r, "refused"),
        };
        let Some(rx) = self.find(&id) else {
            return refuse(Refusal::UnknownReceiver, "unknown receiver");
        };
        if req.body().len() > proxy::MAX_BODY {
            return refuse(Refusal::TooLarge, "too large");
        }
        let url = match proxy::upstream_url(&rx.origin, &path) {
            Ok(u) => u,
            Err(r) => return refuse(r, "refused"),
        };
        let client = match self.client_for(&rx).await {
            Ok(c) => c,
            Err(e) => return proxy::refusal(http::StatusCode::BAD_GATEWAY, &e, origin, allowed),
        };
        let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
            .unwrap_or(reqwest::Method::GET);
        let mut b = self
            .request(&client, &rx, method, url)
            .timeout(Duration::from_secs(proxy::TIMEOUT_SECS));
        for h in proxy::FORWARD_REQUEST_HEADERS {
            if let Some(v) = req.headers().get(*h) {
                b = b.header(*h, v.as_bytes());
            }
        }
        let body = req.into_body();
        if !body.is_empty() {
            b = b.body(body);
        }
        let res = match b.send().await {
            Ok(r) => r,
            Err(e) => {
                let status = if e.is_timeout() {
                    http::StatusCode::GATEWAY_TIMEOUT
                } else {
                    http::StatusCode::BAD_GATEWAY
                };
                return proxy::refusal(status, "the receiver didn't answer", origin, allowed);
            }
        };
        if res
            .content_length()
            .is_some_and(|n| n as usize > proxy::MAX_BODY)
        {
            return refuse(Refusal::TooLarge, "too large");
        }
        let mut out = http::Response::builder().status(res.status().as_u16());
        for h in proxy::FORWARD_RESPONSE_HEADERS {
            if let Some(v) = res.headers().get(*h) {
                out = out.header(*h, v.as_bytes());
            }
        }
        let mut body = Vec::new();
        let mut s = res.bytes_stream();
        while let Some(chunk) = s.next().await {
            match chunk {
                Ok(c) => {
                    if body.len() + c.len() > proxy::MAX_BODY {
                        return refuse(Refusal::TooLarge, "too large");
                    }
                    body.extend_from_slice(&c);
                }
                Err(_) => {
                    return proxy::refusal(
                        http::StatusCode::BAD_GATEWAY,
                        "the receiver stopped answering",
                        origin,
                        allowed,
                    )
                }
            }
        }
        proxy::finish(out.body(body).expect("response"), origin, allowed)
    }

    // ---- page streams (IPC channel) ----

    /// Opens an upstream SSE connection for a page and calls `sink` with every frame,
    /// exactly as received, plus `open` and a final `error { retryInMs }`. No retry here:
    /// the page's transport retries. `sink` returns false when the page is gone.
    pub fn open_stream<S>(
        &self,
        receiver: &str,
        path: &str,
        owner: &str,
        sink: S,
    ) -> Result<u64, String>
    where
        S: Fn(StreamFrame) -> bool + Send + Sync + 'static,
    {
        let r = self.find(receiver).ok_or("unknown receiver")?;
        proxy::check_path(path).map_err(|_| "bad path")?;
        let url = proxy::upstream_url(&r.origin, path).map_err(|_| "bad path")?;
        let id = self.0.next_stream.fetch_add(1, Ordering::Relaxed);
        let hub = self.clone();
        let handle = self
            .spawn(async move {
                let retry = hub.page_stream(&r, url, &sink).await;
                sink(StreamFrame {
                    event: "error".into(),
                    data: None,
                    retry_in_ms: Some(retry),
                });
                hub.0.streams.lock().unwrap().remove(&id);
            })
            .ok_or("no runtime")?;
        self.0.streams.lock().unwrap().insert(
            id,
            PageStream {
                owner: owner.into(),
                task: handle.abort_handle(),
            },
        );
        Ok(id)
    }

    async fn page_stream(
        &self,
        r: &Receiver,
        url: url::Url,
        sink: &(dyn Fn(StreamFrame) -> bool + Send + Sync),
    ) -> u64 {
        let mut retry = 1000;
        let Ok(client) = self.client_for(r).await else {
            return retry;
        };
        let res = self
            .request(&client, r, reqwest::Method::GET, url)
            .header("accept", "text/event-stream")
            .send()
            .await;
        let Ok(res) = res else { return retry };
        if !res.status().is_success() {
            return retry;
        }
        if !sink(StreamFrame {
            event: "open".into(),
            data: None,
            retry_in_ms: None,
        }) {
            return retry;
        }
        let mut parser = SseParser::new();
        let mut body = res.bytes_stream();
        loop {
            let chunk = match tokio::time::timeout(IDLE_LIMIT, body.next()).await {
                Ok(Some(Ok(c))) => c,
                _ => return retry,
            };
            for item in parser.push(&chunk) {
                match item {
                    SseItem::Event { event, data, .. } => {
                        if !sink(StreamFrame {
                            event,
                            data: Some(data),
                            retry_in_ms: None,
                        }) {
                            return retry;
                        }
                    }
                    SseItem::Retry(ms) => retry = ms,
                    SseItem::Comment(_) => {}
                }
            }
        }
    }

    pub fn close_stream(&self, id: u64) -> bool {
        match self.0.streams.lock().unwrap().remove(&id) {
            Some(s) => {
                s.task.abort();
                true
            }
            None => false,
        }
    }

    /// Ends every page stream a window opened (the window closed or reloaded).
    pub fn close_streams_of(&self, owner: &str) -> usize {
        let mut m = self.0.streams.lock().unwrap();
        let ids: Vec<u64> = m
            .iter()
            .filter(|(_, s)| s.owner == owner)
            .map(|(k, _)| *k)
            .collect();
        for id in &ids {
            if let Some(s) = m.remove(id) {
                s.task.abort();
            }
        }
        ids.len()
    }

    pub fn open_streams(&self) -> usize {
        self.0.streams.lock().unwrap().len()
    }

    // ---- the menu-bar streams ----

    /// Every receiver's needs-you items, longest waiting first.
    pub fn needs_you(&self) -> Vec<NeedsYouItem> {
        let mut v: Vec<NeedsYouItem> = self
            .0
            .needs
            .lock()
            .unwrap()
            .values()
            .flatten()
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            a.state_since
                .cmp(&b.state_since)
                .then_with(|| a.session.cmp(&b.session))
        });
        v
    }

    pub fn reconnect_all(&self) {
        for ctl in self.0.trays.lock().unwrap().values() {
            ctl.paused.store(false, Ordering::SeqCst);
            ctl.kick.notify_one();
        }
    }

    pub fn pause_all(&self) {
        for ctl in self.0.trays.lock().unwrap().values() {
            ctl.paused.store(true, Ordering::SeqCst);
            ctl.kick.notify_one();
        }
    }

    fn ensure_tray(&self, id: &str) {
        if self.0.rt.lock().unwrap().is_none() {
            return;
        }
        let ctl = {
            let mut t = self.0.trays.lock().unwrap();
            if t.contains_key(id) {
                return;
            }
            let ctl = Arc::new(TrayCtl::default());
            t.insert(id.into(), ctl.clone());
            ctl
        };
        let hub = self.clone();
        let id = id.to_string();
        self.spawn(async move { hub.tray_loop(id, ctl).await });
    }

    fn set_connected(&self, id: &str, on: bool) {
        let changed = self.0.connected.lock().unwrap().insert(id.into(), on) != Some(on);
        self.0.cfg.status.set_receiver(id, on);
        if changed && on {
            self.emit(HubEvent::Connected { id: id.into() });
        }
    }

    async fn tray_loop(self, id: String, ctl: Arc<TrayCtl>) {
        let mut backoff = Backoff::new();
        let mut needs = NeedsYou::new(&id);
        loop {
            if ctl.stop.load(Ordering::SeqCst) {
                return;
            }
            if ctl.paused.load(Ordering::SeqCst) {
                ctl.kick.notified().await;
                continue;
            }
            let Some(r) = self.find(&id) else { return };
            let kicked = tokio::select! {
                _ = self.tray_once(&r, &mut needs, &mut backoff) => false,
                _ = ctl.kick.notified() => true,
            };
            needs.reset();
            let was = self.is_connected(&id);
            self.set_connected(&id, false);
            if ctl.stop.load(Ordering::SeqCst) {
                return;
            }
            if ctl.paused.load(Ordering::SeqCst) {
                self.emit(HubEvent::Disconnected {
                    id: id.clone(),
                    retry_in_ms: 0,
                });
                continue;
            }
            let delay = if kicked { 0 } else { backoff.next_delay() };
            if was || !kicked {
                self.emit(HubEvent::Disconnected {
                    id: id.clone(),
                    retry_in_ms: delay,
                });
            }
            if delay > 0 {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                    _ = ctl.kick.notified() => {}
                }
            }
        }
    }

    async fn tray_once(&self, r: &Receiver, needs: &mut NeedsYou, backoff: &mut Backoff) {
        let Ok(client) = self.client_for(r).await else {
            return;
        };
        // The lock is let go before the fetch: it is never held across an await.
        let known = self.0.info.lock().unwrap().contains_key(&r.id);
        if !known && self.fetch_info(r).await.is_ok() {
            self.emit(HubEvent::Receivers);
        }
        let Ok(url) = proxy::upstream_url(&r.origin, "/api/ui/stream") else {
            return;
        };
        let res = self
            .request(&client, r, reqwest::Method::GET, url)
            .header("accept", "text/event-stream")
            .header(SHELL_CLIENT_HEADER.0, SHELL_CLIENT_HEADER.1)
            .send()
            .await;
        let Ok(res) = res else { return };
        if !res.status().is_success() {
            log::info!("tray stream {}: HTTP {}", r.id, res.status());
            return;
        }
        let mut parser = SseParser::new();
        let mut body = res.bytes_stream();
        let mut first = true;
        loop {
            let chunk = match tokio::time::timeout(IDLE_LIMIT, body.next()).await {
                Ok(Some(Ok(c))) => c,
                _ => return,
            };
            for item in parser.push(&chunk) {
                self.0.cfg.status.frame(&r.id);
                let SseItem::Event { data, .. } = item else {
                    continue;
                };
                if first {
                    first = false;
                    backoff.reset();
                    self.set_connected(&r.id, true);
                }
                let change = needs.apply_json(&data);
                for a in change.closed {
                    self.emit(HubEvent::AttentionClosed {
                        id: r.id.clone(),
                        attention_id: a,
                    });
                }
                if change.items_changed {
                    let items = needs.items();
                    self.0.cfg.status.set_needs_you(&r.id, items.len());
                    self.0
                        .needs
                        .lock()
                        .unwrap()
                        .insert(r.id.clone(), items.clone());
                    self.emit(HubEvent::NeedsYou {
                        id: r.id.clone(),
                        items,
                    });
                }
            }
        }
    }
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// `AB:CD:…` or `abcd…` → 64 lowercase hex characters.
pub fn normalise_sha256(s: &str) -> Option<String> {
    let h: String = s
        .chars()
        .filter(|c| *c != ':')
        .collect::<String>()
        .to_ascii_lowercase();
    (h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).then_some(h)
}

/// The first certificate of a PEM file, as DER.
fn pem_to_der(pem: &[u8]) -> Option<Vec<u8>> {
    let s = std::str::from_utf8(pem).ok()?;
    let start = s.find("-----BEGIN CERTIFICATE-----")? + "-----BEGIN CERTIFICATE-----".len();
    let end = s[start..].find("-----END CERTIFICATE-----")? + start;
    base64_decode(&s[start..end])
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return None,
        };
        buf = (buf << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{serve, TempDir};

    fn hub(home: &std::path::Path, env: Option<String>) -> Hub {
        Hub::new(HubConfig {
            home: home.to_path_buf(),
            keys: KeyStore::memory(),
            env_receiver_url: env,
            allowed_origins: proxy::default_allowed_origins(None),
            status: StatusFile::new(None, "test"),
            user_agent: "sp-test".into(),
        })
    }

    #[test]
    fn backoff_doubles_to_thirty_seconds_with_jitter() {
        let mut b = Backoff::new();
        let mid: Vec<u64> = (0..9).map(|_| b.next_with(0.5)).collect();
        assert_eq!(
            mid,
            vec![500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
        );
        let mut b = Backoff::new();
        assert_eq!(b.next_with(0.0), 400);
        assert_eq!(b.next_with(1.0), 1200);
        b.reset();
        for _ in 0..100 {
            let mut c = b.clone();
            let d = c.next_delay();
            assert!((400..=600).contains(&d), "{d}");
        }
    }

    #[test]
    fn sha_and_pem_helpers() {
        assert_eq!(
            normalise_sha256(&format!("{}AB", "AB:".repeat(31))),
            Some("ab".repeat(32))
        );
        assert_eq!(normalise_sha256("xyz"), None);
        assert_eq!(base64_decode("Zm9vYmFy").unwrap(), b"foobar");
        let pem = b"-----BEGIN CERTIFICATE-----\nZm9v\nYmFy\n-----END CERTIFICATE-----\n";
        assert_eq!(pem_to_der(pem).unwrap(), b"foobar");
    }

    async fn proxied(
        h: &Hub,
        method: &str,
        uri: &str,
        origin: Option<&str>,
        body: Vec<u8>,
    ) -> http::Response<Vec<u8>> {
        let mut b = http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header(
                "user-agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
            );
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        h.proxy(b.body(body).unwrap()).await
    }

    #[tokio::test]
    async fn proxy_forwards_and_adds_the_cookie_only_for_remote() {
        let t = TempDir::new("hub-proxy");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let port = serve(
            |s| {
                (
                    201,
                    "application/json",
                    format!("{{\"len\":{}}}", s.body.len()).into_bytes(),
                )
            },
            Some(tx),
        )
        .await;

        // Loopback (SP_RECEIVER_URL form): no cookie even with a key in the URL.
        let h = hub(t.path(), Some(format!("http://127.0.0.1:{port}/?k=secret")));
        let id = h.active().unwrap().id;
        let res = proxied(
            &h,
            "POST",
            &format!("rx://localhost/{id}/api/x?y=1"),
            Some("tauri://localhost"),
            b"{}".to_vec(),
        )
        .await;
        assert_eq!(res.status(), 201);
        assert_eq!(res.headers()["content-type"], "application/json");
        assert_eq!(
            res.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
        assert!(
            res.headers().get("x-secret").is_none(),
            "only the listed headers pass"
        );
        assert_eq!(res.body(), b"{\"len\":2}");
        let seen = rx.recv().await.unwrap();
        assert!(
            seen.head.starts_with("POST /api/x?y=1 HTTP/1.1"),
            "{}",
            seen.head
        );
        assert!(
            !seen.head.to_ascii_lowercase().contains("cookie"),
            "{}",
            seen.head
        );
        assert!(
            !seen.head.to_ascii_lowercase().contains("origin:"),
            "{}",
            seen.head
        );
        assert!(
            seen.head.contains("(Macintosh;"),
            "the webview's user-agent passes: {}",
            seen.head
        );

        // A "remote" receiver: the same server reached as localhost.localdomain is not
        // possible without DNS, so mark a registry entry remote by hand.
        let mut reg = Registry::load(t.path());
        let (mut r, _) = Receiver::from_url(&format!("http://127.0.0.1:{port}")).unwrap();
        r.local = false;
        r.id = "remote1234".into();
        reg.upsert(r).unwrap();
        let h2 = hub(t.path(), None);
        h2.0.cfg.keys.set("remote1234", "uikey").unwrap();
        let res = proxied(
            &h2,
            "GET",
            "rx://localhost/remote1234/api/ui/info",
            Some("https://evil.com"),
            vec![],
        )
        .await;
        assert_eq!(res.status(), 201);
        assert!(res.headers().get("access-control-allow-origin").is_none());
        let seen = rx.recv().await.unwrap();
        assert!(
            seen.head
                .to_ascii_lowercase()
                .contains("cookie: spgui=uikey"),
            "{}",
            seen.head
        );

        // Refusals.
        assert_eq!(
            proxied(&h2, "GET", "rx://localhost/nope123456/x", None, vec![])
                .await
                .status(),
            404
        );
        assert_eq!(
            proxied(&h2, "GET", "rx://localhost/remote1234/../x", None, vec![])
                .await
                .status(),
            400
        );
        assert_eq!(
            proxied(
                &h2,
                "GET",
                "rx://localhost/remote1234/http://evil.com/x",
                None,
                vec![]
            )
            .await
            .status(),
            400
        );
        let big = vec![0u8; proxy::MAX_BODY + 1];
        assert_eq!(
            proxied(&h2, "POST", "rx://localhost/remote1234/x", None, big)
                .await
                .status(),
            413
        );
        let pre = proxied(
            &h2,
            "OPTIONS",
            "rx://localhost/remote1234/x",
            Some("tauri://localhost"),
            vec![],
        )
        .await;
        assert_eq!(pre.status(), 204);
        assert_eq!(
            pre.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
    }

    #[tokio::test]
    async fn page_stream_frames_and_final_error() {
        let t = TempDir::new("hub-stream");
        let port = serve(
            |_| (200, "text/event-stream", b"retry: 2500\nevent: snapshot\ndata: {\"a\":1}\n\n: ping\n\nevent: session\ndata: x\ndata: y\n\n".to_vec()),
            None,
        )
        .await;
        let h = hub(t.path(), Some(format!("http://127.0.0.1:{port}")));
        let id = h.active().unwrap().id;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sid = h
            .open_stream(&id, "/api/ui/stream", "main", move |f| tx.send(f).is_ok())
            .unwrap();
        assert!(sid > 0);
        let mut got = vec![];
        while let Some(f) = rx.recv().await {
            let end = f.event == "error";
            got.push(f);
            if end {
                break;
            }
        }
        let ev: Vec<&str> = got.iter().map(|f| f.event.as_str()).collect();
        assert_eq!(ev, vec!["open", "snapshot", "session", "error"]);
        assert_eq!(got[2].data.as_deref(), Some("x\ny"));
        assert_eq!(got[3].retry_in_ms, Some(2500));
        assert!(h.open_stream(&id, "/../x", "main", |_| true).is_err());
        assert!(h.open_stream("unknown", "/x", "main", |_| true).is_err());
    }

    #[tokio::test]
    async fn view_url_carries_the_key_for_remote_only() {
        let t = TempDir::new("hub-view");
        let h = hub(t.path(), Some("http://127.0.0.1:7811/?k=abc".into()));
        let id = h.active().unwrap().id;
        assert_eq!(
            h.view_url(&id, "/t/canvas").unwrap().as_str(),
            "http://127.0.0.1:7811/t/canvas"
        );
        let r = h
            .add("https://studio.example:7373/?k=key1", None, None)
            .await
            .unwrap();
        assert!(!r.local);
        assert_eq!(
            h.view_url(&r.id, "/t/x").unwrap().as_str(),
            "https://studio.example:7373/t/x?k=key1"
        );
        assert!(h.view_url(&r.id, "/../x").is_err());
        assert_eq!(h.receivers().len(), 2);
        assert!(h.remove(&r.id).unwrap());
        assert_eq!(h.receivers().len(), 1);
    }
}
