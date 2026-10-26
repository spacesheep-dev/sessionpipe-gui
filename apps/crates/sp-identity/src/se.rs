//! The hardware, behind a trait so the signer's logic is tested without an enclave, a
//! keychain or a finger. `Enclave` is the real one (swift/Identity.swift through a C ABI,
//! macOS only); elsewhere `Enclave` answers "unavailable".
use crate::Error;

/// What the signer needs from the platform.
pub trait Hardware: Send + Sync + 'static {
    /// A presence-gated hardware key can be made here (never in a simulator).
    fn available(&self) -> bool;
    /// A new key: `(blob, spki)`. `uv`: Touch ID (or the password) for every use.
    fn make(&self, uv: bool) -> Result<(Vec<u8>, Vec<u8>), Error>;
    /// Raw r‖s over `msg`. A presence key shows the system sheet with `reason`.
    fn sign(&self, blob: &[u8], msg: &[u8], reason: Option<&str>) -> Result<[u8; 64], Error>;
    fn random(&self, n: usize) -> Vec<u8>;
}

pub const SPID_OK: i32 = 0;
pub const SPID_CANCELLED: i32 = 1;
pub const SPID_LOCKOUT: i32 = 2;
pub const SPID_UNAVAILABLE: i32 = 3;
pub const SPID_FAILED: i32 = 4;
pub const SPID_NOT_INTERACTIVE: i32 = 5;
pub const SPID_NOT_FOUND: i32 = 6;

pub fn status_error(code: i32) -> Error {
    match code {
        SPID_CANCELLED => Error::new("cancelled", "Touch ID was cancelled"),
        SPID_LOCKOUT => Error::new("lockout", "Touch ID is locked"),
        SPID_UNAVAILABLE => Error::new(
            "unavailable",
            "no Secure Enclave with Touch ID or a password here",
        ),
        SPID_NOT_INTERACTIVE => Error::new(
            "cancelled",
            "the key needs the person, and no prompt may show",
        ),
        _ => Error::new("failed", format!("the Secure Enclave said no ({code})")),
    }
}

#[cfg(spid_swift)]
pub(crate) mod ffi {
    use std::os::raw::c_char;
    extern "C" {
        pub fn spid_available() -> i32;
        pub fn spid_make(
            uv: i32,
            blob: *mut u8,
            blob_cap: isize,
            blob_len: *mut isize,
            spki: *mut u8,
            spki_cap: isize,
            spki_len: *mut isize,
        ) -> i32;
        pub fn spid_sign(
            blob: *const u8,
            blob_len: isize,
            msg: *const u8,
            msg_len: isize,
            reason: *const c_char,
            interactive: i32,
            sig: *mut u8,
        ) -> i32;
        pub fn spid_verify(
            spki: *const u8,
            spki_len: isize,
            msg: *const u8,
            msg_len: isize,
            sig: *const u8,
        ) -> i32;
        pub fn spid_random(out: *mut u8, n: isize) -> i32;
        pub fn spid_kc_set(
            service: *const c_char,
            account: *const c_char,
            data: *const u8,
            len: isize,
        ) -> i32;
        pub fn spid_kc_get(
            service: *const c_char,
            account: *const c_char,
            out: *mut u8,
            cap: isize,
            out_len: *mut isize,
        ) -> i32;
        pub fn spid_kc_delete(service: *const c_char, account: *const c_char) -> i32;
    }
}

/// The Secure Enclave, through CryptoKit.
#[derive(Debug, Default)]
pub struct Enclave {
    available: std::sync::OnceLock<bool>,
}

#[cfg(spid_swift)]
impl Hardware for Enclave {
    fn available(&self) -> bool {
        // Making a throwaway presence key shows no prompt; once per process is enough.
        *self
            .available
            .get_or_init(|| unsafe { ffi::spid_available() } == 1)
    }

