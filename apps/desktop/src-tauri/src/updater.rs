//! Updates (NATIVE-SPEC.md §3.7): checked 10 s after launch and every 6 hours, downloaded
//! in the background, verified (minisign), then "Restart to Update to x" in the menu bar
//! menu and Settings › App. No modal, no auto-restart.
//!
//! Dev builds check only when SP_UPDATE_URL is set (with the throwaway spike key in
//! tauri.conf.json); release builds use the GitHub Releases endpoint in the config.

use crate::Shell;
use serde::Serialize;
use std::time::Duration;
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
    #[cfg(desktop)]
    ready: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateOut {
    pub state: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl UpdateState {
    pub fn out(&self) -> UpdateOut {
        UpdateOut {
            state: self.phase,
            version: self.version.clone(),
        }
    }
    pub fn ready_version(&self) -> Option<String> {
        (self.phase == Phase::Ready)
            .then(|| self.version.clone())
            .flatten()
    }
}

fn set<R: Runtime>(app: &AppHandle<R>, phase: Phase, version: Option<String>) {
    let shell = app.state::<Shell>();
    let out = {
        let mut u = shell.update.lock().unwrap();
        u.phase = phase;
        if version.is_some() || phase == Phase::Idle {
            u.version = version;
        }
        u.out()
    };
    let _ = app.emit("update", &out);
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
            check(&app).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

pub fn check_now<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move { check(&app).await });
}

#[cfg(desktop)]
async fn check<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_updater::UpdaterExt;
    let Some(ep) = endpoint() else { return };
    {
        let shell = app.state::<Shell>();
        let p = shell.update.lock().unwrap().phase;
        if matches!(p, Phase::Checking | Phase::Downloading | Phase::Ready) {
            return;
        }
    }
    set(app, Phase::Checking, None);
    let mut b = app.updater_builder();
    if let Some(u) = ep {
        b = match b.endpoints(vec![u]) {
            Ok(b) => b,
            Err(e) => return fail(app, &e.to_string()),
        };
    }
    let updater = match b.build() {
        Ok(u) => u,
        Err(e) => return fail(app, &e.to_string()),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let v = update.version.clone();
            set(app, Phase::Downloading, Some(v.clone()));
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    app.state::<Shell>().update.lock().unwrap().ready = Some((update, bytes));
                    set(app, Phase::Ready, Some(v));
                }
                Err(e) => fail(app, &e.to_string()),
            }
        }
        Ok(None) => set(app, Phase::Idle, None),
        Err(e) => fail(app, &e.to_string()),
    }
}

#[cfg(not(desktop))]
async fn check<R: Runtime>(_app: &AppHandle<R>) {}

fn fail<R: Runtime>(app: &AppHandle<R>, e: &str) {
    log::warn!("update check: {e}");
    set(app, Phase::Error, None);
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
                Err(e) => fail(&app, &e.to_string()),
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
}
