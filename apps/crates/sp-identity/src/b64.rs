//! base64url without padding, as every sessionpipe field is written; SHA-256.
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use sha2::{Digest, Sha256};

pub fn enc(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

/// Strict: base64url alphabet, no padding.
pub fn dec(s: &str) -> Option<Vec<u8>> {
    if !s
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return None;
    }
    URL_SAFE_NO_PAD.decode(s).ok()
}

/// Standard base64 with padding: how blobs sit in the keychain record.
pub fn std_enc(b: &[u8]) -> String {
    STANDARD.encode(b)
}
pub fn std_dec(s: &str) -> Option<Vec<u8>> {
    STANDARD.decode(s).ok()
}

pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

/// The base64url characters only (a nonce, a key id): `min..=max` of them.
pub fn is_b64url(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
