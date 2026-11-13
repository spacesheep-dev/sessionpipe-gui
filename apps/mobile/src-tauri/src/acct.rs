//! The page's commands for a spacesheep account (docs/rfcs/08, "The phone on an
//! account"). Each is the Hub's own (`sp_receivers`, where the rules and their tests
//! are); this file checks who is asking, shows the Hub's questions as native alerts, and
//! does the two things only native code may: open the connect's link, and fetch this
//! device's own key from the signer. Nothing here takes or returns the account's key,
//! the connect's link or a device key: the page gets digits to show, an email, a state.

use serde_json::Value;
use sp_receivers::{
    AccountStatus, Answered, Confirm, ConnectView, DeviceAsked, Disconnected, Hub, HubEvent,
    Problem, Question,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview};

/// Is this the bundled page in the main window? Its label, and where it is: exactly the
/// app's own origin (the main window never leaves it, `contract::navigation`; this checks
/// again where the account is concerned).
pub(crate) fn allowed(label: &str, url: Option<&tauri::Url>, app_origin: &str) -> bool {
    label == "main"
        && url.is_some_and(|u| {
            u.port().is_none()
                && u.username().is_empty()
                && u.host_str()
                    .map(|h| format!("{}://{h}", u.scheme()))
                    .as_deref()
                    == Some(app_origin)
        })
}

fn gate<R: Runtime>(w: &Webview<R>) -> Result<(), Problem> {
    let origin = crate::contract::Os::current().app_origin();
    if allowed(w.label(), w.url().ok().as_ref(), origin) {
        Ok(())
    } else {
        Err(Problem::new(
            "forbidden",
            "Only the app's own page may ask.",
        ))
    }
}

/// The Hub's questions, as native alerts over the app (`confirm.rs` has the words). An
/// alert that cannot be shown is no answer at all (`None`): the Hub holds an approval
/// and asks again rather than take that for a no.
pub struct Alerts<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> Confirm for Alerts<R> {
    fn ask(&self, question: Question) -> Answered {
        let app = self.0.clone();
        Box::pin(async move {
            let words = crate::confirm::for_question(crate::contract::Os::current(), &question);
            crate::confirm::ask(&app, &words).await
        })
    }
}

/// The accounts here, each with its state, and the connect in progress (or the last
/// one's outcome).
#[tauri::command(async)]
pub fn acct_status<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
) -> Result<AccountStatus, Problem> {
    gate(&webview)?;
    Ok(hub.account_status())
}

/// Asks spacesheep (`origin`, or spacesheep.dev) for a connect code. The page shows the
/// digits and calls `acct_connect_open`; the Hub polls until the person answers there,
/// asks them here whose account it is before keeping it, and says how it went in the
/// `account` event and `acct_status`. On `approved` the page calls `rx_select` with the
/// receiver id it was given, as after `rx_add`. For any origin but spacesheep.dev the
/// Hub asks the person before it starts.
#[tauri::command]
pub async fn acct_connect_start<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    origin: Option<String>,
) -> Result<ConnectView, Problem> {
    gate(&webview)?;
    hub.account_connect_start(origin.as_deref()).await
}

/// Opens the pending connect's page in the system browser. The link is the Hub's and
/// goes from there to the browser: the page never holds it (it carries the code, and
/// whoever has the code can have any account approve it). Ok once the system took the
/// link; `not_opened` when it did not, so the page does not say it is waiting for an
/// answer in a browser that never came up.
#[tauri::command]
pub async fn acct_connect_open<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    hub: State<'_, Hub>,
) -> Result<(), Problem> {
    gate(&webview)?;
    let link = hub
        .account_connect_link()
        .ok_or_else(|| Problem::new("no_connect", "No connect is waiting."))?;
    if crate::open_external_told(&app, &link).await {
        Ok(())
    } else {
        Err(Problem::new(NOT_OPENED.0, NOT_OPENED.1))
    }
}

