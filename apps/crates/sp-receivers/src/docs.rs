//! What the page keeps for a spacesheep account that nothing upstream holds in that mode
//! (docs/rfcs/08): the person's labels and read marks, the sends not yet settled. A few
//! named JSON documents in `<home>/accounts/<account id>/<name>.json`, each within a size
//! limit, read and written whole. They are the account's: another account never reads
//! them, and they are removed when the account is disconnected.
//!
//! Not a database: no partial update, no history, the last write wins. The events
//! themselves are not kept here (the page caches them; losing that cache costs one read
//! of the relay).

use crate::account::Problem;
use crate::registry::write_atomic;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One document, as it is written to disk.
pub const MAX_DOC_BYTES: usize = 1024 * 1024;
/// Documents per account.
pub const MAX_DOCS: usize = 8;

pub struct Docs {
    root: PathBuf,
}

/// A document's name: a lowercase letter, then letters, digits or `-`, 32 at most. Never
/// a path: no dot, no slash.
pub fn is_doc_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// An account id as a folder's name: what `id::account_id` writes and nothing else.
fn is_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn io(e: std::io::Error) -> Problem {
    Problem::new("io", format!("The document could not be kept: {e}"))
}

#[cfg(unix)]
fn owner_only(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn owner_only(_: &Path, _: u32) {}

impl Docs {
    pub fn new(home: &Path) -> Docs {
        Docs {
            root: home.join("accounts"),
        }
    }

    fn dir(&self, id: &str) -> Result<PathBuf, Problem> {
        if !is_id(id) {
            return Err(Problem::new("unknown_account", "No such account."));
        }
        Ok(self.root.join(id))
    }

    fn file(&self, id: &str, name: &str) -> Result<PathBuf, Problem> {
        if !is_doc_name(name) {
            return Err(Problem::new(
                "bad_name",
                "A document's name is a lowercase letter, then up to 31 letters, digits or dashes.",
            ));
        }
        Ok(self.dir(id)?.join(format!("{name}.json")))
    }

    /// The names kept for an account, sorted.
    pub fn names(&self, id: &str) -> Vec<String> {
        let Ok(dir) = self.dir(id) else {
            return vec![];
        };
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().into_string().ok()?;
                n.strip_suffix(".json")
                    .filter(|s| is_doc_name(s))
                    .map(str::to_string)
            })
            .collect();
        v.sort();
        v
    }

    /// The document, or None when there is none (or what is there is not JSON any more).
    pub fn get(&self, id: &str, name: &str) -> Result<Option<Value>, Problem> {
        let path = self.file(id, name)?;
        match std::fs::read(&path) {
            Ok(b) => Ok(serde_json::from_slice(&b).ok()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io(e)),
        }
    }

    /// Writes the document whole; its size on disk. Refused over the size limit, and when
    /// it would be one document too many.
    pub fn set(&self, id: &str, name: &str, value: &Value) -> Result<usize, Problem> {
        let path = self.file(id, name)?;
        let bytes = serde_json::to_vec(value).map_err(|e| io(std::io::Error::other(e)))?;
        if bytes.len() > MAX_DOC_BYTES {
            return Err(Problem::new(
                "too_large",
                format!(
                    "A document is at most {MAX_DOC_BYTES} bytes; this one is {}.",
                    bytes.len()
                ),
            ));
        }
        let names = self.names(id);
        if names.len() >= MAX_DOCS && !names.iter().any(|n| n == name) {
            return Err(Problem::new(
                "too_many",
                format!("An account keeps at most {MAX_DOCS} documents."),
            ));
        }
        let dir = self.dir(id)?;
        std::fs::create_dir_all(&dir).map_err(io)?;
        owner_only(&self.root, 0o700);
        owner_only(&dir, 0o700);
        write_atomic(&path, &bytes).map_err(io)?;
        owner_only(&path, 0o600);
        Ok(bytes.len())
    }

    /// Removes one document; false when there was none.
    pub fn delete(&self, id: &str, name: &str) -> Result<bool, Problem> {
        match std::fs::remove_file(self.file(id, name)?) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(io(e)),
        }
    }

    /// Removes everything kept for an account (it was disconnected).
    pub fn remove_all(&self, id: &str) -> std::io::Result<()> {
        let Ok(dir) = self.dir(id) else {
            return Ok(());
        };
        match std::fs::remove_dir_all(dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use serde_json::json;

    #[test]
    fn documents_round_trip_whole_and_apart_per_account() {
        let t = TempDir::new("docs");
        let d = Docs::new(t.path());
        assert_eq!(d.get("acct000001", "labels").unwrap(), None);
        let labels = json!({ "rev": 3, "names": { "claude:abc": "Fix the café build ✓" } });
        let n = d.set("acct000001", "labels", &labels).unwrap();
        assert_eq!(n, serde_json::to_vec(&labels).unwrap().len());
        d.set("acct000001", "marks", &json!({ "rev": 1 })).unwrap();
        assert_eq!(d.get("acct000001", "labels").unwrap(), Some(labels));
        assert_eq!(d.names("acct000001"), vec!["labels", "marks"]);
        // Another account sees none of it.
        assert_eq!(d.get("acct000002", "labels").unwrap(), None);
        assert!(d.names("acct000002").is_empty());
        // The last write wins, whole.
        d.set("acct000001", "labels", &json!([])).unwrap();
        assert_eq!(d.get("acct000001", "labels").unwrap(), Some(json!([])));
        assert!(d.delete("acct000001", "marks").unwrap());
        assert!(!d.delete("acct000001", "marks").unwrap());
        d.remove_all("acct000001").unwrap();
        assert_eq!(d.get("acct000001", "labels").unwrap(), None);
        assert!(!t.path().join("accounts/acct000001").exists());
        d.remove_all("acct000001").unwrap();
    }

    #[test]
    fn names_are_never_paths() {
        let t = TempDir::new("docs-names");
        let d = Docs::new(t.path());
        for bad in [
            "",
            "Labels",
            "1st",
            "-x",
            "a.b",
            "../x",
            "a/b",
            "a\\b",
            "labels.json",
            "a b",
            "a\0b",
            "é",
            "abcdefghijklmnopqrstuvwxyzabcdefg",
        ] {
            assert_eq!(
                d.set("acct000001", bad, &json!(1)).unwrap_err().code,
                "bad_name",
                "{bad:?}"
            );
            assert_eq!(d.get("acct000001", bad).unwrap_err().code, "bad_name");
            assert_eq!(d.delete("acct000001", bad).unwrap_err().code, "bad_name");
        }
        for bad in ["", "..", "../x", "a/b", "ACCT", "a.b"] {
            assert_eq!(
                d.set(bad, "labels", &json!(1)).unwrap_err().code,
                "unknown_account",
                "{bad:?}"
            );
            assert!(d.names(bad).is_empty());
            d.remove_all(bad).unwrap();
        }
        assert!(
            !t.path().join("accounts").exists(),
            "nothing was written anywhere"
        );
        assert!(is_doc_name("sends") && is_doc_name("read-marks2"));
    }

    #[test]
    fn a_document_has_a_size_and_an_account_a_number_of_them() {
        let t = TempDir::new("docs-caps");
        let d = Docs::new(t.path());
        // A JSON string is its characters and two quotes.
        let fits = json!("a".repeat(MAX_DOC_BYTES - 2));
        assert_eq!(d.set("acct000001", "big", &fits).unwrap(), MAX_DOC_BYTES);
        let over = json!("a".repeat(MAX_DOC_BYTES - 1));
        let e = d.set("acct000001", "big", &over).unwrap_err();
        assert_eq!(e.code, "too_large");
        assert_eq!(
            d.get("acct000001", "big").unwrap(),
            Some(fits),
            "the kept one is untouched"
        );
        for i in 1..MAX_DOCS {
            d.set("acct000001", &format!("d{i}"), &json!(i)).unwrap();
        }
        assert_eq!(d.names("acct000001").len(), MAX_DOCS);
        assert_eq!(
            d.set("acct000001", "one-more", &json!(1)).unwrap_err().code,
            "too_many"
        );
        // One that is there can still be written, and room comes back with a delete.
        d.set("acct000001", "d1", &json!("again")).unwrap();
        assert!(d.delete("acct000001", "d2").unwrap());
        d.set("acct000001", "one-more", &json!(1)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn documents_are_their_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempDir::new("docs-mode");
        let d = Docs::new(t.path());
        d.set("acct000001", "labels", &json!({})).unwrap();
        let mode = |p: &str| {
            std::fs::metadata(t.path().join(p))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("accounts/acct000001/labels.json"), 0o600);
        assert_eq!(mode("accounts/acct000001"), 0o700);
        // No temporary file is left beside it.
        assert_eq!(
            std::fs::read_dir(t.path().join("accounts/acct000001"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn a_file_that_is_not_json_any_more_reads_as_none() {
        let t = TempDir::new("docs-bad");
        let d = Docs::new(t.path());
        d.set("acct000001", "labels", &json!({})).unwrap();
        std::fs::write(t.path().join("accounts/acct000001/labels.json"), b"{").unwrap();
        assert_eq!(d.get("acct000001", "labels").unwrap(), None);
    }
}
