//! sessionpipe for iPhone and Android: a thin Tauri 2 shell around the same bundled web UI
//! as the desktop app (NATIVE-SPEC §2, §6). The window shows only the bundled origin
//! (`contract::Os::app_origin`); receivers are
//! reached through Rust (shell's `sp-receivers`: the `rx:` scheme and the stream channel),
//! never by loading their pages.

mod confirm;
pub mod contract;
mod identity;
mod net;
pub mod notify;
mod settings;
#[cfg(target_os = "ios")]
mod uikit;

use sp_receivers::Hub;
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

/// Opens an http(s) link outside the app (Safari on iOS, the default browser on Android).
#[tauri::command]
fn app_open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("http and https only".into());
    }
    open_external(&app, &url);
    Ok(())
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &str) {
    #[cfg(target_os = "ios")]
    let _ = (app, uikit::open_external(url));
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url(url, None::<&str>) {
            log::warn!("open {url}: {e}");
        }
    }
    #[cfg(not(mobile))]
    let _ = (app, url);
}

/// `"granted" | "denied" | "undetermined"` (§11.1).
#[tauri::command]
fn app_notify_status<R: Runtime>(app: AppHandle<R>) -> String {
    notifications::status(&app)
}

/// Asks iOS once (the system alert); later calls answer with the setting.
#[tauri::command]
fn app_notify_request<R: Runtime>(app: AppHandle<R>) -> String {
    notifications::request(&app)
}

/// "Open Settings" when notifications are off for the app: iOS opens the app's page in
/// Settings. Android's page opens its notification settings through MainActivity's
/// `spNotify` instead, so there this answers Err.
#[tauri::command]
fn app_notify_open_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    return app
        .run_on_main_thread(uikit::open_settings)
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("not on this platform".into())
    }
}

/// Plays one of the page's haptics (§11.3, `contract::Haptic`) on UIKit's generators,
/// which uikit.rs keeps prepared so the first one isn't late. Android's page talks to
/// MainActivity's `spHaptic` directly, so here the word is only checked. An unknown kind
/// is refused.
#[tauri::command]
fn app_haptic<R: Runtime>(app: AppHandle<R>, kind: String) -> Result<(), String> {
    let kind = contract::Haptic::parse(&kind).ok_or_else(|| format!("unknown haptic {kind:?}"))?;
    #[cfg(target_os = "ios")]
    app.run_on_main_thread(move || uikit::haptic(kind))
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "ios"))]
    let _ = (app, kind);
    Ok(())
}

