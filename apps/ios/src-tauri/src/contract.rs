//! The shell contract (NATIVE-SPEC §2.5) and the navigation rule (§2.4), as plain data and
//! pure functions, so both are unit-tested on the host without a simulator.

use serde::Serialize;

/// The receiver this window shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellReceiver {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub local: bool,
}

/// What `window.sessionpipeShell` holds. Field names are the page's (camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub v: u8,
    pub platform: &'static str,
    pub app_version: String,
    pub features: Vec<&'static str>,
    pub receiver: Option<ShellReceiver>,
    pub rx_base: Option<String>,
}

/// The `rx:` base for a receiver on iOS (and macOS/Linux): `rx://localhost/<id>`.
pub fn rx_base(id: &str) -> String {
    format!("rx://localhost/{id}")
}

impl ShellInfo {
    pub fn ios(app_version: &str, receiver: Option<ShellReceiver>) -> Self {
        let rx_base = receiver.as_ref().map(|r| rx_base(&r.id));
        ShellInfo {
            v: 1,
            platform: "ios",
            app_version: app_version.to_owned(),
            // "signer": the identity plugin answers `status` here, so the page shows the
            // Signing row and why sending is off ("Sending needs a real iPhone"). It never
            // makes a key in this build (identity.rs).
            features: vec!["notifications", "signer"],
            receiver,
            rx_base,
        }
    }
}

/// The initialization script: runs before any page script, in the main frame only.
///
/// - `window.sessionpipeShell`: frozen, not writable, not configurable, so page code can't
///   swap the receiver or the rx base under the app.
/// - `data-shell` on `<html>` for the CSS (`web/src/native/ios.css`).
/// - The viewport gets `maximum-scale=1, user-scalable=no`: an app doesn't pinch-zoom its
///   own chrome (WKWebView honours it, unlike Safari).
/// The first line of the contract script: how the shell finds its own script among the
/// webview's user scripts to swap it when the person switches receivers.
pub const MARKER: &str = "/* sessionpipe shell contract v1 */";

pub fn init_script(info: &ShellInfo) -> String {
    // serde_json escapes quotes and control characters; `<`, `>`, `&` and the two JS line
    // separators are escaped too, so no value can end the script or break the literal.
    let json = serde_json::to_string(info)
        .expect("ShellInfo serialises")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        r#"{MARKER}
(() => {{
  if (window.top !== window) return;
  const s = {json};
  Object.freeze(s.features);
  if (s.receiver) Object.freeze(s.receiver);
  Object.defineProperty(window, "sessionpipeShell", {{ value: Object.freeze(s), writable: false, configurable: false, enumerable: false }});
  const mark = () => {{ document.documentElement.dataset.shell = s.platform; }};
  if (document.documentElement) mark(); else document.addEventListener("readystatechange", mark, {{ once: true }});
  const fit = () => {{
    const m = document.querySelector('meta[name="viewport"]');
    if (m && !/user-scalable/.test(m.content)) m.content += ", maximum-scale=1, user-scalable=no";
  }};
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fit, {{ once: true }}); else fit();
}})();"#
    )
}

/// What the main window does with a navigation it is asked to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    /// Within the bundled UI: let it happen.
    Allow,
    /// An http(s) link: hand it to Safari, stay where we are.
    External,
    /// Anything else (other schemes, `rx:` as a page, data: documents): refuse.
    Refuse,
}

