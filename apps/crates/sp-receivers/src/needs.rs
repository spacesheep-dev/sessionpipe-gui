//! Needs-you, as the receiver computes it: the sessions whose `SessionSummary.state` is
//! `"needs_you"` (shared/api.ts). Read from the stream's `snapshot`, `session`, `event`
//! (which carries the session) and `forgotten` frames. Nothing here re-derives state.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// One open attention, as shared/api.ts `Attention` names its fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionInfo {
    pub attention_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub answerable: bool,
}

/// A session that needs the person, for the menu bar, the badge and notifications.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYouItem {
    /// The receiver id.
    pub receiver: String,
    /// `harness:id` (shared/api.ts `SessionKey`).
    pub session: String,
    pub harness: String,
    pub id: String,
    /// The session's title as the receiver has it; None when it has none.
    pub title: Option<String>,
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub state_since: String,
    pub attentions: Vec<AttentionInfo>,
}

impl NeedsYouItem {
    /// The title as the web shows it (web/src/lib/format.ts `sessionTitle`): the title,
    /// else the folder's name, else the id's first 8 characters.
    pub fn display_title(&self) -> String {
        if let Some(t) = self
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return t.to_string();
        }
        if let Some(c) = self.cwd.as_deref() {
            let c = c.trim_end_matches(['/', '\\']);
            if let Some(b) = c.rsplit(['/', '\\']).next().filter(|b| !b.is_empty()) {
                return b.to_string();
            }
        }
        self.id.chars().take(8).collect()
    }
}

/// The slice of `SessionSummary` read here. Unknown fields are ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLite {
    key: String,
    harness: String,
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    machine: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    state: String,
    #[serde(default)]
    state_since: String,
    #[serde(default)]
    open_attentions: Vec<AttentionInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum Frame {
    #[serde(rename = "snapshot")]
    Snapshot { snapshot: SnapshotLite },
    #[serde(rename = "session")]
    Session { session: SessionLite },
    #[serde(rename = "event")]
    Event { session: SessionLite },
    #[serde(rename = "forgotten")]
    Forgotten { key: String },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct SnapshotLite {
    sessions: Vec<SessionLite>,
}

/// What one frame changed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Change {
    /// The needs-you list changed (membership, order or an attention).
    pub items_changed: bool,
    /// Attention ids that were open before this frame and are not any more.
    pub closed: Vec<String>,
    /// Attention ids that opened with this frame (not on the first snapshot).
    pub opened: Vec<String>,
}

#[derive(Default)]
pub struct NeedsYou {
    receiver: String,
    seeded: bool,
    items: BTreeMap<String, NeedsYouItem>,
}

impl NeedsYou {
    pub fn new(receiver: &str) -> Self {
        Self {
            receiver: receiver.into(),
            seeded: false,
            items: BTreeMap::new(),
        }
    }

    pub fn count(&self) -> usize {
        self.items.len()
    }

    /// Longest waiting first.
    pub fn items(&self) -> Vec<NeedsYouItem> {
        let mut v: Vec<_> = self.items.values().cloned().collect();
        v.sort_by(|a, b| {
            a.state_since
                .cmp(&b.state_since)
                .then_with(|| a.session.cmp(&b.session))
        });
        v
    }

    fn open_ids(&self) -> BTreeSet<String> {
        self.items
            .values()
            .flat_map(|i| i.attentions.iter().map(|a| a.attention_id.clone()))
            .collect()
    }

    /// Applies one stream frame (the JSON of an SSE `data:` line).
    pub fn apply_json(&mut self, data: &str) -> Change {
        match serde_json::from_str::<Frame>(data) {
            Ok(f) => self.apply(f),
            Err(e) => {
                log::debug!("needs-you: unreadable frame: {e}");
                Change::default()
            }
        }
    }

