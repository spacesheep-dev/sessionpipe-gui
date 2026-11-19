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
    /// The button that goes ahead removes something: drawn as such (red on iOS).
    pub destructive: bool,
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
        destructive: false,
    }
}

/// The words for a question the Hub asks about a spacesheep account (docs/rfcs/08,
/// `sp_receivers::Question`). Nothing is kept, replaced or removed unless the button that
/// goes ahead is pressed. Cancel is the preferred answer where saying yes loses something
/// or the server is not spacesheep.dev; for an approved account that replaces none, the
/// person has just confirmed it on spacesheep, and going ahead is.
pub fn for_question(os: crate::contract::Os, q: &sp_receivers::Question) -> Ask {
    use sp_receivers::Question;
    let device = sp_receivers::account::sentence_start(os.here());
    let (title, message, ok, prefer_cancel) = match q {
        // spacesheep.dev confirms a connect on its own page; another server's confirm
        // page is that server's, so the person is asked here first.
        Question::Origin { host, .. } => (
            "Use an account on this server?".to_string(),
            format!("{device} will ask {host} for an account and show its sessions. It is not spacesheep.dev: continue only if you know this server."),
            "Continue",
            true,
        ),
        // Whose account was approved, in the title (the address cut in the middle when
        // long), and where it is signed in: the person sees both before this phone keeps
        // it. When another account here goes with a yes, that is said too.
        Question::Attach {
            email,
            host,
            replaces,
            ..
        } => (
            format!("Use {}?", sp_receivers::account::shown_email(email)),
            match replaces {
                Some(old) => format!(
                    "Signed in on {host}.\n{} and its labels here go.",
                    sp_receivers::account::shown_email(old)
                ),
                None => format!("Signed in on {host}."),
            },
            "Use it",
            replaces.is_some(),
        ),
        // One sentence whether or not labels were kept: the page removes everything it
        // holds for the account either way, and the key is only forgotten here.
        Question::Disconnect { email, .. } => (
            format!("Disconnect {}?", sp_receivers::account::shown_email(email)),
            format!("{device} forgets the account: its key, its sessions, labels and read marks, drafts and recent searches. The key keeps working until you revoke it on spacesheep."),
            "Disconnect",
            true,
        ),
    };
    Ask {
        title,
        message,
        ok,
        cancel: "Cancel",
        prefer_cancel,
        destructive: matches!(q, Question::Disconnect { .. }),
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
            replaces: None,
        };
        let replacing = |old: &str| Question::Attach {
            email: "misha@example.com".into(),
            origin: "https://spacesheep.dev".into(),
            host: "spacesheep.dev".into(),
            replaces: Some(old.into()),
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

        // Whose account, in the title; where it is signed in, under it. The same words on
        // both phones.
        let here = attach(
            "https://spacesheep.dev",
            "spacesheep.dev",
            "misha@example.com",
        );
        let a = super::for_question(Os::Ios, &here);
        assert_eq!(a.title, "Use misha@example.com?");
        assert_eq!(a.message, "Signed in on spacesheep.dev.");
        assert_eq!((a.cancel, a.ok), ("Cancel", "Use it"));
        assert_eq!(super::for_question(Os::Android, &here), a);
        // Anywhere else, the host it names is that one.
        for (origin, host) in [
            ("https://stagesheep.dev", "stagesheep.dev"),
            (
                "https://spacesheep.dev.evil.example",
                "spacesheep.dev.evil.example",
            ),
            ("http://localhost:8841", "localhost:8841"),
        ] {
            let a = super::for_question(Os::Ios, &attach(origin, host, "misha@example.com"));
            assert_eq!(a.title, "Use misha@example.com?", "{origin}");
            assert_eq!(a.message, format!("Signed in on {host}."));
        }
        // The longest address there can be is cut in its middle: the title stays one
        // address long, and the host stays in sight.
        let long = format!("{}@{}", "a".repeat(64), "d".repeat(190));
        let a = super::for_question(
            Os::Ios,
            &attach("https://spacesheep.dev", "spacesheep.dev", &long),
        );
        assert_eq!(a.title.chars().count(), "Use ?".len() + 60);
        assert!(a.title.contains('…'));
        assert_eq!(a.message, "Signed in on spacesheep.dev.");
        // Another account here goes with a yes: it is named, cut the same way.
        let a = super::for_question(Os::Ios, &replacing("masha@example.com"));
        assert_eq!(a.title, "Use misha@example.com?");
        assert_eq!(
            a.message,
            "Signed in on spacesheep.dev.\nmasha@example.com and its labels here go."
        );
        assert_eq!((a.cancel, a.ok), ("Cancel", "Use it"));
        let a = super::for_question(Os::Ios, &replacing(&long));
        let lines: Vec<&str> = a.message.split('\n').collect();
        let tail = " and its labels here go.";
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].chars().count(), 60 + tail.len());

        // A disconnect says all that goes, and what does not: the same whether or not
        // labels were kept (the page removes what it holds for the account either way).
        for documents in [true, false] {
            let a = super::for_question(Os::Ios, &disconnect(documents));
            assert_eq!(a.title, "Disconnect misha@example.com?");
            assert_eq!(
                a.message,
                "This iPhone forgets the account: its key, its sessions, labels and read marks, drafts and recent searches. The key keeps working until you revoke it on spacesheep."
            );
            assert_eq!((a.cancel, a.ok), ("Cancel", "Disconnect"));
            assert_eq!(
                super::for_question(Os::Android, &disconnect(documents)).message,
                "This phone forgets the account: its key, its sessions, labels and read marks, drafts and recent searches. The key keeps working until you revoke it on spacesheep."
            );
        }
        // Cancel is the preferred action where a yes loses something or the server is not
        // spacesheep.dev, on both phones; an approved account that replaces none prefers
        // Use it, as adding a receiver prefers Connect. Only a disconnect's button is red.
        for os in [Os::Ios, Os::Android] {
            let ask = |q: &Question| super::for_question(os, q);
            assert!(!ask(&here).prefer_cancel, "nothing is lost by a yes");
            assert!(ask(&replacing("masha@example.com")).prefer_cancel);
            assert!(ask(&origin).prefer_cancel);
            for documents in [true, false] {
                assert!(ask(&disconnect(documents)).prefer_cancel);
                assert!(ask(&disconnect(documents)).destructive);
            }
            for q in [&origin, &here, &replacing("masha@example.com")] {
                assert!(!ask(q).destructive);
            }
        }
        let add = super::add_receiver(Os::Ios, "http://192.168.1.4:7373", false);
        assert!(!add.prefer_cancel);
        assert!(!add.destructive);
    }
}
