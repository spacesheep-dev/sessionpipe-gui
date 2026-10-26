//! sp-receivers: the native apps' network layer (NATIVE-SPEC.md §1, §2.1, §2.2, §11.2).
//!
//! - the receiver list (`receivers.json`) and UI keys (Keychain, or `keys.json` in dev)
//! - discovery of the local receiver (release builds; a debug build only from the
//!   run.json SP_LOCAL_STATE names, for tests)
//! - the `rx:` protocol: the page's requests, forwarded with the `spgui` cookie for
//!   remote receivers and CORS for the bundled origin only
//! - the SSE client: page streams over an IPC channel, and one long-lived menu-bar stream
//!   per receiver (`x-sessionpipe-client: shell`) feeding needs-you
//! - the status file for packaging's reliability tests
//!
//! No Tauri types here: the shell and the iOS app wire it to their own runtime.

pub mod discovery;
mod hub;
pub mod id;
pub mod needs;
pub mod proxy;
pub mod registry;
pub mod sse;
pub mod status;
#[cfg(test)]
pub(crate) mod testutil;

pub use hub::{
    normalise_sha256, Backoff, Hub, HubConfig, HubEvent, ReceiverRef, StreamFrame,
    SHELL_CLIENT_HEADER,
};
pub use needs::{AttentionInfo, NeedsYouItem};
pub use registry::{KeyStore, Receiver};
pub use status::StatusFile;

/// reqwest runs on rustls without a built-in provider (ring, the one the updater already
/// links); install it once per process.
pub fn ensure_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
