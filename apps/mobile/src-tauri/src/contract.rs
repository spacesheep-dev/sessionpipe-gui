//! The shell contract (NATIVE-SPEC §2.5) and the navigation rule (§2.4), as plain data and
//! pure functions, so both are unit-tested on the host without a simulator.

use serde::Serialize;

/// The phone this build is for. Everything that differs between the two is here, so both
/// are tested on the host whichever target the tests are built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Ios,
    Android,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "android") {
            Os::Android
        } else {
            Os::Ios
        }
    }

    /// The page's name for it (`data-shell`, `web/src/native/shell.ts`).
    pub const fn name(self) -> &'static str {
        match self {
            Os::Ios => "ios",
            Os::Android => "android",
        }
    }

    /// Where the bundled UI is served. Android's WebView can't load a custom scheme as a
    /// page, so Tauri serves it as `http://<scheme>.localhost` there.
    pub const fn app_origin(self) -> &'static str {
        match self {
            Os::Ios => "tauri://localhost",
            Os::Android => "http://tauri.localhost",
        }
    }

    /// The `rx:` base for a receiver: `rx://localhost/<id>`, or `http://rx.localhost/<id>`
    /// on Android for the same reason.
    pub fn rx_base(self, id: &str) -> String {
        match self {
            Os::Ios => format!("rx://localhost/{id}"),
            Os::Android => format!("http://rx.localhost/{id}"),
        }
    }
}

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

impl ShellInfo {
    pub fn new(os: Os, app_version: &str, receiver: Option<ShellReceiver>) -> Self {
        let rx_base = receiver.as_ref().map(|r| os.rx_base(&r.id));
        ShellInfo {
            v: 1,
            platform: os.name(),
            app_version: app_version.to_owned(),
            // "signer": the identity plugin answers `status` here, so the page shows the
            // Signing row and why sending is off ("Sending needs a real phone"). It never
            // makes a key in this build (identity.rs).
            // "haptics": `app_haptic` plays a `Haptic` on the phone's engine (§11.3); on
            // Android the page calls MainActivity's `spHaptic.perform` directly.
            features: vec!["notifications", "signer", "haptics"],
            receiver,
            rx_base,
        }
    }
}

/// A haptic the page asks for (`app_haptic`, `web/src/lib/haptics.ts`), named as Apple's
/// generators name them: a selection ticking over, a touch landing, an outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Haptic {
    Selection,
    Light,
    Medium,
    Success,
    Warning,
    Error,
}

impl Haptic {
    /// The page's word for it; anything else is refused (the command answers Err).
    pub fn parse(kind: &str) -> Option<Haptic> {
        Some(match kind {
            "selection" => Haptic::Selection,
            "light" => Haptic::Light,
            "medium" => Haptic::Medium,
            "success" => Haptic::Success,
            "warning" => Haptic::Warning,
            "error" => Haptic::Error,
            _ => return None,
        })
    }
}

/// The scheme the page renders in (`app_appearance`, `web/src/native/appearance.ts`): what
/// `<html data-theme>` says, or Auto when it is absent and the page follows the OS. The
/// system bars follow it, so the status bar's text is readable over a forced dark page
/// on a light phone and the other way round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Light,
    Dark,
    Auto,
}

impl Scheme {
    pub fn parse(scheme: &str) -> Option<Scheme> {
        Some(match scheme {
            "light" => Scheme::Light,
            "dark" => Scheme::Dark,
            "auto" => Scheme::Auto,
            _ => return None,
        })
    }

    /// UIKit's `UIUserInterfaceStyle`: unspecified 0, light 1, dark 2.
    pub const fn ui_user_interface_style(self) -> isize {
        match self {
            Scheme::Auto => 0,
            Scheme::Light => 1,
            Scheme::Dark => 2,
        }
    }
}

/// The first line of the contract script: how the shell finds its own script among the
/// webview's user scripts to swap it when the person switches receivers.
pub const MARKER: &str = "/* sessionpipe shell contract v1 */";

/// The initialization script: runs before any page script, in the main frame only.
///
/// - `window.sessionpipeShell`: frozen, not writable, not configurable, so page code can't
///   swap the receiver or the rx base under the app.
/// - `data-shell` on `<html>` for the CSS (`web/src/native/mobile.css`).
/// - The viewport gets `maximum-scale=1, user-scalable=no`: an app doesn't pinch-zoom its
///   own chrome (WKWebView honours it, unlike Safari).
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
    script(&json)
}

