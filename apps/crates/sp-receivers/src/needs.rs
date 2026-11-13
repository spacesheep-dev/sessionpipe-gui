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

/// A list handed over whole (`NeedsYou::apply_sessions`) holds at most this many
/// sessions, each with at most this many open attentions; a longer one is not a list
/// the Hub takes.
pub const LIST_MAX_SESSIONS: usize = 200;
pub const LIST_MAX_ATTENTIONS: usize = 16;

/// `s` cut to `max` characters, without what a notification must not carry (control
/// characters; a line break is a space).
fn clip(s: &str, max: usize) -> String {
    s.chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

impl SessionLite {
    /// The same session with every text cut to a size a title or a notification has
    /// use for. A stream's sessions come from a receiver the person added; a list
    /// handed over comes from a page, and is kept and shown by the Hub only so far.
    fn clipped(mut self) -> SessionLite {
        self.key = clip(&self.key, 300);
        self.harness = clip(&self.harness, 64);
        self.id = clip(&self.id, 200);
        self.title = self.title.map(|t| clip(&t, 200));
        self.machine = self.machine.map(|m| clip(&m, 100));
        self.cwd = self.cwd.map(|c| clip(&c, 1024));
        self.state_since = clip(&self.state_since, 40);
        for a in &mut self.open_attentions {
            a.attention_id = clip(&a.attention_id, 200);
            a.kind = clip(&a.kind, 40);
            a.tool = a.tool.take().map(|t| clip(&t, 200));
            a.message = a.message.take().map(|m| clip(&m, 300));
            a.at = clip(&a.at, 40);
        }
        self
    }
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

    /// Applies a whole list of sessions as a stream's `snapshot` frame is applied: the
    /// list replaces what was held, the first one only seeds (nothing "opened"), and
    /// what is no longer in it closed. This is how a spacesheep account's needs-you
    /// arrive: its page works the list out from the relay and hands it over
    /// (`Hub::account_needs`), since an account has no stream for the Hub to read.
    /// None when it is not such a list: not an array of sessions, or one longer than
    /// `LIST_MAX_SESSIONS`, or a session with more than `LIST_MAX_ATTENTIONS` open.
    pub fn apply_sessions(&mut self, sessions: serde_json::Value) -> Option<Change> {
        if sessions.as_array()?.len() > LIST_MAX_SESSIONS {
            return None;
        }
        let sessions: Vec<SessionLite> = serde_json::from_value(sessions).ok()?;
        if sessions
            .iter()
            .any(|s| s.open_attentions.len() > LIST_MAX_ATTENTIONS)
        {
            return None;
        }
        Some(self.apply(Frame::Snapshot {
            snapshot: SnapshotLite {
                sessions: sessions.into_iter().map(SessionLite::clipped).collect(),
            },
        }))
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

    /// A list handed over whole is a snapshot: it seeds, replaces, and closes; and a
    /// thing that is not such a list changes nothing.
    #[test]
    fn a_list_handed_over_is_applied_as_a_snapshot_is() {
        let list = |sessions: &[String]| -> serde_json::Value {
            serde_json::from_str(&format!("[{}]", sessions.join(","))).unwrap()
        };
        let mut n = NeedsYou::new("acct");
        let c = n
            .apply_sessions(list(&[
                session("claude:a", "needs_you", &["p1"]),
                session("codex:b", "working", &[]),
            ]))
            .unwrap();
        assert_eq!(n.count(), 1);
        assert!(c.items_changed);
        assert!(c.opened.is_empty(), "the first list only seeds");
        assert_eq!(n.items()[0].receiver, "acct");
        // The same list again: nothing changed, nothing to say.
        let c = n
            .apply_sessions(list(&[session("claude:a", "needs_you", &["p1"])]))
            .unwrap();
        assert_eq!(c, Change::default());
        // One more asks, the first was answered.
        let c = n
            .apply_sessions(list(&[session("codex:b", "needs_you", &["q1"])]))
            .unwrap();
        assert_eq!(
            (c.opened, c.closed),
            (vec!["q1".to_string()], vec!["p1".to_string()])
        );
        // The empty list, when the last one clears.
        let c = n.apply_sessions(list(&[])).unwrap();
        assert!(c.items_changed);
        assert_eq!((n.count(), c.closed), (0, vec!["q1".to_string()]));

        // Not a list of sessions: nothing is applied, what was held stays.
        n.apply_sessions(list(&[session("claude:a", "needs_you", &["p1"])]))
            .unwrap();
        for bad in [
            serde_json::json!(null),
            serde_json::json!({ "sessions": [] }),
            serde_json::json!("claude:a"),
            serde_json::json!([{ "key": "claude:a" }]),
            serde_json::json!([7]),
        ] {
            assert_eq!(n.apply_sessions(bad.clone()), None, "{bad}");
        }
        let many: Vec<String> = (0..=LIST_MAX_SESSIONS)
            .map(|i| session(&format!("claude:s{i}"), "needs_you", &[]))
            .collect();
        assert_eq!(n.apply_sessions(list(&many)), None, "too many sessions");
        let asks: Vec<String> = (0..=LIST_MAX_ATTENTIONS).map(|i| format!("p{i}")).collect();
        let asks: Vec<&str> = asks.iter().map(String::as_str).collect();
        assert_eq!(
            n.apply_sessions(list(&[session("claude:a", "needs_you", &asks)])),
            None,
            "too many attentions"
        );
        assert_eq!(n.count(), 1, "what was held is still held");
        // Exactly the most a list may hold is a list.
        assert!(n.apply_sessions(list(&many[1..])).is_some());
        assert_eq!(n.count(), LIST_MAX_SESSIONS);
    }

    /// What a page hands over is cut to size and carries no control character: a title
    /// and a notification show it.
    #[test]
    fn a_list_handed_over_is_cut_to_size() {
        let mut n = NeedsYou::new("acct");
        let long = "x".repeat(5000);
        n.apply_sessions(serde_json::json!([{
            "key": "claude:a", "harness": "claude", "id": "a",
            "title": format!("line one\nline two\u{7}{long}"), "machine": long, "cwd": long,
            "state": "needs_you", "stateSince": long,
            "openAttentions": [{
                "attentionId": "p1", "kind": "permission", "tool": long,
                "message": format!("rm\u{0}\u{1b}[31m -rf {long}"), "at": long, "answerable": true
            }]
        }]))
        .unwrap();
        let i = &n.items()[0];
        let title = i.title.clone().unwrap();
        assert!(title.starts_with("line one line two") && title.chars().count() == 200);
        assert_eq!(i.machine.as_ref().unwrap().len(), 100);
        assert_eq!(i.cwd.as_ref().unwrap().len(), 1024);
        assert_eq!(i.state_since.len(), 40);
        let a = &i.attentions[0];
        assert_eq!(a.tool.as_ref().unwrap().len(), 200);
        let m = a.message.clone().unwrap();
        assert!(
            m.starts_with("rm[31m -rf x") && m.chars().count() == 300,
            "{m}"
        );
        assert_eq!(a.at.len(), 40);
        assert!(
            !format!("{i:?}").contains("\\u{"),
            "no control character is kept"
        );
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
