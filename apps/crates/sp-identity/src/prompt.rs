//! The Touch ID prompt's words, written by Rust from what is really being signed, never by
//! the page (arch-identity §6.4). macOS shows them as “"sessionpipe" is trying to <reason>”.
use crate::validate::Checked;

/// A name from a receiver or a command, safe on a system sheet: no control characters,
/// no bidi overrides, at most 40 characters.
pub fn clean(s: &str) -> String {
    let t: String = s
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}'))
        .collect();
    let t = t.trim();
    if t.chars().count() > 40 {
        format!("{}…", t.chars().take(39).collect::<String>())
    } else {
        t.to_string()
    }
}

/// The day grant: “send to your machines through <host> for the next 24 hours”.
pub fn grant(host: &str) -> String {
    format!(
        "send to your machines through {} for the next 24 hours",
        clean(host)
    )
}

/// A confirm: what the command does, on which machine.
pub fn confirm(c: &Checked, machine: &str) -> String {
    let m = clean(machine);
    match c.kind.as_str() {
        "key.add" => format!(
            "trust “{}” on {m}",
            clean(c.name.as_deref().unwrap_or("a new device"))
        ),
        "permission.answer" if c.decision.as_deref() == Some("deny") => {
            format!("deny a permission request on {m}")
        }
        "permission.answer" => format!("allow a permission request on {m}"),
        "start" => format!("start a session on {m}"),
        "cancel" => format!("stop a session on {m}"),
        _ => format!("send a message to a session on {m}"),
    }
}

/// A pairing: the machine and its six digits, so the person compares them with the
/// terminal on a sheet the page can't draw.
pub fn pair(machine: &str, check: &str) -> String {
    let d: String = check.chars().filter(char::is_ascii_digit).collect();
    let spaced = if d.len() == 6 {
        format!("{} {}", &d[..3], &d[3..])
    } else {
        clean(check)
    };
    format!("pair {} — check {spaced}", clean(machine))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checked(kind: &str, decision: Option<&str>, name: Option<&str>) -> Checked {
        Checked {
            kind: kind.into(),
            machine: "m_x".into(),
            session: "s".into(),
            decision: decision.map(Into::into),
            name: name.map(Into::into),
        }
    }

    #[test]
    fn words_from_the_parsed_fields() {
        assert_eq!(
            grant("studio-mac.local"),
            "send to your machines through studio-mac.local for the next 24 hours"
        );
        assert_eq!(
            confirm(&checked("key.add", None, Some("iPhone")), "studio-mac"),
            "trust “iPhone” on studio-mac"
        );
        assert_eq!(
            confirm(
                &checked("permission.answer", Some("allow"), None),
                "build-box"
            ),
            "allow a permission request on build-box"
        );
        assert_eq!(
            confirm(
                &checked("permission.answer", Some("deny"), None),
                "build-box"
            ),
            "deny a permission request on build-box"
        );
        assert_eq!(
            confirm(&checked("start", None, None), "studio-mac"),
            "start a session on studio-mac"
        );
        assert_eq!(
            confirm(&checked("cancel", None, None), "studio-mac"),
            "stop a session on studio-mac"
        );
        assert_eq!(
            confirm(&checked("prompt", None, None), "studio-mac"),
            "send a message to a session on studio-mac"
        );
        assert_eq!(
            pair("build-box", "482913"),
            "pair build-box — check 482 913"
        );
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean("evil\u{202E}txt.exe\n"), "eviltxt.exe");
        assert_eq!(clean(&"x".repeat(80)).chars().count(), 40);
        assert_eq!(
            confirm(&checked("key.add", None, Some("a\u{0007}b")), "m"),
            "trust “ab” on m"
        );
    }
}
