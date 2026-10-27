//! Local notifications for needs-you (arch-mobile §6, NATIVE-SPEC §6), no cloud: while the
//! app is in the background (the ~30 s iOS grants after leaving, see
//! `uikit::watch_background`), each new attention a receiver reports becomes one
//! notification, removed again when it is answered anywhere. In front, the page shows it
//! and nothing is posted. A permission carries Allow and Deny (neither destructive, so
//! neither is red); both open the app on the session, because this build can't sign.

use sp_receivers::{HubEvent, NeedsYouItem};
use std::collections::{BTreeMap, BTreeSet};

/// The notification category for an answerable permission.
pub const PERMISSION: &str = "permission";

/// A notification to post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Post {
    pub id: i32,
    pub title: String,
    pub body: String,
    pub category: Option<&'static str>,
    pub receiver: String,
    /// The page path that shows the session: `/s/<harness>/<id>`.
    pub path: String,
}

/// What to do after a Hub event.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub post: Vec<Post>,
    pub remove: Vec<i32>,
}

/// A stable 31-bit id for an attention (iOS keys notifications by string; the plugin by i32).
pub fn notification_id(receiver: &str, attention: &str) -> i32 {
    // FNV-1a: stable across runs, unlike std's hasher.
    let mut h: u32 = 0x811c9dc5;
    for b in receiver.bytes().chain([0]).chain(attention.bytes()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    (h & 0x7fff_ffff) as i32
}

fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// The human name of a tool, as the menu bar shows it (Bash → Shell; MCP tools by their
/// last part).
pub fn tool_name(tool: &str) -> String {
    let t = tool.rsplit("__").next().unwrap_or(tool);
    match t {
        "Bash" | "bash" | "shell" | "run_shell_command" => "Shell".into(),
        "Edit" | "MultiEdit" | "edit" | "replace" => "Edit".into(),
        "Write" | "write_file" => "Write".into(),
        "WebFetch" | "web_fetch" => "Fetch".into(),
        _ => t.replace('_', " "),
    }
}

fn post_for(item: &NeedsYouItem, a: &sp_receivers::AttentionInfo) -> Post {
    let title = item.display_title();
    let asks = match a.kind.as_str() {
        "permission" => {
            let tool = a
                .tool
                .as_deref()
                .map(tool_name)
                .unwrap_or_else(|| "A tool".into());
            // Harnesses often start the message with the raw tool name ("Bash rm -rf …").
            let raw = a.tool.as_deref().unwrap_or("");
            let message = a.message.as_deref().map(str::trim).map(|m| {
                if !raw.is_empty() {
                    m.strip_prefix(raw).map(str::trim_start).unwrap_or(m)
                } else {
                    m
                }
            });
            match message.filter(|m| !m.is_empty()) {
                Some(m) => format!("{tool} wants to run: {m}"),
                None => format!("{tool} is waiting for your answer."),
            }
        }
        _ => a
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "Waiting for you.".into()),
    };
    let body = match item.machine.as_deref() {
        Some(m) if !m.is_empty() => format!("{asks}\n{m}"),
        _ => asks,
    };
    Post {
        id: notification_id(&item.receiver, &a.attention_id),
        title,
        body: body.chars().take(240).collect(),
        category: (a.kind == "permission" && a.answerable).then_some(PERMISSION),
        receiver: item.receiver.clone(),
        path: format!("/s/{}/{}", enc(&item.harness), enc(&item.id)),
    }
}

/// The notifier's memory: which attentions it has seen (in front or behind) and which it
/// has posted. Pure, so the rules are tested without iOS.
#[derive(Debug, Default)]
pub struct Notifier {
    /// receiver → attention ids open at the last report.
    open: BTreeMap<String, BTreeSet<String>>,
    /// Posted notification ids, by (receiver, attention).
    posted: BTreeMap<(String, String), i32>,
}

impl Notifier {
    pub fn on_event(&mut self, e: &HubEvent, background: bool) -> Plan {
        let mut plan = Plan::default();
        match e {
            HubEvent::NeedsYou { id, items } => {
                let before = self.open.remove(id).unwrap_or_default();
                let mut now = BTreeSet::new();
                for item in items {
                    for a in &item.attentions {
                        now.insert(a.attention_id.clone());
                        // New since the last report, and nobody is looking: one notification.
                        // Seen in front: never posted later (the person saw it).
                        if background && !before.contains(&a.attention_id) {
                            let p = post_for(item, a);
                            self.posted
                                .insert((id.clone(), a.attention_id.clone()), p.id);
                            plan.post.push(p);
                        }
                    }
                }
                for gone in before.difference(&now) {
                    if let Some(n) = self.posted.remove(&(id.clone(), gone.clone())) {
                        plan.remove.push(n);
                    }
                }
                self.open.insert(id.clone(), now);
            }
            HubEvent::AttentionClosed { id, attention_id } => {
                if let Some(set) = self.open.get_mut(id) {
                    set.remove(attention_id);
                }
                if let Some(n) = self.posted.remove(&(id.clone(), attention_id.clone())) {
                    plan.remove.push(n);
                }
            }
            _ => {}
        }
        plan
    }

