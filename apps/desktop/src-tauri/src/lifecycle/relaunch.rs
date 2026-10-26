//! Restarting the app (after an update is installed: "Restart to Update").
//!
//! Tauri's `AppHandle::restart()` relaunches a macOS bundle with `open -n`, so launchd owns
//! the new process, which is right, but LaunchServices drops the environment. A dev or test
//! run lives on its environment (SP_RECEIVER_URL keeps a release build away from :7373 and
//! ~/.local/state, SP_SHELL_HOME and SP_SHELL_STATUS keep its files in scratch), so a plain
//! restart would bring it back as an unconfined release app. `relaunch` keeps `open -n`
//! and passes the SP_* variables that are set along with `--env`; for a person, none are set
//! and it is exactly `open -n <bundle>`.
//!
//! It runs on RunEvent::Exit, after the single-instance plugin has let go of its socket
//! (that plugin is registered first), so the new process doesn't hand itself to the old one.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Runtime};

/// What a dev or test run is made of; carried across a relaunch when set.
pub const CARRIED: &[&str] = &[
    "SP_RECEIVER_URL",
    "SP_SHELL_HOME",
    "SP_SHELL_STATUS",
    "SP_TEST_HOOKS",
    "SP_LOCAL_STATE",
    "SP_UPDATE_URL",
    "SP_DEV_CLI",
    "SP_DEV_RECEIVER_PORT",
    "RUST_LOG",
];

static PENDING: AtomicBool = AtomicBool::new(false);

/// Quits and starts again (the caller installed the update first).
pub fn relaunch<R: Runtime>(app: &AppHandle<R>) {
    log::info!(target: "sessionpipe::lifecycle", "relaunch: quitting, then opening the bundle again with the dev environment");
    PENDING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The .app around an executable at `<bundle>/Contents/MacOS/<exe>`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// The command that starts the app again: `open -n <bundle> [--env K=V…] --args …` for a
/// bundle, else the executable itself (which inherits the environment anyway).
pub fn command(
    exe: &Path,
    env: &dyn Fn(&str) -> Option<OsString>,
    args: &[OsString],
) -> (PathBuf, Vec<OsString>) {
    match bundle_of(exe) {
        Some(bundle) => {
            let mut a: Vec<OsString> = vec!["-n".into(), bundle.into_os_string()];
            for k in CARRIED {
                if let Some(v) = env(k).filter(|v| !v.is_empty()) {
                    let mut kv = OsString::from(format!("{k}="));
                    kv.push(v);
                    a.push("--env".into());
                    a.push(kv);
                }
            }
            if !args.is_empty() {
                a.push("--args".into());
                a.extend(args.iter().cloned());
            }
            (PathBuf::from("/usr/bin/open"), a)
        }
        None => (exe.to_path_buf(), args.to_vec()),
    }
}

/// Called on RunEvent::Exit: starts the new process when a relaunch was asked for.
pub fn on_exit() {
    if !PENDING.swap(false, Ordering::SeqCst) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let (program, argv) = command(&exe, &|k| std::env::var_os(k), &args);
    match Command::new(&program)
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => {
            log::info!(target: "sessionpipe::lifecycle", "relaunch: started {}", program.display())
        }
        Err(e) => log::error!(target: "sessionpipe::lifecycle", "relaunch failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_the_bundle_again_with_the_dev_environment() {
        let exe = Path::new("/x/sessionpipe.app/Contents/MacOS/sessionpipe-desktop");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/x/sessionpipe.app")));
        let env = |k: &str| match k {
            "SP_RECEIVER_URL" => Some(OsString::from("http://127.0.0.1:7827")),
            "SP_SHELL_HOME" => Some(OsString::from("/s")),
            "SP_UPDATE_URL" => Some(OsString::new()),
            _ => None,
        };
        let (p, a) = command(
            exe,
            &env,
            &["--deep-link".into(), "sessionpipe://open".into()],
        );
        assert_eq!(p, PathBuf::from("/usr/bin/open"));
        let a: Vec<String> = a.into_iter().map(|s| s.into_string().unwrap()).collect();
        assert_eq!(
            a,
            [
                "-n",
                "/x/sessionpipe.app",
                "--env",
                "SP_RECEIVER_URL=http://127.0.0.1:7827",
                "--env",
                "SP_SHELL_HOME=/s",
                "--args",
                "--deep-link",
                "sessionpipe://open"
            ]
        );
    }

    #[test]
    fn a_person_gets_a_plain_open_and_a_bare_binary_runs_itself() {
        let none = |_: &str| None;
        let (p, a) = command(Path::new("/A/sessionpipe.app/Contents/MacOS/s"), &none, &[]);
        assert_eq!(
            (p, a),
            (
                PathBuf::from("/usr/bin/open"),
                vec![OsString::from("-n"), OsString::from("/A/sessionpipe.app")]
            )
        );
        let (p, a) = command(
            Path::new("/target/debug/sessionpipe-desktop"),
            &none,
            &["-x".into()],
        );
        assert_eq!(
            (p, a),
            (
                PathBuf::from("/target/debug/sessionpipe-desktop"),
                vec![OsString::from("-x")]
            )
        );
    }
}
