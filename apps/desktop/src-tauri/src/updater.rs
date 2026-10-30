//! Updates (NATIVE-SPEC.md §3.7): checked 10 s after launch and every 6 hours while
//! "Check for updates automatically" is on (Settings › App › Updates, on by default),
//! downloaded in the background, verified (minisign), then "Install and relaunch" in the
//! menu bar menu and Settings › App. No modal while the window is up, no auto-restart.
//! "Check for Updates…" in the app menu runs the same check; with no window open it
//! answers in a native dialog instead.
//!
//! A failed download leaves nothing behind: the plugin keeps the archive in memory until
//! it is verified, and installs by unpacking into a temp dir beside the app and swapping
//! the two bundles, with the old one restored if that fails.
//!
//! Dev builds check only when SP_UPDATE_URL is set (with the throwaway spike key in
//! tauri.conf.json); release builds use the GitHub Releases endpoint in the config.

use crate::Shell;
use serde::Serialize;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const FIRST_CHECK: Duration = Duration::from_secs(10);
pub const EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Ready,
    Error,
}

#[derive(Default)]
pub struct UpdateState {
    pub phase: Phase,
    pub version: Option<String>,
    /// ISO time the last check finished (up to date, ready or failed).
    pub last_checked: Option<String>,
    /// Why the last check or install failed, in plain words.
    pub error: Option<String>,
    /// Percent downloaded, while downloading.
    pub progress: Option<u8>,
    #[cfg(desktop)]
    ready: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOut {
    pub state: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
}

impl UpdateState {
    pub fn out(&self) -> UpdateOut {
        UpdateOut {
            state: self.phase,
            version: self.version.clone(),
            last_checked: self.last_checked.clone(),
            error: self.error.clone(),
            progress: self.progress,
        }
    }
    pub fn ready_version(&self) -> Option<String> {
        (self.phase == Phase::Ready)
            .then(|| self.version.clone())
            .flatten()
    }
    /// A check or a download is under way, or one is already waiting to be installed.
    pub fn busy(&self) -> bool {
        matches!(
            self.phase,
            Phase::Checking | Phase::Downloading | Phase::Ready
        )
    }

    // The state machine: idle/error → checking → downloading → ready, or back to idle
    // (up to date) or error (a reason), with the time the check finished.
    pub fn begin(&mut self) {
        self.phase = Phase::Checking;
        self.error = None;
        self.progress = None;
    }
    pub fn found(&mut self, version: &str) {
        self.phase = Phase::Downloading;
        self.version = Some(version.to_string());
        self.progress = Some(0);
    }
    pub fn downloaded(&mut self, percent: u8) {
        self.progress = Some(percent.min(100));
    }
    pub fn verified(&mut self, now: &str) {
        self.phase = Phase::Ready;
        self.progress = None;
        self.last_checked = Some(now.to_string());
    }
    pub fn up_to_date(&mut self, now: &str) {
        self.phase = Phase::Idle;
        self.version = None;
        self.progress = None;
        self.last_checked = Some(now.to_string());
    }
    pub fn failed(&mut self, reason: &str, now: &str) {
        self.phase = Phase::Error;
        self.version = None;
        self.progress = None;
        self.error = Some(reason.to_string());
        self.last_checked = Some(now.to_string());
    }
}

/// Does the schedule check now? Only with the toggle on and nothing under way.
pub fn due(auto_update: bool, state: &UpdateState) -> bool {
    auto_update && !state.busy()
}

fn now_iso() -> String {
    sp_receivers::status::iso(SystemTime::now())
}

/// Changes the state under the lock, then tells the page and the menu bar item.
fn publish<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut UpdateState)) {
    let shell = app.state::<Shell>();
    let out = {
        let mut u = shell.update.lock().unwrap();
        f(&mut u);
        u.out()
    };
    let _ = app.emit("update", &out);
    crate::tray::refresh(app);
}

fn current<R: Runtime>(app: &AppHandle<R>) -> UpdateOut {
    app.state::<Shell>().update.lock().unwrap().out()
}

/// Where to check, or None (dev without SP_UPDATE_URL).
pub fn endpoint() -> Option<Option<url::Url>> {
    match std::env::var("SP_UPDATE_URL")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(u) => url::Url::parse(&u).ok().map(Some),
        None if cfg!(debug_assertions) => None,
        None => Some(None), // the config's endpoint
    }
}

