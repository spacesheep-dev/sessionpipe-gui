//! The phone's network: shell's `sp-receivers` Hub, wired to this app's runtime. The `rx:`
//! scheme answers the page's requests, `rx_stream` carries the live stream over an IPC
//! channel, and the `rx_*` commands manage the receiver list (NATIVE-SPEC §2.1, §2.2,
//! §11.1). Nothing is re-implemented here: every request, stream and list change is the
//! Hub's own.

use crate::contract::{Os, ShellInfo, ShellReceiver};
use serde::Serialize;
use sp_receivers::{proxy, Hub, HubConfig, KeyStore, ReceiverRef, StatusFile, StreamFrame};
use std::path::PathBuf;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State, Webview};

/// The Hub's settings for the phone. Keys live in the app's own container (`keys.json`,
/// 0600) until sp-receivers' keychain covers the phones; `SP_RECEIVER_URL` (a dev launch's
/// `SIMCTL_CHILD_SP_RECEIVER_URL`) adds one receiver for the run. A phone has no local
/// receiver to discover.
pub fn config(home: PathBuf, version: &str) -> HubConfig {
    HubConfig {
        keys: KeyStore::File(home.join("keys.json")),
        home,
        env_receiver_url: std::env::var("SP_RECEIVER_URL")
            .ok()
            .filter(|u| !u.trim().is_empty()),
        allowed_origins: proxy::default_allowed_origins(None),
        status: StatusFile::new(None, version),
        user_agent: format!("sessionpipe-{}/{version}", Os::current().name()),
    }
}

/// What the window's shell contract says about a receiver.
pub fn shell_receiver(r: &ReceiverRef) -> ShellReceiver {
    ShellReceiver {
        id: r.id.clone(),
        name: r.name.clone(),
        origin: r.origin.clone(),
        local: r.local,
    }
}

/// The contract for a window showing the Hub's active receiver (or none: the welcome).
pub fn shell_info(hub: &Hub, version: &str) -> ShellInfo {
    ShellInfo::new(
        Os::current(),
        version,
        hub.active().as_ref().map(shell_receiver),
    )
}

/// `rx://localhost/<id>/<path>`: the Hub forwards it (cookie, pinned CA, CORS for the
/// bundled origin only, refusals).
pub fn handle_rx<R: Runtime>(
    app: &AppHandle<R>,
    req: http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let hub = app.state::<Hub>().inner().clone();
    tauri::async_runtime::spawn(async move { responder.respond(hub.proxy(req).await) });
}

/// `http://shell.localhost/contract` (Android, `contract::live_init_script`): the contract
/// for the Hub's active receiver, to the bundled origin only. Anything else is a 404.
pub fn handle_shell<R: Runtime>(
    app: &AppHandle<R>,
    req: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let info = shell_info(&app.state::<Hub>(), &app.package_info().version.to_string());
    shell_response(req, &info)
}

pub(crate) fn shell_response(
    req: &http::Request<Vec<u8>>,
    info: &ShellInfo,
) -> http::Response<Vec<u8>> {
    let origin = Os::current().app_origin();
    let from_app = req
        .headers()
        .get(http::header::ORIGIN)
        .is_some_and(|o| o.as_bytes() == origin.as_bytes());
    if req.method() != http::Method::GET || req.uri().path() != "/contract" || !from_app {
        return http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("static response");
    }
    http::Response::builder()
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(serde_json::to_vec(info).expect("ShellInfo serialises"))
        .expect("static response")
}

