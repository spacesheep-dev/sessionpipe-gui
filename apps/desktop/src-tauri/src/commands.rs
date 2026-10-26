//! The commands the bundled page may call (NATIVE-SPEC.md §11.1). Each needs its
//! `allow-*` permission, which only capabilities/main.json grants, to the main window.

use crate::settings::AppSettings;
use crate::Shell;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sp_receivers::{Hub, StreamFrame};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverOut {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub local: bool,
    pub connected: bool,
    pub active: bool,
}

pub fn receiver_list(hub: &Hub) -> Vec<ReceiverOut> {
    let active = hub.active().map(|a| a.id);
    hub.receivers()
        .into_iter()
        .map(|r| ReceiverOut {
            connected: hub.is_connected(&r.id),
            active: active.as_deref() == Some(r.id.as_str()),
            id: r.id,
            name: r.name,
            origin: r.origin,
            local: r.local,
        })
        .collect()
}

fn out(hub: &Hub, id: &str) -> Option<ReceiverOut> {
    receiver_list(hub).into_iter().find(|r| r.id == id)
}

/// Every command answers only the bundled main window.
fn main_only<R: Runtime>(w: &WebviewWindow<R>) -> Result<(), String> {
    if w.label() != crate::window::MAIN {
        return Err("not allowed here".into());
    }
    Ok(())
}

#[tauri::command]
fn rx_list<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
) -> Result<Vec<ReceiverOut>, String> {
    main_only(&window)?;
    Ok(receiver_list(&shell.hub))
}

/// Adds a receiver after the native confirmation. Resolves when the person answered.
#[tauri::command]
async fn rx_add<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    url: String,
    key: Option<String>,
    ca: Option<String>,
) -> Result<ReceiverOut, String> {
    main_only(&window)?;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let origin =
        sp_receivers::id::canonical_origin(&url).ok_or("That isn't an http or https address.")?;
    let host = url::Url::parse(&origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or(origin.clone());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message("It will be able to show you its sessions.")
        .title(format!("Add {host}?"))
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Add".into(),
            "Cancel".into(),
        ))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    if !rx.await.unwrap_or(false) {
        return Err("cancelled".into());
    }
    let shell = app.state::<Shell>();
    let r = shell.hub.add(&url, key.as_deref(), ca.as_deref()).await?;
    let _ = app.emit("receivers", json!({ "list": receiver_list(&shell.hub) }));
    out(&shell.hub, &r.id).ok_or_else(|| "gone".into())
}

#[tauri::command]
fn rx_remove<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    shell.hub.remove(&id)?;
    let _ = app.emit("receivers", json!({ "list": receiver_list(&shell.hub) }));
    Ok(())
}

#[tauri::command]
fn rx_select<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    crate::actions::select_receiver(&app, &id)
}

#[derive(Serialize)]
struct Discovered {
    local: Option<ReceiverOut>,
}

#[tauri::command]
async fn rx_discover<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<Discovered, String> {
    main_only(&window)?;
    let shell = app.state::<Shell>();
    if let Some(r) = shell.hub.receivers().into_iter().find(|r| r.local) {
        return Ok(Discovered {
            local: out(&shell.hub, &r.id),
        });
    }
    let client = sp_receivers::discovery::Client::new();
    let found = sp_receivers::discovery::find_local_default(&client).await;
    let local = found
        .and_then(|o| shell.hub.add_transient(&o))
        .and_then(|r| out(&shell.hub, &r.id));
    Ok(Discovered { local })
}

#[derive(Clone, Serialize)]
struct Progress {
    step: String,
    message: String,
}

#[tauri::command]
async fn rx_start_local<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    on_progress: Channel<Progress>,
) -> Result<ReceiverOut, String> {
    main_only(&window)?;
    let r = crate::lifecycle::start_local_receiver(|step, message| {
        let _ = on_progress.send(Progress {
            step: step.into(),
            message: message.into(),
        });
    })
    .await
    .map_err(|e| e.to_string())?;
    let shell = app.state::<Shell>();
    shell.hub.add_transient(&r.origin);
    out(&shell.hub, &r.id).ok_or_else(|| "gone".into())
}

#[tauri::command]
fn rx_stream<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
    receiver: String,
    path: String,
    on_frame: Channel<StreamFrame>,
) -> Result<u64, String> {
    main_only(&window)?;
    shell
        .hub
        .open_stream(&receiver, &path, window.label(), move |f| {
            on_frame.send(f).is_ok()
        })
}

#[tauri::command]
fn rx_stream_close<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
    stream_id: u64,
) -> Result<bool, String> {
    main_only(&window)?;
    Ok(shell.hub.close_stream(stream_id))
}

#[tauri::command]
fn app_settings_get<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
) -> Result<AppSettings, String> {
    main_only(&window)?;
    Ok(shell.settings())
}

/// Saves the settings and applies what changed (menu bar, Dock, shortcut, login item).
#[tauri::command]
fn app_settings_set<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    main_only(&window)?;
    apply_settings(&app, settings)
}

