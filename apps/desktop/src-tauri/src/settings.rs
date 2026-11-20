//! Settings › App (NATIVE-SPEC.md §3.9, §11.1), in `<home>/settings.json`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifyKinds {
    pub permission: bool,
    pub question: bool,
    pub error: bool,
    pub idle: bool,
}

impl Default for NotifyKinds {
    fn default() -> Self {
        // The spec §3.4 table's defaults.
        NotifyKinds {
            permission: true,
            question: true,
            error: true,
            idle: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifySettings {
    pub enabled: bool,
    pub kinds: NotifyKinds,
    /// ISO time until which notifications are paused, or None.
    pub paused_until: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub launch_at_login: bool,
    pub menu_bar: bool,
    pub dock_badge: bool,
    pub keep_running: bool,
    pub menu_bar_only: bool,
    /// An accelerator such as "Control+Alt+N", or None (off, the default).
    pub hotkey: Option<String>,
    pub notifications: NotifySettings,
    /// The first-run sheet was seen.
    pub first_run_done: bool,
    /// Check for updates on launch and every six hours (§3.7); off leaves Check now.
    pub auto_update: bool,
    /// The app version whose launch last checked this computer's background service
    /// (lifecycle::supervisor::launch_check). Another one's launch is a new version's
    /// first, which brings the service along. None: none has (a first run, or a file from
    /// an app before this field). The shell's own: the page's saves never change it.
    pub last_version: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            launch_at_login: false,
            menu_bar: true,
            dock_badge: true,
            keep_running: true,
            menu_bar_only: false,
            hotkey: None,
            notifications: NotifySettings::default(),
            first_run_done: false,
            auto_update: true,
            last_version: None,
        }
    }
}

impl AppSettings {
    /// Menu bar only needs the menu bar item (and is a Mac idea): without the item nothing
    /// would show the app is running, no Dock icon, no menu bar item and no app menu.
    pub fn normalized(mut self) -> Self {
        self.menu_bar_only &= self.menu_bar && cfg!(target_os = "macos");
        self
    }

    /// Notes `app` as the version that last checked the background service, and says
    /// whether it is another one than the last: this launch is that version's first.
    pub fn opened_version(&mut self, app: &str) -> bool {
        let new = self.last_version.as_deref() != Some(app);
        self.last_version = Some(app.to_string());
        new
    }
}

pub fn path(home: &Path) -> PathBuf {
    home.join("settings.json")
}

pub fn load(home: &Path) -> AppSettings {
    std::fs::read(path(home))
        .ok()
        .and_then(|b| serde_json::from_slice::<AppSettings>(&b).ok())
        .unwrap_or_default()
        .normalized()
}

pub fn save(home: &Path, s: &AppSettings) -> std::io::Result<()> {
    std::fs::create_dir_all(home)?;
    let p = path(home);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).expect("json"))?;
    std::fs::rename(tmp, p)
}

/// Is `paused_until` in the future (ISO strings compare in time order when both are UTC Z)?
pub fn paused(s: &NotifySettings, now_iso: &str) -> bool {
    s.paused_until.as_deref().is_some_and(|u| u > now_iso)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("sp-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), AppSettings::default());
        let mut s = AppSettings {
            hotkey: Some("Control+Alt+N".into()),
            keep_running: false,
            ..Default::default()
        };
        s.notifications.enabled = true;
        s.notifications.kinds.idle = true;
        s.notifications.paused_until = Some("2026-10-25T10:00:00.000Z".into());
        s.last_version = Some("0.8.6".into());
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
        // The page's JSON shape (§11.1).
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        for k in [
            "launchAtLogin",
            "menuBar",
            "dockBadge",
            "keepRunning",
            "menuBarOnly",
            "hotkey",
            "notifications",
            "autoUpdate",
            "lastVersion",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(
            v["notifications"]["pausedUntil"],
            "2026-10-25T10:00:00.000Z"
        );
        // Unknown and missing fields are tolerated.
        std::fs::write(path(&dir), br#"{"menuBar":false,"future":1}"#).unwrap();
        let l = load(&dir);
        assert!(!l.menu_bar && l.dock_badge && l.auto_update);
        // A file from before lastVersion: no version has checked the service yet.
        assert_eq!(l.last_version, None);
        // A file saved before the two were tied: it can't start the app hidden.
        std::fs::write(path(&dir), br#"{"menuBar":false,"menuBarOnly":true}"#).unwrap();
        let l = load(&dir);
        assert!(!l.menu_bar && !l.menu_bar_only);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn menu_bar_only_needs_the_menu_bar_item() {
        let only = |menu_bar| {
            AppSettings {
                menu_bar,
                menu_bar_only: true,
                ..Default::default()
            }
            .normalized()
            .menu_bar_only
        };
        assert!(!only(false));
        // With the item it stays on a Mac; nowhere else is there a Dock icon to hide.
        assert_eq!(only(true), cfg!(target_os = "macos"));
        // Nothing else changes, and off stays off.
        let s = AppSettings {
            menu_bar: false,
            keep_running: false,
            ..Default::default()
        };
        assert_eq!(s.clone().normalized(), s);
        assert_eq!(AppSettings::default().normalized(), AppSettings::default());
    }

    #[test]
    fn a_launch_of_another_version_is_its_first() {
        let mut s = AppSettings::default();
        // A first run, or a file from an app before the field: new.
        assert!(s.opened_version("0.8.6"));
        assert_eq!(s.last_version.as_deref(), Some("0.8.6"));
        // A relaunch of the same version: not new.
        assert!(!s.opened_version("0.8.6"));
        // An update, and a step back to an older app: each is that version's first.
        assert!(s.opened_version("0.8.7"));
        assert!(s.opened_version("0.8.6"));
        assert_eq!(s.last_version.as_deref(), Some("0.8.6"));
    }

    #[test]
    fn pause_window() {
        let mut n = NotifySettings::default();
        assert!(!paused(&n, "2026-10-25T09:00:00.000Z"));
        n.paused_until = Some("2026-10-25T10:00:00.000Z".into());
        assert!(paused(&n, "2026-10-25T09:00:00.000Z"));
        assert!(!paused(&n, "2026-10-25T10:00:01.000Z"));
    }
}
