//! One running app (NATIVE-SPEC §4 "Second launch / deep link while running"). A second
//! launch, from a terminal, a script or a link on Linux and Windows, hands its argv to the
//! running app and exits; the running app comes forward and follows the link. macOS
//! already delivers `sessionpipe://` to the running app through LaunchServices; this
//! covers launching the binary directly, and the dev builds, which declare no scheme.
//!
//! Test hooks, only when the running app was started with SP_TEST_HOOKS=1 (or is a debug
//! build): `--debug-simulate sleep|wake` drives power.rs without sleeping the Mac, and
//! `--debug-close-window` closes the main window as ⌘W does (the reopen measurement),
//! `--debug-update status|check|restart` logs the updater's state, checks now, or does
//! what "Restart to Update" does (the updater end-to-end test).

use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

use super::power::{self, Power};

/// The link in a second launch's argv: `--deep-link <url>`, or a bare `sessionpipe://…`
/// (how Linux and Windows pass a clicked link).
pub fn link_from_argv(argv: &[String]) -> Option<String> {
    crate::deeplink::from_argv(argv.iter().cloned()).or_else(|| {
        argv.iter()
            .skip(1)
            .find(|a| a.starts_with("sessionpipe://"))
            .cloned()
    })
}

/// `--debug-simulate sleep|wake` in argv.
pub fn simulate_from_argv(argv: &[String]) -> Option<Power> {
    let i = argv.iter().position(|a| a == "--debug-simulate")?;
    argv.get(i + 1).and_then(|s| Power::parse(s))
}

pub fn test_hooks_on() -> bool {
    cfg!(debug_assertions) || std::env::var("SP_TEST_HOOKS").as_deref() == Ok("1")
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app: &AppHandle<R>, argv: Vec<String>, _cwd: String| {
        on_second_launch(app, &argv);
    })
}

fn on_second_launch<R: Runtime>(app: &AppHandle<R>, argv: &[String]) {
    if let Some(p) = simulate_from_argv(argv) {
        if test_hooks_on() {
            log::info!(target: "sessionpipe::lifecycle", "test hook: simulate {p:?}");
            power::on_power(app, p);
        } else {
            log::warn!(target: "sessionpipe::lifecycle", "--debug-simulate ignored (no SP_TEST_HOOKS)");
        }
        return;
    }
    // `--debug-eval <js>`: runs a script in the main window, as a person's click would act
    // (the QA walkthrough drives the page this way instead of the Mac's keyboard and
    // mouse). Debug builds only: a release build has no such code.
    #[cfg(debug_assertions)]
    if let Some(i) = argv.iter().position(|a| a == "--debug-eval") {
        if let (Some(js), Some(w)) = (argv.get(i + 1), app.get_webview_window("main")) {
            log::info!(target: "sessionpipe::lifecycle", "test hook: eval {} bytes", js.len());
            let _ = w.eval(js);
        }
        return;
    }
    let hook = argv
        .iter()
        .position(|a| a == "--debug-close-window" || a == "--debug-update");
    if let Some(i) = hook {
        if !test_hooks_on() {
            log::warn!(target: "sessionpipe::lifecycle", "{} ignored (no SP_TEST_HOOKS)", argv[i]);
            return;
        }
        match (argv[i].as_str(), argv.get(i + 1).map(String::as_str)) {
            ("--debug-close-window", _) => {
                log::info!(target: "sessionpipe::lifecycle", "test hook: close the main window");
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
            (_, Some("check")) => crate::updater::check_now(app.clone()),
            (_, Some("restart")) => {
                log::info!(target: "sessionpipe::lifecycle", "test hook: restart to update");
                crate::updater::restart(app.clone());
            }
            _ => {
                let out = app.state::<crate::Shell>().update.lock().unwrap().out();
                log::info!(
                    target: "sessionpipe::lifecycle",
                    "test hook: update state {}",
                    serde_json::to_string(&out).unwrap_or_default()
                );
            }
        }
        return;
    }
    match link_from_argv(argv) {
        Some(url) => {
            log::info!(target: "sessionpipe::lifecycle", "second launch: forwarding a deep link");
            crate::deeplink::handle_deep_link(app, &url);
        }
        None => {
            log::info!(target: "sessionpipe::lifecycle", "second launch: bringing the window forward");
            crate::deeplink::handle_deep_link(app, "sessionpipe://open");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_the_link() {
        assert_eq!(
            link_from_argv(&v(&["app", "--deep-link", "sessionpipe://inbox"])).as_deref(),
            Some("sessionpipe://inbox")
        );
        assert_eq!(
            link_from_argv(&v(&["app", "--deep-link=sessionpipe://feed"])).as_deref(),
            Some("sessionpipe://feed")
        );
        assert_eq!(
            link_from_argv(&v(&["app", "sessionpipe://open"])).as_deref(),
            Some("sessionpipe://open")
        );
        assert_eq!(link_from_argv(&v(&["sessionpipe://not-argv0-twice"])), None);
        assert_eq!(link_from_argv(&v(&["app", "-psn_0_123"])), None);
    }

    #[test]
    fn finds_the_test_hook() {
        assert_eq!(
            simulate_from_argv(&v(&["app", "--debug-simulate", "sleep"])),
            Some(Power::Sleep)
        );
        assert_eq!(
            simulate_from_argv(&v(&["app", "--debug-simulate", "wake"])),
            Some(Power::Wake)
        );
        assert_eq!(
            simulate_from_argv(&v(&["app", "--debug-simulate", "nap"])),
            None
        );
        assert_eq!(simulate_from_argv(&v(&["app"])), None);
    }
}
