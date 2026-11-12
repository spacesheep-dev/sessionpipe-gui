//! The receivers the person added (NATIVE-SPEC.md §1.3), kept in `<home>/receivers.json`,
//! and their UI keys: the Keychain (service `<bundle id>.receivers`, account `<id>`), or
//! `<home>/keys.json` when SP_SHELL_HOME is set (dev: nothing is left in the keychain).
//!
//! A receiver has a kind. An ordinary one is a sessionpipe-gui server; a spacesheep account
//! (docs/rfcs/08, `account.rs`) sits in the same list and can be the active one, but
//! nothing that speaks to a receiver speaks to it: its key has its own name in the key
//! store, and the Hub forwards only its doors.

use crate::id::{
    account_id, canonical_origin, is_account_id, is_loopback_origin, is_receiver_id, receiver_id,
};
use crate::keychain;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What an entry of the list is. A file written before kinds existed has none: a receiver.
/// A kind this version does not know is not here at all: such an entry is kept as the
/// JSON it was (`Registry`), never read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A sessionpipe-gui server.
    #[default]
    Receiver,
    /// A spacesheep account: the Hub holds its key and forwards its doors.
    Spacesheep,
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
    /// The id of this device's own key, once the Hub asked spacesheep to trust it: the
    /// only key the device door is ever asked about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_key_id: Option<String>,
    /// Fields a newer version wrote here, kept and written back as they were.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
    /// Fields a newer version wrote on an entry this version does read: kept, and
    /// written back as they were at every save.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
                extra: Default::default(),
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
                device_key_id: None,
                extra: Default::default(),
            }),
            extra: Default::default(),
        })
    }

    pub fn is_account(&self) -> bool {
        self.kind == Kind::Spacesheep && self.account.is_some()
    }

    /// An entry this version reads: a receiver with a receiver's id and nothing of an
    /// account, or an account with an account's id and its record, which is never
    /// `local` (this version writes no such entry: one that says so was rewritten, to
    /// have the account taken for this computer's own receiver). Anything else in the
    /// file (a newer kind, a field of another shape, an id of neither shape) is not an
    /// entry to this version.
    fn read(entry: &serde_json::Value) -> Option<Receiver> {
        let r: Receiver = serde_json::from_value(entry.clone()).ok()?;
        let ok = match r.kind {
            Kind::Receiver => r.account.is_none() && is_receiver_id(&r.id),
            Kind::Spacesheep => r.account.is_some() && is_account_id(&r.id) && !r.local,
        };
        ok.then_some(r)
    }
}

/// `<home>/receivers.json`: `{ receivers: [...], active? }`.
///
/// What this version does not read is kept as it is. An entry of a kind a newer version
/// wrote stays in the file byte for byte in meaning (the JSON value it was), through every
/// save; it is never listed, never selectable, never spoken to. A top-level field this
/// version does not know is written back too. A file that is not a list at all is never
/// saved over blind: a copy is kept beside it (`receivers.json.bad`) and the list starts
/// empty in memory.
pub struct Registry {
    path: PathBuf,
    receivers: Vec<Receiver>,
    /// Entries kept and not read, in the order they were in.
    raw: Vec<serde_json::Value>,
    active: Option<String>,
    /// Top-level fields this version does not know.
    rest: serde_json::Map<String, serde_json::Value>,
    existed: bool,
}