/// A link a person scanned or pasted, as `rx_add` takes it (NATIVE-SPEC §11.5). The page
/// hands over the text as it is (`web/src/native/scanner.ts`); the shell finds the
/// receiver and the key in it. The forms:
///
/// - `http://10.0.0.128:7397/?k=<key>`: the code the Connect page shows (plain http,
///   `server/phone/index.ts` `lanPhoneUrl`). The receiver is the origin; `?k=` is the UI
///   key, which the Hub keeps (`keys.json`) and the page never sees.
/// - `https://studio.local:7373/trust?k=<key>`: the same code when the receiver runs TLS.
///   It points at the receiver's trust page (`shared/api.ts` `ROUTES.trust`), where a phone
///   installs the CA; the receiver is the origin and the key is the same. Until that
///   certificate is trusted on this phone the receiver can't be reached, so the page tells
///   this form by its path and offers the link (opened outside the app) before connecting.
/// - `http://192.168.1.4:7373`, `https://studio.tail1234.ts.net`: a pasted address (the
///   page puts `http://` before a bare host first, `logic.ts` `parseAddress`). No key.
///
/// Anything else (`javascript:`, `rx:`, a bare host, no host) is refused with a message
/// the page can show. The path and anything after the key are dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectLink {
    /// The receiver, as the registry writes it (scheme, lowercase host, port).
    pub origin: String,
    /// `?k=`, decoded; none when absent or empty.
    pub key: Option<String>,
}

impl ConnectLink {
    pub fn parse(text: &str) -> Result<ConnectLink, String> {
        let (r, key) =
            sp_receivers::Receiver::from_url(text).ok_or("That isn't an http or https address.")?;
        Ok(ConnectLink {
            origin: r.origin,
            key,
        })
    }
}

/// A row of `rx_list` (§11.1).
#[derive(Debug, Clone, Serialize)]
pub struct ListedReceiver {
    #[serde(flatten)]
    pub receiver: ReceiverRef,
    pub connected: bool,
}

/// Every command here answers the bundled main window only.
pub(crate) fn main_only<R: Runtime>(w: &Webview<R>) -> Result<(), String> {
    if w.label() == "main" {
        Ok(())
    } else {
        Err("forbidden".into())
    }
}

#[tauri::command]
pub fn rx_list<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
) -> Result<Vec<ListedReceiver>, String> {
    main_only(&webview)?;
    Ok(hub
        .receivers()
        .into_iter()
        .map(|r| ListedReceiver {
            connected: hub.is_connected(&r.id),
            receiver: r,
        })
        .collect())
}

/// Adds a receiver after the person confirms it in a native alert. The page then calls
/// `rx_select` to show it (§11.1). `url` is a `ConnectLink`: a scanned code or a pasted
/// address, its `?k=` the key unless `key` is given; `ca` pins the CA's SHA-256.
#[tauri::command]
pub async fn rx_add<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    hub: State<'_, Hub>,
    url: String,
    key: Option<String>,
    ca: Option<String>,
) -> Result<ReceiverRef, String> {
    main_only(&webview)?;
    let link = ConnectLink::parse(&url)?;
    if !crate::confirm::ask(
        &app,
        &crate::confirm::add_receiver(Os::current(), &link.origin, ca.is_some()),
    )
    .await
    {
        return Err("cancelled".into());
    }
    hub.add(&url, key.as_deref().or(link.key.as_deref()), ca.as_deref())
        .await
}

#[tauri::command]
pub fn rx_select<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
) -> Result<ReceiverRef, String> {
    main_only(&webview)?;
    let r = hub.set_active(&id)?;
    crate::reopen(&app);
    Ok(r)
}

#[tauri::command]
pub fn rx_remove<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
) -> Result<bool, String> {
    main_only(&webview)?;
    hub.remove(&id)
}

/// Opens the receiver's SSE stream for the page; frames arrive on `on_frame` exactly as
/// received, plus `open` and a final `error { retryInMs }`.
#[tauri::command]
pub fn rx_stream<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    receiver: String,
    path: String,
    on_frame: Channel<StreamFrame>,
) -> Result<u64, String> {
    main_only(&webview)?;
    hub.open_stream(&receiver, &path, webview.label(), move |f| {
        on_frame.send(f).is_ok()
    })
}

