//! What the menu bar, the app menu, deep links, notifications and the shortcut do. One
//! place, so each path behaves the same.

use crate::deeplink::DeepLink;
use crate::window::{self, MAIN};
use crate::Shell;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// An event for the page, held until it has loaded when the window was closed.
#[derive(Debug, Clone)]
pub struct PageEvent {
    pub name: &'static str,
    pub payload: Value,
}

/// The route each go-to action opens, so a closed window opens straight on it.
fn route_of(action: &str) -> Option<&'static str> {
    Some(match action {
        "go-board" => "/",
        "go-inbox" => "/inbox",
        "go-feed" => "/feed",
        "go-review" => "/review",
        "go-machines" => "/machines",
        _ => return None,
    })
}

/// Sends an event to the main window, opening it first if needed (then the event waits
/// for the page to load).
pub fn to_page<R: Runtime>(app: &AppHandle<R>, name: &'static str, payload: Value) {
    match app.get_webview_window(MAIN) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.emit(name, payload);
        }
        None => {
            app.state::<Shell>()
                .pending
                .lock()
                .unwrap()
                .push(PageEvent { name, payload });
            let _ = window::open_main(app, None);
        }
    }
}

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    crate::macos::activate(app, true);
    let _ = window::open_main(app, None);
}

pub fn navigate<R: Runtime>(app: &AppHandle<R>, to: &str) {
    if app.get_webview_window(MAIN).is_none() {
        #[cfg(target_os = "macos")]
        crate::macos::activate(app, true);
        let _ = window::open_main(app, Some(to));
        return;
    }
    to_page(app, "navigate", json!({ "to": to }));
}

/// A menu item's action id (§3.10) for the page.
pub fn menu_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    if app.get_webview_window(MAIN).is_none() {
        if let Some(path) = route_of(action) {
            return navigate(app, path);
        }
    }
    to_page(app, "menu", json!({ "action": action }));
}

/// New session, optionally prefilled (deep link `new`). Never sends.
pub fn new_session<R: Runtime>(app: &AppHandle<R>, prefill: Option<Value>) {
    let mut p = json!({ "action": "new-session" });
    if let Some(pre) = prefill {
        p["prefill"] = pre;
    }
    to_page(app, "menu", p);
}

pub fn open_external(url: &str) {
    let Ok(u) = url::Url::parse(url) else { return };
    if !matches!(u.scheme(), "http" | "https") {
        return;
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("/usr/bin/open")
        .arg(u.as_str())
        .spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", u.as_str()])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open")
        .arg(u.as_str())
        .spawn();
    if let Err(e) = r {
        log::warn!("open {u}: {e}");
    }
}

/// Switches the window to another receiver (reloads it with the new contract).
pub fn select_receiver<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let shown = shell.shown.lock().unwrap().clone();
    if !choose(&shell.hub, shown.as_deref(), id)? {
        return Ok(());
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        log::info!("main window: switching to receiver {id}");
        // The contract is baked into the init script: a fresh window carries the new one.
        let _ = w.destroy();
        // The old window leaves the manager on its Destroyed event; open after that.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            for _ in 0..100 {
                if app.get_webview_window(MAIN).is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let _ = window::open_main(&app, None);
        });
    }
    Ok(())
}

/// Makes `id` the chosen receiver; true when the main window must be built again for it.
///
/// What the window shows is the receiver its contract was built with (`shown`), not the
/// hub's active one: with nothing chosen yet, `active()` falls back to the first receiver
/// known, which is the very one just discovered, started or added while the welcome
/// (built with none) is up. Comparing with that kept the welcome window, whose page had
/// already handed itself over, on its static first frame for good.
pub fn choose(hub: &sp_receivers::Hub, shown: Option<&str>, id: &str) -> Result<bool, String> {
    hub.set_active(id)?;
    Ok(shown != Some(id))
}

/// The machine went to sleep: close the native streams (packaging's power.rs calls this).
pub fn on_sleep<R: Runtime>(app: &AppHandle<R>) {
    let shell = app.state::<Shell>();
    shell.hub.pause_all();
}

/// Woke up: reconnect, and tell the page to resync.
pub fn on_wake<R: Runtime>(app: &AppHandle<R>) {
    let shell = app.state::<Shell>();
    shell.hub.reconnect_all();
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.emit("wake", json!({}));
    }
}