impl Registry {
    pub fn load(home: &Path) -> Registry {
        let path = home.join("receivers.json");
        let mut reg = Registry {
            path,
            receivers: Vec::new(),
            raw: Vec::new(),
            active: None,
            rest: serde_json::Map::new(),
            existed: false,
        };
        let Ok(bytes) = std::fs::read(&reg.path) else {
            return reg;
        };
        reg.existed = true;
        let top = match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Object(top))
                if top.get("receivers").is_none_or(|r| r.is_array()) =>
            {
                top
            }
            _ => {
                let bad = reg.path.with_extension("json.bad");
                match std::fs::copy(&reg.path, &bad) {
                    Ok(_) => log::warn!(
                        "receivers.json is not a list this version reads; a copy is kept as {}",
                        bad.display()
                    ),
                    Err(e) => log::warn!("receivers.json is unreadable, and no copy was kept: {e}"),
                }
                return reg;
            }
        };
        for (k, v) in top {
            match (k.as_str(), v) {
                ("receivers", serde_json::Value::Array(entries)) => {
                    for e in entries {
                        match Receiver::read(&e) {
                            Some(r) if !reg.receivers.iter().any(|x| x.id == r.id) => {
                                reg.receivers.push(r)
                            }
                            _ => reg.raw.push(e),
                        }
                    }
                }
                ("active", serde_json::Value::String(id)) => reg.active = Some(id),
                ("receivers" | "active", _) => {}
                (_, v) => {
                    reg.rest.insert(k, v);
                }
            }
        }
        reg
    }

    /// Was there a list on disk when this one was loaded (readable or not)? False on the
    /// app's first start in this home.
    pub fn existed(&self) -> bool {
        self.existed
    }

    /// The entries this version reads.
    pub fn list(&self) -> &[Receiver] {
        &self.receivers
    }

    /// How many entries are kept and not read.
    pub fn kept_unread(&self) -> usize {
        self.raw.len()
    }

    pub fn active(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn set_active(&mut self, id: Option<&str>) -> std::io::Result<()> {
        let before = self.snapshot();
        self.active = id.map(str::to_string);
        self.commit(before)
    }

    fn snapshot(&self) -> (Vec<Receiver>, Option<String>) {
        (self.receivers.clone(), self.active.clone())
    }

    /// Saves, or puts the list back as it was: what is in memory is what is on disk,
    /// also when the disk said no.
    fn commit(&mut self, before: (Vec<Receiver>, Option<String>)) -> std::io::Result<()> {
        self.save()
            .inspect_err(|_| (self.receivers, self.active) = before)
    }

    /// Is `id` the id of an entry kept and not read? (It is not free to take.)
    pub fn kept_under(&self, id: &str) -> bool {
        self.raw
            .iter()
            .any(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
    }

    /// Adds or replaces (same id) a receiver and saves. An entry never changes kind, and
    /// never takes the id of one this version keeps without reading.
    pub fn upsert(&mut self, r: Receiver) -> std::io::Result<()> {
        if self.kept_under(&r.id) {
            return Err(std::io::Error::other(
                "that id belongs to an entry this version does not read",
            ));
        }
        let before = self.snapshot();
        match self.receivers.iter_mut().find(|x| x.id == r.id) {
            Some(x) if x.kind != r.kind => {
                return Err(std::io::Error::other(
                    "that id belongs to an entry of another kind",
                ))
            }
            Some(x) => *x = r,
            None => self.receivers.push(r),
        }
        self.commit(before)
    }

    /// Changes one entry in place and saves; false when there is none.
    pub fn update(&mut self, id: &str, f: impl FnOnce(&mut Receiver)) -> std::io::Result<bool> {
        let before = self.snapshot();
        let Some(x) = self.receivers.iter_mut().find(|x| x.id == id) else {
            return Ok(false);
        };
        f(x);
        if self.receivers == before.0 {
            return Ok(true);
        }
        self.commit(before)?;
        Ok(true)
    }

    pub fn remove(&mut self, id: &str) -> std::io::Result<bool> {
        let before = self.snapshot();
        self.receivers.retain(|r| r.id != id);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
        let removed = before.0.len() != self.receivers.len();
        self.commit(before)?;
        Ok(removed)
    }

    /// Writes the list: what this version reads, then what it only keeps.
    pub fn save(&self) -> std::io::Result<()> {
        let mut top = self.rest.clone();
        let mut entries: Vec<serde_json::Value> = self
            .receivers
            .iter()
            .map(|r| serde_json::to_value(r).expect("json"))
            .collect();
        entries.extend(self.raw.iter().cloned());
        top.insert("receivers".into(), serde_json::Value::Array(entries));
        if let Some(a) = &self.active {
            top.insert("active".into(), serde_json::Value::String(a.clone()));
        }
        write_atomic(
            &self.path,
            &serde_json::to_vec_pretty(&serde_json::Value::Object(top)).expect("json"),
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

    /// Empties the store (`keychain::delete_all` says when and why). Only ever called on
    /// a store that holds nothing but account keys.
    pub fn clear_all(&self) -> std::io::Result<()> {
        match self {
            KeyStore::File(p) => match std::fs::remove_file(p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
            KeyStore::Memory(m) => {
                m.lock().unwrap().clear();
                Ok(())
            }
            KeyStore::Keychain { service } => keychain::delete_all(service),
        }
    }

    /// Do two stores keep their keys in the same place? (An account's keys must not be
    /// where a receiver's are: `Hub::new` checks.)
    pub fn same_place(&self, other: &KeyStore) -> bool {
        match (self, other) {
            (KeyStore::File(a), KeyStore::File(b)) => a == b,
            (KeyStore::Keychain { service: a }, KeyStore::Keychain { service: b }) => a == b,
            (KeyStore::Memory(a), KeyStore::Memory(b)) => std::ptr::eq(a, b),
            _ => false,
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

    fn list_on_disk(t: &TempDir) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(t.path().join("receivers.json")).unwrap()).unwrap()
    }

    /// A list written before kinds existed reads as receivers and is written back as it
    /// was; an account's entry says its kind; an entry never changes kind.
    #[test]
    fn kinds_in_the_list() {
        let t = TempDir::new("registry-kinds");
        let old = r#"{ "receivers": [ { "id": "abcdefghij", "name": "studio", "origin": "http://192.168.1.9:7373", "local": false } ], "active": "abcdefghij" }"#;
        std::fs::write(t.path().join("receivers.json"), old).unwrap();
        let mut reg = Registry::load(t.path());
        assert!(reg.existed());
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
        assert_eq!(a.id.len(), 52);
        assert!(a.is_account() && !a.local);
        assert_eq!(a.name, "spacesheep.dev");
        reg.upsert(a.clone()).unwrap();
        let v = list_on_disk(&t);
        assert_eq!(
            v["receivers"][0],
            serde_json::json!({ "id": "abcdefghij", "name": "studio", "origin": "http://192.168.1.9:7373", "local": false }),
            "a receiver's entry gains nothing"
        );
        assert_eq!(v["active"], "abcdefghij");
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
    }

    /// What this version does not read is kept as the JSON it was, through every save: a
    /// newer kind with fields of its own, an account whose record has another shape, an
    /// entry whose id is of neither shape, a top-level field. None of them is an entry
    /// here: not listed, not replaceable by one of the same id.
    #[test]
    fn what_is_not_read_is_kept_as_it_is() {
        let t = TempDir::new("registry-raw");
        let acct = "a".repeat(52);
        let newer = serde_json::json!({
            "id": "teleport2345", "name": "beam", "origin": "https://beam.example", "local": false,
            "kind": "teleport", "beam": { "power": 9, "targets": ["a", "b"] }
        });
        let reshaped = serde_json::json!({
            "id": acct, "name": "spacesheep.dev", "origin": "https://spacesheep.dev", "local": false,
            "kind": "spacesheep", "account": ["of", "another", "shape"]
        });
        let odd_id = serde_json::json!({
            "id": "acct:abcdefghij", "name": "x", "origin": "https://evil.example", "local": false
        });
        let no_record = serde_json::json!({
            "id": acct.replace('a', "b"), "name": "x", "origin": "https://spacesheep.dev",
            "local": false, "kind": "spacesheep"
        });
        // An account that says it is this computer's own receiver: no account is.
        let local_account = serde_json::json!({
            "id": acct.replace('a', "c"), "name": "localhost", "origin": "http://127.0.0.1:7373",
            "local": true, "kind": "spacesheep",
            "account": { "email": "a@b.example", "connectedAt": "then" }
        });
        let plain = serde_json::json!({
            "id": "abcdefghij", "name": "studio", "origin": "http://192.168.1.9:7373", "local": false
        });
        let file = serde_json::json!({
            "receivers": [newer, plain, reshaped, odd_id, no_record, local_account],
            "active": "abcdefghij",
            "schema": { "v": 2 }
        });
        std::fs::write(t.path().join("receivers.json"), file.to_string()).unwrap();
        let mut reg = Registry::load(t.path());
        assert_eq!(reg.list().len(), 1, "one entry this version reads");
        assert_eq!(reg.list()[0].id, "abcdefghij");
        assert_eq!(reg.kept_unread(), 5);
        // Saves of every sort leave them as they were.
        let (r, _) = Receiver::from_url("http://192.168.1.10:7373").unwrap();
        reg.upsert(r.clone()).unwrap();
        reg.set_active(Some(&r.id)).unwrap();
        reg.remove("abcdefghij").unwrap();
        let v = list_on_disk(&t);
        let on_disk = v["receivers"].as_array().unwrap();
        assert_eq!(on_disk.len(), 6);
        for kept in [&newer, &reshaped, &odd_id, &no_record, &local_account] {
            assert!(on_disk.contains(kept), "{kept}");
        }
        assert_eq!(v["schema"], serde_json::json!({ "v": 2 }));
        assert_eq!(v["active"], r.id.as_str());
        // An id that is kept is not one to take.
        let mut thief = Receiver::account("https://spacesheep.dev", "a@b.example", "now").unwrap();
        thief.id = acct.clone();
        assert!(reg.upsert(thief).is_err());
        assert_eq!(Registry::load(t.path()).kept_unread(), 5);
        // The same id twice: the first is the entry, the second is only kept.
        let twice = serde_json::json!({ "receivers": [plain, plain] });
        std::fs::write(t.path().join("receivers.json"), twice.to_string()).unwrap();
        let reg = Registry::load(t.path());
        assert_eq!((reg.list().len(), reg.kept_unread()), (1, 1));
    }

    /// A field a newer version wrote on an entry this version does read (a receiver's,
    /// an account's record's) is kept through every save, beside what this version
    /// changes.
    #[test]
    fn a_newer_field_on_an_entry_that_is_read_survives() {
        let t = TempDir::new("registry-extra");
        let acct = account_id("https://spacesheep.dev", "misha@example.com");
        let file = serde_json::json!({
            "receivers": [
                { "id": "abcdefghij", "name": "studio", "origin": "http://192.168.1.9:7373",
                  "local": false, "pinned": true, "tags": ["work", { "n": 1 }] },
                { "id": acct, "name": "spacesheep.dev", "origin": "https://spacesheep.dev",
                  "local": false, "kind": "spacesheep", "colour": "green",
                  "account": { "email": "misha@example.com", "connectedAt": "then",
                               "plan": { "name": "pro" }, "seats": 3 } }
            ]
        });
        std::fs::write(t.path().join("receivers.json"), file.to_string()).unwrap();
        let mut reg = Registry::load(t.path());
        assert_eq!(
            (reg.list().len(), reg.kept_unread()),
            (2, 0),
            "both are read"
        );
        assert_eq!(reg.list()[0].extra["pinned"], true);
        // Changes of this version's own, and saves of every sort.
        reg.update(&acct, |r| {
            let a = r.account.as_mut().unwrap();
            a.unauthorized = true;
            a.rp_id = Some("spacesheep.dev".into());
        })
        .unwrap();
        reg.update("abcdefghij", |r| r.name = "studio-mac".into())
            .unwrap();
        reg.set_active(Some("abcdefghij")).unwrap();
        let again = reg.list()[1].clone();
        reg.upsert(again).unwrap();
        let v = list_on_disk(&t);
        assert_eq!(v["receivers"][0]["pinned"], true);
        assert_eq!(
            v["receivers"][0]["tags"],
            serde_json::json!(["work", { "n": 1 }])
        );
        assert_eq!(v["receivers"][0]["name"], "studio-mac");
        assert_eq!(v["receivers"][1]["colour"], "green");
        assert_eq!(
            v["receivers"][1]["account"]["plan"],
            serde_json::json!({ "name": "pro" })
        );
        assert_eq!(v["receivers"][1]["account"]["seats"], 3);
        assert_eq!(v["receivers"][1]["account"]["unauthorized"], true);
        assert_eq!(v["receivers"][1]["account"]["rpId"], "spacesheep.dev");
        // And nothing is added to an entry that had none.
        let (plain, _) = Receiver::from_url("http://192.168.1.10:7373").unwrap();
        assert!(plain.extra.is_empty());
        assert_eq!(
            serde_json::to_value(&plain)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            4
        );
    }

    /// A file that is no list is never saved over blind: a copy stays beside it.
    #[test]
    fn an_unreadable_list_is_copied_before_anything_is_saved() {
        for (i, bad) in [
            "{ \"receivers\": [ { \"id\": ",
            "[]",
            "{ \"receivers\": { \"not\": \"a list\" } }",
            "",
        ]
        .iter()
        .enumerate()
        {
            let t = TempDir::new("registry-bad");
            let path = t.path().join("receivers.json");
            std::fs::write(&path, bad).unwrap();
            let mut reg = Registry::load(t.path());
            assert!(reg.existed(), "{i}: there was a list, however broken");
            assert!(reg.list().is_empty());
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                *bad,
                "{i}: untouched by a load"
            );
            let copy = t.path().join("receivers.json.bad");
            assert_eq!(std::fs::read_to_string(&copy).unwrap(), *bad, "{i}");
            let (r, _) = Receiver::from_url("http://192.168.1.10:7373").unwrap();
            reg.upsert(r).unwrap();
            assert_eq!(
                std::fs::read_to_string(&copy).unwrap(),
                *bad,
                "{i}: the copy stays"
            );
            assert_eq!(Registry::load(t.path()).list().len(), 1);
        }
        // No file at all is a first start, and leaves nothing behind.
        let t = TempDir::new("registry-none");
        assert!(!Registry::load(t.path()).existed());
        assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_store_can_be_emptied_and_knows_its_place() {
        let t = TempDir::new("keys-clear");
        let a = KeyStore::File(t.path().join("a.json"));
        let b = KeyStore::File(t.path().join("b.json"));
        a.set("x", "1").unwrap();
        a.clear_all().unwrap();
        assert_eq!(a.get("x"), None);
        assert!(!t.path().join("a.json").exists());
        a.clear_all().unwrap();
        assert!(a.same_place(&KeyStore::File(t.path().join("a.json"))));
        assert!(!a.same_place(&b));
        let m = KeyStore::memory();
        assert!(m.same_place(&m) && !m.same_place(&KeyStore::memory()));
        m.set("x", "1").unwrap();
        m.clear_all().unwrap();
        assert_eq!(m.get("x"), None);
        let k = |s: &str| KeyStore::Keychain { service: s.into() };
        assert!(
            k("a").same_place(&k("a")) && !k("a").same_place(&k("b")) && !k("a").same_place(&a)
        );
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
