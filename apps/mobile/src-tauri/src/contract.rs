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

    /// Can this phone use a spacesheep account with no receiver (docs/rfcs/08)? The
    /// iPhone can. Android cannot yet: an account is reached over https, and the Hub's
    /// https client verifies certificates through the platform's verifier, which on
    /// Android has to be handed the app's Java context at start (and its Kotlin half
    /// built into the app). Until that is done a request there would end the app, so the
    /// Hub refuses to connect one and the page is not told the feature is there.
    pub const fn account(self) -> bool {
        matches!(self, Os::Ios)
    }

    /// What this install calls itself on spacesheep's confirm page, and in the name of
    /// the key made for it there ("sessionpipe-gui on iPhone (0.8.0)").
    pub const fn device_name(self) -> &'static str {
        match self {
            Os::Ios => "iPhone",
            Os::Android => "Android phone",
        }
    }
}

/// The receiver this window shows. A sessionpipe-gui receiver has the first four fields
/// and nothing else, as it always had. A spacesheep account (docs/rfcs/08) has all seven:
/// `kind: "spacesheep"` is how the page knows there is no server behind `rxBase`, only
/// the account's doors, and that it carries its own board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellReceiver {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub local: bool,
    /// `"spacesheep"` for an account; absent for a receiver.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// Whose account, for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// `"ok"`, `"unauthorized"` or `"no_key"` as the window opened. It can change while
    /// the window lives: `acct_status` and the `account` event say how it is now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<&'static str>,
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
        let mut features = vec!["notifications", "signer", "haptics", "scanner"];
        // "account": the `acct_*` commands are here and the Hub takes a spacesheep
        // account as a receiver (`Os::account`).
        // "account-needs": `acct_needs` is here too: the page hands the Hub the
        // account's sessions that need the person, and they are notified of as a
        // receiver's are.
        if os.account() {
            features.push("account");
            features.push("account-needs");
        }
        ShellInfo {
            v: 1,
            platform: os.name(),
            app_version: app_version.to_owned(),
            // "signer": the identity plugin answers `status` here. On an iPhone it is
            // the signer itself (sp-identity: the key in the Secure Enclave, Face ID);
            // in the simulator and on Android `status` says why sending is off
            // ("Sending needs a real iPhone", identity.rs) and no key is ever made.
            // "haptics": `app_haptic` plays a `Haptic` on the phone's engine (§11.3); on
            // Android the page calls MainActivity's `spHaptic.perform` directly.
            // "scanner": the QR scanner (§11.5, `web/src/native/scanner.ts`):
            // tauri-plugin-barcode-scanner's commands, and `rx_add` takes what it decodes.
            features,
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

/// The contract script the window was last given (iOS: the WKUserScript that runs as
/// each page starts). The Hub's list changes under a page that stays (an account is
/// disconnected, a key is refused, a receiver says its name); the script is swapped
/// when what it would say changed, so a page that reloads itself reads the contract as
/// it is now, and not the one the window was opened with.
#[derive(Debug, Default)]
pub struct Injected(std::sync::Mutex<String>);

impl Injected {
    /// Notes `script` as the one in the window. True when it is not the one that was
    /// there (and so has to be swapped in).
    pub fn renew(&self, script: &str) -> bool {
        let mut last = self.0.lock().unwrap();
        if *last == script {
            return false;
        }
        *last = script.to_owned();
        true
    }
}

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
            kind: None,
            email: None,
            state: None,
        }
    }

    fn account() -> ShellReceiver {
        ShellReceiver {
            id: "klmnopqrst".into(),
            name: "spacesheep.dev".into(),
            origin: "https://spacesheep.dev".into(),
            local: false,
            kind: Some("spacesheep"),
            email: Some("misha@example.com".into()),
            state: Some("ok"),
        }
    }

    #[test]
    fn ios_info_matches_the_contract() {
        let v = serde_json::to_value(ShellInfo::new(Os::Ios, "0.2.0", Some(receiver()))).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "v": 1, "platform": "ios", "appVersion": "0.2.0", "features": ["notifications", "signer", "haptics", "scanner", "account", "account-needs"],
                "receiver": { "id": "abcdefghij", "name": "studio-mac", "origin": "http://127.0.0.1:7823", "local": true },
                "rxBase": "rx://localhost/abcdefghij"
            })
        );
    }

    /// A receiver's entry is what it always was, field for field; an account's adds
    /// three, and its `rxBase` is made the same way.
    #[test]
    fn an_account_says_so_and_a_receiver_says_nothing_new() {
        let plain = serde_json::to_value(receiver()).unwrap();
        let mut keys: Vec<&String> = plain.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["id", "local", "name", "origin"]);
        let v = serde_json::to_value(ShellInfo::new(Os::Ios, "0.8.0", Some(account()))).unwrap();
        assert_eq!(
            v["receiver"],
            serde_json::json!({
                "id": "klmnopqrst", "name": "spacesheep.dev", "origin": "https://spacesheep.dev", "local": false,
                "kind": "spacesheep", "email": "misha@example.com", "state": "ok"
            })
        );
        assert_eq!(v["rxBase"], "rx://localhost/klmnopqrst");
        // The page freezes the receiver; every field of an account is on it, none nested.
        assert!(v["receiver"]
            .as_object()
            .unwrap()
            .values()
            .all(|x| !x.is_object()));
    }

    /// The iPhone says it can use an account; Android does not, until it can (`Os::account`).
    #[test]
    fn the_account_feature_is_the_iphones_for_now() {
        assert!(ShellInfo::new(Os::Ios, "0.8.0", None)
            .features
            .contains(&"account"));
        assert!(!ShellInfo::new(Os::Android, "0.8.0", None)
            .features
            .contains(&"account"));
        assert_eq!(Os::Ios.device_name(), "iPhone");
        // The needs-you hand-over is there exactly where the account is.
        for os in [Os::Ios, Os::Android] {
            let f = ShellInfo::new(os, "0.8.0", None).features;
            assert_eq!(f.contains(&"account-needs"), f.contains(&"account"));
        }
    }

    /// The window's contract script is swapped when what it says changed, and only then.
    #[test]
    fn the_contract_in_the_window_is_renewed_when_it_changed() {
        let with = init_script(&ShellInfo::new(Os::Ios, "0.8.0", Some(account())));
        let without = init_script(&ShellInfo::new(Os::Ios, "0.8.0", None));
        assert_ne!(with, without);
        let window = Injected::default();
        assert!(window.renew(&with), "the first one is new");
        assert!(!window.renew(&with), "the same again is not");
        // The account was disconnected: the next page must not start on it.
        assert!(window.renew(&without));
        assert!(!without.contains("klmnopqrst") && !without.contains("misha@example.com"));
        assert!(!window.renew(&without));
        // The account's state is part of what a page reads as it starts.
        let mut refused = account();
        refused.state = Some("unauthorized");
        assert!(window.renew(&init_script(&ShellInfo::new(
            Os::Ios,
            "0.8.0",
            Some(refused)
        ))));
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
    fn both_phones_list_the_scanner() {
        for os in [Os::Ios, Os::Android] {
            assert!(ShellInfo::new(os, "0.2.0", None)
                .features
                .contains(&"scanner"));
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
