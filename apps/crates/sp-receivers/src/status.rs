//! The status file (NATIVE-SPEC.md §11.2): with `SP_SHELL_STATUS=<path>` set, the shell
//! rewrites a small JSON file on every change, for packaging's reliability tests.
//! `{ version, window: "open"|"closed", receivers: [{ id, connected, lastFrameAt }], needsYou, updatedAt }`

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverStatus {
    pub id: String,
    pub connected: bool,
    pub last_frame_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDoc {
    pub version: String,
    pub window: &'static str,
    pub receivers: Vec<ReceiverStatus>,
    pub needs_you: usize,
    pub updated_at: String,
}

struct State {
    window_open: bool,
    receivers: BTreeMap<String, ReceiverStatus>,
    needs_you: BTreeMap<String, usize>,
    last_write: Option<Instant>,
    /// lastFrameAt alone changed: written at most once a second.
    frame_only_dirty: bool,
}

pub struct StatusFile {
    path: Option<PathBuf>,
    version: String,
    state: Mutex<State>,
}

pub fn iso_now() -> String {
    iso(SystemTime::now())
}

/// RFC 3339 UTC with milliseconds, without a date crate.
pub fn iso(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let ms = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{ms:03}Z")
}

impl StatusFile {
    pub fn new(path: Option<PathBuf>, version: &str) -> Self {
        StatusFile {
            path,
            version: version.into(),
            state: Mutex::new(State {
                window_open: false,
                receivers: BTreeMap::new(),
                needs_you: BTreeMap::new(),
                last_write: None,
                frame_only_dirty: false,
            }),
        }
    }

    pub fn from_env(version: &str) -> Self {
        Self::new(
            std::env::var_os("SP_SHELL_STATUS")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty()),
            version,
        )
    }

    pub fn set_window(&self, open: bool) {
        let mut s = self.state.lock().unwrap();
        if s.window_open != open {
            s.window_open = open;
            self.write(&mut s);
        }
    }

    pub fn set_receiver(&self, id: &str, connected: bool) {
        let mut s = self.state.lock().unwrap();
        let e = s.receivers.entry(id.into()).or_insert(ReceiverStatus {
            id: id.into(),
            connected: false,
            last_frame_at: None,
        });
        if e.connected != connected {
            e.connected = connected;
            self.write(&mut s);
        }
    }

    pub fn remove_receiver(&self, id: &str) {
        let mut s = self.state.lock().unwrap();
        s.needs_you.remove(id);
        if s.receivers.remove(id).is_some() {
            self.write(&mut s);
        }
    }

    pub fn frame(&self, id: &str) {
        let mut s = self.state.lock().unwrap();
        let e = s.receivers.entry(id.into()).or_insert(ReceiverStatus {
            id: id.into(),
            connected: true,
            last_frame_at: None,
        });
        e.last_frame_at = Some(iso_now());
        let recent = s
            .last_write
            .is_some_and(|t| t.elapsed() < Duration::from_secs(1));
        if recent {
            s.frame_only_dirty = true;
        } else {
            self.write(&mut s);
        }
    }

    pub fn set_needs_you(&self, id: &str, n: usize) {
        let mut s = self.state.lock().unwrap();
        if s.needs_you.get(id) != Some(&n) {
            s.needs_you.insert(id.into(), n);
            self.write(&mut s);
        }
    }

    /// Writes a pending lastFrameAt-only change (call now and then).
    pub fn flush(&self) {
        let mut s = self.state.lock().unwrap();
        if s.frame_only_dirty {
            self.write(&mut s);
        }
    }

    pub fn doc(&self) -> StatusDoc {
        let s = self.state.lock().unwrap();
        self.doc_of(&s)
    }

    fn doc_of(&self, s: &State) -> StatusDoc {
        StatusDoc {
            version: self.version.clone(),
            window: if s.window_open { "open" } else { "closed" },
            receivers: s.receivers.values().cloned().collect(),
            needs_you: s.needs_you.values().sum(),
            updated_at: iso_now(),
        }
    }

    fn write(&self, s: &mut State) {
        s.last_write = Some(Instant::now());
        s.frame_only_dirty = false;
        let Some(p) = &self.path else { return };
        let doc = self.doc_of(s);
        if let Err(e) =
            crate::registry::write_atomic(p, &serde_json::to_vec_pretty(&doc).expect("json"))
        {
            log::warn!("status file {}: {e}", p.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn iso_formats() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_millis(1_761_350_400_123)),
            "2025-10-25T00:00:00.123Z"
        );
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn writes_on_every_change() {
        let t = TempDir::new("status");
        let p = t.path().join("status.json");
        let f = StatusFile::new(Some(p.clone()), "0.2.0");
        let read =
            || serde_json::from_slice::<serde_json::Value>(&std::fs::read(&p).unwrap()).unwrap();
        f.set_window(true);
        assert_eq!(read()["window"], "open");
        assert_eq!(read()["version"], "0.2.0");
        f.set_receiver("abc", true);
        f.set_needs_you("abc", 2);
        let v = read();
        assert_eq!(v["needsYou"], 2);
        assert_eq!(v["receivers"][0]["id"], "abc");
        assert_eq!(v["receivers"][0]["connected"], true);
        f.frame("abc");
        f.flush();
        assert!(read()["receivers"][0]["lastFrameAt"].is_string());
        f.set_window(false);
        f.set_receiver("abc", false);
        let v = read();
        assert_eq!(v["window"], "closed");
        assert_eq!(v["receivers"][0]["connected"], false);
        assert!(v["updatedAt"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn no_path_no_file() {
        let f = StatusFile::new(None, "x");
        f.set_window(true);
        assert_eq!(f.doc().window, "open");
    }
}