/// The system bars follow the page's scheme (§11.4, `contract::Scheme`): `"light"`,
/// `"dark"` or `"auto"`, as `<html data-theme>` says. iOS overrides the window's
/// interface style, so the status bar's text flips with the page; Android's page tells
/// MainActivity's `spAppearance` directly.
#[tauri::command]
fn app_appearance<R: Runtime>(app: AppHandle<R>, scheme: String) -> Result<(), String> {
    let scheme =
        contract::Scheme::parse(&scheme).ok_or_else(|| format!("unknown scheme {scheme:?}"))?;
    #[cfg(target_os = "ios")]
    {
        let win = app.get_webview_window("main").ok_or("no main window")?;
        win.with_webview(move |pv| unsafe {
            uikit::set_appearance(pv.inner() as *mut objc2::runtime::AnyObject, scheme)
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    let _ = (app, scheme);
    Ok(())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The path the window opens at. Dev and measurement only: `SP_START_PATH=/?mock=1`
/// (passed as `SIMCTL_CHILD_SP_START_PATH`) opens the demo without tapping through.
fn start_url(path: Option<&str>) -> WebviewUrl {
    let env = std::env::var("SP_START_PATH").ok();
    match path.or(env.as_deref()) {
        Some(p) if p.starts_with('/') && !p.starts_with("//") && p.len() > 1 => {
            WebviewUrl::App(p.trim_start_matches('/').into())
        }
        _ => WebviewUrl::default(),
    }
}

/// Builds the main window on the Hub's active receiver. The shell contract is fixed for
/// the window's life (it is frozen in the page), so switching receivers makes a new one.
fn open_main<R: Runtime>(app: &AppHandle<R>, path: Option<&str>) -> tauri::Result<()> {
    let hub = app.state::<Hub>();
    let info = net::shell_info(&hub, &app.package_info().version.to_string());
    let probe = std::env::var_os("SP_PROBE").is_some();
    let handle = app.clone();
    let script = match contract::Os::current() {
        contract::Os::Ios => contract::init_script(&info),
        contract::Os::Android => contract::live_init_script(),
    };
    let win = WebviewWindowBuilder::new(app, "main", start_url(path))
        .initialization_script(script)
        .initialization_script(if probe { PROBE_ERRORS } else { "" })
        .on_navigation(move |url| {
            match contract::navigation(contract::Os::current(), url.as_str()) {
                contract::Nav::Allow => true,
                contract::Nav::External => {
                    open_external(&handle, url.as_str());
                    false
                }
                contract::Nav::Refuse => false,
            }
        })
        .build()?;
    #[cfg(target_os = "ios")]
    {
        let _ = win
            .with_webview(|pv| unsafe { uikit::fit(pv.inner() as *mut objc2::runtime::AnyObject) });
        // The generators warm up with the window, so the first tap's haptic is on time.
        let _ = app.run_on_main_thread(uikit::prepare_haptics);
    }
    #[cfg(not(target_os = "ios"))]
    let _ = win;
    Ok(())
}

/// Shows the (new) active receiver in the main window, at `path` or the board. iOS keeps
/// its one window: the contract script is renewed in place and the bundled UI reloads.
/// Android's page reads the contract as it starts (`contract::live_init_script`), so it
/// just navigates.
pub(crate) fn reopen_at<R: Runtime>(app: &AppHandle<R>, path: Option<String>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let hub = app.state::<Hub>();
    hub.close_streams_of("main");
    let script = contract::init_script(&net::shell_info(
        &hub,
        &app.package_info().version.to_string(),
    ));
    let url = format!(
        "{}{}",
        contract::Os::current().app_origin(),
        path.as_deref()
            .filter(|p| p.starts_with('/') && !p.starts_with("//"))
            .unwrap_or("/")
    );
    #[cfg(target_os = "ios")]
    let _ = win.with_webview(move |pv| unsafe {
        uikit::renew_contract(
            pv.inner() as *mut objc2::runtime::AnyObject,
            contract::MARKER,
            &script,
            &url,
        )
    });
    // Android: the page reads the contract as it starts, so a navigation is enough.
    #[cfg(target_os = "android")]
    {
        let _ = script;
        match url.parse() {
            Ok(u) => {
                if let Err(e) = win.navigate(u) {
                    log::warn!("reopen: {e}");
                }
            }
            Err(e) => log::warn!("reopen {url}: {e}"),
        }
    }
    #[cfg(not(mobile))]
    let _ = (win, script, url);
}

pub(crate) fn reopen<R: Runtime>(app: &AppHandle<R>) {
    reopen_at(app, None)
}

/// Collects the page's errors from the first script on (probe runs only).
const PROBE_ERRORS: &str = "window.__probeErrors = []; addEventListener('error', (e) => __probeErrors.push(String(e.message || e.target?.src || e.target?.href || e) + ' @ ' + String(e.error?.stack || e.filename + ':' + e.lineno + ':' + e.colno).slice(0, 400))); addEventListener('unhandledrejection', (e) => __probeErrors.push('rej ' + String(e.reason && (e.reason.stack || e.reason)))); addEventListener('securitypolicyviolation', (e) => __probeErrors.push('csp ' + e.violatedDirective + ' ' + e.blockedURI)); const ce = console.error; console.error = (...a) => { __probeErrors.push('ce ' + a.map(String).join(' ').slice(0, 300)); ce(...a); };";

/// Dev launches with `SP_PROBE` set (`SIMCTL_CHILD_SP_PROBE=1`; iOS apps get no env
/// otherwise): what the page shows 3 s after load, written to `<app data>/probe.txt` (the
/// simulator has no scriptable inspector). The result rides in the URL hash, which needs
/// no IPC permission.
fn probe<R: Runtime>(webview: &tauri::Webview<R>) {
    if std::env::var_os("SP_PROBE").is_none() {
        return;
    }
    // Simulator builds only: a dev launch can drive the page (the simulator has no
    // scriptable taps). A device build ignores it.
    #[cfg(target_env = "sim")]
    if let Ok(js) = std::env::var("SP_EVAL") {
        let _ = webview.eval(format!("setTimeout(() => {{ try {{ {js} }} catch (e) {{ (window.__probeErrors || []).push('eval ' + e); }} }}, 1200);"));
    }
    let _ = webview.eval(
        "setTimeout(() => { const d = document.documentElement; history.replaceState(history.state, '', location.pathname + location.search + '#probe=' + encodeURIComponent(JSON.stringify({ href: location.href, shell: d.dataset.shell, theme: d.dataset.theme, sp: window.sessionpipeShell && { receiver: window.sessionpipeShell.receiver, rxBase: window.sessionpipeShell.rxBase }, font: getComputedStyle(d).fontSize, text: document.body.innerText.slice(0, 600), w: innerWidth, h: innerHeight, errors: window.__probeErrors || [] }))); }, 2500);",
    );
    let wv = webview.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(3500));
        if let (Ok(u), Ok(dir)) = (wv.url(), wv.app_handle().path().app_data_dir()) {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("probe.txt"), u.as_str());
        }
    });
}

