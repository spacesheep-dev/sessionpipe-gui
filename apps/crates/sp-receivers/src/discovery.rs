//! Finding the local receiver (NATIVE-SPEC.md §1.1, §1.2).
//!
//! Order: a loopback probe of the default port, then `<state>/run.json`, then the
//! receivers the person added (the caller has those). Debug builds never run the default
//! probe and never read `~/.local/state`; setting SP_RECEIVER_URL turns it off in any build.
//! Everything takes `home` and the probe address so tests use a temp dir and a demo port.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub use reqwest::Client;

pub const DEFAULT_PORT: u16 = 7373;

/// Whether default discovery may run at all.
pub fn enabled(env_receiver_url: Option<&str>) -> bool {
    cfg!(not(debug_assertions)) && env_receiver_url.is_none_or(|s| s.trim().is_empty())
}

/// The receiver's default state dir for a given home, as server/config.ts
/// `defaultStateDir()` computes it (env first).
pub fn default_state_dir(home: &Path, env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(s) = env("SESSIONPIPE_GUI_STATE").filter(|s| !s.is_empty()) {
        return PathBuf::from(s);
    }
    if let Some(x) = env("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(x).join("sessionpipe-gui");
    }
    home.join(".local").join("state").join("sessionpipe-gui")
}

/// `<state>/run.json`, written by the receiver on listen (packaging's server/runfile.ts).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunFile {
    pub port: u16,
    pub pid: u32,
    #[serde(default)]
    pub version: String,
    pub url: String,
    #[serde(default)]
    pub started_at: String,
}

pub fn read_run_file(state_dir: &Path) -> Option<RunFile> {
    let bytes = std::fs::read(state_dir.join("run.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Is a process with this pid alive (signal 0)?
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        // SAFETY: kill(pid, 0) only checks for existence and permission.
        let r = unsafe { kill(pid as i32, 0) };
        if r == 0 {
            return true;
        }
        // EPERM: it exists but belongs to someone else.
        std::io::Error::last_os_error().raw_os_error() == Some(1)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// `GET <origin>/api/ui/info`, accepted when `name === "sessionpipe-gui"`. Returns the info.
pub async fn probe(client: &reqwest::Client, origin: &str) -> Option<serde_json::Value> {
    let res = client
        .get(format!("{origin}/api/ui/info"))
        .header("accept", "application/json")
        .timeout(Duration::from_millis(800))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v: serde_json::Value = res.json().await.ok()?;
    (v.get("name").and_then(|n| n.as_str()) == Some("sessionpipe-gui")).then_some(v)
}

/// The local receiver, by the default port first, then run.json. `probe_origin` is
/// `http://127.0.0.1:7373` in release builds; tests pass a demo port.
pub async fn find_local(
    client: &reqwest::Client,
    probe_origin: &str,
    state_dir: &Path,
) -> Option<String> {
    if probe(client, probe_origin).await.is_some() {
        return Some(probe_origin.to_string());
    }
    let run = read_run_file(state_dir)?;
    if !pid_alive(run.pid) {
        log::info!("run.json names pid {} which is gone; ignored", run.pid);
        return None;
    }
    let origin = crate::id::canonical_origin(&run.url)?;
    if !crate::id::is_loopback_origin(&origin) {
        return None;
    }
    probe(client, &origin).await.map(|_| origin)
}

/// The release-build entry: everything decided from the environment. Compiled out in
/// debug builds, which only ever connect to SP_RECEIVER_URL.
#[cfg(not(debug_assertions))]
pub async fn find_local_default(client: &reqwest::Client) -> Option<String> {
    if !enabled(std::env::var("SP_RECEIVER_URL").ok().as_deref()) {
        return None;
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let state = default_state_dir(&home, &|k| std::env::var(k).ok());
    find_local(client, &format!("http://127.0.0.1:{DEFAULT_PORT}"), &state).await
}

#[cfg(debug_assertions)]
pub async fn find_local_default(_client: &reqwest::Client) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{serve_once_forever, TempDir};

    #[test]
    fn disabled_in_debug_and_by_env() {
        // Tests are debug builds: never on.
        assert!(!enabled(None));
        assert!(!enabled(Some("http://127.0.0.1:7811")));
    }

    #[test]
    fn state_dir_follows_the_server_rules() {
        let home = Path::new("/h");
        let none = |_: &str| None;
        assert_eq!(
            default_state_dir(home, &none),
            PathBuf::from("/h/.local/state/sessionpipe-gui")
        );
        let xdg = |k: &str| (k == "XDG_STATE_HOME").then(|| "/x".to_string());
        assert_eq!(
            default_state_dir(home, &xdg),
            PathBuf::from("/x/sessionpipe-gui")
        );
        let own = |k: &str| (k == "SESSIONPIPE_GUI_STATE").then(|| "/s".to_string());
        assert_eq!(default_state_dir(home, &own), PathBuf::from("/s"));
    }

    #[test]
    fn pid_checks() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        assert!(!pid_alive(9_999_990));
    }

    #[tokio::test]
    async fn run_json_is_used_and_a_stale_one_ignored() {
        crate::ensure_crypto();
        let t = TempDir::new("disc");
        let client = reqwest::Client::new();
        // A fake receiver on an ephemeral port that answers /api/ui/info.
        let port = serve_once_forever(r#"{"name":"sessionpipe-gui","version":"0.2.0"}"#).await;
        // Nothing on the probe port (a closed ephemeral port), no run.json: nothing.
        let dead = "http://127.0.0.1:9";
        assert_eq!(find_local(&client, dead, t.path()).await, None);
        // run.json with a live pid: found.
        let url = format!("http://127.0.0.1:{port}");
        std::fs::write(
            t.path().join("run.json"),
            format!(
                r#"{{"port":{port},"pid":{},"version":"0.2.0","url":"{url}","startedAt":"x"}}"#,
                std::process::id()
            ),
        )
        .unwrap();
        assert_eq!(
            find_local(&client, dead, t.path()).await.as_deref(),
            Some(url.as_str())
        );
        // Stale pid: ignored.
        std::fs::write(
            t.path().join("run.json"),
            format!(r#"{{"port":{port},"pid":99999990,"version":"0.2.0","url":"{url}"}}"#),
        )
        .unwrap();
        assert_eq!(find_local(&client, dead, t.path()).await, None);
        // The probe port itself answering wins.
        assert_eq!(
            find_local(&client, &url, t.path()).await.as_deref(),
            Some(url.as_str())
        );
        // Debug builds never run the default discovery.
        assert_eq!(find_local_default(&client).await, None);
    }
}
