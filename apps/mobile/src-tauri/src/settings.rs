//! The app's own settings on iPhone (§11.1 `AppSettings`), in `<home>/settings.json`. Only
//! what a phone has is honoured (notifications, the first run); the desktop-only fields
//! are kept as the page sent them, so one shape serves both shells.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Runtime, State, Webview};

pub struct Settings {
    path: PathBuf,
    lock: Mutex<()>,
}

pub fn defaults() -> Value {
    json!({
        "launchAtLogin": false,
        "menuBar": false,
        "dockBadge": false,
        "keepRunning": false,
        "menuBarOnly": false,
        "hotkey": null,
        "notifications": { "enabled": false, "kinds": {}, "pausedUntil": null },
        "firstRunDone": false
    })
}

/// `base` with `patch`'s known top-level keys over it; unknown keys and wrong types are dropped.
pub fn merge(base: &Value, patch: &Value) -> Value {
    let mut out: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
    let d = defaults();
    if let Some(p) = patch.as_object() {
        for (k, v) in p {
            let Some(def) = d.get(k) else { continue };
            let same = matches!(
                (def, v),
                (Value::Bool(_), Value::Bool(_)) | (Value::Object(_), Value::Object(_))
            ) || (k == "hotkey" && (v.is_null() || v.is_string()));
            if same {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

impl Settings {
    pub fn new(home: &Path) -> Self {
        Settings {
            path: home.join("settings.json"),
            lock: Mutex::new(()),
        }
    }
    pub fn get(&self) -> Value {
        let _g = self.lock.lock().unwrap();
        let stored = std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or(Value::Null);
        merge(&defaults(), &stored)
    }
    pub fn set(&self, patch: &Value) -> std::io::Result<Value> {
        let next = merge(&self.get(), patch);
        let _g = self.lock.lock().unwrap();
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&next)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(next)
    }
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub fn notifications_on(&self) -> bool {
        self.get()["notifications"]["enabled"]
            .as_bool()
            .unwrap_or(false)
    }
}

#[tauri::command]
pub fn app_settings_get<R: Runtime>(
    webview: Webview<R>,
    s: State<'_, Settings>,
) -> Result<Value, String> {
    crate::net::main_only(&webview)?;
    Ok(s.get())
}

#[tauri::command]
pub fn app_settings_set<R: Runtime>(
    webview: Webview<R>,
    s: State<'_, Settings>,
    settings: Value,
) -> Result<Value, String> {
    crate::net::main_only(&webview)?;
    s.set(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_first_run_done<R: Runtime>(
    webview: Webview<R>,
    s: State<'_, Settings>,
) -> Result<(), String> {
    crate::net::main_only(&webview)?;
    s.set(&json!({ "firstRunDone": true }))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// No updater on iPhone: the App Store updates the app.
#[tauri::command]
pub fn app_update_status() -> Value {
    json!({ "state": "idle" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_known_keys_of_the_right_type() {
        let m = merge(
            &defaults(),
            &json!({ "firstRunDone": true, "hotkey": 3, "evil": 1, "notifications": { "enabled": true } }),
        );
        assert_eq!(m["firstRunDone"], true);
        assert_eq!(m["hotkey"], Value::Null);
        assert!(m.get("evil").is_none());
        assert_eq!(m["notifications"]["enabled"], true);
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = std::env::temp_dir().join(format!("sp-ios-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Settings::new(&dir);
        assert!(!s.notifications_on());
        s.set(&json!({ "notifications": { "enabled": true, "kinds": {}, "pausedUntil": null } }))
            .unwrap();
        assert!(Settings::new(&dir).notifications_on());
        assert_eq!(Settings::new(&dir).get()["firstRunDone"], false);
        let _ = std::fs::remove_dir_all(dir);
    }
}
