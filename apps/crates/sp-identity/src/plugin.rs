//! The Tauri plugin `identity` (NATIVE-SPEC §5.5, §11.3): `plugin:identity|status`, `key`,
//! `sign`, `pair` and `forget`. Scoped by capabilities/identity.json to the main window with
//! no remote URL, and each handler checks the calling webview's label and origin again
//! (caller.rs). The page never gets a private key, a blob or the grant's private half.
use crate::answer::{self, blocking, SIGNER};
use crate::se::Enclave;
use crate::signer::{Signer, Status};
use crate::validate::Mode;
use crate::vault::{Keychain, Memory, Vault};
use crate::{caller, device::DeviceKey, Error, ReceiverLookup};
use serde_json::Value;
use std::sync::Arc;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State, Webview};

struct Shared {
    signer: Arc<Signer>,
    lookup: Arc<dyn ReceiverLookup>,
    dev_url: Option<String>,
}

fn gate<R: Runtime>(w: &Webview<R>, s: &Shared) -> Result<(), Error> {
    let url = w.url().map(|u| u.to_string()).unwrap_or_default();
    caller::allowed(
        w.label(),
        &url,
        s.dev_url.as_deref(),
        cfg!(debug_assertions),
    )
}

#[tauri::command]
async fn status<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Shared>,
    receiver: String,
    rp: Option<String>,
) -> Result<Status, Error> {
    gate(&webview, &state)?;
    let t = answer::target(state.lookup.as_ref(), &receiver, rp.as_deref()).await?;
    Ok(state.signer.status(&t.rp))
}

#[tauri::command]
async fn key<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Shared>,
    receiver: String,
    rp: Option<String>,
) -> Result<DeviceKey, Error> {
    gate(&webview, &state)?;
    let t = answer::target(state.lookup.as_ref(), &receiver, rp.as_deref()).await?;
    let s = state.signer.clone();
    blocking(move || s.key(&t.rp)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sign<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Shared>,
    receiver: String,
    rp: Option<String>,
    cmd: Option<String>,
    mode: String,
    fresh: Option<bool>,
) -> Result<Value, Error> {
    gate(&webview, &state)?;
    let mode = match mode.as_str() {
        "grant" => Mode::Grant,
        "confirm" => Mode::Confirm,
        _ => return Err(Error::refused("mode is grant or confirm")),
    };
    let t = answer::target(state.lookup.as_ref(), &receiver, rp.as_deref()).await?;
    // The machine's name for a confirm's prompt, read by Rust from the receiver.
    let machine = match (
        &mode,
        cmd.as_deref()
            .and_then(|c| serde_json::from_str::<Value>(c).ok()),
    ) {
        (Mode::Confirm, Some(v)) => match v["machine"].as_str() {
            Some(m) => answer::machine_name(state.lookup.as_ref(), &receiver, m).await,
            None => String::new(),
        },
        _ => String::new(),
    };
    let s = state.signer.clone();
    blocking(move || {
        s.sign(
            &t.rp,
            &t.host,
            cmd.as_deref(),
            mode,
            fresh.unwrap_or(false),
            &machine,
        )
    })
    .await
}

#[tauri::command]
async fn pair<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Shared>,
    receiver: String,
    code: String,
) -> Result<Value, Error> {
    gate(&webview, &state)?;
    let t = answer::target(state.lookup.as_ref(), &receiver, None).await?;
    let p = answer::pairing(state.lookup.as_ref(), &receiver, &code).await?;
    if p.rp != t.rp {
        return Err(Error::new(
            "rp_mismatch",
            "the pairing is for another rp id than its receiver",
        ));
    }
    let s = state.signer.clone();
    blocking(move || s.pair(&t.rp, &p.machine_id, &p.machine_name, &code, &p.check)).await
}

#[tauri::command]
async fn forget<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Shared>,
    receiver: String,
    rp: Option<String>,
) -> Result<(), Error> {
    gate(&webview, &state)?;
    let t = answer::target(state.lookup.as_ref(), &receiver, rp.as_deref()).await?;
    state.signer.forget(&t.rp)
}

/// The plugin. Keys live in the login keychain under `<identifier>.identity`; a debug
/// build keeps the day key and grant in memory only (each launch: one Touch ID).
pub fn init<R: Runtime>(lookup: Arc<dyn ReceiverLookup>) -> TauriPlugin<R> {
    Builder::new("identity")
        .invoke_handler(tauri::generate_handler![status, key, sign, pair, forget])
        .setup(move |app, _api| {
            let id = app.config().identifier.clone();
            let devices: Arc<dyn Vault> = Arc::new(Keychain::for_app(&id));
            let days: Arc<dyn Vault> = if cfg!(debug_assertions) {
                Arc::new(Memory::default())
            } else {
                Arc::new(Keychain::for_app(&id))
            };
            let signer = Arc::new(Signer::new(Arc::new(Enclave::default()), devices, days));
            let _ = SIGNER.set(signer.clone());
            let dev_url = app.config().build.dev_url.as_ref().map(|u| u.to_string());
            app.manage(Shared {
                signer,
                lookup,
                dev_url,
            });
            Ok(())
        })
        .build()
}
