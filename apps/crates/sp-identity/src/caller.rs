//! Who may reach the signer (arch-identity §6.2, NATIVE-SPEC §2.4): only the webview
//! labelled `main`, showing the app's own bundled origin (`tauri://localhost` on macOS and
//! iOS, `http(s)://tauri.localhost` on Windows and Android), or the dev server in a debug
//! build. The capability file already scopes the plugin to `main` with no remote URL; this
//! is the same rule again, inside each command.
use crate::Error;

/// `scheme://authority` of a URL, lower-cased; None when it has none.
pub fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    (!scheme.is_empty() && !authority.is_empty() && !authority.contains('@')).then(|| {
        format!(
            "{}://{}",
            scheme.to_ascii_lowercase(),
            authority.to_ascii_lowercase()
        )
    })
}

pub const BUNDLED: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

pub fn allowed(label: &str, url: &str, dev_url: Option<&str>, debug: bool) -> Result<(), Error> {
    if label != "main" {
        return Err(Error::new(
            "not_main",
            "only the app's main window can sign",
        ));
    }
    let here =
        origin(url).ok_or_else(|| Error::new("not_main", "only the app's own page can sign"))?;
    if BUNDLED.contains(&here.as_str()) {
        return Ok(());
    }
    if debug && dev_url.and_then(origin).is_some_and(|d| d == here) {
        return Ok(());
    }
    Err(Error::new(
        "not_main",
        format!("{here} can't reach the signer"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_main_window_only() {
        assert!(allowed("main", "tauri://localhost/index.html", None, false).is_ok());
        assert!(allowed("main", "tauri://localhost/s/claude/abc?x=1#y", None, false).is_ok());
        assert!(allowed("main", "http://tauri.localhost/", None, false).is_ok());
        // Another window (a view window on a receiver's origin), whatever it shows.
        assert_eq!(
            allowed("view-canvas", "tauri://localhost/", None, false)
                .unwrap_err()
                .code,
            "not_main"
        );
        // The main window showing anything else: a receiver's page, a lookalike, a file.
        for u in [
            "http://127.0.0.1:7373/",
            "https://studio-mac.local:7373/",
            "tauri://localhost.evil.example/",
            "tauri://evil/",
            "file:///Users/x/index.html",
            "about:blank",
            "rx://localhost/abc/api",
        ] {
            assert!(allowed("main", u, None, false).is_err(), "{u}");
        }
    }

    #[test]
    fn the_dev_server_in_debug_builds_only() {
        let dev = Some("http://127.0.0.1:7816/");
        assert!(allowed("main", "http://127.0.0.1:7816/settings", dev, true).is_ok());
        assert!(allowed("main", "http://127.0.0.1:7816/settings", dev, false).is_err());
        assert!(allowed("main", "http://127.0.0.1:7817/", dev, true).is_err());
        assert!(allowed("main", "http://127.0.0.1:7816/", None, true).is_err());
    }
}