pub fn schedule<R: Runtime>(app: AppHandle<R>) {
    if endpoint().is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let go = {
                let shell = app.state::<Shell>();
                let auto = shell.settings().auto_update;
                let u = shell.update.lock().unwrap();
                due(auto, &u)
            };
            if go {
                check(&app).await;
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// A check the person asked for (Check now, or the toggle just turned on).
pub fn check_now<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move { check(&app).await });
}

/// "Check for Updates…" in the app menu: the same check; Settings › App shows how it goes
/// when the window is up, a native dialog says what came of it when it isn't.
pub fn check_from_menu<R: Runtime>(app: AppHandle<R>) {
    if app.get_webview_window(crate::window::MAIN).is_some() {
        crate::actions::menu_action(&app, "settings");
        check_now(app);
        return;
    }
    tauri::async_runtime::spawn(async move {
        check(&app).await;
        let out = current(&app);
        let version = app.package_info().version.to_string();
        let (title, message, install) = dialog_words(&out, &version);
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let buttons = if install {
            MessageDialogButtons::OkCancelCustom("Install and relaunch".into(), "Later".into())
        } else {
            MessageDialogButtons::Ok
        };
        let h = app.clone();
        app.dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(buttons)
            .show(move |ok| {
                if ok && install {
                    restart(h);
                }
            });
    });
}

/// The dialog's title, text, and whether it offers Install and relaunch.
pub fn dialog_words(u: &UpdateOut, app_version: &str) -> (String, String, bool) {
    match u.state {
        Phase::Ready => (
            format!(
                "sessionpipe {} is ready",
                u.version.as_deref().unwrap_or("update")
            ),
            format!(
                "You have {app_version}. Install it and relaunch now, or later from the menu bar."
            ),
            true,
        ),
        Phase::Error => (
            "Couldn't check for updates".into(),
            u.error.clone().unwrap_or_else(|| "Try again later.".into()),
            false,
        ),
        Phase::Checking | Phase::Downloading => (
            "Checking for updates…".into(),
            "The menu bar item says when one is ready.".into(),
            false,
        ),
        Phase::Idle => (
            "You're up to date".into(),
            format!("sessionpipe {app_version} is the newest version."),
            false,
        ),
    }
}

#[cfg(desktop)]
async fn check<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_updater::UpdaterExt;
    let Some(ep) = endpoint() else { return };
    if app.state::<Shell>().update.lock().unwrap().busy() {
        return;
    }
    publish(app, |u| u.begin());
    let mut b = app.updater_builder();
    if let Some(u) = ep {
        b = match b.endpoints(vec![u]) {
            Ok(b) => b,
            Err(e) => return fail(app, &plain(&e)),
        };
    }
    let updater = match b.build() {
        Ok(u) => u,
        Err(e) => return fail(app, &plain(&e)),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let v = update.version.clone();
            publish(app, |u| u.found(&v));
            let mut got: u64 = 0;
            let mut shown: u8 = 0;
            let on_chunk = |n: usize, total: Option<u64>| {
                got += n as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    let pct = (got.saturating_mul(100) / t).min(100) as u8;
                    if pct != shown {
                        shown = pct;
                        publish(app, |u| u.downloaded(pct));
                    }
                }
            };
            // Verified against the config's public key before these bytes come back.
            match update.download(on_chunk, || {}).await {
                Ok(bytes) => publish(app, |u| {
                    u.ready = Some((update, bytes));
                    u.verified(&now_iso());
                }),
                Err(e) => fail(app, &plain(&e)),
            }
        }
        Ok(None) => publish(app, |u| u.up_to_date(&now_iso())),
        Err(e) => fail(app, &plain(&e)),
    }
}

#[cfg(not(desktop))]
async fn check<R: Runtime>(_app: &AppHandle<R>) {}

/// The plugin's errors in plain words. Anything else keeps its own text.
#[cfg(desktop)]
pub fn plain(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(r) if r.is_connect() || r.is_timeout() => {
            "You're offline, or GitHub can't be reached.".into()
        }
        E::Reqwest(r) => match r.status() {
            Some(s) if s.as_u16() == 404 => "The release has no update manifest.".into(),
            Some(s) => format!("GitHub answered {}.", s.as_u16()),
            None => "You're offline, or GitHub can't be reached.".into(),
        },
        E::Network(_) => "The download didn't finish.".into(),
        E::ReleaseNotFound => "The release has no update manifest.".into(),
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => {
            "The download's signature doesn't match sessionpipe's key.".into()
        }
        E::TargetNotFound(_) | E::TargetsNotFound(_) => {
            "The release has no build for this computer.".into()
        }
        other => other.to_string(),
    }
}