pub fn apply_settings<R: Runtime>(
    app: &AppHandle<R>,
    mut next: AppSettings,
) -> Result<AppSettings, String> {
    let shell = app.state::<Shell>();
    let prev = shell.settings();
    // The shortcut goes through its own command (it can fail to register).
    next.hotkey = prev.hotkey.clone();
    next.first_run_done = next.first_run_done || prev.first_run_done;
    if next.launch_at_login != prev.launch_at_login {
        #[cfg(target_os = "macos")]
        crate::macos::login_item::set(next.launch_at_login)?;
    }
    if next.menu_bar != prev.menu_bar {
        if next.menu_bar {
            crate::tray::install(app).map_err(|e| e.to_string())?;
        } else {
            crate::tray::uninstall(app);
        }
    }
    #[cfg(target_os = "macos")]
    if next.menu_bar_only != prev.menu_bar_only {
        let _ = app.set_activation_policy(if next.menu_bar_only {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        });
    }
    *shell.settings.lock().unwrap() = next.clone();
    crate::settings::save(&shell.home, &next).map_err(|e| e.to_string())?;
    crate::tray::refresh(app);
    crate::tray::update_badge(app, false);
    Ok(next)
}

/// Sets (or clears, with null) the New session shortcut. Fails when the system refuses it.
#[tauri::command]
fn app_shortcut_set<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    hotkey: Option<String>,
) -> Result<AppSettings, String> {
    main_only(&window)?;
    let shell = app.state::<Shell>();
    let prev = shell.settings().hotkey;
    if let Some(p) = &prev {
        let _ = crate::hotkey::unregister(&app, p);
    }
    if let Some(h) = &hotkey {
        if let Err(e) = crate::hotkey::register(&app, h) {
            if let Some(p) = &prev {
                let _ = crate::hotkey::register(&app, p);
            }
            return Err(e);
        }
    }
    let mut s = shell.settings.lock().unwrap();
    s.hotkey = hotkey;
    crate::settings::save(&shell.home, &s).map_err(|e| e.to_string())?;
    let s2 = s.clone();
    drop(s);
    crate::tray::refresh(&app);
    Ok(s2)
}

#[tauri::command]
async fn app_notify_status<R: Runtime>(window: WebviewWindow<R>) -> Result<String, String> {
    main_only(&window)?;
    #[cfg(target_os = "macos")]
    return Ok(crate::macos::notify::status().await.to_string());
    #[cfg(not(target_os = "macos"))]
    Ok("denied".into())
}

/// The only place the app asks for notification permission (§3.4: never at launch).
#[tauri::command]
async fn app_notify_request<R: Runtime>(window: WebviewWindow<R>) -> Result<String, String> {
    main_only(&window)?;
    #[cfg(target_os = "macos")]
    return Ok(crate::macos::notify::request().await.to_string());
    #[cfg(not(target_os = "macos"))]
    Ok("denied".into())
}

/// "Open System Settings" when notifications are off for the app.
#[tauri::command]
fn app_notify_open_settings<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        let id = &app.config().identifier;
        let url =
            format!("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={id}");
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
fn app_open_view<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    receiver: String,
    path: String,
) -> Result<(), String> {
    main_only(&window)?;
    crate::window::open_view(&app, &receiver, &path)
}

#[tauri::command]
fn app_open_external<R: Runtime>(window: WebviewWindow<R>, url: String) -> Result<(), String> {
    main_only(&window)?;
    let u = url::Url::parse(&url).map_err(|_| "bad url")?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("only http and https".into());
    }
    crate::actions::open_external(u.as_str());
    Ok(())
}

#[tauri::command]
fn app_update_status<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
) -> Result<crate::updater::UpdateOut, String> {
    main_only(&window)?;
    Ok(shell.update.lock().unwrap().out())
}

#[tauri::command]
fn app_update_check<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<crate::updater::UpdateOut, String> {
    main_only(&window)?;
    crate::updater::check_now(app.clone());
    Ok(app.state::<Shell>().update.lock().unwrap().out())
}

#[tauri::command]
fn app_update_restart<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    main_only(&window)?;
    crate::updater::restart(app);
    Ok(())
}

#[tauri::command]
fn app_first_run_done<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
) -> Result<(), String> {
    main_only(&window)?;
    let mut s = shell.settings.lock().unwrap();
    s.first_run_done = true;
    crate::settings::save(&shell.home, &s).map_err(|e| e.to_string())
}

/// The page reports its first contentful paint (the shell's launch timing).
#[tauri::command]
fn app_mark<R: Runtime>(
    window: WebviewWindow<R>,
    shell: State<'_, Shell>,
    name: String,
    at: f64,
    ms: f64,
) -> Result<(), String> {
    main_only(&window)?;
    let start = shell
        .started_wall
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    eprintln!(
        "[shell] page {name} at t+{:.0} ms (navigation +{ms:.0} ms)",
        at - start
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Simulate {
    Sleep,
    Wake,
}

/// Debug builds: packaging's reliability tests simulate sleep and wake.
#[tauri::command]
fn debug_simulate<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    what: Simulate,
) -> Result<(), String> {
    main_only(&window)?;
    if !cfg!(debug_assertions) {
        return Err("debug builds only".into());
    }
    match what {
        Simulate::Sleep => crate::actions::on_sleep(&app),
        Simulate::Wake => crate::actions::on_wake(&app),
    }
    Ok(())
}

pub fn handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        rx_list,
        rx_add,
        rx_remove,
        rx_select,
        rx_discover,
        rx_start_local,
        rx_stream,
        rx_stream_close,
        app_settings_get,
        app_settings_set,
        app_shortcut_set,
        app_notify_status,
        app_notify_request,
        app_notify_open_settings,
        app_open_view,
        app_open_external,
        app_update_status,
        app_update_check,
        app_update_restart,
        app_first_run_done,
        app_mark,
        debug_simulate
    ]
}
