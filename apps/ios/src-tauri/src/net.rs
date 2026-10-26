//! The phone's network: shell's `sp-receivers` Hub, wired to this app's runtime. The `rx:`
//! scheme answers the page's requests, `rx_stream` carries the live stream over an IPC
//! channel, and the `rx_*` commands manage the receiver list (NATIVE-SPEC §2.1, §2.2,
//! §11.1). Nothing is re-implemented here: every request, stream and list change is the
//! Hub's own.

use crate::contract::{ShellInfo, ShellReceiver};
use serde::Serialize;
use sp_receivers::{proxy, Hub, HubConfig, KeyStore, ReceiverRef, StatusFile, StreamFrame};
use std::path::PathBuf;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State, Webview};

/// The Hub's settings for the phone. Keys live in the app's own container (`keys.json`,
/// 0600) until sp-receivers' keychain covers iOS; `SP_RECEIVER_URL` (a dev launch's
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
        user_agent: format!("sessionpipe-ios/{version}"),
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
    ShellInfo::ios(version, hub.active().as_ref().map(shell_receiver))
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
/// `rx_select` to show it (§11.1).
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
    let shown = sp_receivers::Receiver::from_url(&url)
        .ok_or("That isn't an http or https address.")?
        .0;
    if !crate::confirm::ask(
        &app,
        &crate::confirm::add_receiver(&shown.origin, ca.is_some()),
    )
    .await
    {
        return Err("cancelled".into());
    }
    hub.add(&url, key.as_deref(), ca.as_deref()).await
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
            Some(format!("rx://localhost/{}", r.id).as_str())
        );
        // The UI key never reaches the page.
        assert!(!crate::contract::init_script(&info).contains("abc\""));
        let _ = std::fs::remove_dir_all(dir);
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
    fn the_rx_scheme_only_serves_the_bundled_origin() {
        let o = proxy::default_allowed_origins(None);
        assert!(o.iter().any(|x| x == "tauri://localhost"));
        assert!(!o.iter().any(|x| x.starts_with("http://127.0.0.1")));
    }
}