/// `acct_connect_open` when the system browser did not take the link.
pub(crate) const NOT_OPENED: (&str, &str) = ("not_opened", "The browser could not be opened.");

/// Stops a pending connect (true), or clears a finished one's outcome (false).
#[tauri::command]
pub fn acct_connect_cancel<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
) -> Result<bool, Problem> {
    gate(&webview)?;
    Ok(hub.account_connect_cancel())
}

/// Forgets the account on this phone: its key, its documents, its entry. The Hub always
/// asks the person first. The answer says what this does not do
/// (the key works until it is revoked on spacesheep) and where to do it. When it was the
/// one the window shows, the page calls `rx_select` for another receiver or reloads to
/// the welcome.
#[tauri::command]
pub async fn acct_disconnect<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
) -> Result<Disconnected, Problem> {
    gate(&webview)?;
    let gone = hub.account_disconnect(&id).await?;
    // Before the page hears of it: the page it loads next (it reloads itself to the
    // welcome, or to the receiver that is left) must not start on the account that is
    // gone. `watch` does the same on the Hub's events; here it is in line ahead of the
    // answer.
    crate::sync_contract(&app);
    Ok(gone)
}

/// Asks spacesheep to trust this phone's own device key for the account, for the person
/// to approve on its Devices page (the answer has the number shown on both sides). The
/// key comes from the signer, here, natively, and the Hub writes the whole request: the
/// page names no key and no device. iPhone only: Android has no signer yet.
#[tauri::command]
pub async fn acct_device_ask<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
) -> Result<DeviceAsked, Problem> {
    gate(&webview)?;
    #[cfg(target_os = "ios")]
    {
        let lookup = crate::identity_glue::Lookup(hub.inner().clone());
        let key = sp_identity::device_key(&lookup, &id)
            .await
            .map_err(|e| Problem {
                code: "signer",
                message: e.message,
                retry_after_s: None,
                upstream: Some(e.code.to_string()),
            })?;
        let key = serde_json::to_value(&key)
            .map_err(|_| Problem::new("signer", "This phone's key could not be read."))?;
        hub.account_device_ask(&id, &key).await
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (hub, id);
        Err(Problem::new(
            "unsupported",
            "Sending from this phone comes in a later version.",
        ))
    }
}

/// The account's sessions that need the person, handed over by the page that works
/// them out (an account has no stream for the Hub to read them from): every session of
/// its board whose state is `needs_you`, each a cut of its summary. The Hub says them as
/// it says a receiver's, so a notification is posted for one that opens while the app is
/// behind. Listed in the contract as the feature `"account-needs"`. The answer is how
/// many need the person now.
#[tauri::command(async)]
pub fn acct_needs<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
    sessions: Value,
) -> Result<usize, Problem> {
    gate(&webview)?;
    hub.account_needs(&id, sessions)
}

/// One of the account's documents, or null. (The documents' commands read and write a
/// file of up to a megabyte: off the main thread.)
#[tauri::command(async)]
pub fn acct_doc_get<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
    name: String,
) -> Result<Option<Value>, Problem> {
    gate(&webview)?;
    hub.account_doc_get(&id, &name)
}

/// Writes a document whole; its size in bytes.
#[tauri::command(async)]
pub fn acct_doc_set<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
    name: String,
    value: Value,
) -> Result<usize, Problem> {
    gate(&webview)?;
    hub.account_doc_set(&id, &name, &value)
}

/// Removes a document; false when there was none.
#[tauri::command(async)]
pub fn acct_doc_delete<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
    name: String,
) -> Result<bool, Problem> {
    gate(&webview)?;
    hub.account_doc_delete(&id, &name)
}

/// What one of the Hub's events asks of the window: the `account` event said to the
/// page, the contract a reload would read brought up to date, both, or neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Told {
    pub account: bool,
    pub contract: bool,
}