    /// Back in front: what was posted stays in Notification Center until answered.
    pub fn posted(&self) -> usize {
        self.posted.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sp_receivers::AttentionInfo;

    fn item(att: &[(&str, &str, bool)]) -> NeedsYouItem {
        NeedsYouItem {
            receiver: "rx1".into(),
            session: "claude:abc".into(),
            harness: "claude".into(),
            id: "abc".into(),
            title: Some("Outbox: a batch reads 1 MB".into()),
            machine: Some("misha-air".into()),
            cwd: None,
            state_since: "2026-10-25T00:00:00Z".into(),
            attentions: att
                .iter()
                .map(|(id, kind, answerable)| AttentionInfo {
                    attention_id: (*id).into(),
                    kind: (*kind).into(),
                    tool: Some("Bash".into()),
                    message: Some("git push origin main".into()),
                    at: String::new(),
                    answerable: *answerable,
                })
                .collect(),
        }
    }
    fn needs(items: Vec<NeedsYouItem>) -> HubEvent {
        HubEvent::NeedsYou {
            id: "rx1".into(),
            items,
        }
    }

    #[test]
    fn in_front_nothing_is_posted_and_it_is_never_posted_later() {
        let mut n = Notifier::default();
        assert_eq!(
            n.on_event(&needs(vec![item(&[("a1", "permission", true)])]), false),
            Plan::default()
        );
        assert!(n
            .on_event(&needs(vec![item(&[("a1", "permission", true)])]), true)
            .post
            .is_empty());
    }

    #[test]
    fn one_notification_per_new_attention_in_the_background() {
        let mut n = Notifier::default();
        n.on_event(&needs(vec![]), true);
        let p = n.on_event(
            &needs(vec![item(&[
                ("a1", "permission", true),
                ("a2", "question", false),
            ])]),
            true,
        );
        assert_eq!(p.post.len(), 2);
        let allow = &p.post[0];
        assert_eq!(allow.title, "Outbox: a batch reads 1 MB");
        assert_eq!(
            allow.body,
            "Shell wants to run: git push origin main\nmisha-air"
        );
        assert_eq!(allow.category, Some(PERMISSION));
        assert_eq!(allow.path, "/s/claude/abc");
        assert_eq!(p.post[1].category, None);
        // The same report again posts nothing.
        assert!(n
            .on_event(
                &needs(vec![item(&[
                    ("a1", "permission", true),
                    ("a2", "question", false)
                ])]),
                true
            )
            .post
            .is_empty());
    }

    #[test]
    fn answered_anywhere_removes_it() {
        let mut n = Notifier::default();
        n.on_event(&needs(vec![]), true);
        let id = n
            .on_event(&needs(vec![item(&[("a1", "permission", true)])]), true)
            .post[0]
            .id;
        let p = n.on_event(
            &HubEvent::AttentionClosed {
                id: "rx1".into(),
                attention_id: "a1".into(),
            },
            false,
        );
        assert_eq!(p.remove, vec![id]);
        assert_eq!(n.posted(), 0);
        // Or by vanishing from the next report.
        let id2 = n
            .on_event(&needs(vec![item(&[("a3", "permission", true)])]), true)
            .post[0]
            .id;
        assert_eq!(n.on_event(&needs(vec![]), false).remove, vec![id2]);
    }

    #[test]
    fn the_raw_tool_name_is_not_said_twice() {
        let mut it = item(&[("a1", "permission", true)]);
        it.attentions[0].message = Some("Bash rm -rf node_modules".into());
        let mut n = Notifier::default();
        assert_eq!(
            n.on_event(&needs(vec![it]), true).post[0].body,
            "Shell wants to run: rm -rf node_modules\nmisha-air"
        );
    }

    #[test]
    fn an_unanswerable_permission_has_no_buttons() {
        let mut n = Notifier::default();
        let p = n.on_event(&needs(vec![item(&[("a1", "permission", false)])]), true);
        assert_eq!(p.post[0].category, None);
    }

    #[test]
    fn ids_are_stable_and_positive() {
        assert_eq!(notification_id("rx1", "a1"), notification_id("rx1", "a1"));
        assert_ne!(notification_id("rx1", "a1"), notification_id("rx2", "a1"));
        assert!(notification_id("x", "y") >= 0);
    }

    #[test]
    fn tool_names_are_human() {
        assert_eq!(tool_name("Bash"), "Shell");
        assert_eq!(tool_name("mcp__github__search_issues"), "search issues");
        assert_eq!(tool_name("Edit"), "Edit");
    }

    #[test]
    fn paths_are_encoded() {
        let mut it = item(&[("a1", "question", false)]);
        it.id = "a/b c".into();
        let mut n = Notifier::default();
        assert_eq!(
            n.on_event(&needs(vec![it]), true).post[0].path,
            "/s/claude/a%2Fb%20c"
        );
    }
}
