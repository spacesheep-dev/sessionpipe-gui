//! The receivers the person added (NATIVE-SPEC.md §1.3), kept in `<home>/receivers.json`,
//! and their UI keys: the Keychain (service `<bundle id>.receivers`, account `<id>`), or
//! `<home>/keys.json` when SP_SHELL_HOME is set (dev: nothing is left in the keychain).

use crate::id::{canonical_origin, is_loopback_origin, receiver_id};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receiver {
    pub id: String,
    pub name: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lan_origins: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_sha256: Option<String>,
    pub local: bool,
}

impl Receiver {
    /// A receiver from a URL the person gave (a phone QR link works: its `?k=` is the key).
    /// Returns the receiver and the key found in the URL, if any.
    pub fn from_url(url: &str) -> Option<(Receiver, Option<String>)> {
        let origin = canonical_origin(url)?;
        let key = url::Url::parse(url.trim())
            .ok()
            .and_then(|u| {
                u.query_pairs()
                    .find(|(k, _)| k == "k")
                    .map(|(_, v)| v.into_owned())
            })
            .filter(|k| !k.is_empty());
        let host = url::Url::parse(&origin).ok()?.host_str()?.to_string();
        Some((
            Receiver {
                id: receiver_id(&origin),
                name: host,
                local: is_loopback_origin(&origin),
                origin,
                lan_origins: vec![],
                ca_sha256: None,
            },
            key,
        ))
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReceiversFile {
    #[serde(default)]
    receivers: Vec<Receiver>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active: Option<String>,
}

pub struct Registry {
    path: PathBuf,
    file: ReceiversFile,
}

impl Registry {
    pub fn load(home: &Path) -> Registry {
        let path = home.join("receivers.json");
        let file = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<ReceiversFile>(&b).ok())
            .unwrap_or_default();
        Registry { path, file }
    }

    pub fn list(&self) -> &[Receiver] {
        &self.file.receivers
    }

    pub fn active(&self) -> Option<&str> {
        self.file.active.as_deref()
    }

    pub fn set_active(&mut self, id: Option<&str>) -> std::io::Result<()> {
        self.file.active = id.map(str::to_string);
        self.save()
    }

    /// Adds or replaces (same id) a receiver and saves.
    pub fn upsert(&mut self, r: Receiver) -> std::io::Result<()> {
        match self.file.receivers.iter_mut().find(|x| x.id == r.id) {
            Some(x) => *x = r,
            None => self.file.receivers.push(r),
        }
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> std::io::Result<bool> {
        let n = self.file.receivers.len();
        self.file.receivers.retain(|r| r.id != id);
        if self.file.active.as_deref() == Some(id) {
            self.file.active = None;
        }
        let removed = n != self.file.receivers.len();
        self.save()?;
        Ok(removed)
    }

    fn save(&self) -> std::io::Result<()> {
        write_atomic(
            &self.path,
            &serde_json::to_vec_pretty(&self.file).expect("json"),
        )
    }
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Where UI keys live.
pub enum KeyStore {
    /// `<dir>/keys.json` (dev, SP_SHELL_HOME set).
    File(PathBuf),
    /// The login keychain, service `<bundle id>.receivers`, account = receiver id.
    Keychain { service: String },
    /// Tests.
    Memory(std::sync::Mutex<BTreeMap<String, String>>),
}

impl KeyStore {
    pub fn memory() -> KeyStore {
        KeyStore::Memory(Default::default())
    }

    fn read_file(path: &Path) -> BTreeMap<String, String> {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<String> {
        match self {
            KeyStore::File(p) => Self::read_file(p).remove(id),
            KeyStore::Memory(m) => m.lock().unwrap().get(id).cloned(),
            KeyStore::Keychain { service } => keychain::get(service, id),
        }
    }

    pub fn set(&self, id: &str, key: &str) -> std::io::Result<()> {
        match self {
            KeyStore::File(p) => {
                let mut all = Self::read_file(p);
                all.insert(id.into(), key.into());
                write_atomic(p, &serde_json::to_vec_pretty(&all).expect("json"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
                }
                Ok(())
            }
            KeyStore::Memory(m) => {
                m.lock().unwrap().insert(id.into(), key.into());
                Ok(())
            }
            KeyStore::Keychain { service } => keychain::set(service, id, key),
        }
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        match self {
            KeyStore::File(p) => {
                let mut all = Self::read_file(p);
                if all.remove(id).is_some() {
                    write_atomic(p, &serde_json::to_vec_pretty(&all).expect("json"))?;
                }
                Ok(())
            }
            KeyStore::Memory(m) => {
                m.lock().unwrap().remove(id);
                Ok(())
            }
            KeyStore::Keychain { service } => keychain::delete(service, id),
        }
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub fn get(service: &str, account: &str) -> Option<String> {
        get_generic_password(service, account)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    }
    pub fn set(service: &str, account: &str, key: &str) -> std::io::Result<()> {
        set_generic_password(service, account, key.as_bytes()).map_err(std::io::Error::other)
    }
    pub fn delete(service: &str, account: &str) -> std::io::Result<()> {
        match delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            // errSecItemNotFound: nothing to delete.
            Err(e) if e.code() == -25300 => Ok(()),
            Err(e) => Err(std::io::Error::other(e)),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    // Windows / Linux credential stores come with their CI builds; until then keys stay
    // in memory for the session.
    pub fn get(_: &str, _: &str) -> Option<String> {
        None
    }
    pub fn set(_: &str, _: &str, _: &str) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "no credential store on this platform yet",
        ))
    }
    pub fn delete(_: &str, _: &str) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn from_url_reads_the_phone_link() {
        let (r, k) = Receiver::from_url("http://192.168.1.9:7373/?k=abc123").unwrap();
        assert_eq!(r.origin, "http://192.168.1.9:7373");
        assert_eq!(k.as_deref(), Some("abc123"));
        assert!(!r.local);
        assert_eq!(r.name, "192.168.1.9");
        assert_eq!(r.id.len(), 10);
        let (l, k) = Receiver::from_url("http://127.0.0.1:7811").unwrap();
        assert!(l.local && k.is_none());
        assert!(Receiver::from_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn registry_round_trips() {
        let t = TempDir::new("registry");
        let mut reg = Registry::load(t.path());
        assert!(reg.list().is_empty());
        let (r, _) = Receiver::from_url("https://studio-mac.local:7373").unwrap();
        reg.upsert(r.clone()).unwrap();
        reg.set_active(Some(&r.id)).unwrap();
        let again = Registry::load(t.path());
        assert_eq!(again.list(), std::slice::from_ref(&r));
        assert_eq!(again.active(), Some(r.id.as_str()));
        let mut again = again;
        assert!(again.remove(&r.id).unwrap());
        assert_eq!(Registry::load(t.path()).active(), None);
    }

    #[test]
    fn file_keys_round_trip() {
        let t = TempDir::new("keys");
        let ks = KeyStore::File(t.path().join("keys.json"));
        assert_eq!(ks.get("a"), None);
        ks.set("a", "k1").unwrap();
        ks.set("b", "k2").unwrap();
        assert_eq!(ks.get("a").as_deref(), Some("k1"));
        ks.delete("a").unwrap();
        assert_eq!(ks.get("a"), None);
        assert_eq!(ks.get("b").as_deref(), Some("k2"));
    }
}
