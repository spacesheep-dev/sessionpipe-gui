//! `plugin:identity|status` for the phone apps. The real signer is identity's crate
//! (sp-identity, macOS). Here no key is ever made: the simulator can't make a key that
//! checks the person (`.userPresence` fails with LAError -1020, NATIVE-SPEC §5.4), and a
//! device build has no signer yet. The gate is the build target, never
//! `SecureEnclave.isAvailable` (which says yes in the simulator).

use serde::Serialize;
use tauri::{plugin::TauriPlugin, Runtime, Webview};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub available: bool,
    /// Why not, in the words the page shows (web/src/control/nativeSigner.ts).
    pub reason: &'static str,
    /// The same, for code: `simulator` | `unsupported`.
    pub code: &'static str,
}

/// Why this build can't sign.
pub const fn current() -> Status {
    #[cfg(all(target_os = "ios", target_env = "sim"))]
    return Status {
        available: false,
        reason: "Sending needs a real iPhone",
        code: "simulator",
    };
    #[cfg(not(all(target_os = "ios", target_env = "sim")))]
    return Status {
        available: false,
        reason: "Sending from this phone comes in a later version",
        code: "unsupported",
    };
}

/// Only the bundled main window may ask (arch-identity §6.2, defence in depth on top of
/// the capability).
fn trusted<R: Runtime>(w: &Webview<R>) -> bool {
    w.label() == "main"
        && w.url()
            .map(|u| {
                u.port().is_none()
                    && u.host_str()
                        .map(|h| format!("{}://{h}", u.scheme()))
                        .as_deref()
                        == Some(crate::contract::Os::current().app_origin())
            })
            .unwrap_or(false)
}

#[tauri::command]
fn status<R: Runtime>(webview: Webview<R>, rp: Option<String>) -> Result<Status, String> {
    let _ = rp; // one answer for every receiver on this build
    if !trusted(&webview) {
        return Err("forbidden".into());
    }
    Ok(current())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("identity")
        .invoke_handler(tauri::generate_handler![status])
        .build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn never_available_here() {
        let s = super::current();
        assert!(!s.available);
        assert_eq!(serde_json::to_value(&s).unwrap()["available"], false);
    }
}
