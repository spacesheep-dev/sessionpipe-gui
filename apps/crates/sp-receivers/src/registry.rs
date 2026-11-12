//! The receivers the person added (NATIVE-SPEC.md §1.3), kept in `<home>/receivers.json`,
//! and their UI keys: the Keychain (service `<bundle id>.receivers`, account `<id>`), or
//! `<home>/keys.json` when SP_SHELL_HOME is set (dev: nothing is left in the keychain).
//!
//! A receiver has a kind. An ordinary one is a sessionpipe-gui server; a spacesheep account
//! (docs/rfcs/08, `account.rs`) sits in the same list and can be the active one, but
//! nothing that speaks to a receiver speaks to it: its key has its own name in the key
//! store, and the Hub forwards only its doors.

use crate::id::{account_id, canonical_origin, is_loopback_origin, receiver_id};
use crate::keychain;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What an entry of the list is. A file written before kinds existed has none: a receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A sessionpipe-gui server.
    #[default]
    Receiver,
    /// A spacesheep account: the Hub holds its key and forwards its doors.
    Spacesheep,
    /// A kind a newer version wrote. Kept as it is in the file and never spoken to, so an
    /// older build neither loses the list nor treats the entry as a receiver.
    #[serde(other)]
    Unknown,
}

impl Kind {
    fn is_receiver(&self) -> bool {
        *self == Kind::Receiver
    }
}

/// What the list keeps about a spacesheep account. Never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Whose account, for display.
    pub email: String,
    pub connected_at: String,
    /// spacesheep answered 401 to the key and nothing has succeeded since.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unauthorized: bool,
    /// The rp id spacesheep signs for, as its machines door last said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rp_id: Option<String>,
}

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
    #[serde(default, skip_serializing_if = "Kind::is_receiver")]
    pub kind: Kind,
    /// Set exactly when `kind` is `Spacesheep`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
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
                kind: Kind::Receiver,
                account: None,
            },
            key,
        ))
    }

    /// A spacesheep account at `origin` (already cleaned, `account::clean_origin`). It is
    /// never `local`: nothing about it is trusted for being on loopback.
    pub fn account(origin: &str, email: &str, connected_at: &str) -> Option<Receiver> {
        let host = url::Url::parse(origin).ok()?.host_str()?.to_string();
        Some(Receiver {
            id: account_id(origin, email),
            name: host,
            origin: origin.to_string(),
            lan_origins: vec![],
            ca_sha256: None,
            local: false,
            kind: Kind::Spacesheep,
            account: Some(Account {
                email: email.to_string(),
                connected_at: connected_at.to_string(),
                unauthorized: false,
                rp_id: None,
            }),
        })
    }

    pub fn is_account(&self) -> bool {
        self.kind == Kind::Spacesheep && self.account.is_some()
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

    /// Adds or replaces (same id) a receiver and saves. An entry never changes kind: an
    /// id is 50 bits of a hash, and a link can choose its origin, so a receiver whose id
    /// met an account's must not take its place (and with it, its name in the key store).
    pub fn upsert(&mut self, r: Receiver) -> std::io::Result<()> {
        match self.file.receivers.iter_mut().find(|x| x.id == r.id) {
            Some(x) if x.kind != r.kind => {
                return Err(std::io::Error::other(
                    "that id belongs to an entry of another kind",
                ))
            }
            Some(x) => *x = r,
            None => self.file.receivers.push(r),
        }
        self.save()
    }

    /// Changes one entry in place and saves; false when there is none.
    pub fn update(&mut self, id: &str, f: impl FnOnce(&mut Receiver)) -> std::io::Result<bool> {
        let Some(x) = self.file.receivers.iter_mut().find(|x| x.id == id) else {
            return Ok(false);
        };
        let before = x.clone();
        f(x);
        if *x == before {
            return Ok(true);
        }
        self.save()?;
        Ok(true)
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

/// `write_atomic` for a file that holds a secret or the person's own notes: it is its
/// owner's alone from the moment it exists, not from a moment after it was written.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        // A leftover of the same name would keep the mode it had.
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        drop(f);
        std::fs::rename(&tmp, path)
    }
    #[cfg(not(unix))]
    write_atomic(path, bytes)
}

/// The name an account's key has in a key store. A receiver's key is under its bare id
/// (ten characters of base32); nothing that looks a key up by id can reach this one.
pub fn account_key_name(id: &str) -> String {
    format!("acct:{id}")
}

