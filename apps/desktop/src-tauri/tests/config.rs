//! The security-relevant configuration, checked against NATIVE-SPEC.md §2.4.

use std::path::Path;

fn dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn json(p: &Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())))
        .unwrap()
}

/// Every capability file: windows exactly ["main"], no `remote` block anywhere.
#[test]
fn capabilities_are_main_window_only_and_never_remote() {
    let mut n = 0;
    for e in std::fs::read_dir(dir().join("capabilities")).unwrap() {
        let p = e.unwrap().path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        n += 1;
        let v = json(&p);
        assert_eq!(
            v["windows"],
            serde_json::json!(["main"]),
            "{}: windows",
            p.display()
        );
        assert!(v.get("webviews").is_none(), "{}: webviews", p.display());
        fn no_remote(v: &serde_json::Value, at: &str) {
            match v {
                serde_json::Value::Object(m) => {
                    assert!(!m.contains_key("remote"), "{at}: a remote block");
                    for (k, x) in m {
                        no_remote(x, &format!("{at}.{k}"));
                    }
                }
                serde_json::Value::Array(a) => a.iter().for_each(|x| no_remote(x, at)),
                _ => {}
            }
        }
        no_remote(&v, &p.display().to_string());
    }
    assert!(n >= 1);
    // And no config file declares capabilities inline with a remote either.
    for f in [
        "tauri.conf.json",
        "tauri.macos.conf.json",
        "tauri.release.conf.json",
        "tauri.measure.conf.json",
    ] {
        let p = dir().join(f);
        if p.exists() {
            assert!(
                !std::fs::read_to_string(&p).unwrap().contains("\"remote\""),
                "{f}"
            );
        }
    }
}

#[test]
fn csp_matches_the_spec_and_no_global_tauri() {
    const SPEC: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' rx: http://rx.localhost; img-src 'self' data: blob: rx: http://rx.localhost; font-src 'self' rx: http://rx.localhost; media-src 'self' rx: http://rx.localhost; connect-src 'self' ipc: http://ipc.localhost rx: http://rx.localhost; frame-src 'none'; object-src 'none'; base-uri 'none'";
    let v = json(&dir().join("tauri.conf.json"));
    assert_eq!(v["app"]["security"]["csp"], SPEC);
    assert_eq!(v["app"]["withGlobalTauri"], false);
    // Tauri's asset hashes in style-src would switch 'unsafe-inline' off and block the
    // page's style="" attributes (seen on iOS); scripts keep their hashes.
    assert_eq!(
        v["app"]["security"]["dangerousDisableAssetCspModification"],
        serde_json::json!(["style-src"])
    );
    assert_eq!(v["build"]["frontendDist"], "../dist-app");
    // No URL scheme in the dev config: the release overlay is packaging's.
    assert!(v["plugins"].get("deep-link").is_none());
}

/// The macOS release ships the Touch ID signer (`--features identity`), and only the macOS
/// one: Linux and Windows build without it. Its Secure Enclave keys and login-keychain items
/// need no entitlement (checked with a Developer ID, hardened-runtime build), so
/// Entitlements.plist stays empty and the app needs no provisioning profile.
#[test]
fn the_macos_release_carries_the_signer_and_no_entitlement() {
    let read =
        |p: &str| std::fs::read_to_string(dir().join(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
    let wf = read("../../../.github/workflows/desktop-release.yml");
    let rows: Vec<&str> = wf.lines().filter(|l| l.contains("\"platform\":")).collect();
    assert_eq!(rows.len(), 3, "macOS, Windows and Linux");
    for row in rows {
        assert_eq!(
            row.contains("--features identity"),
            row.contains("\"platform\":\"macos\""),
            "{row}"
        );
    }
    assert!(read("../scripts/build-mac.sh").contains("features=identity"));
    // A Windows checkout has CRLF line ends (core.autocrlf); the shape is what counts.
    let plist = read("Entitlements.plist").replace("\r\n", "\n");
    let dict = &plist[plist.find("<dict>").unwrap()..];
    assert!(
        dict.starts_with("<dict>\n</dict>"),
        "Entitlements.plist names an entitlement"
    );
}