/// Where Android's script reads the contract (`net::handle_shell`).
pub const CONTRACT_URL: &str = "http://shell.localhost/contract";

/// Android's script: its WebView can't swap a document-start script, so the same script
/// asks the shell for the contract as each page starts (a synchronous request, so it is
/// there before any page script runs), and switching receivers is a navigation.
pub fn live_init_script() -> String {
    script(&format!(
        r#"(() => {{ try {{ const x = new XMLHttpRequest(); x.open("GET", "{CONTRACT_URL}", false); x.send(); return x.status === 200 ? JSON.parse(x.responseText) : null; }} catch {{ return null; }} }})()"#
    ))
}

fn script(source: &str) -> String {
    format!(
        r#"{MARKER}
(() => {{
  if (window.top !== window) return;
  const s = {source};
  if (!s) return;
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
    /// An http(s) link: hand it to the browser, stay where we are.
    External,
    /// Anything else (other schemes, `rx:` as a page, data: documents): refuse.
    Refuse,
}

/// The main window may navigate only within the bundled origin (`Os::app_origin`).
pub fn navigation(os: Os, url: &str) -> Nav {
    let lower = url.to_ascii_lowercase();
    if lower == "about:blank" || lower == "about:srcdoc" {
        return Nav::Allow;
    }
    if let Some(rest) = lower.strip_prefix(os.app_origin()) {
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
        let v = serde_json::to_value(ShellInfo::new(Os::Ios, "0.2.0", Some(receiver()))).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "v": 1, "platform": "ios", "appVersion": "0.2.0", "features": ["notifications", "signer", "haptics"],
                "receiver": { "id": "abcdefghij", "name": "studio-mac", "origin": "http://127.0.0.1:7823", "local": true },
                "rxBase": "rx://localhost/abcdefghij"
            })
        );
    }

    #[test]
    fn android_info_names_android_and_its_http_rx_base() {
        let v =
            serde_json::to_value(ShellInfo::new(Os::Android, "0.2.0", Some(receiver()))).unwrap();
        assert_eq!(v["platform"], "android");
        assert_eq!(v["rxBase"], "http://rx.localhost/abcdefghij");
    }

    #[test]
    fn no_receiver_means_no_rx_base() {
        let v = serde_json::to_value(ShellInfo::new(Os::Ios, "0.2.0", None)).unwrap();
        assert_eq!(v["receiver"], serde_json::Value::Null);
        assert_eq!(v["rxBase"], serde_json::Value::Null);
    }

    #[test]
    fn the_signer_feature_means_the_status_is_there_not_a_key() {
        assert!(ShellInfo::new(Os::Ios, "0.2.0", None)
            .features
            .contains(&"signer"));
        assert!(!crate::identity::current().available);
    }

    #[test]
    fn both_phones_list_haptics() {
        for os in [Os::Ios, Os::Android] {
            assert!(ShellInfo::new(os, "0.2.0", None)
                .features
                .contains(&"haptics"));
        }
    }

    #[test]
    fn haptic_kinds_are_the_pages_words_and_nothing_else() {
        assert_eq!(Haptic::parse("selection"), Some(Haptic::Selection));
        assert_eq!(Haptic::parse("light"), Some(Haptic::Light));
        assert_eq!(Haptic::parse("medium"), Some(Haptic::Medium));
        assert_eq!(Haptic::parse("success"), Some(Haptic::Success));
        assert_eq!(Haptic::parse("warning"), Some(Haptic::Warning));
        assert_eq!(Haptic::parse("error"), Some(Haptic::Error));
        for bad in ["heavy", "Light", "", "impact"] {
            assert_eq!(Haptic::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn schemes_map_to_uikits_styles() {
        assert_eq!(Scheme::parse("light"), Some(Scheme::Light));
        assert_eq!(Scheme::parse("dark"), Some(Scheme::Dark));
        assert_eq!(Scheme::parse("auto"), Some(Scheme::Auto));
        assert_eq!(Scheme::parse("system"), None);
        assert_eq!(Scheme::parse(""), None);
        assert_eq!(Scheme::Auto.ui_user_interface_style(), 0);
        assert_eq!(Scheme::Light.ui_user_interface_style(), 1);
        assert_eq!(Scheme::Dark.ui_user_interface_style(), 2);
    }

    #[test]
    fn init_script_sets_the_global_and_the_attribute() {
        let s = init_script(&ShellInfo::new(Os::Ios, "0.2.0", None));
        assert!(s.contains(r#""platform":"ios""#));
        assert!(s.contains(r#"Object.defineProperty(window, "sessionpipeShell""#));
        assert!(s.contains("writable: false, configurable: false"));
        assert!(s.contains("dataset.shell = s.platform"));
        assert!(s.contains("user-scalable=no"));
        assert!(s.starts_with(MARKER) && s.ends_with("})();"));
    }

    #[test]
    fn the_live_script_reads_the_contract_synchronously() {
        let s = live_init_script();
        assert!(s.starts_with(MARKER) && s.ends_with("})();"));
        assert!(s.contains(r#"x.open("GET", "http://shell.localhost/contract", false)"#));
        assert!(s.contains("if (!s) return;"));
        assert!(s.contains(r#"Object.defineProperty(window, "sessionpipeShell""#));
    }

    #[test]
    fn init_script_cannot_be_broken_out_of() {
        let mut r = receiver();
        r.name = "</script><script>alert(1)</script>\u{2028}\"'`".into();
        let s = init_script(&ShellInfo::new(Os::Ios, "0.2.0", Some(r)));
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
        assert_eq!(navigation(Os::Ios, "tauri://localhost"), Nav::Allow);
        assert_eq!(navigation(Os::Ios, "tauri://localhost/"), Nav::Allow);
        assert_eq!(
            navigation(Os::Ios, "tauri://localhost/s/abc?x=1#y"),
            Nav::Allow
        );
        assert_eq!(navigation(Os::Ios, "TAURI://LOCALHOST/inbox"), Nav::Allow);
        assert_eq!(navigation(Os::Ios, "about:blank"), Nav::Allow);
        assert_eq!(
            navigation(Os::Ios, "https://github.com/spacesheep-dev"),
            Nav::External
        );
        assert_eq!(
            navigation(Os::Ios, "http://192.168.1.4:7373/"),
            Nav::External
        );
        assert_eq!(
            navigation(Os::Ios, "tauri://localhost.evil.com/"),
            Nav::Refuse
        );
        assert_eq!(navigation(Os::Ios, "tauri://localhost:8080/"), Nav::Refuse);
        assert_eq!(navigation(Os::Ios, "tauri://localhost@evil/"), Nav::Refuse);
        assert_eq!(
            navigation(Os::Ios, "rx://localhost/abc/api/ui/info"),
            Nav::Refuse
        );
        assert_eq!(
            navigation(Os::Ios, "data:text/html,<script>1</script>"),
            Nav::Refuse
        );
        assert_eq!(navigation(Os::Ios, "javascript:alert(1)"), Nav::Refuse);
        assert_eq!(navigation(Os::Ios, "file:///etc/passwd"), Nav::Refuse);
        assert_eq!(
            navigation(Os::Ios, "sessionpipe://connect?url=x"),
            Nav::Refuse
        );
        // iOS's bundle is never served over http.
        assert_eq!(
            navigation(Os::Ios, "http://tauri.localhost/"),
            Nav::External
        );
    }

    #[test]
    fn android_navigation_stays_in_its_http_bundle() {
        let a = |u| navigation(Os::Android, u);
        assert_eq!(a("http://tauri.localhost"), Nav::Allow);
        assert_eq!(a("http://tauri.localhost/s/abc?x=1#y"), Nav::Allow);
        assert_eq!(a("HTTP://TAURI.LOCALHOST/inbox"), Nav::Allow);
        assert_eq!(a("http://tauri.localhost.evil.com/"), Nav::Refuse);
        assert_eq!(a("http://tauri.localhost:8080/"), Nav::Refuse);
        assert_eq!(a("https://tauri.localhost/"), Nav::External);
        assert_eq!(a("tauri://localhost/"), Nav::Refuse);
        assert_eq!(a("http://192.168.1.4:7373/"), Nav::External);
        assert_eq!(a("javascript:alert(1)"), Nav::Refuse);
    }
}
