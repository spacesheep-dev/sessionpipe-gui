//! Sleep and wake (NATIVE-SPEC §4). `NSWorkspace` `willSleep` closes the native streams
//! (the menu bar's, and the page's); `didWake` reconnects the menu bar's and sends the page
//! a `wake` event, which the page's transport turns into its resync (as on
//! `visibilitychange`), instead of trusting a connection that died in its sleep.
//!
//! Tests drive the same path without sleeping the Mac: `debug_simulate` from the page in a
//! debug build, or `--debug-simulate sleep|wake` on a second launch when the running app
//! has SP_TEST_HOOKS=1 (single_instance.rs).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Runtime};

static ASLEEP: AtomicBool = AtomicBool::new(false);

/// Between willSleep and didWake: nothing reconnects (supervisor.rs asks).
pub fn asleep() -> bool {
    ASLEEP.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Power {
    Sleep,
    Wake,
}

impl Power {
    pub fn parse(s: &str) -> Option<Power> {
        match s {
            "sleep" => Some(Power::Sleep),
            "wake" => Some(Power::Wake),
            _ => None,
        }
    }
}

/// What sleep and wake do, from the OS or from a test: the shell's own actions (the
/// streams are its), logged here.
pub fn on_power<R: Runtime>(app: &AppHandle<R>, p: Power) {
    ASLEEP.store(p == Power::Sleep, Ordering::SeqCst);
    match p {
        Power::Sleep => {
            log::info!(target: "sessionpipe::power", "will sleep: closing the native streams");
            crate::actions::on_sleep(app);
        }
        Power::Wake => {
            log::info!(target: "sessionpipe::power", "did wake: reconnecting, the page resyncs");
            crate::actions::on_wake(app);
        }
    }
}

/// Registers for NSWorkspace's sleep and wake notifications for the life of the app.
#[cfg(target_os = "macos")]
pub fn observe<R: Runtime>(app: AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    for (name, p) in [
        // SAFETY: framework-provided static NSString constants.
        (unsafe { NSWorkspaceWillSleepNotification }, Power::Sleep),
        (unsafe { NSWorkspaceDidWakeNotification }, Power::Wake),
    ] {
        let app = app.clone();
        let block = RcBlock::new(move |_n: NonNull<NSNotification>| on_power(&app, p));
        // SAFETY: no object filter, no queue (delivered on the posting thread, the main
        // thread for NSWorkspace); the block owns a clone of the app handle.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // Observed for the life of the process.
        std::mem::forget(token);
    }
    log::info!(target: "sessionpipe::power", "observing sleep and wake");
}

#[cfg(not(target_os = "macos"))]
pub fn observe<R: Runtime>(_app: AppHandle<R>) {
    // Windows (WM_POWERBROADCAST) and Linux (logind PrepareForSleep) are phase 2; until
    // then the streams' 45 s read-idle limit notices a dead connection after wake.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_tests_send() {
        assert_eq!(Power::parse("sleep"), Some(Power::Sleep));
        assert_eq!(Power::parse("wake"), Some(Power::Wake));
        assert_eq!(Power::parse("hibernate"), None);
    }
}
