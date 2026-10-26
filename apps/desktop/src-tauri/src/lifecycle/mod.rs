//! Lifecycle: single instance, sleep/wake, the local receiver supervisor and the shell's
//! log (NATIVE-SPEC.md §4, §11.2). Owned by packaging from the shell's skeleton commit on.

pub mod logging;
pub mod power;
pub mod relaunch;
pub mod single_instance;
pub mod supervisor;

use std::sync::OnceLock;
use tauri::{Manager, Runtime};

pub use relaunch::relaunch;
pub use supervisor::StartError;

/// The hub and the app version, for `start_local_receiver` (whose contract takes neither).
static HUB: OnceLock<(sp_receivers::Hub, String)> = OnceLock::new();

/// Plugins that must come first: single-instance (which forwards deep links and the test
/// hooks), then the one that stops a dev receiver child on exit.
pub fn plugins<R: Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b.plugin(single_instance::init())
        .plugin(supervisor::plugin())
}

/// The shell's log file, sleep/wake, and the run.json watch. Called once from setup.
pub fn setup<R: Runtime>(app: &tauri::App<R>, hub: sp_receivers::Hub) -> tauri::Result<()> {
    if let Some(dir) = logging::log_dir(app.path().app_log_dir().ok()) {
        if let Some(file) = logging::set_dir(&dir) {
            log::info!(target: "sessionpipe::lifecycle", "sessionpipe {} · log {}", app.package_info().version, file.display());
        }
    }
    let _ = HUB.set((hub.clone(), app.package_info().version.to_string()));
    power::observe(app.handle().clone());
    supervisor::watch(app.handle().clone(), hub);
    Ok(())
}

/// The welcome's "Start sessionpipe": `service install`, then the receiver it started
/// (debug builds: a dry run and a demo child on 7828 instead).
pub async fn start_local_receiver(
    progress: impl Fn(&str, &str),
) -> Result<sp_receivers::ReceiverRef, StartError> {
    let (hub, version) = HUB
        .get()
        .cloned()
        .ok_or_else(|| StartError::Failed("the app is still starting".into()))?;
    supervisor::start_local_receiver(&hub, &version, progress).await
}