    fn make(&self, uv: bool) -> Result<(Vec<u8>, Vec<u8>), Error> {
        let mut blob = vec![0u8; 1024];
        let mut spki = vec![0u8; 256];
        let (mut bl, mut sl) = (0isize, 0isize);
        let rc = unsafe {
            ffi::spid_make(
                uv as i32,
                blob.as_mut_ptr(),
                blob.len() as isize,
                &mut bl,
                spki.as_mut_ptr(),
                spki.len() as isize,
                &mut sl,
            )
        };
        if rc == SPID_NOT_INTERACTIVE {
            return Err(Error::new(
                "unavailable",
                "unlock this Mac first: a key can't be made while it is locked",
            ));
        }
        if rc != SPID_OK {
            return Err(status_error(rc));
        }
        blob.truncate(bl as usize);
        spki.truncate(sl as usize);
        Ok((blob, spki))
    }

    fn sign(&self, blob: &[u8], msg: &[u8], reason: Option<&str>) -> Result<[u8; 64], Error> {
        let reason = reason.map(|r| std::ffi::CString::new(r.replace('\0', "")).expect("no NUL"));
        let mut sig = [0u8; 64];
        let rc = unsafe {
            ffi::spid_sign(
                blob.as_ptr(),
                blob.len() as isize,
                msg.as_ptr(),
                msg.len() as isize,
                reason.as_ref().map_or(std::ptr::null(), |r| r.as_ptr()),
                reason.is_some() as i32,
                sig.as_mut_ptr(),
            )
        };
        if rc != SPID_OK {
            return Err(status_error(rc));
        }
        Ok(sig)
    }

    fn random(&self, n: usize) -> Vec<u8> {
        let mut out = vec![0u8; n];
        let rc = unsafe { ffi::spid_random(out.as_mut_ptr(), n as isize) };
        assert_eq!(rc, SPID_OK, "SecRandomCopyBytes failed");
        out
    }
}

#[cfg(not(spid_swift))]
impl Hardware for Enclave {
    fn available(&self) -> bool {
        let _ = &self.available;
        false
    }
    fn make(&self, _uv: bool) -> Result<(Vec<u8>, Vec<u8>), Error> {
        Err(status_error(SPID_UNAVAILABLE))
    }
    fn sign(&self, _blob: &[u8], _msg: &[u8], _reason: Option<&str>) -> Result<[u8; 64], Error> {
        Err(status_error(SPID_UNAVAILABLE))
    }
    fn random(&self, n: usize) -> Vec<u8> {
        // Only reached where nothing can be signed anyway; still never predictable.
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let s = std::collections::hash_map::RandomState::new();
            out.extend_from_slice(&std::hash::BuildHasher::hash_one(&s, out.len()).to_le_bytes());
        }
        out.truncate(n);
        out
    }
}

/// Does `sig` verify over `msg` for `spki`? (CryptoKit; tests and self-checks only.)
#[cfg(spid_swift)]
pub fn verify(spki: &[u8], msg: &[u8], sig: &[u8; 64]) -> bool {
    unsafe {
        ffi::spid_verify(
            spki.as_ptr(),
            spki.len() as isize,
            msg.as_ptr(),
            msg.len() as isize,
            sig.as_ptr(),
        ) == 1
    }
}

#[cfg(all(test, spid_swift, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::device::{self, Purpose};

    /// A real enclave key with NO presence flag (nobody is at the sensor tonight): made,
    /// used and verified, never stored anywhere. A presence key would hang waiting for a
    /// finger; that path is the morning's manual check.
    #[test]
    fn enclave_makes_and_signs_without_presence() {
        let se = Enclave::default();
        let (blob, spki) = match se.make(false) {
            Ok(k) => k,
            // No enclave (CI), or this Mac is locked (nobody at it tonight): nothing to test.
            Err(e) if e.code == "unavailable" => {
                eprintln!("SKIPPED enclave test: {}", e.message);
                return;
            }
            Err(e) => panic!("{e}"),
        };
        assert!(spki.len() >= 91, "an SPKI");
        let msg = device::message(Purpose::Confirm, "localhost", &crate::b64::sha256(b"cmd"));
        let t = std::time::Instant::now();
        let sig = se
            .sign(&blob, &msg, None)
            .expect("a no-presence key signs with no prompt");
        let ms = t.elapsed().as_millis();
        assert!(verify(&spki, &msg, &sig));
        assert!(!verify(&spki, b"another message", &sig));
        eprintln!("enclave csig: {ms} ms, key id {}", device::key_id(&spki));
        assert_eq!(se.random(32).len(), 32);
        assert_ne!(se.random(16), se.random(16));
    }
}
