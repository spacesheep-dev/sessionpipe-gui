//! The Touch ID prompt's words, written by Rust from what is really being signed, never by
//! the page (arch-identity §6.4). macOS shows them as “"sessionpipe" is trying to <reason>”.
use crate::validate::Checked;
use crate::words::Device;

/// A character that draws nothing and can change how the text around it reads: the
/// bidi marks, embeddings, overrides and isolates, the zero-width and joining
/// characters and the other invisible operators, the line and paragraph separators,
/// the interlinear marks and the tag characters. The same set sp-receivers drops from
/// what a notification shows (`needs::is_invisible`, which turns the two separators
/// into a space instead); the two lists are kept alike.
pub fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}'
        | '\u{200B}'..='\u{200F}'
        | '\u{2028}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}'
        | '\u{FEFF}'
        | '\u{FFF9}'..='\u{FFFB}'
        | '\u{E0000}'..='\u{E007F}')
}

/// A name from a receiver or a command, safe on a system sheet: no control characters,
/// nothing invisible (`is_invisible`: no bidi override, no second line, no zero-width
/// character), at most 40 characters.
pub fn clean(s: &str) -> String {
    let t: String = s
        .chars()
        .filter(|c| !c.is_control() && !is_invisible(*c))
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
    grant_on(Device::current(), host)
}

/// The day grant's words on `device`. An iPhone shows them alone, as a sentence, and
/// calls what it sends to "your computers", as the rest of the phone's words do.
pub fn grant_on(device: Device, host: &str) -> String {
    match device {
        Device::Mac => format!(
            "send to your machines through {} for the next 24 hours",
            clean(host)
        ),
        Device::IPhone => format!(
            "Send to your computers through {} for the next 24 hours.",
            clean(host)
        ),
    }
}

/// A confirm: what the command does, on which machine.
pub fn confirm(c: &Checked, machine: &str) -> String {
    confirm_on(Device::current(), c, machine)
}

/// A confirm's words on `device`: the Mac's fragment, or the same as a sentence.
pub fn confirm_on(device: Device, c: &Checked, machine: &str) -> String {
    device.reason(confirm_fragment(c, machine))
}

fn confirm_fragment(c: &Checked, machine: &str) -> String {
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
        "pool" => pool(c.pool_action.as_deref().unwrap_or(""), &m),
        _ => format!("send a message to a session on {m}"),
    }
}

/// A pool command, by its action: “Turn the account pool on on lab-mac”.
fn pool(action: &str, m: &str) -> String {
    match action {
        "on" => format!("turn the account pool on on {m}"),
        "off" => format!("turn the account pool off on {m}"),
        "enable" => format!("turn an account on in the pool on {m}"),
        "disable" => format!("turn an account off in the pool on {m}"),
        "remove" => format!("remove an account from the pool on {m}"),
        "order" => format!("reorder the accounts in the pool on {m}"),
        "refresh" => format!("re-read an account's usage in the pool on {m}"),
        "login.begin" => format!("start signing in to Claude on {m}"),
        "login.complete" => format!("finish signing in to Claude on {m}"),
        _ => format!("change the account pool on {m}"),
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
            pool_action: None,
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
        let mut p = checked("pool", None, None);
        p.pool_action = Some("on".into());
        assert_eq!(
            confirm(&p, "lab-mac"),
            "turn the account pool on on lab-mac"
        );
        p.pool_action = Some("remove".into());
        assert_eq!(
            confirm(&p, "lab-mac"),
            "remove an account from the pool on lab-mac"
        );
        p.pool_action = Some("login.begin".into());
        assert_eq!(
            confirm(&p, "lab-mac"),
            "start signing in to Claude on lab-mac"
        );
    }

    /// On an iPhone the sheet shows the reason alone: each is a sentence there. What is
    /// signed is the same; only the words around it differ.
    #[test]
    fn on_an_iphone_each_reason_is_a_sentence() {
        let i = Device::IPhone;
        assert_eq!(
            grant_on(i, "spacesheep.dev"),
            "Send to your computers through spacesheep.dev for the next 24 hours."
        );
        assert_eq!(
            grant_on(Device::Mac, "spacesheep.dev"),
            grant("spacesheep.dev"),
            "the tests run on a Mac"
        );
        let on = |c: &Checked| confirm_on(i, c, "studio-mac");
        assert_eq!(
            on(&checked("key.add", None, Some("iPhone"))),
            "Trust “iPhone” on studio-mac."
        );
        assert_eq!(
            on(&checked("permission.answer", Some("allow"), None)),
            "Allow a permission request on studio-mac."
        );
        assert_eq!(
            on(&checked("permission.answer", Some("deny"), None)),
            "Deny a permission request on studio-mac."
        );
        assert_eq!(
            on(&checked("start", None, None)),
            "Start a session on studio-mac."
        );
        assert_eq!(
            on(&checked("cancel", None, None)),
            "Stop a session on studio-mac."
        );
        assert_eq!(
            on(&checked("prompt", None, None)),
            "Send a message to a session on studio-mac."
        );
        // A name is cleaned the same wherever it is shown.
        assert_eq!(
            confirm_on(
                i,
                &checked("key.add", None, Some("a\u{0007}b")),
                "m\u{202E}"
            ),
            "Trust “ab” on m."
        );
        assert_eq!(
            confirm_on(Device::Mac, &checked("prompt", None, None), "studio-mac"),
            confirm(&checked("prompt", None, None), "studio-mac")
        );
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean("evil\u{202E}txt.exe\n"), "eviltxt.exe");
        // A name cannot start a line of its own on the sheet, nor hide a character in
        // it, nor turn what follows it around.
        assert_eq!(
            clean("studio\u{2028}Approve\u{2029}now\u{200B}\u{061C}\u{2066}x\u{2069}\u{FEFF}"),
            "studioApprovenowx"
        );
        for c in [
            '\u{00AD}',
            '\u{061C}',
            '\u{180E}',
            '\u{200B}',
            '\u{200C}',
            '\u{200D}',
            '\u{200E}',
            '\u{200F}',
            '\u{2028}',
            '\u{2029}',
            '\u{202A}',
            '\u{202B}',
            '\u{202C}',
            '\u{202D}',
            '\u{202E}',
            '\u{2060}',
            '\u{2061}',
            '\u{2064}',
            '\u{2066}',
            '\u{2067}',
            '\u{2068}',
            '\u{2069}',
            '\u{206A}',
            '\u{206F}',
            '\u{FEFF}',
            '\u{FFF9}',
            '\u{FFFB}',
            '\u{E0001}',
            '\u{E007F}',
        ] {
            assert!(is_invisible(c), "{c:?}");
            assert_eq!(clean(&format!("a{c}b")), "ab", "{c:?}");
        }
        for plain in [
            "studio-mac",
            "Мой Мак",
            "田中のMac",
            "café-box",
            "מחשב",
            "build 🚀",
        ] {
            assert_eq!(clean(plain), plain);
        }
        assert_eq!(
            confirm(
                &checked("prompt", None, None),
                "studio\u{2028}Trust “x” on evil"
            ),
            "send a message to a session on studioTrust “x” on evil"
        );
        assert_eq!(clean(&"x".repeat(80)).chars().count(), 40);
        assert_eq!(
            confirm(&checked("key.add", None, Some("a\u{0007}b")), "m"),
            "trust “ab” on m"
        );
    }
}
