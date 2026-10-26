//! What a notification says (NATIVE-SPEC.md §3.4), apart from how it is delivered
//! (macos/notify.rs). Pure, so the copy is tested.

use crate::settings::NotifyKinds;
use crate::tools::{message_without_tool, one_line, tool_label};
use sp_receivers::{AttentionInfo, NeedsYouItem};

pub const BODY_MAX: usize = 140;

/// Category ids registered with the notification center.
pub const CAT_PERMISSION: &str = "permission";
pub const CAT_QUESTION: &str = "question";
pub const CAT_IDLE: &str = "idle";
pub const ACTION_ALLOW: &str = "allow";
pub const ACTION_DENY: &str = "deny";
pub const ACTION_REPLY: &str = "reply";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Content {
    /// `<receiver id>:<attentionId>`: one notification per attention.
    pub identifier: String,
    /// `<receiver id>:<session key>`.
    pub thread: String,
    pub title: String,
    pub subtitle: String,
    pub body: String,
    /// The action category, or None (click opens the session).
    pub category: Option<&'static str>,
    pub sound: bool,
    /// What the click opens.
    pub path: String,
}

fn wants(tool: &str) -> String {
    let l = tool_label(tool);
    match l.as_str() {
        "Bash" | "Shell" => format!("Wants to run {l}"),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "Wants to edit a file".into(),
        "Read" | "Read files" => "Wants to read files".into(),
        "Fetch" | "WebFetch" => "Wants to fetch a page".into(),
        "Web search" | "WebSearch" => "Wants to search the web".into(),
        _ => format!("Wants to use {l}"),
    }
}

/// Whether this kind is on in the person's settings.
pub fn kind_on(kinds: &NotifyKinds, kind: &str) -> bool {
    match kind {
        "permission" => kinds.permission,
        "question" | "elicitation" => kinds.question,
        "error" => kinds.error,
        "idle" => kinds.idle,
        _ => false,
    }
}

/// The notification for one attention. `can_answer`: this app can sign for that machine
/// (identity is built in and the daemon takes device keys).
pub fn content(rx: &str, item: &NeedsYouItem, a: &AttentionInfo, can_answer: bool) -> Content {
    let title = one_line(&item.display_title(), 80);
    let msg = message_without_tool(a)
        .map(|m| one_line(m.lines().next().unwrap_or(""), BODY_MAX))
        .unwrap_or_default();
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let path = format!("/s/{}/{}", enc(&item.harness), enc(&item.id));
    let (subtitle, category, sound) = match a.kind.as_str() {
        "permission" => (
            a.tool
                .as_deref()
                .map(wants)
                .unwrap_or_else(|| "Wants your permission".into()),
            (a.answerable && can_answer).then_some(CAT_PERMISSION),
            true,
        ),
        "question" | "elicitation" => (
            "Asks you".to_string(),
            can_answer.then_some(CAT_QUESTION),
            true,
        ),
        "error" => ("Stopped with an error".to_string(), None, false),
        "idle" => (
            "Finished".to_string(),
            can_answer.then_some(CAT_IDLE),
            false,
        ),
        other => (one_line(other, 40), None, false),
    };
    Content {
        identifier: format!("{rx}:{}", a.attention_id),
        thread: format!("{rx}:{}", item.session),
        title,
        subtitle,
        body: msg,
        category,
        sound,
        path,
    }
}

/// The one replacement after a failed answer from a notification.
pub fn couldnt_answer(identifier: &str) -> Content {
    Content {
        identifier: identifier.to_string(),
        thread: String::new(),
        title: "Couldn't answer".into(),
        subtitle: String::new(),
        body: "Open sessionpipe to try again".into(),
        category: None,
        sound: false,
        path: "/inbox".into(),
    }
}