/// Where keys live: a receiver's UI key, a spacesheep account's API key.
pub enum KeyStore {
    /// `<dir>/keys.json`, readable by its owner alone (dev with SP_SHELL_HOME set; the
    /// phones' receiver keys; an account's key on Android, where it is the app's private
    /// storage and nothing stronger).
    File(PathBuf),
    /// The system keychain (`keychain.rs`): service `<bundle id>.receivers` for receiver
    /// keys on a Mac, `<bundle id>.account` for an account's key on an iPhone.
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
                write_private(p, &serde_json::to_vec_pretty(&all).expect("json"))
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
                    write_private(p, &serde_json::to_vec_pretty(&all).expect("json"))?;
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

    /// The key file is its owner's alone when it appears and after every change, also
    /// when a looser one was there before.
    #[cfg(unix)]
    #[test]
    fn file_keys_are_their_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempDir::new("keys-mode");
        let p = t.path().join("keys.json");
        let mode = || std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        std::fs::write(&p, b"{}").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        let ks = KeyStore::File(p.clone());
        ks.set("a", "k1").unwrap();
        assert_eq!(mode(), 0o600);
        ks.set(&account_key_name("b"), "k2").unwrap();
        ks.delete("a").unwrap();
        assert_eq!(mode(), 0o600);
        assert_eq!(ks.get("acct:b").as_deref(), Some("k2"));
        assert_eq!(
            ks.get("b"),
            None,
            "an account's key is not under the bare id"
        );
        assert_eq!(
            std::fs::read_dir(t.path()).unwrap().count(),
            1,
            "no temporary file left"
        );
    }

    /// A list written before kinds existed reads as receivers and is written back as it
    /// was; an account's entry says its kind; a kind from a newer version neither breaks
    /// the list nor becomes a receiver.
    #[test]
    fn kinds_in_the_list() {
        let t = TempDir::new("registry-kinds");
        let old = r#"{ "receivers": [ { "id": "abcdefghij", "name": "studio", "origin": "http://192.168.1.9:7373", "local": false } ], "active": "abcdefghij" }"#;
        std::fs::write(t.path().join("receivers.json"), old).unwrap();
        let mut reg = Registry::load(t.path());
        assert_eq!(reg.list()[0].kind, Kind::Receiver);
        assert!(!reg.list()[0].is_account());
        let a = Receiver::account(
            "https://spacesheep.dev",
            "Misha@Example.com",
            "2026-11-12T08:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            a.id,
            account_id("https://spacesheep.dev", "misha@example.com")
        );
        assert_ne!(a.id, receiver_id("https://spacesheep.dev"));
        assert!(a.is_account() && !a.local);
        assert_eq!(a.name, "spacesheep.dev");
        reg.upsert(a.clone()).unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(t.path().join("receivers.json")).unwrap())
                .unwrap();
        assert_eq!(
            v["receivers"][0],
            serde_json::json!({ "id": "abcdefghij", "name": "studio", "origin": "http://192.168.1.9:7373", "local": false }),
            "a receiver's entry gains nothing"
        );
        assert_eq!(v["receivers"][1]["kind"], "spacesheep");
        assert_eq!(v["receivers"][1]["account"]["email"], "Misha@Example.com");
        assert!(v["receivers"][1]["account"].get("unauthorized").is_none());
        // An entry never changes kind, either way.
        let mut as_receiver = a.clone();
        as_receiver.kind = Kind::Receiver;
        as_receiver.account = None;
        assert!(reg.upsert(as_receiver).is_err());
        let mut as_account = a.clone();
        as_account.id = "abcdefghij".into();
        assert!(reg.upsert(as_account).is_err());
        assert_eq!(Registry::load(t.path()).list().len(), 2);
        // update: in place, saved only when something changed.
        assert!(reg
            .update(&a.id, |r| r.account.as_mut().unwrap().unauthorized = true)
            .unwrap());
        assert!(!reg.update("nobody", |_| {}).unwrap());
        assert!(
            Registry::load(t.path()).list()[1]
                .account
                .as_ref()
                .unwrap()
                .unauthorized
        );
        // A newer version's kind.
        let newer = std::fs::read_to_string(t.path().join("receivers.json"))
            .unwrap()
            .replace("\"spacesheep\"", "\"teleport\"");
        std::fs::write(t.path().join("receivers.json"), newer).unwrap();
        let reg = Registry::load(t.path());
        assert_eq!(reg.list().len(), 2, "the list still loads");
        assert_eq!(reg.list()[1].kind, Kind::Unknown);
        assert!(!reg.list()[1].is_account());
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
