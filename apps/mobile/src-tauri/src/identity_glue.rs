//! The phone's side of the signer (NATIVE-SPEC §5.5): sp-identity takes a `ReceiverLookup`
//! the shell implements over the Hub, the same as the Mac app's identity_glue. iOS only:
//! the device key lives in the iPhone's Secure Enclave and Face ID (or the passcode)
//! signs each command; the Swift half is the crate's, built by its build.rs for iOS.
use sp_receivers::Hub;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tauri::Runtime;

type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The Hub, as sp-identity sees it.
pub struct Lookup(pub Hub);

impl sp_identity::ReceiverLookup for Lookup {
    fn receiver(&self, id: &str) -> Option<sp_identity::ReceiverRef> {
        self.0.receiver(id).map(|r| sp_identity::ReceiverRef {
            id: r.id,
            origin: r.origin,
            rp_id: r.rp_id,
            local: r.local,
        })
    }
    fn get(&self, id: &str, path: &str) -> Fut<'_, sp_identity::Result<Vec<u8>>> {
        let (id, path) = (id.to_string(), path.to_string());
        Box::pin(async move {
            self.0
                .get(&id, &path)
                .await
                .map_err(sp_identity::Error::network)
        })
    }
    fn post_json(
        &self,
        id: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Fut<'_, sp_identity::Result<(u16, Vec<u8>)>> {
        let (id, path) = (id.to_string(), path.to_string());
        Box::pin(async move {
            self.0
                .post_json(&id, &path, body)
                .await
                .map_err(sp_identity::Error::network)
        })
    }
}

pub fn init<R: Runtime>(app: &mut tauri::App<R>, hub: Hub) -> tauri::Result<()> {
    app.handle()
        .plugin(sp_identity::init(Arc::new(Lookup(hub))))?;
    Ok(())
}
