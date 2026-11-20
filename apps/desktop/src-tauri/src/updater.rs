//! Updates (NATIVE-SPEC.md §3.7): checked 10 s after launch and every 6 hours while
//! "Check for updates automatically" is on (Settings › About, on by default), downloaded
//! in the background, verified (minisign), then "Install and relaunch" in Settings ›
//! About, in the menu bar menu and in the app menu, whose "Check for Updates…" reads
//! "Install 0.8.5 and Relaunch" while one is ready. No modal, no auto-restart.
//! "Check for Updates…" opens Settings › About, which shows the check as it goes, and
//! runs the same check, with a window open or not.
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
    /// Why the last check, download or install failed, in plain words.
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
    // (up to date) or error (a reason), with the time the check finished. A check starts
    // with no version, so one that fails has none ("Couldn't check for updates"); a
    // download or an install that fails keeps the version it was for ("Couldn't update to
    // 0.8.5").
    pub fn begin(&mut self) {
        self.phase = Phase::Checking;
        self.version = None;
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

/// The app menu's update item: "Check for Updates…", or what it does while an update is
/// ready (no ellipsis: it acts at once). The menu bar menu's item reads the same.
pub fn menu_title(ready: Option<&str>) -> String {
    match ready {
        Some(v) => format!("Install {v} and Relaunch"),
        None => "Check for Updates…".into(),
    }
}

/// Changes the state under the lock, then tells the page, the app menu and the menu bar
/// item. The app menu's item is retitled only as an update becomes ready or stops being:
/// never on each percent of a download.
fn publish<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut UpdateState)) {
    let shell = app.state::<Shell>();
    let (out, was, ready) = {
        let mut u = shell.update.lock().unwrap();
        let was = u.ready_version();
        f(&mut u);
        (u.out(), was, u.ready_version())
    };
    let _ = app.emit("update", &out);
    if was != ready {
        crate::menu::retitle_update(app, &menu_title(ready.as_deref()));
    }
    crate::tray::refresh(app);
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

/// "Check for Updates…" in the app menu: Settings › About, where the check shows as it
/// goes (a window is opened for it when there is none), and the same check.
pub fn check_from_menu<R: Runtime>(app: AppHandle<R>) {
    crate::actions::navigate(&app, "/settings?section=about");
    check_now(app);
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
                // The row names what failed ("Couldn't update to 0.8.5"): this is the reason.
                Err(e) => fail(&app, &plain(&e)),
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
        s.begin();
        s.failed("You're offline, or GitHub can't be reached.", "t0");
        assert_eq!(s.phase, Phase::Error);
        assert_eq!(s.last_checked.as_deref(), Some("t0"));
        assert_eq!(s.version, None, "a check that failed found no version");
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

    /// The row's words follow the version: "Couldn't update to 0.7.0" for a download or an
    /// install that failed, "Couldn't check for updates" for a check that found none.
    #[test]
    fn a_failure_keeps_its_version_and_the_next_check_drops_it() {
        let mut s = UpdateState::default();
        s.begin();
        s.found("0.7.0");
        s.downloaded(40);
        s.failed("The download didn't finish.", "t0");
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({
                "state": "error", "version": "0.7.0", "lastChecked": "t0",
                "error": "The download didn't finish."
            })
        );
        assert_eq!(s.ready_version(), None);
        // Try again: a new check, which knows of no version until it finds one.
        s.begin();
        assert_eq!(
            serde_json::to_value(s.out()).unwrap(),
            serde_json::json!({ "state": "checking", "lastChecked": "t0" })
        );
        // An install that failed: the update was ready, and its version stays.
        s.found("0.7.0");
        s.verified("t1");
        s.failed(
            "The download's signature doesn't match sessionpipe's key.",
            "t2",
        );
        assert_eq!(s.phase, Phase::Error);
        assert_eq!(s.version.as_deref(), Some("0.7.0"));
        // A check that fails after it finds none of that.
        s.begin();
        s.failed("You're offline, or GitHub can't be reached.", "t3");
        assert_eq!(s.version, None);
    }

    #[test]
    fn the_menu_item_installs_what_is_ready() {
        assert_eq!(menu_title(None), "Check for Updates…");
        assert_eq!(menu_title(Some("0.8.5")), "Install 0.8.5 and Relaunch");
        // It follows the state: only a downloaded, verified update is offered.
        let mut s = UpdateState::default();
        assert_eq!(
            menu_title(s.ready_version().as_deref()),
            "Check for Updates…"
        );
        s.begin();
        s.found("0.8.5");
        assert_eq!(
            menu_title(s.ready_version().as_deref()),
            "Check for Updates…"
        );
        s.verified("t");
        assert_eq!(
            menu_title(s.ready_version().as_deref()),
            "Install 0.8.5 and Relaunch"
        );
        s.failed("x", "t");
        assert_eq!(
            menu_title(s.ready_version().as_deref()),
            "Check for Updates…"
        );
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
