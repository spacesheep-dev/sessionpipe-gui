//! The main window (NATIVE-SPEC.md §2.4, §2.5, §3.1, §3.11) and view windows (§2.3).

use crate::Shell;
use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, Runtime, Webview, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};

pub const MAIN: &str = "main";

/// Light and dark `--bg` of the sessionpipe skin (white #FFFFFF, ink #141414), painted before the page.
pub const BG_LIGHT: (u8, u8, u8) = (255, 255, 255);
pub const BG_DARK: (u8, u8, u8) = (20, 20, 20);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReceiver {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub local: bool,
}

/// `window.sessionpipeShell` (§2.5).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellContract {
    pub v: u8,
    pub platform: &'static str,
    pub app_version: String,
    pub features: Vec<&'static str>,
    pub receiver: Option<ShellReceiver>,
    pub rx_base: Option<String>,
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "linux"
    }
}

pub fn rx_base(id: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("http://rx.localhost/{id}")
    } else {
        format!("rx://localhost/{id}")
    }
}

pub fn features() -> Vec<&'static str> {
    let mut f = vec!["tray", "notifications", "hotkey", "deeplink", "updater"];
    if cfg!(target_os = "macos") {
        f.push("autostart");
    }
    if cfg!(feature = "identity") {
        f.push("signer");
    }
    if vibrancy() {
        f.push("vibrancy");
    }
    f
}

/// Sidebar vibrancy ships only if measured cheap (§3.1); until then it is opt-in for the
/// measurement: SP_VIBRANCY=1.
pub fn vibrancy() -> bool {
    cfg!(target_os = "macos") && std::env::var("SP_VIBRANCY").as_deref() == Ok("1")
}

pub fn contract<R: Runtime>(app: &AppHandle<R>) -> ShellContract {
    let shell = app.state::<Shell>();
    let active = shell.hub.active();
    ShellContract {
        v: 1,
        platform: platform(),
        app_version: app.package_info().version.to_string(),
        features: features(),
        rx_base: active.as_ref().map(|r| rx_base(&r.id)),
        receiver: active.map(|r| ShellReceiver {
            id: r.id,
            name: r.name,
            origin: r.origin,
            local: r.local,
        }),
    }
}

/// The initialization script: runs before any page script, in the main frame only.
pub fn init_script(c: &ShellContract, initial_path: Option<&str>) -> String {
    let json = serde_json::to_string(c).expect("json");
    let path = initial_path
        .map(|p| serde_json::to_string(p).expect("json"))
        .unwrap_or_else(|| "null".into());
    format!(
        r#"(function(){{
  if (window.top !== window) return;
  var s = {json};
  Object.defineProperty(window, "sessionpipeShell", {{ value: Object.freeze(s), configurable: false, writable: false }});
  document.documentElement.dataset.shell = s.platform;
  var p = {path};
  if (p && (location.pathname === "/" || location.pathname === "/index.html")) {{ try {{ history.replaceState(null, "", p); }} catch (e) {{}} }}
  try {{
    new PerformanceObserver(function (l) {{
      l.getEntries().forEach(function (e) {{
        if (e.name === "first-contentful-paint" && window.__TAURI_INTERNALS__) {{
          window.__TAURI_INTERNALS__.invoke("app_mark", {{ name: "fcp", at: Date.now(), ms: e.startTime }}).catch(function () {{}});
        }}
      }});
    }}).observe({{ type: "paint", buffered: true }});
  }} catch (e) {{}}
}})();"#
    )
}

/// Navigation inside the main window: the bundled origin only (and the dev server in
/// debug builds). http(s) elsewhere opens in the default browser.
pub fn allowed_navigation(url: &url::Url, dev_origin: Option<&str>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            let o = url.origin().ascii_serialization();
            if o == "http://tauri.localhost" {
                return true;
            }
            cfg!(debug_assertions) && dev_origin.is_some_and(|d| d == o)
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

fn is_dark() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::macos::system_dark()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Set once the event loop runs (RunEvent::Ready).
pub static LOOP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn on_main_thread() -> bool {
    std::thread::current().name() == Some("main")
}

/// Opens (or focuses) the main window. `initial_path` puts the page on a route before
/// its scripts run.
///
/// Called from a menu, the tray, Reopen or a second launch, it runs on the main thread
/// inside the event loop, where building a window waits on the loop itself (a hang seen
/// with the window-state restore): the build moves to a worker there.
pub fn open_main<R: Runtime>(app: &AppHandle<R>, initial_path: Option<&str>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(p) = initial_path {
            let _ = w.emit("navigate", serde_json::json!({ "to": p }));
        }
        return Ok(());
    }
    if on_main_thread() && LOOP_RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
        let app = app.clone();
        let path = initial_path.map(str::to_string);
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = build_main(&app, path.as_deref()) {
                log::warn!("main window: {e}");
            }
        });
        return Ok(());
    }
    build_main(app, initial_path)
}

