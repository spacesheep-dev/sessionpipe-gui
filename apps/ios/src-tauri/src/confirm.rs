//! Native confirmation (a UIAlertController): nothing the page asks for adds a receiver
//! without the person saying so in UI the page can't draw or click (NATIVE-SPEC §1.3).

use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub title: String,
    pub message: String,
    pub ok: &'static str,
    pub cancel: &'static str,
}

/// The words for adding a receiver: its address as the person will see it in the list.
pub fn add_receiver(origin: &str, pinned: bool) -> Ask {
    let host = origin.split("://").nth(1).unwrap_or(origin);
    let mut message = format!("This iPhone will show the sessions on {host}.");
    if pinned {
        message.push_str(" Its certificate is pinned to the one in the link.");
    }
    Ask {
        title: "Connect to this receiver?".into(),
        message,
        ok: "Connect",
        cancel: "Cancel",
    }
}

/// Shows the alert over the app and waits for the answer. False when it can't be shown.
pub async fn ask<R: Runtime>(app: &AppHandle<R>, a: &Ask) -> bool {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("main") else {
            return false;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let a = a.clone();
        let shown = win.with_webview(move |pv| {
            crate::uikit::alert(pv.inner() as *mut objc2::runtime::AnyObject, &a, tx)
        });
        if shown.is_err() {
            return false;
        }
        // Simulator builds only: a scripted run (SP_CONFIRM=yes, the simulator has no
        // scriptable taps) sees the alert for 2 s, then it is answered for it. A device
        // build always waits for the person.
        #[cfg(target_env = "sim")]
        if std::env::var("SP_CONFIRM").as_deref() == Ok("yes") {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let _ = win.with_webview(|pv| {
                crate::uikit::dismiss_alert(pv.inner() as *mut objc2::runtime::AnyObject)
            });
            return true;
        }
        rx.await.unwrap_or(false)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, a);
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn says_where_and_never_shows_the_key() {
        let a = super::add_receiver("https://studio-mac.tail1234.ts.net", true);
        assert_eq!(a.title, "Connect to this receiver?");
        assert_eq!(a.message, "This iPhone will show the sessions on studio-mac.tail1234.ts.net. Its certificate is pinned to the one in the link.");
        assert_eq!(
            super::add_receiver("http://192.168.1.4:7373", false).message,
            "This iPhone will show the sessions on 192.168.1.4:7373."
        );
    }
}