/// `<receiver id>:<attentionId>` → (receiver id, attention id).
pub fn split_identifier(id: &str) -> Option<(&str, &str)> {
    id.split_once(':')
        .filter(|(r, a)| !r.is_empty() && !a.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: Option<&str>, atts: Vec<AttentionInfo>) -> NeedsYouItem {
        NeedsYouItem {
            receiver: "rx12345678".into(),
            session: "claude:4f2a".into(),
            harness: "claude".into(),
            id: "4f2a".into(),
            title: title.map(str::to_string),
            machine: Some("studio-mac".into()),
            cwd: Some("/Users/m/src/queue".into()),
            state_since: "t".into(),
            attentions: atts,
        }
    }

    fn att(kind: &str, tool: Option<&str>, msg: &str, answerable: bool) -> AttentionInfo {
        AttentionInfo {
            attention_id: "att-1".into(),
            kind: kind.into(),
            tool: tool.map(str::to_string),
            message: Some(msg.into()),
            at: "t".into(),
            answerable,
        }
    }

    #[test]
    fn permission_answerable() {
        let a = att(
            "permission",
            Some("Bash"),
            "Bash: `npm test -- --watch`\nsecond line",
            true,
        );
        let c = content(
            "rx12345678",
            &item(Some("Fix the flaky queue test"), vec![a.clone()]),
            &a,
            true,
        );
        assert_eq!(c.identifier, "rx12345678:att-1");
        assert_eq!(c.thread, "rx12345678:claude:4f2a");
        assert_eq!(c.title, "Fix the flaky queue test");
        assert_eq!(c.subtitle, "Wants to run Bash");
        assert_eq!(c.body, "npm test -- --watch");
        assert_eq!(c.category, Some(CAT_PERMISSION));
        assert!(c.sound);
        assert_eq!(c.path, "/s/claude/4f2a");
    }

    #[test]
    fn permission_not_answerable_has_no_actions() {
        let a = att(
            "permission",
            Some("mcp__github__search_issues"),
            "query",
            false,
        );
        let c = content("r", &item(None, vec![a.clone()]), &a, true);
        assert_eq!(c.subtitle, "Wants to use GitHub: search issues");
        assert_eq!(c.title, "queue", "falls back to the folder name");
        assert_eq!(c.category, None);
        let a = att("permission", Some("Edit"), "/x/y.rs", true);
        assert_eq!(
            content("r", &item(None, vec![a.clone()]), &a, false).category,
            None,
            "no signer: no actions"
        );
        assert_eq!(
            content("r", &item(None, vec![a.clone()]), &a, true).subtitle,
            "Wants to edit a file"
        );
    }

    #[test]
    fn question_error_idle() {
        let q = att("question", None, "Which branch?", true);
        let c = content("r", &item(Some("Docs"), vec![q.clone()]), &q, true);
        assert_eq!(
            (c.subtitle.as_str(), c.category, c.sound),
            ("Asks you", Some(CAT_QUESTION), true)
        );
        let e = att("error", None, "Rate limited\nretry later", false);
        let c = content("r", &item(Some("Docs"), vec![e.clone()]), &e, true);
        assert_eq!(
            (c.subtitle.as_str(), c.body.as_str(), c.category, c.sound),
            ("Stopped with an error", "Rate limited", None, false)
        );
        let i = att("idle", None, "Done. All tests pass.", false);
        let c = content("r", &item(Some("Docs"), vec![i.clone()]), &i, true);
        assert_eq!(
            (c.subtitle.as_str(), c.category, c.sound),
            ("Finished", Some(CAT_IDLE), false)
        );
    }

    #[test]
    fn body_is_at_most_140_and_has_no_backticks() {
        let long = format!("Bash: `{}`", "a".repeat(400));
        let a = att("permission", Some("Bash"), &long, true);
        let c = content("r", &item(Some("T"), vec![a.clone()]), &a, true);
        assert_eq!(c.body.chars().count(), BODY_MAX);
        assert!(!c.body.contains('`'));
    }

    #[test]
    fn kinds_and_identifiers() {
        let k = NotifyKinds::default();
        assert!(kind_on(&k, "permission") && kind_on(&k, "elicitation") && kind_on(&k, "error"));
        assert!(!kind_on(&k, "idle"));
        assert_eq!(split_identifier("rx:att:1"), Some(("rx", "att:1")));
        assert_eq!(split_identifier("nope"), None);
        assert_eq!(couldnt_answer("r:a").title, "Couldn't answer");
    }
}
