//! The New session shortcut (NATIVE-SPEC.md §3.5): off until the person sets one.
//! `tauri-plugin-global-shortcut` (a Carbon hot key: no Accessibility prompt).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The last press opened the sheet and the window has stayed in front since.
static OPENED: AtomicBool = AtomicBool::new(false);

/// Accepts "Control+Alt+N", "Ctrl+Alt+N", "CmdOrCtrl+Shift+Space" … as the plugin parses them.
pub fn validate(accel: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    let s: tauri_plugin_global_shortcut::Shortcut = accel.parse().map_err(|e| format!("{e}"))?;
    if s.mods.is_empty() {
        return Err("A shortcut needs at least one modifier key.".into());
    }
    Ok(s)
}

pub fn register<R: Runtime>(app: &AppHandle<R>, accel: &str) -> Result<(), String> {
    let s = validate(accel)?;
    app.global_shortcut()
        .on_shortcut(s, |app, _s, ev| {
            if ev.state() == ShortcutState::Pressed {
                pressed(app);
            }
        })
        .map_err(|e| format!("That shortcut isn't available: {e}"))
}

pub fn unregister<R: Runtime>(app: &AppHandle<R>, accel: &str) -> Result<(), String> {
    let s = validate(accel)?;
    app.global_shortcut()
        .unregister(s)
        .map_err(|e| e.to_string())
}

/// Brings sessionpipe forward with New session open; pressed again while it is still in
/// front, hides the app (a toggle, as Raycast does). The page keeps the draft.
fn pressed<R: Runtime>(app: &AppHandle<R>) {
    // The app is in front with its window (read from AppKit: this runs on the main thread).
    #[cfg(target_os = "macos")]
    let focused = app.get_webview_window(crate::window::MAIN).is_some()
        && objc2::MainThreadMarker::new()
            .map(|m| objc2_app_kit::NSApplication::sharedApplication(m).isActive())
            .unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    let focused = app
        .get_webview_window(crate::window::MAIN)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if focused && OPENED.swap(false, Ordering::SeqCst) {
        #[cfg(target_os = "macos")]
        crate::macos::activate(app, false);
        #[cfg(not(target_os = "macos"))]
        if let Some(w) = app.get_webview_window(crate::window::MAIN) {
            let _ = w.minimize();
        }
        return;
    }
    OPENED.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    crate::macos::activate(app, true);
    let mut p = serde_json::json!({ "source": "hotkey" });
    p["action"] = "new-session".into();
    crate::actions::to_page(app, "menu", p);
}

/// The window lost focus: the next press opens again rather than hiding.
pub fn focus_lost() {
    OPENED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_refuses() {
        assert!(validate("Control+Alt+N").is_ok());
        assert!(validate("Ctrl+Alt+Shift+F12").is_ok());
        assert!(validate("CmdOrCtrl+Shift+Space").is_ok());
        assert!(validate("N").is_err(), "no modifier");
        assert!(validate("Hyper+Nope").is_err());
        assert!(validate("").is_err());
    }
}