pub fn deep_link<R: Runtime>(app: &AppHandle<R>, link: DeepLink) {
    let shell = app.state::<Shell>();
    let unknown = |rx: &Option<String>| {
        rx.as_deref()
            .is_some_and(|r| shell.hub.receiver(r).is_none())
    };
    match &link {
        DeepLink::Open => show(app),
        DeepLink::Session { rx, .. } | DeepLink::Pair { rx, .. } | DeepLink::New { rx, .. }
            if unknown(rx) =>
        {
            to_page(
                app,
                "navigate",
                json!({ "to": "/", "notice": "That link is for a receiver this app doesn't know." }),
            );
        }
        DeepLink::Session { rx, .. } | DeepLink::Pair { rx, .. } => {
            if let Some(r) = rx {
                let _ = select_receiver(app, r);
            }
            if let Some(p) = crate::deeplink::page_path(&link) {
                navigate(app, &p);
            }
        }
        DeepLink::Page(_) => {
            if let Some(p) = crate::deeplink::page_path(&link) {
                navigate(app, &p);
            }
        }
        DeepLink::New {
            rx,
            machine,
            harness,
            folder,
        } => {
            if let Some(r) = rx {
                let _ = select_receiver(app, r);
            }
            new_session(
                app,
                Some(json!({ "machine": machine, "harness": harness, "folder": folder })),
            );
        }
        DeepLink::Connect { url, key, ca } => {
            confirm_connect(app, url.clone(), key.clone(), ca.clone())
        }
    }
}

/// "Add studio-mac.local? It will be able to show you its sessions." Add / Cancel.
/// Never silent.
pub fn confirm_connect<R: Runtime>(
    app: &AppHandle<R>,
    origin: String,
    key: Option<String>,
    ca: Option<String>,
) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let host = url::Url::parse(&origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or(origin.clone());
    let h = app.clone();
    show(app);
    let mut d = app
        .dialog()
        .message("It will be able to show you its sessions.");
    // A sheet on the window (NSAlert), not a free-floating system alert.
    if let Some(w) = app.get_webview_window(MAIN) {
        d = d.parent(&w);
    }
    d.title(format!("Add {host}?"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Add".into(),
            "Cancel".into(),
        ))
        .show(move |ok| {
            if !ok {
                return;
            }
            let h2 = h.clone();
            tauri::async_runtime::spawn(async move {
                let shell = h2.state::<Shell>();
                match shell.hub.add(&origin, key.as_deref(), ca.as_deref()).await {
                    Ok(r) => {
                        let _ = h2.emit(
                            "receivers",
                            json!({ "list": crate::commands::receiver_list(&shell.hub) }),
                        );
                        log::info!("added receiver {}", r.id);
                    }
                    Err(e) => {
                        to_page(
                            &h2,
                            "navigate",
                            json!({ "to": "/", "notice": format!("Couldn't add {host}: {e}") }),
                        );
                    }
                }
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use sp_receivers::{Hub, HubConfig, KeyStore, StatusFile};

    fn hub(home: &std::path::Path) -> Hub {
        Hub::new(HubConfig {
            home: home.to_path_buf(),
            keys: KeyStore::memory(),
            env_receiver_url: None,
            allowed_origins: vec![],
            status: StatusFile::new(None, "test"),
            user_agent: "sp-test".into(),
        })
    }

    /// The first run on a Mac whose receiver is already running: the window opens with no
    /// receiver (the welcome), the page finds the local one, and selecting it must give the
    /// window a new contract, although the hub already counts it as active.
    #[test]
    fn selecting_the_discovered_receiver_rebuilds_the_welcome_window() {
        let home = std::env::temp_dir().join(format!("sp-choose-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let h = hub(&home);
        let shown = h.active().map(|r| r.id); // what build_main bakes in: none
        assert_eq!(shown, None);
        let found = h.add_transient("http://127.0.0.1:7861").unwrap();
        assert_eq!(
            h.active().map(|r| r.id),
            Some(found.id.clone()),
            "the fallback"
        );
        assert!(choose(&h, shown.as_deref(), &found.id).unwrap());
        // The window built for it shows it: selecting it again leaves the window alone.
        assert!(!choose(&h, Some(&found.id), &found.id).unwrap());
        // "Start sessionpipe" on the welcome adds its receiver the same way.
        let h2 = hub(&home.join("2"));
        let added = h2.add_transient("http://127.0.0.1:7862").unwrap();
        assert!(choose(&h2, None, &added.id).unwrap());
        assert!(
            choose(&h, Some(&found.id), &added.id).is_err(),
            "unknown here"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
