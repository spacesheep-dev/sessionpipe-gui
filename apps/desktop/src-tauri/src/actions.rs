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
    if shell.hub.active().is_some_and(|a| a.id == id) {
        return Ok(());
    }
    shell.hub.set_active(id)?;
    if let Some(w) = app.get_webview_window(MAIN) {
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