/// The main window may navigate only within the bundled origin (`tauri://localhost`).
pub fn navigation(url: &str) -> Nav {
    let lower = url.to_ascii_lowercase();
    if lower == "about:blank" || lower == "about:srcdoc" {
        return Nav::Allow;
    }
    if let Some(rest) = lower.strip_prefix("tauri://localhost") {
        // Exactly that host: `tauri://localhost.evil` or a port or userinfo is not it.
        return match rest.chars().next() {
            None | Some('/') | Some('?') | Some('#') => Nav::Allow,
            _ => Nav::Refuse,
        };
    }
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Nav::External;
    }
    Nav::Refuse
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receiver() -> ShellReceiver {
        ShellReceiver {
            id: "abcdefghij".into(),
            name: "studio-mac".into(),
            origin: "http://127.0.0.1:7823".into(),
            local: true,
        }
    }

    #[test]
    fn ios_info_matches_the_contract() {
        let v = serde_json::to_value(ShellInfo::ios("0.2.0", Some(receiver()))).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "v": 1, "platform": "ios", "appVersion": "0.2.0", "features": ["notifications", "signer"],
                "receiver": { "id": "abcdefghij", "name": "studio-mac", "origin": "http://127.0.0.1:7823", "local": true },
                "rxBase": "rx://localhost/abcdefghij"
            })
        );
    }

    #[test]
    fn no_receiver_means_no_rx_base() {
        let v = serde_json::to_value(ShellInfo::ios("0.2.0", None)).unwrap();
        assert_eq!(v["receiver"], serde_json::Value::Null);
        assert_eq!(v["rxBase"], serde_json::Value::Null);
    }

    #[test]
    fn the_signer_feature_means_the_status_is_there_not_a_key() {
        assert!(ShellInfo::ios("0.2.0", None).features.contains(&"signer"));
        assert!(!crate::identity::current().available);
    }

    #[test]
    fn init_script_sets_the_global_and_the_attribute() {
        let s = init_script(&ShellInfo::ios("0.2.0", None));
        assert!(s.contains(r#""platform":"ios""#));
        assert!(s.contains(r#"Object.defineProperty(window, "sessionpipeShell""#));
        assert!(s.contains("writable: false, configurable: false"));
        assert!(s.contains("dataset.shell = s.platform"));
        assert!(s.contains("user-scalable=no"));
        assert!(s.starts_with(MARKER) && s.ends_with("})();"));
    }

    #[test]
    fn init_script_cannot_be_broken_out_of() {
        let mut r = receiver();
        r.name = "</script><script>alert(1)</script>\u{2028}\"'`".into();
        let s = init_script(&ShellInfo::ios("0.2.0", Some(r)));
        assert!(!s.contains("</script>"));
        assert!(!s.contains('\u{2028}'));
        // The literal still parses back to the same name.
        let start = s.find("const s = ").unwrap() + "const s = ".len();
        let end = s[start..].find(";\n").unwrap() + start;
        let v: serde_json::Value = serde_json::from_str(&s[start..end]).unwrap();
        assert_eq!(
            v["receiver"]["name"],
            "</script><script>alert(1)</script>\u{2028}\"'`"
        );
    }

    #[test]
    fn navigation_stays_in_the_bundle() {
        assert_eq!(navigation("tauri://localhost"), Nav::Allow);
        assert_eq!(navigation("tauri://localhost/"), Nav::Allow);
        assert_eq!(navigation("tauri://localhost/s/abc?x=1#y"), Nav::Allow);
        assert_eq!(navigation("TAURI://LOCALHOST/inbox"), Nav::Allow);
        assert_eq!(navigation("about:blank"), Nav::Allow);
        assert_eq!(
            navigation("https://github.com/spacesheep-dev"),
            Nav::External
        );
        assert_eq!(navigation("http://192.168.1.4:7373/"), Nav::External);
        assert_eq!(navigation("tauri://localhost.evil.com/"), Nav::Refuse);
        assert_eq!(navigation("tauri://localhost:8080/"), Nav::Refuse);
        assert_eq!(navigation("tauri://localhost@evil/"), Nav::Refuse);
        assert_eq!(navigation("rx://localhost/abc/api/ui/info"), Nav::Refuse);
        assert_eq!(navigation("data:text/html,<script>1</script>"), Nav::Refuse);
        assert_eq!(navigation("javascript:alert(1)"), Nav::Refuse);
        assert_eq!(navigation("file:///etc/passwd"), Nav::Refuse);
        assert_eq!(navigation("sessionpipe://connect?url=x"), Nav::Refuse);
    }
}