fn build_main<R: Runtime>(app: &AppHandle<R>, initial_path: Option<&str>) -> tauri::Result<()> {
    if app.get_webview_window(MAIN).is_some() {
        return Ok(());
    }
    let t = std::time::Instant::now();
    let c = contract(app);
    let dev_origin = app
        .config()
        .build
        .dev_url
        .as_ref()
        .map(|u| u.origin().ascii_serialization());
    let (r, g, b) = if is_dark() { BG_DARK } else { BG_LIGHT };
    let handle = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("sessionpipe")
        .inner_size(1200.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .background_color(tauri::window::Color(r, g, b, 255))
        .initialization_script(init_script(&c, initial_path))
        .disable_drag_drop_handler()
        .on_navigation(move |u| {
            let ok = allowed_navigation(u, dev_origin.as_deref());
            if !ok {
                if matches!(u.scheme(), "http" | "https") {
                    crate::actions::open_external(u.as_str());
                } else {
                    log::warn!("navigation refused: {}", u.scheme());
                }
            }
            ok
        })
        .on_new_window(move |u, _features| {
            if matches!(u.scheme(), "http" | "https") {
                crate::actions::open_external(u.as_str());
            }
            NewWindowResponse::Deny
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(16.0, 22.0));
    #[cfg(target_os = "macos")]
    let builder = if vibrancy() {
        use tauri::window::{Effect, EffectsBuilder};
        builder
            .transparent(true)
            .effects(EffectsBuilder::new().effect(Effect::Sidebar).build())
    } else {
        builder
    };
    // Debug aid for screenshots: WebKit stops painting an occluded window.
    let builder =
        if cfg!(debug_assertions) && std::env::var("SP_SHELL_ON_TOP").as_deref() == Ok("1") {
            builder.always_on_top(true)
        } else {
            builder
        };
    let w = builder.build()?;
    // Size and place come back through the window-state plugin's own hook (calling
    // restore_state here as well deadlocked against that hook on a reopen).
    let shell = handle.state::<Shell>();
    *shell.shown.lock().unwrap() = c.receiver.as_ref().map(|r| r.id.clone());
    shell.hub.status().set_window(true);
    eprintln!(
        "[shell] main window created in {} ms (t+{} ms)",
        t.elapsed().as_millis(),
        shell.ms()
    );
    let h = handle.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            let shell = h.state::<Shell>();
            let n = shell.hub.close_streams_of(MAIN);
            shell.hub.status().set_window(false);
            log::info!("main window closed; {n} page streams ended");
        }
    });
    Ok(())
}

pub fn on_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if webview.label() != MAIN {
        return;
    }
    let app = webview.app_handle();
    let shell = app.state::<Shell>();
    match payload.event() {
        PageLoadEvent::Started => {
            // A reload: the old page's streams are gone with it.
            shell.hub.close_streams_of(MAIN);
        }
        PageLoadEvent::Finished => {
            eprintln!(
                "[shell] page load finished at t+{} ms ({})",
                shell.ms(),
                payload.url()
            );
            let pending: Vec<_> = std::mem::take(&mut *shell.pending.lock().unwrap());
            if !pending.is_empty() {
                let w = webview.clone();
                tauri::async_runtime::spawn(async move {
                    // Give the page's listeners a moment to register.
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    for e in pending {
                        let _ = w.emit(e.name, e.payload);
                    }
                });
            }
        }
    }
}

/// A view window (an installed, third-party view) on the receiver's own origin, with
/// `?k=` for a remote receiver and no capability: no IPC at all.
pub fn open_view<R: Runtime>(app: &AppHandle<R>, receiver: &str, path: &str) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let url = shell.hub.view_url(receiver, path)?;
    let tag: String = format!("{receiver}-{path}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(60)
        .collect();
    let label = format!("view-{tag}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let origin = url.origin();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title("sessionpipe")
        .inner_size(1100.0, 760.0)
        .on_navigation(move |u| {
            let same = u.origin() == origin;
            if !same && matches!(u.scheme(), "http" | "https") {
                crate::actions::open_external(u.as_str());
            }
            same
        })
        .on_new_window(|u, _| {
            if matches!(u.scheme(), "http" | "https") {
                crate::actions::open_external(u.as_str());
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_guard() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(allowed_navigation(&u("tauri://localhost/index.html"), None));
        assert!(allowed_navigation(&u("http://tauri.localhost/inbox"), None));
        assert!(!allowed_navigation(&u("https://evil.com/"), None));
        assert!(!allowed_navigation(
            &u("http://127.0.0.1:7811/"),
            Some("http://127.0.0.1:7812")
        ));
        assert!(
            allowed_navigation(
                &u("http://127.0.0.1:7812/inbox"),
                Some("http://127.0.0.1:7812")
            ),
            "debug devUrl"
        );
        assert!(!allowed_navigation(&u("rx://localhost/abc/x"), None));
        assert!(!allowed_navigation(&u("file:///etc/passwd"), None));
        assert!(!allowed_navigation(&u("tauri://evil/x"), None));
    }

    #[test]
    fn init_script_sets_the_contract() {
        let c = ShellContract {
            v: 1,
            platform: "macos",
            app_version: "0.2.0".into(),
            features: vec!["tray"],
            receiver: Some(ShellReceiver {
                id: "abcdefgh23".into(),
                name: "This Mac".into(),
                origin: "http://127.0.0.1:7811".into(),
                local: true,
            }),
            rx_base: Some(rx_base("abcdefgh23")),
        };
        let s = init_script(&c, Some("/inbox"));
        assert!(s.contains(r#""rxBase":"rx://localhost/abcdefgh23""#));
        assert!(s.contains(r#""appVersion":"0.2.0""#));
        assert!(s.contains("dataset.shell = s.platform"));
        assert!(s.contains(r#"var p = "/inbox";"#));
        assert!(init_script(&c, None).contains("var p = null;"));
        // A path can't break out of the string.
        assert!(init_script(&c, Some("\"</script>")).contains(r#""\"</script>""#));
    }
}