#[cfg(mobile)]
mod notifications {
    use crate::notify::{Notifier, Post, PERMISSION};
    use sp_receivers::Hub;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, Manager, Runtime};
    use tauri_plugin_notification::{Action, ActionType, NotificationExt, PermissionState};

    fn word(s: PermissionState) -> String {
        match s {
            PermissionState::Granted => "granted",
            PermissionState::Denied => "denied",
            _ => "undetermined",
        }
        .into()
    }
    pub fn status<R: Runtime>(app: &AppHandle<R>) -> String {
        app.notification()
            .permission_state()
            .map(word)
            .unwrap_or_else(|_| "undetermined".into())
    }
    pub fn request<R: Runtime>(app: &AppHandle<R>) -> String {
        app.notification()
            .request_permission()
            .map(word)
            .unwrap_or_else(|_| "undetermined".into())
    }

    fn post<R: Runtime>(app: &AppHandle<R>, p: &Post) {
        let mut b = app
            .notification()
            .builder()
            .id(p.id)
            .title(&p.title)
            .body(&p.body)
            .extra("path", &p.path)
            .extra("receiver", &p.receiver);
        if let Some(c) = p.category {
            b = b.action_type_id(c);
        }
        if let Err(e) = b.show() {
            log::warn!("notification: {e}");
        }
    }

    /// The category, the action handler, the background flag and the Hub listener.
    pub fn start<R: Runtime>(app: &AppHandle<R>, hub: Hub) {
        let n = app.notification();
        // Allow and Deny: plain buttons (red is for errors), and both open the app on the
        // session, where this build says why it can't send. A device build with a signer
        // answers them in the background instead (arch-mobile §6.2).
        let actions = ActionType::builder(PERMISSION)
            .actions(vec![
                Action::builder("allow", "Allow")
                    .foreground(true)
                    .requires_authentication(true)
                    .build(),
                Action::builder("deny", "Deny")
                    .foreground(true)
                    .requires_authentication(true)
                    .build(),
            ])
            .build();
        if let Err(e) = n.register_action_types(vec![actions]) {
            log::warn!("notification category: {e}");
        }
        let handle = app.clone();
        let _ = n.on_action(move |a| {
            let Some(note) = a.notification() else { return };
            let path = note
                .extra()
                .get("path")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let receiver = note
                .extra()
                .get("receiver")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let Some(path) = path.filter(|p| p.starts_with("/s/")) else {
                return;
            };
            let hub = handle.state::<Hub>();
            let active = hub.active().map(|r| r.id);
            match receiver {
                Some(r) if Some(&r) != active.as_ref() && hub.set_active(&r).is_ok() => {
                    crate::reopen_at(&handle, Some(path))
                }
                _ => {
                    let _ = handle.emit_to("main", "navigate", serde_json::json!({ "to": path }));
                }
            }
        });

        let background = Arc::new(AtomicBool::new(false));
        #[cfg(target_os = "ios")]
        {
            let bg = background.clone();
            let h = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::uikit::watch_background(move |on| {
                    bg.store(on, Ordering::SeqCst);
                    // Back in front: the window's own streams resync (§11.1 `wake`).
                    if !on {
                        let _ = h.emit_to("main", "wake", ());
                    }
                })
            });
        }
        let app = app.clone();
        let mut events = hub.subscribe();
        tauri::async_runtime::spawn(async move {
            let mut notifier = Notifier::default();
            loop {
                let e = match events.recv().await {
                    Ok(e) => e,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                };
                // Off in Settings (or never turned on): the notifier still keeps count, so
                // turning it on never replays what was already open.
                let on = app.state::<crate::settings::Settings>().notifications_on();
                let plan = notifier.on_event(&e, on && background.load(Ordering::SeqCst));
                for p in &plan.post {
                    post(&app, p);
                }
                if !plan.remove.is_empty() {
                    let _ = app.notification().remove_active(plan.remove);
                }
            }
        });
    }
}