/// An account changed: both. The list changed (a receiver added, removed, renamed, an
/// account's key refused): the contract. Fell behind (`None`): both, as it is now.
pub(crate) fn told_by(event: Option<&HubEvent>) -> Told {
    let (account, contract) = match event {
        None | Some(HubEvent::Account) => (true, true),
        Some(HubEvent::Receivers) => (false, true),
        Some(_) => (false, false),
    };
    Told { account, contract }
}

/// Tells the page whenever what `acct_status` says changed: the `account` event carries
/// the same value, so a page waiting for a connect needs no timer of its own. And keeps
/// the window's contract in step with the list (`sync_contract`), for the page that
/// reloads itself after an account is gone.
pub fn watch<R: Runtime>(app: &AppHandle<R>, hub: Hub) {
    let app = app.clone();
    let mut events = hub.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let told = match events.recv().await {
                Ok(e) => told_by(Some(&e)),
                // Fell behind: say how it is now rather than nothing.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => told_by(None),
                Err(_) => return,
            };
            if told.contract {
                crate::sync_contract(&app);
            }
            if told.account {
                let status = app.state::<Hub>().account_status();
                let _ = app.emit_to("main", "account", status);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{allowed, told_by, Told};
    use crate::contract::Os;
    use sp_receivers::HubEvent;

    /// Which of the Hub's events reach the page as `account`, and which bring the
    /// window's contract up to date.
    #[test]
    fn an_account_event_is_said_and_any_change_of_the_list_renews_the_contract() {
        let both = Told {
            account: true,
            contract: true,
        };
        assert_eq!(told_by(Some(&HubEvent::Account)), both);
        assert_eq!(told_by(None), both, "fell behind: as it is now");
        assert_eq!(
            told_by(Some(&HubEvent::Receivers)),
            Told {
                account: false,
                contract: true
            }
        );
        for quiet in [
            HubEvent::Connected { id: "a".into() },
            HubEvent::Disconnected {
                id: "a".into(),
                retry_in_ms: 0,
            },
            HubEvent::NeedsYou {
                id: "a".into(),
                items: vec![],
            },
        ] {
            assert_eq!(
                told_by(Some(&quiet)),
                Told {
                    account: false,
                    contract: false
                }
            );
        }
        assert_eq!(super::NOT_OPENED.0, "not_opened");
    }

    fn at(url: &str) -> Option<tauri::Url> {
        url.parse().ok()
    }

    /// Who may ask about an account: the main window, on the bundled origin, and nothing
    /// that only resembles either.
    #[test]
    fn only_the_bundled_page_in_the_main_window_may_ask() {
        let ios = Os::Ios.app_origin();
        let android = Os::Android.app_origin();
        assert!(allowed("main", at("tauri://localhost/").as_ref(), ios));
        assert!(allowed(
            "main",
            at("tauri://localhost/s/claude/abc?x=1#y").as_ref(),
            ios
        ));
        assert!(allowed(
            "main",
            at("http://tauri.localhost/inbox").as_ref(),
            android
        ));
        for (label, url, origin) in [
            // Another window, whatever it shows.
            ("view-1", "tauri://localhost/", ios),
            ("Main", "tauri://localhost/", ios),
            ("", "tauri://localhost/", ios),
            // The main window somewhere else.
            ("main", "https://spacesheep.dev/", ios),
            ("main", "https://evil.example/", ios),
            ("main", "tauri://localhost.evil.example/", ios),
            ("main", "tauri://localhost:8080/", ios),
            ("main", "tauri://user@localhost/", ios),
            ("main", "rx://localhost/abc", ios),
            ("main", "about:blank", ios),
            ("main", "data:text/html,x", ios),
            ("main", "http://tauri.localhost/", ios),
            ("main", "https://tauri.localhost/", android),
            ("main", "http://tauri.localhost:8080/", android),
            ("main", "http://tauri.localhost.evil.example/", android),
            ("main", "tauri://localhost/", android),
        ] {
            assert!(!allowed(label, at(url).as_ref(), origin), "{label} {url}");
        }
        assert!(!allowed("main", None, ios), "a window with no address");
    }
}
