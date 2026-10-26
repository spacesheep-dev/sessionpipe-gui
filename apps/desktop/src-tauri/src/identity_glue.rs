//! The shell's side of the signer (NATIVE-SPEC.md §5.5, §11.3): sp-identity takes a
//! `ReceiverLookup` the shell implements over the Hub, and the shell calls
//! `sp_identity::answer` from notification actions. Behind the `identity` cargo feature
//! (off by default); without it the app has no signer and notifications carry no actions.

/// An answer from a notification, before identity's types are in play.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Permission {
        machine: String,
        session: String,
        attention_id: String,
        allow: bool,
    },
    Reply {
        machine: String,
        session: String,
        text: String,
    },
}

/// Whether this build can sign at all.
pub const HAS_SIGNER: bool = cfg!(feature = "identity");

#[cfg(not(feature = "identity"))]
pub fn init<R: tauri::Runtime>(_app: &mut tauri::App<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(feature = "identity"))]
pub async fn answer(_hub: &sp_receivers::Hub, _rx: &str, _a: Answer) -> Result<(), String> {
    Err("this build has no signer".into())
}

#[cfg(feature = "identity")]
mod imp {
    use super::Answer;
    use sp_receivers::Hub;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use tauri::{Manager, Runtime};

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

    pub fn init<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
        let hub = app.state::<crate::Shell>().hub.clone();
        app.handle()
            .plugin(sp_identity::init(Arc::new(Lookup(hub))))?;
        Ok(())
    }

    pub async fn answer(hub: &Hub, rx: &str, a: Answer) -> Result<(), String> {
        let lookup = Lookup(hub.clone());
        let native = match a {
            Answer::Permission {
                machine,
                session,
                attention_id,
                allow,
            } => sp_identity::NativeAnswer::Permission {
                machine,
                session,
                attention_id,
                decision: if allow { "allow".into() } else { "deny".into() },
            },
            Answer::Reply {
                machine,
                session,
                text,
            } => sp_identity::NativeAnswer::Reply {
                machine,
                session,
                text,
            },
        };
        sp_identity::answer(&lookup, rx, native)
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(feature = "identity")]
pub use imp::{answer, init, Lookup};