#[tauri::command]
pub fn rx_stream_close<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    stream_id: u64,
) -> Result<bool, String> {
    main_only(&webview)?;
    Ok(hub.close_stream(stream_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub(dir: &std::path::Path) -> Hub {
        Hub::new(HubConfig {
            env_receiver_url: Some("http://127.0.0.1:7823/?k=abc".into()),
            ..config(dir.to_path_buf(), "0.2.0")
        })
    }

    #[test]
    fn a_dev_receiver_url_becomes_the_window_receiver() {
        let dir = std::env::temp_dir().join(format!("sp-ios-net-{}", std::process::id()));
        let info = shell_info(&hub(&dir), "0.2.0");
        let r = info.receiver.clone().expect("receiver");
        assert_eq!(r.origin, "http://127.0.0.1:7823");
        assert!(r.local);
        assert_eq!(r.id.len(), 10);
        assert_eq!(
            info.rx_base.as_deref(),
            Some(Os::current().rx_base(&r.id).as_str())
        );
        // The UI key never reaches the page.
        assert!(!crate::contract::init_script(&info).contains("abc\""));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_scanned_code_names_the_receiver_and_its_key() {
        // The Connect page's code: the LAN address with the UI key.
        assert_eq!(
            ConnectLink::parse("http://10.0.0.128:7397/?k=uik_abc123").unwrap(),
            ConnectLink {
                origin: "http://10.0.0.128:7397".into(),
                key: Some("uik_abc123".into()),
            }
        );
        // TLS on: the code points at the trust page; same receiver, same key. The key
        // arrives percent-encoded (encodeURIComponent) and comes out plain.
        assert_eq!(
            ConnectLink::parse("https://Studio.local:7373/trust?k=uik%2Babc%3D").unwrap(),
            ConnectLink {
                origin: "https://studio.local:7373".into(),
                key: Some("uik+abc=".into()),
            }
        );
        // Pasted: no key, whitespace around it forgiven.
        assert_eq!(
            ConnectLink::parse(" http://192.168.1.4:7373 ").unwrap(),
            ConnectLink {
                origin: "http://192.168.1.4:7373".into(),
                key: None,
            }
        );
        // An empty key is none; a fragment never is the key.
        assert!(ConnectLink::parse("http://192.168.1.4:7373/?k=")
            .unwrap()
            .key
            .is_none());
        assert!(ConnectLink::parse("http://192.168.1.4:7373/#k=x")
            .unwrap()
            .key
            .is_none());
        for bad in [
            "javascript:alert(1)",
            "rx://localhost/abc",
            "studio.local:7373",
            "",
            "tauri://localhost/",
        ] {
            assert_eq!(
                ConnectLink::parse(bad),
                Err("That isn't an http or https address.".into()),
                "{bad}"
            );
        }
    }

    #[test]
    fn no_receiver_means_the_welcome() {
        let dir = std::env::temp_dir().join(format!("sp-ios-net-none-{}", std::process::id()));
        let h = Hub::new(HubConfig {
            env_receiver_url: None,
            ..config(dir.clone(), "0.2.0")
        });
        assert!(shell_info(&h, "0.2.0").receiver.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_contract_goes_to_the_bundled_origin_only() {
        let info = ShellInfo::new(Os::current(), "0.2.0", None);
        let ask = |origin: Option<&str>, path: &str| {
            let mut b = http::Request::builder().uri(format!("http://shell.localhost{path}"));
            if let Some(o) = origin {
                b = b.header("origin", o);
            }
            shell_response(&b.body(Vec::new()).unwrap(), &info)
        };
        let app = Os::current().app_origin();
        let ok = ask(Some(app), "/contract");
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers()["access-control-allow-origin"], app);
        let v: serde_json::Value = serde_json::from_slice(ok.body()).unwrap();
        assert_eq!(v["platform"], Os::current().name());
        assert_eq!(ask(None, "/contract").status(), 404);
        assert_eq!(ask(Some("http://evil.example"), "/contract").status(), 404);
        assert_eq!(ask(Some(app), "/other").status(), 404);
    }

    #[test]
    fn the_rx_scheme_only_serves_the_bundled_origin() {
        let o = proxy::default_allowed_origins(None);
        assert!(o.iter().any(|x| x == Os::Ios.app_origin()));
        assert!(o.iter().any(|x| x == Os::Android.app_origin()));
        assert!(!o.iter().any(|x| x.starts_with("http://127.0.0.1")));
    }
}
