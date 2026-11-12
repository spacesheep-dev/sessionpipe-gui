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
        // Whose account was approved, and where: the person sees it before this phone
        // keeps it. The host first, on a line of its own, then the address (cut in the
        // middle when long, so neither can push the other out of sight), then what
        // saying yes does. Only spacesheep.dev is called a spacesheep account.
        Question::Attach {
            email,
            host,
            origin,
        } => (
            if origin == sp_receivers::account::DEFAULT_ORIGIN {
                "Use this spacesheep account?".to_string()
            } else {
                "Use this account?".to_string()
            },
            format!(
                "{host}\n{}\n{device} will show its sessions.",
                sp_receivers::account::shown_email(email)
            ),
            "Use it",
        ),
        Question::Disconnect {
            email, documents, ..
        } => (
            format!("Disconnect {}?", sp_receivers::account::shown_email(email)),
            if *documents {
                format!("Labels and read marks kept on {this_device} for it are removed.")
            } else {
                format!("{device} stops showing its sessions.")
            },
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

/// Shows the alert over the app and waits for the answer: `Some(true)` for the button
/// that goes ahead, `Some(false)` for Cancel. `None` when it could not be shown (another
/// alert of the app's is already up, there is no window to show it over): that is not
/// an answer, and whoever asked decides what an unasked question means.
pub async fn ask<R: Runtime>(app: &AppHandle<R>, a: &Ask) -> Option<bool> {
    let _turn = Turn::take()?;
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("main") else {
            return None;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let a = a.clone();
        let shown = win.with_webview(move |pv| {
            crate::uikit::alert(pv.inner() as *mut objc2::runtime::AnyObject, &a, tx)
        });
        if shown.is_err() {
            return None;
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
            return Some(true);
        }
        rx.await.ok()
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
        rx.await.ok()
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, a);
        None
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
        let attach = |origin: &str, host: &str, email: &str| Question::Attach {
            email: email.into(),
            origin: origin.into(),
            host: host.into(),
        };
        let disconnect = |documents: bool| Question::Disconnect {
            email: "misha@example.com".into(),
            origin: "https://spacesheep.dev".into(),
            host: "spacesheep.dev".into(),
            documents,
        };
        let a = super::for_question(Os::Ios, &origin);
        assert_eq!(a.title, "Use an account on this server?");
        assert_eq!(a.message, "This iPhone will ask stagesheep.dev for an account and show its sessions. It is not spacesheep.dev: continue only if you know this server.");
        assert_eq!((a.cancel, a.ok), ("Cancel", "Continue"));

        // On spacesheep.dev: named so. The host, then the address, then what yes does.
        let here = attach(
            "https://spacesheep.dev",
            "spacesheep.dev",
            "misha@example.com",
        );
        let a = super::for_question(Os::Ios, &here);
        assert_eq!(a.title, "Use this spacesheep account?");
        assert_eq!(
            a.message,
            "spacesheep.dev\nmisha@example.com\nThis iPhone will show its sessions."
        );
        assert_eq!((a.cancel, a.ok), ("Cancel", "Use it"));
        assert_eq!(
            super::for_question(Os::Android, &here).message,
            "spacesheep.dev\nmisha@example.com\nThis phone will show its sessions."
        );
        // Anywhere else the title does not say whose server it is; the first line does.
        for (origin, host) in [
            ("https://stagesheep.dev", "stagesheep.dev"),
            (
                "https://spacesheep.dev.evil.example",
                "spacesheep.dev.evil.example",
            ),
            ("http://localhost:8841", "localhost:8841"),
        ] {
            let a = super::for_question(Os::Ios, &attach(origin, host, "misha@example.com"));
            assert_eq!(a.title, "Use this account?", "{origin}");
            assert_eq!(
                a.message,
                format!("{host}\nmisha@example.com\nThis iPhone will show its sessions.")
            );
        }
        // The longest address there can be takes one line, cut in its middle: the host
        // stays the first thing read, and the last line stays in sight.
        let long = format!("{}@{}", "a".repeat(64), "d".repeat(190));
        let a = super::for_question(
            Os::Ios,
            &attach("https://spacesheep.dev", "spacesheep.dev", &long),
        );
        let lines: Vec<&str> = a.message.split('\n').collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "spacesheep.dev");
        assert_eq!(lines[1].chars().count(), 60);
        assert!(lines[1].contains('…'));
        assert_eq!(lines[2], "This iPhone will show its sessions.");

        let a = super::for_question(Os::Ios, &disconnect(true));
        assert_eq!(a.title, "Disconnect misha@example.com?");
        assert_eq!(
            a.message,
            "Labels and read marks kept on this iPhone for it are removed."
        );
        assert_eq!((a.cancel, a.ok), ("Cancel", "Disconnect"));
        let a = super::for_question(Os::Ios, &disconnect(false));
        assert_eq!(a.title, "Disconnect misha@example.com?");
        assert_eq!(a.message, "This iPhone stops showing its sessions.");
        assert_eq!(
            super::for_question(Os::Android, &disconnect(true)).message,
            "Labels and read marks kept on this phone for it are removed."
        );
        assert_eq!(
            super::for_question(Os::Android, &disconnect(false)).message,
            "This phone stops showing its sessions."
        );
        // Cancel is the preferred action of every one of them, on both phones; adding a
        // receiver keeps the button it had.
        for os in [Os::Ios, Os::Android] {
            for q in [&origin, &here, &disconnect(true), &disconnect(false)] {
                assert!(super::for_question(os, q).prefer_cancel);
            }
        }
        assert!(!super::add_receiver(Os::Ios, "http://192.168.1.4:7373", false).prefer_cancel);
    }
}
