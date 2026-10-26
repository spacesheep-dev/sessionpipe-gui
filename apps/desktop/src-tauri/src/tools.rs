//! Human words for tools and attentions, the same vocabulary as the web
//! (web/src/lib/format.ts `toolLabel`, `ATTENTION_LABEL`), never raw MCP ids.

use sp_receivers::{AttentionInfo, NeedsYouItem};

/// Gemini CLI's and Codex's built-in tools, named the way Claude Code names its own.
const SNAKE_TOOLS: &[(&str, &str)] = &[
    ("run_shell_command", "Shell"),
    ("shell", "Shell"),
    ("local_shell", "Shell"),
    ("exec_command", "Shell"),
    ("run_terminal_cmd", "Shell"),
    ("read_file", "Read"),
    ("read_many_files", "Read files"),
    ("write_file", "Write"),
    ("replace", "Edit"),
    ("edit_file", "Edit"),
    ("apply_patch", "Edit"),
    ("list_directory", "List"),
    ("list_dir", "List"),
    ("glob", "Glob"),
    ("search_file_content", "Search"),
    ("grep_search", "Search"),
    ("web_fetch", "Fetch"),
    ("google_web_search", "Web search"),
    ("web_search", "Web search"),
    ("save_memory", "Memory"),
    ("update_plan", "Plan"),
];

/// Servers whose names have a known spelling.
const BRANDS: &[(&str, &str)] = &[
    ("github", "GitHub"),
    ("gitlab", "GitLab"),
    ("linear", "Linear"),
    ("slack", "Slack"),
    ("notion", "Notion"),
    ("figma", "Figma"),
    ("sentry", "Sentry"),
    ("playwright", "Playwright"),
    ("context7", "Context7"),
    ("jira", "Jira"),
    ("atlassian", "Atlassian"),
    ("google_drive", "Google Drive"),
    ("gmail", "Gmail"),
    ("vercel", "Vercel"),
    ("supabase", "Supabase"),
    ("stripe", "Stripe"),
];

fn sentence(s: &str) -> String {
    s.replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// "Bash", "Edit", "GitHub: search issues".
pub fn tool_label(name: &str) -> String {
    if let Some((_, w)) = SNAKE_TOOLS.iter().find(|(k, _)| *k == name) {
        return (*w).to_string();
    }
    let Some(rest) = name.strip_prefix("mcp__") else {
        return name.to_string();
    };
    let Some((server, tool)) = rest.split_once("__") else {
        return name.to_string();
    };
    let mut server = server
        .strip_prefix("claude_ai_")
        .unwrap_or(server)
        .to_string();
    if let Some(p) = server.strip_prefix("plugin_") {
        if let Some((_, s)) = p.split_once('_') {
            server = s.to_string();
        }
    }
    let lower = server.to_ascii_lowercase();
    let server = match BRANDS.iter().find(|(k, _)| *k == lower) {
        Some((_, b)) => (*b).to_string(),
        None => {
            let s = sentence(&server);
            let mut c = s.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => s,
            }
        }
    };
    format!("{server}: {}", sentence(tool))
}

/// What an attention asks for, short (the menu bar's right column).
pub fn attention_short(a: &AttentionInfo) -> String {
    match a.kind.as_str() {
        "permission" => a
            .tool
            .as_deref()
            .map(tool_label)
            .unwrap_or_else(|| "Permission".into()),
        "question" | "elicitation" => "Question".into(),
        "idle" => "Finished".into(),
        "error" => "Error".into(),
        k => k.to_string(),
    }
}

/// What a needs-you session waits on (its oldest open attention).
pub fn item_short(i: &NeedsYouItem) -> String {
    i.attentions
        .first()
        .map(attention_short)
        .unwrap_or_else(|| "Needs you".into())
}

/// One line, at most `max` characters, whitespace collapsed, no backticks.
pub fn one_line(s: &str, max: usize) -> String {
    let t: String = s
        .replace('`', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if t.chars().count() > max {
        let mut c: String = t.chars().take(max.saturating_sub(1)).collect();
        c.push('…');
        c
    } else {
        t
    }
}

/// The message without the tool name it sometimes starts with ("Bash rm -rf …").
pub fn message_without_tool(a: &AttentionInfo) -> Option<String> {
    let m = a.message.as_deref()?;
    let Some(t) = a.tool.as_deref() else {
        return Some(m.to_string());
    };
    let rest = m
        .strip_prefix(t)
        .map(|r| r.trim_start_matches(':').trim_start())
        .filter(|r| !r.is_empty() && m.len() > t.len());
    Some(rest.unwrap_or(m).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_read_like_the_web() {
        assert_eq!(tool_label("Bash"), "Bash");
        assert_eq!(tool_label("run_shell_command"), "Shell");
        assert_eq!(tool_label("apply_patch"), "Edit");
        assert_eq!(
            tool_label("mcp__github__search_issues"),
            "GitHub: search issues"
        );
        assert_eq!(
            tool_label("mcp__claude_ai_Linear__list_issues"),
            "Linear: list issues"
        );
        assert_eq!(
            tool_label("mcp__plugin_figma_figma__get_code"),
            "Figma: get code"
        );
        assert_eq!(
            tool_label("mcp__my_server__do-thing"),
            "My server: do thing"
        );
        assert_eq!(tool_label("mcp__broken"), "mcp__broken");
    }

    #[test]
    fn one_line_cuts_and_cleans() {
        assert_eq!(one_line("  `rm -rf`\n  build ", 140), "rm -rf build");
        let long = "x".repeat(200);
        let cut = one_line(&long, 140);
        assert_eq!(cut.chars().count(), 140);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn message_strips_the_tool() {
        let a = |tool: Option<&str>, m: &str| AttentionInfo {
            attention_id: "a".into(),
            kind: "permission".into(),
            tool: tool.map(str::to_string),
            message: Some(m.into()),
            at: String::new(),
            answerable: true,
        };
        assert_eq!(
            message_without_tool(&a(Some("Bash"), "Bash: npm test")).as_deref(),
            Some("npm test")
        );
        assert_eq!(
            message_without_tool(&a(Some("Bash"), "Bash")).as_deref(),
            Some("Bash")
        );
        assert_eq!(
            message_without_tool(&a(None, "Pick one")).as_deref(),
            Some("Pick one")
        );
    }
}
