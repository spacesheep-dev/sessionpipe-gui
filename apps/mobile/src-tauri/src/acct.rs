//! The page's commands for a spacesheep account (docs/rfcs/08, "The phone on an
//! account"). Each is the Hub's own (`sp_receivers`, where the rules and their tests
//! are); this file only checks who is asking. Nothing here takes or returns the account's
//! key: the page gets digits to show, a link to open, an email, a state.

use serde_json::Value;
use sp_receivers::{AccountStatus, ConnectView, Disconnected, Hub, HubEvent, Problem};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview};

/// The bundled page in the main window, and nothing else: its label, and where it is
/// (the main window never leaves the bundled origin, `contract::navigation`; this checks
/// it again where the account is concerned).
fn gate<R: Runtime>(w: &Webview<R>) -> Result<(), Problem> {
    let here = w.url().ok().is_some_and(|u| {
        u.port().is_none()
            && u.host_str()
                .map(|h| format!("{}://{h}", u.scheme()))
                .as_deref()
                == Some(crate::contract::Os::current().app_origin())
    });
    if w.label() == "main" && here {
        Ok(())
    } else {
        Err(Problem::new(
            "forbidden",
            "Only the app's own page may ask.",
        ))
    }
}

/// The accounts here, each with its state, and the connect in progress (or the last
/// one's outcome).
#[tauri::command]
pub fn acct_status<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
) -> Result<AccountStatus, Problem> {
    gate(&webview)?;
    Ok(hub.account_status())
}

/// Asks spacesheep (`origin`, or spacesheep.dev) for a connect code. The page shows the
/// digits and opens the link with `app_open_external`; the Hub polls until the person
/// answers there, and says so in the `account` event and `acct_status`. On `approved` the
/// page calls `rx_select` with the receiver id it was given, as after `rx_add`.
#[tauri::command]
pub async fn acct_connect_start<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    origin: Option<String>,
) -> Result<ConnectView, Problem> {
    gate(&webview)?;
    hub.account_connect_start(origin.as_deref()).await
}

/// Stops a pending connect (true), or clears a finished one's outcome (false).
#[tauri::command]
pub fn acct_connect_cancel<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
) -> Result<bool, Problem> {
    gate(&webview)?;
    Ok(hub.account_connect_cancel())
}

/// Forgets the account on this phone: its key, its documents, its entry. The answer says
/// what that does not do (the key works until it is revoked on spacesheep) and where to
/// do it. When it was the one the window shows, the page calls `rx_select` for another
/// receiver or reloads to the welcome, as after `rx_remove`.
#[tauri::command]
pub fn acct_disconnect<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
) -> Result<Disconnected, Problem> {
    gate(&webview)?;
    hub.account_disconnect(&id)
}

/// One of the account's documents, or null.
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
pub fn acct_doc_delete<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, Hub>,
    id: String,
    name: String,
) -> Result<bool, Problem> {
    gate(&webview)?;
    hub.account_doc_delete(&id, &name)
}

/// Tells the page whenever what `acct_status` says changed: the `account` event carries
/// the same value, so a page waiting for a connect needs no timer of its own.
pub fn watch<R: Runtime>(app: &AppHandle<R>, hub: Hub) {
    let app = app.clone();
    let mut events = hub.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(HubEvent::Account) => {}
                // Fell behind: say how it is now rather than nothing.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Ok(_) => continue,
                Err(_) => return,
            }
            let status = app.state::<Hub>().account_status();
            let _ = app.emit_to("main", "account", status);
        }
    });
}
