//! sessionpipe for the desktop (NATIVE-SPEC.md): a thin Tauri 2 shell around the web UI
//! bundled in the app. Rust is the network: the page reaches receivers through the `rx:`
//! protocol and IPC streams (sp-receivers); the menu bar item, Dock badge and
//! notifications run on the shell's own streams, with or without a window.

pub mod actions;
pub mod commands;
pub mod deeplink;
pub mod hotkey;
pub mod identity_glue;
pub mod lifecycle;
pub mod menu;
pub mod notifications;
pub mod settings;
pub mod tools;
pub mod tray;
pub mod updater;
pub mod window;

#[cfg(target_os = "macos")]
pub mod macos;

use sp_receivers::{Hub, HubConfig, KeyStore, StatusFile};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Instant, SystemTime};
use tauri::{Manager, RunEvent};

/// Everything the shell keeps, in Tauri's state.
pub struct Shell {
    pub hub: Hub,
    pub home: PathBuf,
    pub settings: Mutex<settings::AppSettings>,
    /// The receiver baked into the main window's contract when it was built (None: the
    /// welcome). What the page talks to until the window is built again.
    pub shown: Mutex<Option<String>>,
    pub started: Instant,
    pub started_wall: SystemTime,
    pub update: Mutex<updater::UpdateState>,
    /// Actions to send once the page is up (a menu item chosen with the window closed).
    pub pending: Mutex<Vec<actions::PageEvent>>,
}

impl Shell {
    /// Milliseconds since main().
    pub fn ms(&self) -> u128 {
        self.started.elapsed().as_millis()
    }

    pub fn settings(&self) -> settings::AppSettings {
        self.settings.lock().unwrap().clone()
    }
}

/// The app's config dir, or SP_SHELL_HOME (dev: the receiver list, settings, logs).
fn shell_home(app: &tauri::App) -> PathBuf {
    if let Some(h) = std::env::var_os("SP_SHELL_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("sessionpipe"))
}

pub fn run() {
    let started = Instant::now();
    let started_wall = SystemTime::now();
    sp_receivers::ensure_crypto();
    // packaging's logger: stderr per RUST_LOG, then <logs>/shell.log once setup names it.
    lifecycle::logging::install();

    let builder = lifecycle::plugins(tauri::Builder::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .with_denylist(&["view-*"])
                .build(),
        );
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
        .register_asynchronous_uri_scheme_protocol("rx", |ctx, req, responder| {
            // Only the bundled main window speaks rx:. A view window lives on the
            // receiver's own origin and never needs it.
            if ctx.webview_label() != "main" {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(403)
                        .body(b"forbidden".to_vec())
                        .expect("response"),
                );
                return;
            }
            let hub = ctx.app_handle().state::<Shell>().hub.clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(hub.proxy(req).await);
            });
        })
        .invoke_handler(commands::handler())
        .on_page_load(window::on_page_load)
        .setup(move |app| {
            let home = shell_home(app);
            let _ = std::fs::create_dir_all(&home);
            let version = app.package_info().version.to_string();
            let dev_keys = std::env::var_os("SP_SHELL_HOME").is_some_and(|h| !h.is_empty());
            let keys = if dev_keys {
                KeyStore::File(home.join("keys.json"))
            } else {
                KeyStore::Keychain {
                    service: format!("{}.receivers", app.config().identifier),
                }
            };
            let dev_url = app.config().build.dev_url.as_ref().map(|u| u.to_string());
            let hub = Hub::new(HubConfig {
                home: home.clone(),
                keys,
                env_receiver_url: std::env::var("SP_RECEIVER_URL").ok(),
                allowed_origins: sp_receivers::proxy::default_allowed_origins(dev_url.as_deref()),
                status: StatusFile::from_env(&version),
                user_agent: format!("sessionpipe-desktop/{version}"),
            });
            let s = settings::load(&home);
            app.manage(Shell {
                hub: hub.clone(),
                home,
                settings: Mutex::new(s.clone()),
                shown: Mutex::new(None),
                started,
                started_wall,
                update: Mutex::new(updater::UpdateState::default()),
                pending: Mutex::new(Vec::new()),
            });

            #[cfg(target_os = "macos")]
            if s.menu_bar_only {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            menu::install(app.handle())?;
            if s.menu_bar {
                tray::install(app.handle())?;
            }
            // Subscribe before the streams start, so no early event is missed.
            tray::watch(app.handle().clone());
            hub.start(tauri::async_runtime::handle().inner().clone());
            #[cfg(target_os = "macos")]
            macos::notify::init(app.handle());
            identity_glue::init(app)?;
            if let Some(h) = s.hotkey.as_deref() {
                if let Err(e) = hotkey::register(app.handle(), h) {
                    log::warn!("shortcut {h}: {e}");
                }
            }
            updater::schedule(app.handle().clone());
            lifecycle::setup(app, hub.clone())?;

            #[cfg(debug_assertions)]
            debug_hooks(app.handle());
            let link = deeplink::from_argv(std::env::args());
            window::open_main(app.handle(), None)?;
            eprintln!(
                "[shell] window built at {} ms",
                started.elapsed().as_millis()
            );
            if let Some(l) = link {
                deeplink::handle_deep_link(app.handle(), &l);
            }
            // Links from the OS (release builds declare the scheme).
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = app.handle().clone();
                app.deep_link().on_open_url(move |ev| {
                    for u in ev.urls() {
                        deeplink::handle_deep_link(&h, u.as_str());
                    }
                });
            }
            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("sessionpipe: could not start");
    eprintln!("[shell] app built at {} ms", started.elapsed().as_millis());
    app.run(|app, event| match event {
        RunEvent::Ready => window::LOOP_RUNNING.store(true, std::sync::atomic::Ordering::SeqCst),
        // The last window closed: keep the menu bar item, badge and notifications.
        RunEvent::ExitRequested {
            api, code: None, ..
        } if app.state::<Shell>().settings().keep_running => {
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } if app.get_webview_window("main").is_none() => {
            let _ = window::open_main(app, None);
        }
        _ => {}
    });
}

/// Dev-only checks that need a running app (each logs what happened):
/// - SP_TEST_HOTKEY=<accel>: registers the shortcut, reports it, unregisters it 3 s later
/// - SP_TEST_OPEN_VIEW=<path>: opens a view window on the receiver's origin
#[cfg(debug_assertions)]
fn debug_hooks<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Ok(accel) = std::env::var("SP_TEST_HOTKEY") {
        let r = hotkey::register(app, &accel);
        let on = hotkey::validate(&accel)
            .map(|s| app.global_shortcut().is_registered(s))
            .unwrap_or(false);
        eprintln!("[shell] test hotkey {accel}: register={r:?} registered={on}");
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let r = hotkey::unregister(&h, &accel);
            let on = hotkey::validate(&accel)
                .map(|s| h.global_shortcut().is_registered(s))
                .unwrap_or(true);
            eprintln!("[shell] test hotkey {accel}: unregister={r:?} registered={on}");
        });
    }
    if let Ok(path) = std::env::var("SP_TEST_OPEN_VIEW") {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let id = h
                .state::<Shell>()
                .hub
                .active()
                .map(|r| r.id)
                .unwrap_or_default();
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || {
                let r = window::open_view(&h2, &id, &path);
                eprintln!("[shell] test view {path}: {r:?}");
            });
        });
    }
}
