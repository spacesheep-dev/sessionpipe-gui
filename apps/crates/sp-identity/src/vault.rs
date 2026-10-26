//! Where key blobs live: the login keychain (generic passwords, service
//! `<bundle id>.identity`, account `<rp>:device` / `<rp>:day`), or memory. Never a plain
//! file: on this Mac an enclave blob is a bearer token for any same-user process
//! (arch-identity F10). The keychain item's default ACL trusts only the app that made it.
use crate::Error;
use std::collections::HashMap;
use std::sync::Mutex;

pub trait Vault: Send + Sync + 'static {
    fn get(&self, account: &str) -> Option<Vec<u8>>;
    fn set(&self, account: &str, data: &[u8]) -> Result<(), Error>;
    fn delete(&self, account: &str) -> Result<(), Error>;
}

/// Held for this process only (dev builds keep the day key here: an ad-hoc build's
/// keychain ACL changes with every rebuild, so each launch costs one Touch ID).
#[derive(Debug, Default)]
pub struct Memory(Mutex<HashMap<String, Vec<u8>>>);

impl Vault for Memory {
    fn get(&self, account: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(account).cloned()
    }
    fn set(&self, account: &str, data: &[u8]) -> Result<(), Error> {
        self.0.lock().unwrap().insert(account.into(), data.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), Error> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// The login keychain.
#[derive(Debug)]
pub struct Keychain {
    pub service: String,
}

impl Keychain {
    /// `<identifier>.identity`, e.g. `dev.spacesheep.sessionpipe.dev-identity.identity`.
    pub fn for_app(identifier: &str) -> Self {
        Self {
            service: format!("{identifier}.identity"),
        }
    }
}

#[cfg(spid_swift)]
impl Vault for Keychain {
    fn get(&self, account: &str) -> Option<Vec<u8>> {
        use crate::se::ffi;
        let (s, a) = (cstr(&self.service), cstr(account));
        let mut buf = vec![0u8; 4096];
        let mut len = 0isize;
        let rc = unsafe {
            ffi::spid_kc_get(
                s.as_ptr(),
                a.as_ptr(),
                buf.as_mut_ptr(),
                buf.len() as isize,
                &mut len,
            )
        };
        if rc != 0 {
            return None;
        }
        buf.truncate(len as usize);
        Some(buf)
    }
    fn set(&self, account: &str, data: &[u8]) -> Result<(), Error> {
        let (s, a) = (cstr(&self.service), cstr(account));
        let rc = unsafe {
            crate::se::ffi::spid_kc_set(s.as_ptr(), a.as_ptr(), data.as_ptr(), data.len() as isize)
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(Error::new("failed", "the keychain refused to keep the key"))
        }
    }
    fn delete(&self, account: &str) -> Result<(), Error> {
        let (s, a) = (cstr(&self.service), cstr(account));
        let rc = unsafe { crate::se::ffi::spid_kc_delete(s.as_ptr(), a.as_ptr()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(Error::new(
                "failed",
                "the keychain refused to delete the key",
            ))
        }
    }
}

#[cfg(spid_swift)]
fn cstr(s: &str) -> std::ffi::CString {
    std::ffi::CString::new(s.replace('\0', "")).expect("no NUL")
}

#[cfg(not(spid_swift))]
impl Vault for Keychain {
    fn get(&self, _account: &str) -> Option<Vec<u8>> {
        None
    }
    fn set(&self, _account: &str, _data: &[u8]) -> Result<(), Error> {
        Err(Error::new("unavailable", "no keychain on this platform"))
    }
    fn delete(&self, _account: &str) -> Result<(), Error> {
        Ok(())
    }
}

/// The two kinds of record, per rp id.
pub fn device_account(rp: &str) -> String {
    format!("{rp}:device")
}
pub fn day_account(rp: &str) -> String {
    format!("{rp}:day")
}

#[cfg(all(test, spid_swift))]
mod tests {
    use super::*;

    /// The login keychain, with a throwaway service of this test's own, emptied before the
    /// test ends (a keychain item needs no prompt to add, read or delete for its maker).
    /// Opt-in (`SPID_KEYCHAIN_TEST=1`): a locked keychain could ask for a password.
    #[test]
    fn keychain_round_trip_and_cleanup() {
        if std::env::var("SPID_KEYCHAIN_TEST").as_deref() != Ok("1") {
            eprintln!("SKIPPED keychain test (set SPID_KEYCHAIN_TEST=1)");
            return;
        }
        let k = Keychain {
            service: format!(
                "dev.spacesheep.sessionpipe.dev-identity.test-{}",
                std::process::id()
            ),
        };
        assert_eq!(k.get("rp:device"), None);
        k.set("rp:device", b"blob-1").unwrap();
        assert_eq!(k.get("rp:device").as_deref(), Some(&b"blob-1"[..]));
        k.set("rp:device", b"blob-2").unwrap();
        assert_eq!(k.get("rp:device").as_deref(), Some(&b"blob-2"[..]));
        k.delete("rp:device").unwrap();
        assert_eq!(k.get("rp:device"), None);
        k.delete("rp:device").unwrap();
    }
}