    fn apply(&mut self, f: Frame) -> Change {
        let before_ids = self.open_ids();
        let before: Vec<NeedsYouItem> = self.items();
        let first = !self.seeded;
        match f {
            Frame::Snapshot { snapshot } => {
                self.items.clear();
                for s in snapshot.sessions {
                    self.upsert(s);
                }
                self.seeded = true;
            }
            Frame::Session { session } | Frame::Event { session } => {
                if !self.seeded {
                    return Change::default();
                }
                self.upsert(session);
            }
            Frame::Forgotten { key } => {
                self.items.remove(&key);
            }
            Frame::Other => return Change::default(),
        }
        let after_ids = self.open_ids();
        Change {
            // The first snapshot always reports, so a count of 0 is known too.
            items_changed: first || before != self.items(),
            closed: before_ids.difference(&after_ids).cloned().collect(),
            opened: if first {
                vec![]
            } else {
                after_ids.difference(&before_ids).cloned().collect()
            },
        }
    }

    fn upsert(&mut self, s: SessionLite) {
        if s.state != "needs_you" {
            self.items.remove(&s.key);
            return;
        }
        let title = s.title.filter(|t| !t.trim().is_empty());
        self.items.insert(
            s.key.clone(),
            NeedsYouItem {
                receiver: self.receiver.clone(),
                session: s.key,
                harness: s.harness,
                id: s.id,
                title,
                machine: s.machine,
                cwd: s.cwd,
                state_since: s.state_since,
                attentions: s.open_attentions,
            },
        );
    }

    /// Forget everything (the stream dropped; the next snapshot reseeds).
    pub fn reset(&mut self) {
        self.seeded = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(key: &str, state: &str, att: &[&str]) -> String {
        let (h, id) = key.split_once(':').unwrap();
        let atts: Vec<String> = att
            .iter()
            .map(|a| format!(r#"{{"attentionId":"{a}","kind":"permission","tool":"Bash","message":"ls","at":"t","answerable":true}}"#))
            .collect();
        format!(
            r#"{{"key":"{key}","harness":"{h}","id":"{id}","title":"T {id}","state":"{state}","stateSince":"2026-10-25T00:00:0{}Z","openAttentions":[{}],"counts":{{}}}}"#,
            id.len() % 10,
            atts.join(",")
        )
    }

    #[test]
    fn counts_needs_you_from_snapshot_and_session_frames() {
        let mut n = NeedsYou::new("rx1");
        let snap = format!(
            r#"{{"kind":"snapshot","snapshot":{{"at":"x","sessions":[{},{}],"machines":[],"stats":{{}}}}}}"#,
            session("claude:a", "needs_you", &["p1"]),
            session("codex:b", "working", &[])
        );
        let c = n.apply_json(&snap);
        assert_eq!(n.count(), 1);
        assert!(c.items_changed);
        assert!(c.opened.is_empty(), "the first snapshot only seeds");

        let c = n.apply_json(&format!(
            r#"{{"kind":"session","session":{}}}"#,
            session("codex:b", "needs_you", &["q1"])
        ));
        assert_eq!(n.count(), 2);
        assert_eq!(c.opened, vec!["q1".to_string()]);

        let c = n.apply_json(&format!(
            r#"{{"kind":"event","event":{{}},"session":{}}}"#,
            session("claude:a", "working", &[])
        ));
        assert_eq!(n.count(), 1);
        assert_eq!(c.closed, vec!["p1".to_string()]);

        let c = n.apply_json(r#"{"kind":"forgotten","key":"codex:b"}"#);
        assert_eq!(n.count(), 0);
        assert_eq!(c.closed, vec!["q1".to_string()]);

        let c = n.apply_json(r#"{"kind":"stats","stats":{}}"#);
        assert_eq!(c, Change::default());
    }

    #[test]
    fn frames_before_the_snapshot_are_ignored() {
        let mut n = NeedsYou::new("rx1");
        n.apply_json(&format!(
            r#"{{"kind":"session","session":{}}}"#,
            session("claude:a", "needs_you", &["p1"])
        ));
        assert_eq!(n.count(), 0);
    }

    #[test]
    fn a_new_snapshot_closes_what_vanished() {
        let mut n = NeedsYou::new("rx1");
        n.apply_json(&format!(
            r#"{{"kind":"snapshot","snapshot":{{"sessions":[{}]}}}}"#,
            session("claude:a", "needs_you", &["p1"])
        ));
        let c = n.apply_json(r#"{"kind":"snapshot","snapshot":{"sessions":[]}}"#);
        assert_eq!(c.closed, vec!["p1".to_string()]);
        assert_eq!(n.count(), 0);
    }
}