#[cfg(not(mobile))]
mod notifications {
    use tauri::{AppHandle, Runtime};
    pub fn status<R: Runtime>(_: &AppHandle<R>) -> String {
        "denied".into()
    }
    pub fn request<R: Runtime>(_: &AppHandle<R>) -> String {
        "denied".into()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let entry = now_ms();
    let builder = tauri::Builder::default().plugin(identity::init());
    // The scanner (§11.5) is the page's: `plugin:barcode-scanner|scan` runs the camera
    // behind the webview, and `net::rx_add` reads the receiver out of what it decoded.
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    builder
        .register_asynchronous_uri_scheme_protocol("rx", |ctx, req, responder| net::handle_rx(ctx.app_handle(), req, responder))
        .register_uri_scheme_protocol("shell", |ctx, req| net::handle_shell(ctx.app_handle(), &req))
        .invoke_handler(tauri::generate_handler![
            app_open_external,
            app_notify_status,
            app_notify_request,
            app_notify_open_settings,
            app_haptic,
            app_appearance,
            net::rx_list,
            net::rx_add,
            net::rx_select,
            net::rx_remove,
            net::rx_stream,
            net::rx_stream_close,
            settings::app_settings_get,
            settings::app_settings_set,
            settings::app_first_run_done,
            settings::app_update_status,
        ])
        .setup(|app| {
            let version = app.package_info().version.to_string();
            let home = match std::env::var_os("SP_SHELL_HOME") {
                Some(h) => h.into(),
                None => app.path().app_config_dir()?,
            };
            std::fs::create_dir_all(&home)?;
            app.manage(settings::Settings::new(&home));
            let hub = Hub::new(net::config(home, &version));
            hub.start(tauri::async_runtime::handle().inner().clone());
            app.manage(hub.clone());
            #[cfg(mobile)]
            notifications::start(app.handle(), hub);
            #[cfg(not(mobile))]
            let _ = hub;
            open_main(app.handle(), None)?;
            Ok(())
        })
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                // A reload ends the streams the old page opened.
                webview.app_handle().state::<Hub>().close_streams_of(webview.label());
                return;
            }
            probe(webview);
            // Launch measurement (measure-launch.sh): with SP_MEASURE set, the first page's
            // load is written to the app's data dir, as the spike did.
            if std::env::var_os("SP_MEASURE").is_none() {
                return;
            }
            if let Ok(dir) = webview.app_handle().path().app_data_dir() {
                let report = serde_json::json!({ "rustEntryEpochMs": entry, "pageFinishedEpochMs": now_ms(), "url": payload.url().as_str() });
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join("launch-report.json"), report.to_string());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
