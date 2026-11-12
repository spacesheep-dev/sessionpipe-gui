//! Native confirmation (a UIAlertController on iOS, the system dialog on Android): nothing
//! the page asks for adds a receiver
//! without the person saying so in UI the page can't draw or click (NATIVE-SPEC §1.3).

use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub title: String,
    pub message: String,
    pub ok: &'static str,
    pub cancel: &'static str,
    /// Cancel is the alert's preferred action (the one in bold, the one the return key
    /// of a keyboard gives), not the button that goes ahead.
    pub prefer_cancel: bool,
}

/// The words for adding a receiver: its address as the person will see it in the list.
pub fn add_receiver(os: crate::contract::Os, origin: &str, pinned: bool) -> Ask {
    let host = origin.split("://").nth(1).unwrap_or(origin);
    let device = match os {
        crate::contract::Os::Ios => "This iPhone",
        crate::contract::Os::Android => "This phone",
    };
    let mut message = format!("{device} will show the sessions on {host}.");
    if pinned {
        message.push_str(" Its certificate is pinned to the one in the link.");
    }
    Ask {
        title: "Connect to this receiver?".into(),
        message,
        ok: "Connect",
        cancel: "Cancel",
        prefer_cancel: false,
    }
}

/// The words for a question the Hub asks about a spacesheep account (docs/rfcs/08,
/// `sp_receivers::Question`). In each, Cancel is the answer a stray tap or the return key
/// gives; nothing is kept, replaced or removed unless the other button is pressed.
pub fn for_question(os: crate::contract::Os, q: &sp_receivers::Question) -> Ask {
    use sp_receivers::Question;
    let (device, this_device) = match os {
        crate::contract::Os::Ios => ("This iPhone", "this iPhone"),
        crate::contract::Os::Android => ("This phone", "this phone"),
    };
    let (title, message, ok) = match q {
        // spacesheep.dev confirms a connect on its own page; another server's confirm
        // page is that server's, so the person is asked here first.
        Question::Origin { host, .. } => (
            "Use an account on this server?".to_string(),
            format!("{device} will ask {host} for an account and show its sessions. It is not spacesheep.dev: continue only if you know this server."),
            "Continue",
        ),
        // Whose account was approved: the person sees it before this phone keeps it.
        Question::Attach { email, host, .. } => (
            "Use this spacesheep account?".to_string(),
            format!("{email} on {host}. {device} will show its sessions."),
            "Use it",
        ),
        Question::Disconnect { email, .. } => (
            format!("Disconnect {email}?"),
            format!("Labels and read marks kept on {this_device} for it are removed."),
            "Disconnect",
        ),
    };
    Ask {
        title,
        message,
        ok,
        cancel: "Cancel",
        prefer_cancel: true,
    }
}

/// An alert of this app's is on the screen. A second one meanwhile is not shown and not
/// queued: its answer is no (`ask`), whoever asked for it.
static OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Takes the one place there is for an alert, until dropped. None while it is taken.
pub(crate) struct Turn;

impl Turn {
    pub(crate) fn take() -> Option<Turn> {
        (!OPEN.swap(true, std::sync::atomic::Ordering::SeqCst)).then_some(Turn)
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Shows the alert over the app and waits for the answer. False when it can't be shown,
/// and when another alert of the app's is already up.
pub async fn ask<R: Runtime>(app: &AppHandle<R>, a: &Ask) -> bool {
    let Some(_turn) = Turn::take() else {
        return false;
    };
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
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(&a.message)
            .title(&a.title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                a.ok.into(),
                a.cancel.into(),
            ))
            .show(move |ok| {
                let _ = tx.send(ok);
            });
        rx.await.unwrap_or(false)
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, a);
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn says_where_and_never_shows_the_key() {
        use crate::contract::Os;
        let a = super::add_receiver(Os::Ios, "https://studio-mac.tail1234.ts.net", true);
        assert_eq!(a.title, "Connect to this receiver?");
        assert_eq!(a.message, "This iPhone will show the sessions on studio-mac.tail1234.ts.net. Its certificate is pinned to the one in the link.");
        assert_eq!(
            super::add_receiver(Os::Ios, "http://192.168.1.4:7373", false).message,
            "This iPhone will show the sessions on 192.168.1.4:7373."
        );
        assert_eq!(
            super::add_receiver(Os::Android, "http://192.168.1.4:7373", false).message,
            "This phone will show the sessions on 192.168.1.4:7373."
        );
    }

    /// One alert at a time: while one is up the place is taken, and free again after.
    #[test]
    fn there_is_one_place_for_an_alert() {
        let first = super::Turn::take().expect("free");
        assert!(super::Turn::take().is_none(), "a second one is refused");
        drop(first);
        assert!(
            super::Turn::take().is_some(),
            "free again once the first is answered"
        );
    }

    /// Every sentence a person reads about an account, on both phones.
    #[test]
    fn the_account_questions_in_words() {
        use crate::contract::Os;
        use sp_receivers::Question;
        let origin = Question::Origin {
            origin: "https://stagesheep.dev".into(),
            host: "stagesheep.dev".into(),
        };
        let attach = Question::Attach {
            email: "misha@example.com".into(),
            origin: "https://spacesheep.dev".into(),
            host: "spacesheep.dev".into(),
        };
        let disconnect = Question::Disconnect {
            email: "misha@example.com".into(),
            origin: "https://spacesheep.dev".into(),
            host: "spacesheep.dev".into(),
        };
        let a = super::for_question(Os::Ios, &origin);
        assert_eq!(a.title, "Use an account on this server?");
        assert_eq!(a.message, "This iPhone will ask stagesheep.dev for an account and show its sessions. It is not spacesheep.dev: continue only if you know this server.");
        assert_eq!((a.cancel, a.ok), ("Cancel", "Continue"));
        let a = super::for_question(Os::Ios, &attach);
        assert_eq!(a.title, "Use this spacesheep account?");
        assert_eq!(
            a.message,
            "misha@example.com on spacesheep.dev. This iPhone will show its sessions."
        );
        assert_eq!((a.cancel, a.ok), ("Cancel", "Use it"));
        let a = super::for_question(Os::Ios, &disconnect);
        assert_eq!(a.title, "Disconnect misha@example.com?");
        assert_eq!(
            a.message,
            "Labels and read marks kept on this iPhone for it are removed."
        );
        assert_eq!((a.cancel, a.ok), ("Cancel", "Disconnect"));
        assert_eq!(
            super::for_question(Os::Android, &attach).message,
            "misha@example.com on spacesheep.dev. This phone will show its sessions."
        );
        assert_eq!(
            super::for_question(Os::Android, &disconnect).message,
            "Labels and read marks kept on this phone for it are removed."
        );
        // Cancel is the preferred action of every one of them, on both phones; adding a
        // receiver keeps the button it had.
        for os in [Os::Ios, Os::Android] {
            for q in [&origin, &attach, &disconnect] {
                assert!(super::for_question(os, q).prefer_cancel);
            }
        }
        assert!(!super::add_receiver(Os::Ios, "http://192.168.1.4:7373", false).prefer_cancel);
    }
}