fn fail<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    log::warn!("update check: {reason}");
    publish(app, |u| u.failed(reason, &now_iso()));
}

/// Installs the downloaded update and restarts (only when the person chose it).
pub fn restart<R: Runtime>(app: AppHandle<R>) {
    #[cfg(desktop)]
    {
        let ready = app.state::<Shell>().update.lock().unwrap().ready.take();
        if let Some((update, bytes)) = ready {
            match update.install(bytes) {
                // Not app.restart(): LaunchServices would drop SP_RECEIVER_URL and friends,
                // and a test or dev run would come back as a release app (lifecycle/relaunch.rs).
                Ok(()) => crate::lifecycle::relaunch(&app),
                Err(e) => fail(&app, &format!("Couldn't install the update: {}", plain(&e))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_serialise_for_the_page() {
        let mut s = UpdateState::default();
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({ "state": "idle" })
        );
        s.phase = Phase::Ready;
        s.version = Some("0.3.1".into());
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({ "state": "ready", "version": "0.3.1" })
        );
        assert_eq!(s.ready_version().as_deref(), Some("0.3.1"));
        s.phase = Phase::Downloading;
        assert_eq!(s.ready_version(), None);
    }

    #[test]
    fn a_check_runs_its_course() {
        let mut s = UpdateState::default();
        s.failed("You're offline, or GitHub can't be reached.", "t0");
        assert_eq!(s.phase, Phase::Error);
        assert_eq!(s.last_checked.as_deref(), Some("t0"));
        s.begin();
        assert_eq!(s.phase, Phase::Checking);
        assert_eq!(s.error, None);
        assert_eq!(
            s.last_checked.as_deref(),
            Some("t0"),
            "kept until this one ends"
        );
        s.found("0.7.0");
        s.downloaded(42);
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({
                "state": "downloading", "version": "0.7.0", "lastChecked": "t0", "progress": 42
            })
        );
        s.verified("t1");
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({ "state": "ready", "version": "0.7.0", "lastChecked": "t1" })
        );
        s.begin();
        s.up_to_date("t2");
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({ "state": "idle", "lastChecked": "t2" })
        );
    }

    #[test]
    fn the_schedule_waits_for_the_toggle_and_a_quiet_state() {
        let mut s = UpdateState::default();
        assert!(due(true, &s));
        assert!(!due(false, &s), "the toggle off: Check now only");
        s.failed("x", "t");
        assert!(due(true, &s), "a failed check is tried again");
        for p in [Phase::Checking, Phase::Downloading, Phase::Ready] {
            s.phase = p;
            assert!(!due(true, &s), "{p:?} is left alone");
        }
    }

    #[test]
    fn the_menu_dialog_says_what_came_of_it() {
        let mut s = UpdateState::default();
        s.up_to_date("t");
        let (title, msg, install) = dialog_words(&s.out(), "0.6.0");
        assert_eq!(title, "You're up to date");
        assert_eq!(msg, "sessionpipe 0.6.0 is the newest version.");
        assert!(!install);
        s.found("0.7.0");
        s.verified("t");
        let (title, msg, install) = dialog_words(&s.out(), "0.6.0");
        assert_eq!(title, "sessionpipe 0.7.0 is ready");
        assert!(msg.starts_with("You have 0.6.0."));
        assert!(install);
        s.failed("The release has no update manifest.", "t");
        let (title, msg, install) = dialog_words(&s.out(), "0.6.0");
        assert_eq!(title, "Couldn't check for updates");
        assert_eq!(msg, "The release has no update manifest.");
        assert!(!install);
    }

    #[cfg(desktop)]
    #[test]
    fn the_plugins_errors_in_plain_words() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(
            plain(&E::ReleaseNotFound),
            "The release has no update manifest."
        );
        assert_eq!(
            plain(&E::TargetNotFound("darwin-aarch64".into())),
            "The release has no build for this computer."
        );
        assert_eq!(
            plain(&E::SignatureUtf8("x".into())),
            "The download's signature doesn't match sessionpipe's key."
        );
        assert_eq!(
            plain(&E::Network("reset".into())),
            "The download didn't finish."
        );
        assert_eq!(plain(&E::EmptyEndpoints), E::EmptyEndpoints.to_string());
    }
}
