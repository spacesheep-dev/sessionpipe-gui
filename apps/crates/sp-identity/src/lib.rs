//! sessionpipe's native signer (NATIVE-SPEC.md §5, arch-identity §6).
//!
//! The app signs control commands with a **device key** (sessionpipe CONTROL.md §2): a P-256
//! key made in the Secure Enclave that won't sign without Touch ID (or the password), every
//! time. It vouches once a day for a **day key** (also in the enclave, no prompt) through a
//! grant string this crate writes itself; each command is then signed by the day key.
//!
//! Only Rust and Swift touch keys. The webview asks through five plugin commands, scoped to
//! the bundled main window ([`plugin`]); before anything is signed, Rust checks the command
//! ([`validate`]), the receiver's rp id against its own URL ([`rp`]), the rate limits
//! ([`rate`]), and writes the Touch ID prompt itself ([`prompt`]). Notification actions
//! answer natively through [`answer`].
//!
//! The crate never talks to the network itself: the shell hands it a [`ReceiverLookup`].

pub mod answer;
pub mod b64;
pub mod caller;
pub mod device;

pub mod prompt;
pub mod rate;
pub mod rp;
pub mod se;
pub mod signer;
pub mod validate;
pub mod vault;

#[cfg(feature = "plugin")]
pub mod plugin;

use std::future::Future;
use std::pin::Pin;

pub use answer::{answer, NativeAnswer};
#[cfg(feature = "plugin")]
pub use plugin::init;
pub use signer::Signer;

/// A future the shell's lookup returns.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A receiver the person added in the app, as the shell knows it. The webview can't add one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverRef {
    pub id: String,
    /// `http(s)://host[:port]`, the receiver Rust talks to.
    pub origin: String,
    /// `Info.control.rpId`, once the receiver answered.
    pub rp_id: Option<String>,
    /// Found on this Mac's loopback by the shell itself.
    pub local: bool,
}

/// What the shell gives the signer: its receivers, and GET / POST through its own network
/// layer (the `rx:` protocol's client, with the receiver's key and pinned CA).
pub trait ReceiverLookup: Send + Sync + 'static {
    fn receiver(&self, id: &str) -> Option<ReceiverRef>;
    fn get(&self, id: &str, path: &str) -> BoxFuture<'_, Result<Vec<u8>>>;
    fn post_json(
        &self,
        id: &str,
        path: &str,
        body: Vec<u8>,
    ) -> BoxFuture<'_, Result<(u16, Vec<u8>)>>;
}

/// Why the signer said no. `code` is stable (the page maps it to words); the message is
/// for the person. Serialised to the webview as `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    /// A refusal of the command or the request itself.
    pub fn refused(message: impl Into<String>) -> Self {
        Self::new("refused", message)
    }
    /// The shell's network layer failed.
    pub fn network(message: String) -> Self {
        Self::new("failed", message)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}
