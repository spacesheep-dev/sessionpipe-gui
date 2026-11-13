//! Local notifications for needs-you (arch-mobile §6, NATIVE-SPEC §6), no cloud: while the
//! app is in the background (the ~30 s iOS grants after leaving, see
//! `uikit::watch_background`), each new attention a receiver reports, or an account's
//! page hands over (`acct_needs`), becomes one notification, removed again when it is
//! answered anywhere. In front, the page shows it and nothing is posted. A permission
//! carries Allow and Deny (neither destructive, so neither is red); both open the app on
//! the session, where the answer is given and signed: answering from the notification
//! itself, with the app behind, is not built.

use sp_receivers::needs::shown;
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

/// A notification's words. Every text in them came from outside (a session's title, a
/// tool's name and message, a machine's name: a receiver's stream, or an account's page
/// that read them off the relay), and each is shown as one plain line
/// (`sp_receivers::needs::shown`): no control character, nothing invisible, nothing that
/// reorders what follows it. The one line break in the body is this function's own.
fn post_for(item: &NeedsYouItem, a: &sp_receivers::AttentionInfo) -> Post {
    let title = shown(&item.display_title(), 200);
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
    let asks = shown(&asks, 240);
    let body = match item.machine.as_deref().map(|m| shown(m, 100)) {
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
            HubEvent::NeedsYou { id, items } => self.listed(id, items, background, &mut plan),
            // A list that only seeds (an account's first after a window opened) is the
            // board as its page found it: all of it was there before anyone could have
            // been told, so it is taken as seen and nothing is posted for it, behind or
            // not. What a later list adds to it is news.
            HubEvent::NeedsYouSeed { id, items } => self.listed(id, items, false, &mut plan),
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

    /// One receiver's list as it stands now. `post`: nobody is looking, so what is new
    /// in it since the last one becomes a notification each. Either way it is what the
    /// next list is compared with, and what is no longer in it has its notification
    /// removed.
    fn listed(&mut self, id: &str, items: &[NeedsYouItem], post: bool, plan: &mut Plan) {
        let before = self.open.remove(id).unwrap_or_default();
        let mut now = BTreeSet::new();
        for item in items {
            for a in &item.attentions {
                now.insert(a.attention_id.clone());
                // New since the last report, and nobody is looking: one notification.
                // Seen in front: never posted later (the person saw it).
                if post && !before.contains(&a.attention_id) {
                    let p = post_for(item, a);
                    self.posted
                        .insert((id.to_string(), a.attention_id.clone()), p.id);
                    plan.post.push(p);
                }
            }
        }
        for gone in before.difference(&now) {
            if let Some(n) = self.posted.remove(&(id.to_string(), gone.clone())) {
                plan.remove.push(n);
            }
        }
        self.open.insert(id.to_string(), now);
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

    /// An account's first list after a window opened is the board as it was found: with
    /// the app behind too, nothing is posted for it, and it is what later lists are
    /// compared with.
    #[test]
    fn a_list_that_only_seeds_posts_nothing_even_behind() {
        let seed = |items: Vec<NeedsYouItem>| HubEvent::NeedsYouSeed {
            id: "rx1".into(),
            items,
        };
        let mut n = Notifier::default();
        let found = vec![item(&[
            ("a1", "permission", true),
            ("a2", "question", false),
        ])];
        assert_eq!(n.on_event(&seed(found.clone()), true), Plan::default());
        assert_eq!(n.posted(), 0);
        // The same list said again as news is not news.
        assert!(n.on_event(&needs(found), true).post.is_empty());
        // One more opens: that one is posted, alone.
        let p = n.on_event(
            &needs(vec![item(&[
                ("a1", "permission", true),
                ("a2", "question", false),
                ("a3", "permission", true),
            ])]),
            true,
        );
        assert_eq!(p.post.len(), 1);
        assert_eq!(p.post[0].id, notification_id("rx1", "a3"));
        // The next window's seed no longer holds it (answered meanwhile): its
        // notification goes, and what the seed does hold is still not posted.
        let p = n.on_event(&seed(vec![item(&[("a9", "permission", true)])]), true);
        assert!(p.post.is_empty());
        assert_eq!(p.remove, vec![notification_id("rx1", "a3")]);
        // Two hundred found at once, behind: none posted.
        let many: Vec<NeedsYouItem> = (0..200)
            .map(|i| {
                let mut it = item(&[("x", "permission", true)]);
                it.session = format!("claude:{i}");
                it.attentions[0].attention_id = format!("m{i}");
                it
            })
            .collect();
        let mut fresh = Notifier::default();
        assert!(fresh.on_event(&seed(many), true).post.is_empty());
    }

    /// What a notification shows is one plain line each for the title, the ask and the
    /// machine, whatever the session, the tool or the machine put in their texts.
    #[test]
    fn a_notifications_words_carry_nothing_invisible() {
        let nasty =
            "Apple ID\u{202E}gnp.exe\u{2028}Your password is needed\u{200B}\u{2066}x\u{2069}";
        let mut it = item(&[("a1", "permission", true)]);
        it.title = Some(nasty.into());
        it.machine = Some(nasty.into());
        it.attentions[0].tool = Some("Bash".into());
        it.attentions[0].message = Some(format!("Bash {nasty}"));
        let mut n = Notifier::default();
        n.on_event(&needs(vec![]), true);
        let p = n.on_event(&needs(vec![it.clone()]), true);
        let clean = "Apple IDgnp.exe Your password is neededx";
        assert_eq!(p.post[0].title, clean);
        assert_eq!(
            p.post[0].body,
            format!("Shell wants to run: {clean}\n{clean}")
        );
        // A question's own words, the same.
        it.attentions[0].kind = "question".into();
        it.attentions[0].attention_id = "a2".into();
        it.attentions[0].message = Some(nasty.into());
        let p = n.on_event(&needs(vec![it]), true);
        assert_eq!(p.post[0].body, format!("{clean}\n{clean}"));
        for post in &p.post {
            for c in post.title.chars().chain(post.body.chars()) {
                assert!(
                    c == '\n' || (!c.is_control() && !sp_receivers::needs::is_invisible(c)),
                    "{c:?}"
                );
            }
            assert_eq!(post.body.matches('\n').count(), 1, "the one break is ours");
        }
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
