//! The local receiver: starting it (the welcome's "Start sessionpipe", NATIVE-SPEC §1.1,
//! §3.9) and finding it again when it moves (§4 "Receiver restarts on a new port").
//!
//! Starting runs `sessionpipe-gui service install` (a LaunchAgent / systemd unit: the
//! receiver must outlive the window, so it is never the app's child), found through a login
//! shell, because an app opened from Finder has no user PATH, then the known prefixes.
//! With only npx: `npx -y --package=<this version's release tarball> -- sessionpipe-gui
//! service install` (the GUI is not on npm; its GitHub release carries the tarball). No Node: the
//! welcome shows the one-line installer.
//!
//! `service install` upgrades a service it finds in place (every app update does), so its
//! lines are read as they come and shown on the welcome: "Updating sessionpipe 0.4.1 →
//! 0.6.0…", "Starting… this can take a minute on a big board" (a big state dir rebuilds its
//! index at boot). Exit 0 is success, whatever it said; exit 1 is its last line.
//!
//! Debug builds never install anything and never touch :7373: they run the install with
//! `--dry-run`, then start a demo receiver as a child on SP_DEV_RECEIVER_PORT (7828),
//! which dies with the app.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sp_receivers::{discovery, Hub, HubEvent, ReceiverRef};
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

pub const SERVICE_PORT: u16 = 7373;
pub const DEV_PORT: u16 = 7828;
/// How long the receiver gets to answer after the install: a 1 GB state dir takes ~30 s
/// to index at boot (the installer itself waits 90 s for it).
pub const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// npx may download the release first, then the installer waits READY_TIMEOUT.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug)]
pub enum StartError {
    /// No sessionpipe-gui, node or npx anywhere we looked.
    NoNode,
    /// `service install` refused or failed; its words, for the welcome's progress line.
    Failed(String),
    /// Installed, but nothing answered in time.
    Timeout(u16),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NoNode => write!(f, "sessionpipe needs Node 20 or later"),
            StartError::Failed(m) => write!(f, "{m}"),
            StartError::Timeout(p) => {
                write!(
                    f,
                    "sessionpipe started but isn't answering on port {p} yet; a big board takes a while to load"
                )
            }
        }
    }
}

impl std::error::Error for StartError {}

// ---- finding node and the CLI ----

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Tools {
    pub cli: Option<PathBuf>,
    pub node: Option<PathBuf>,
    pub npx: Option<PathBuf>,
}

impl Tools {
    fn merge(self, o: Tools) -> Tools {
        Tools {
            cli: self.cli.or(o.cli),
            node: self.node.or(o.node),
            npx: self.npx.or(o.npx),
        }
    }
    fn complete(&self) -> bool {
        self.cli.is_some() && self.node.is_some() && self.npx.is_some()
    }
}

/// The output of `command -v sessionpipe-gui node npx`: one absolute path per line for
/// each one found (aliases and functions print something else, which is skipped).
pub fn parse_command_v(out: &str) -> Tools {
    let mut t = Tools::default();
    for line in out.lines().map(str::trim).filter(|l| l.starts_with('/')) {
        let p = PathBuf::from(line);
        match p.file_name().and_then(|n| n.to_str()) {
            Some("sessionpipe-gui") if t.cli.is_none() => t.cli = Some(p),
            Some("node") if t.node.is_none() => t.node = Some(p),
            Some("npx") if t.npx.is_none() => t.npx = Some(p),
            _ => {}
        }
    }
    t
}

/// Where Node lives when PATH doesn't say: Homebrew, /usr/local, ~/.local/bin (the
/// one-line installer), nvm (newest version first) and Volta.
pub fn known_prefixes(home: &Path) -> Vec<PathBuf> {
    let mut v = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/bin"),
    ];
    if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut nvm: Vec<(Vec<u64>, PathBuf)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let ver = name
                    .trim_start_matches('v')
                    .split('.')
                    .map(|x| x.parse().unwrap_or(0))
                    .collect();
                Some((ver, e.path().join("bin")))
            })
            .collect();
        nvm.sort_by(|a, b| b.0.cmp(&a.0));
        v.extend(nvm.into_iter().map(|(_, p)| p));
    }
    v.push(home.join(".volta/bin"));
    v
}

fn executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

pub fn search(dirs: &[PathBuf]) -> Tools {
    let find = |name: &str| dirs.iter().map(|d| d.join(name)).find(|p| executable(p));
    Tools {
        cli: find("sessionpipe-gui"),
        node: find("node"),
        npx: find("npx"),
    }
}

/// `/bin/zsh -lc 'command -v sessionpipe-gui node npx'` (the person's own PATH), with a
/// timeout: a login shell that waits on something must not hang the welcome.
fn login_shell_lookup() -> Option<String> {
    let shell = if Path::new("/bin/zsh").exists() {
        "/bin/zsh"
    } else {
        "/bin/sh"
    };
    let child = Command::new(shell)
        .args(["-lc", "command -v sessionpipe-gui node npx"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let out = wait_output(child, Duration::from_secs(5), |_| {}).ok()?;
    Some(out.1)
}

/// Login shell first, then the known prefixes for whatever it didn't find.
pub fn discover_tools(home: &Path, login_shell: Option<String>) -> Tools {
    let t = login_shell
        .as_deref()
        .map(parse_command_v)
        .unwrap_or_default();
    if t.complete() {
        return t;
    }
    t.merge(search(&known_prefixes(home)))
}

// ---- the install command ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// PATH for the child: node's and the CLI's dirs first (`#!/usr/bin/env node`).
    pub path: String,
}

pub struct InstallOpts {
    pub port: u16,
    pub state: Option<PathBuf>,
    pub dry_run: bool,
    /// The app's version: what npx pins.
    pub version: String,
}

fn child_path(t: &Tools) -> String {
    let mut dirs: Vec<String> = [&t.node, &t.cli, &t.npx]
        .into_iter()
        .flatten()
        .filter_map(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
        .collect();
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs.join(":")
}

/// `sessionpipe-gui service install …`, or the npx form, or NoNode.
pub fn install_invocation(t: &Tools, o: &InstallOpts) -> Result<Invocation, StartError> {
    let mut rest = vec![
        "service".to_string(),
        "install".to_string(),
        "--port".to_string(),
        o.port.to_string(),
    ];
    if let Some(s) = &o.state {
        rest.extend(["--state".to_string(), s.to_string_lossy().into_owned()]);
    }
    if o.dry_run {
        rest.push("--dry-run".into());
    }
    let path = child_path(t);
    match (&t.cli, &t.node, &t.npx) {
        // node + the CLI: node runs it, so a missing `env node` on PATH doesn't matter.
        (Some(cli), Some(node), _) => {
            let mut args = vec![cli.to_string_lossy().into_owned()];
            args.extend(rest);
            Ok(Invocation {
                program: node.clone(),
                args,
                path,
            })
        }
        (Some(cli), None, _) => Ok(Invocation {
            program: cli.clone(),
            args: rest,
            path,
        }),
        (None, _, Some(npx)) => {
            // Not `sessionpipe-gui@<v>`: the GUI is not published on npm, so that is a 404.
            // The release that shipped this app carries the same version as a tarball.
            let mut args = vec![
                "-y".to_string(),
                format!("--package={}", release_tarball(&o.version)),
                "--".to_string(),
                "sessionpipe-gui".to_string(),
            ];
            args.extend(rest);
            Ok(Invocation {
                program: npx.clone(),
                args,
                path,
            })
        }
        _ => Err(StartError::NoNode),
    }
}

/// The npm tarball attached to the GUI's GitHub release of `version`.
pub fn release_tarball(version: &str) -> String {
    format!(
        "https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v{version}/sessionpipe-gui-{version}.tgz"
    )
}

/// Waits for a child with a deadline, collecting (status, stdout, stderr); each stdout
/// line goes to `on_line` as it arrives.
fn wait_output(
    mut child: Child,
    timeout: Duration,
    mut on_line: impl FnMut(&str),
) -> Result<(i32, String, String), StartError> {
    let deadline = Instant::now() + timeout;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let out_t = std::thread::spawn(move || {
        if let Some(o) = stdout {
            for line in BufReader::new(o).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        }
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let mut out = String::new();
    let mut drain = |out: &mut String| {
        while let Ok(line) = rx.try_recv() {
            on_line(&line);
            out.push_str(&line);
            out.push('\n');
        }
    };
    loop {
        drain(&mut out);
        match child.try_wait() {
            Ok(Some(st)) => {
                let _ = out_t.join();
                drain(&mut out);
                let err = err_t.join().unwrap_or_default();
                return Ok((st.code().unwrap_or(-1), out, err));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(StartError::Failed(format!(
                    "it didn't finish in {} s",
                    timeout.as_secs()
                )));
            }
            Err(e) => return Err(StartError::Failed(e.to_string())),
        }
    }
}

/// Runs an invocation; Ok(stdout) on exit 0, else the last line it printed. `on_line`
/// sees each stdout line as the program prints it.
pub fn run(
    inv: &Invocation,
    timeout: Duration,
    on_line: impl FnMut(&str),
) -> Result<String, StartError> {
    let child = Command::new(&inv.program)
        .args(&inv.args)
        .env("PATH", &inv.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| StartError::Failed(format!("couldn't run {}: {e}", inv.program.display())))?;
    let (code, out, err) = wait_output(child, timeout, on_line)?;
    if code == 0 {
        return Ok(out);
    }
    let why = err
        .lines()
        .chain(out.lines())
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    let why = why
        .strip_prefix("sessionpipe-gui: ")
        .unwrap_or(&why)
        .to_string();
    Err(StartError::Failed(if why.is_empty() {
        format!("service install exited with {code}")
    } else {
        why
    }))
}

/// The welcome's words for a line `service install` printed, when it is one worth showing:
/// `updating <label>: 0.4.1 → 0.6.0`, `updated …`, `already running 0.6.0 on <url>`,
/// `installed <label> (…)`, and the wait's `starting on :7373… 283 sessions to load; …` /
/// `still starting after 30 s…`.
pub fn progress_for(line: &str) -> Option<String> {
    let line = line.trim();
    let versions = |rest: &str| -> String {
        // "<label>: 0.4.1 → 0.6.0 (…)" or "<label>: 0.6.0 (…)"
        let after = rest.split_once(": ").map(|(_, v)| v).unwrap_or(rest);
        let v = after.split(" (").next().unwrap_or(after).trim();
        if v.contains('→') {
            v.to_string()
        } else {
            format!("to {v}")
        }
    };
    if let Some(rest) = line.strip_prefix("updating ") {
        return Some(format!("Updating sessionpipe {}…", versions(rest)));
    }
    if let Some(rest) = line.strip_prefix("updated ") {
        return Some(format!(
            "Updated sessionpipe {}; waiting for it to answer…",
            versions(rest)
        ));
    }
    if let Some(rest) = line.strip_prefix("already running ") {
        let v = rest.split_whitespace().next().unwrap_or("");
        return Some(format!("sessionpipe {v} is already running"));
    }
    if line.starts_with("installed ") {
        return Some("Installed the background service; waiting for it to answer…".into());
    }
    if line.starts_with("starting on :") || line.starts_with("still starting") {
        let sessions = line
            .split("… ")
            .nth(1)
            .and_then(|r| r.split_once(" sessions to load"))
            .map(|(n, _)| n.trim());
        return Some(match sessions {
            Some(n) => format!("Starting… {n} sessions to load; this can take a minute"),
            None => "Starting… this can take a minute on a big board".into(),
        });
    }
    None
}

// ---- waiting for it ----

/// `GET /api/ui/info` on loopback with std only (no client to build): true when a
/// sessionpipe-gui answers. Loopback needs no key.
pub fn probe_loopback(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    let req = format!(
        "GET /api/ui/info HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = Vec::new();
    let _ = s.take(256 * 1024).read_to_end(&mut body);
    let text = String::from_utf8_lossy(&body);
    text.starts_with("HTTP/1.1 200") && text.contains("\"name\":\"sessionpipe-gui\"")
}

/// Polls until a receiver answers on the port, or the timeout.
pub fn wait_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if probe_loopback(port, Duration::from_millis(500)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

// ---- the dev child ----

static DEV_CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn kill_dev_child() {
    if let Some(mut c) = DEV_CHILD.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
        log::info!(target: "sessionpipe::lifecycle", "dev receiver child stopped");
    }
}

fn env_port(name: &str, default: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// The scratch state dir the dev child (and the dry run) use.
fn dev_state() -> PathBuf {
    std::env::var_os("SP_SHELL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("sessionpipe-dev"))
        .join("local-receiver")
}

/// Starts the demo receiver as a child (debug builds). SP_DEV_CLI names the CLI to run
/// (the worktree's dist/cli.js); otherwise the one found on PATH.
fn start_dev_child(t: &Tools, port: u16, state: &Path) -> Result<(), StartError> {
    kill_dev_child();
    let cli = std::env::var_os("SP_DEV_CLI")
        .map(PathBuf::from)
        .or_else(|| t.cli.clone())
        .ok_or(StartError::NoNode)?;
    let node = t.node.clone().ok_or(StartError::NoNode)?;
    let child = Command::new(node)
        .arg(&cli)
        .args([
            "--demo",
            "--test-door",
            "--no-outbox",
            "--host",
            "127.0.0.1",
            "--quiet",
            "--port",
            &port.to_string(),
            "--state",
        ])
        .arg(state)
        .env("PATH", child_path(t))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| StartError::Failed(format!("couldn't start the demo receiver: {e}")))?;
    log::info!(target: "sessionpipe::lifecycle", "dev receiver child pid {} on :{port}", child.id());
    *DEV_CHILD.lock().unwrap() = Some(child);
    Ok(())
}

// ---- start ----

/// The welcome's "Start sessionpipe". `progress(step, message)` feeds its one progress
/// line. Blocking work runs off the async runtime.
pub async fn start_local_receiver(
    hub: &Hub,
    version: &str,
    progress: impl Fn(&str, &str),
) -> Result<ReceiverRef, StartError> {
    progress("find", "Looking for Node…");
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let tools =
        tauri::async_runtime::spawn_blocking(move || discover_tools(&home, login_shell_lookup()))
            .await
            .map_err(|e| StartError::Failed(e.to_string()))?;
    log::info!(target: "sessionpipe::lifecycle", "start: cli {:?} node {:?} npx {:?}", tools.cli, tools.node, tools.npx);

    let debug = cfg!(debug_assertions);
    let port = if debug {
        env_port("SP_DEV_RECEIVER_PORT", DEV_PORT)
    } else {
        SERVICE_PORT
    };
    let state = debug.then(dev_state);
    let inv = install_invocation(
        &tools,
        &InstallOpts {
            port,
            state: state.clone(),
            dry_run: debug,
            version: version.into(),
        },
    )?;
    progress(
        "install",
        if debug {
            "Checking the service install (dry run)…"
        } else {
            "Installing the background service…"
        },
    );
    // The installer's lines, as it prints them: an upgrade in place and a slow start both
    // say what they are doing, and the welcome shows it.
    let inv2 = inv.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let install = tauri::async_runtime::spawn_blocking(move || {
        run(&inv2, INSTALL_TIMEOUT, |line| {
            let _ = tx.send(line.to_string());
        })
    });
    while let Some(line) = rx.recv().await {
        log::info!(target: "sessionpipe::lifecycle", "service install: {line}");
        if let Some(words) = progress_for(&line) {
            progress("install", &words);
        }
    }
    install
        .await
        .map_err(|e| StartError::Failed(e.to_string()))??;

    if debug {
        progress("start", "Starting a demo receiver…");
        start_dev_child(&tools, port, state.as_deref().unwrap())?;
    }
    progress("wait", "Starting… this can take a minute on a big board");
    let ready = tauri::async_runtime::spawn_blocking(move || wait_ready(port, READY_TIMEOUT))
        .await
        .unwrap_or(false);
    if !ready {
        return Err(StartError::Timeout(port));
    }
    let r = hub
        .add_transient(&format!("http://127.0.0.1:{port}"))
        .ok_or_else(|| StartError::Failed("the receiver's address isn't valid".into()))?;
    progress("done", "sessionpipe is running");
    Ok(r)
}

// ---- finding it again (run.json) ----

/// The state dir whose run.json says where the local receiver went: SP_LOCAL_STATE in any
/// build (tests), else the receiver's default (env rules as the server's) in a release
/// build without SP_RECEIVER_URL. Debug builds never read ~/.local/state, and
/// SP_RECEIVER_URL turns default discovery off in release builds too (NATIVE-SPEC §1.2).
pub fn local_state_dir() -> Option<PathBuf> {
    local_state_dir_with(
        &|k| std::env::var(k).ok(),
        discovery::enabled(std::env::var("SP_RECEIVER_URL").ok().as_deref()),
    )
}

pub fn local_state_dir_with(
    env: &dyn Fn(&str) -> Option<String>,
    discovery_on: bool,
) -> Option<PathBuf> {
    if let Some(s) = env("SP_LOCAL_STATE").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(s));
    }
    if !discovery_on {
        return None;
    }
    let home = PathBuf::from(env("HOME")?);
    Some(discovery::default_state_dir(&home, env))
}

/// What `<state>/run.json` says about the local receiver that dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunState {
    /// No file, a dead pid, not loopback, or nothing answering on its port.
    Nothing,
    /// The same receiver is listening again.
    Back,
    /// A live receiver on another origin.
    Moved(String),
}

/// Reads run.json and probes the receiver it names.
pub fn run_state(state: &Path, current_origin: &str) -> RunState {
    let Some(run) = discovery::read_run_file(state) else {
        return RunState::Nothing;
    };
    if !discovery::pid_alive(run.pid) {
        return RunState::Nothing;
    }
    let Some(origin) = sp_receivers::id::canonical_origin(&run.url) else {
        return RunState::Nothing;
    };
    if !sp_receivers::id::is_loopback_origin(&origin)
        || !probe_loopback(run.port, Duration::from_millis(800))
    {
        return RunState::Nothing;
    }
    if origin == current_origin {
        RunState::Back
    } else {
        RunState::Moved(origin)
    }
}

/// The origin run.json names, when it is a live loopback receiver other than `current`.
pub fn moved_to(state: &Path, current_origin: &str) -> Option<String> {
    match run_state(state, current_origin) {
        RunState::Moved(o) => Some(o),
        _ => None,
    }
}

/// Which receiver wrote run.json, and when: a different stamp is a receiver that started.
pub fn run_stamp(state: &Path) -> Option<(u32, String)> {
    discovery::read_run_file(state).map(|r| (r.pid, r.started_at))
}

/// How long a dropped local receiver is followed through run.json before only the
/// streams' backoff (up to 30 s) is left.
pub const FOLLOW_FOR: Duration = Duration::from_secs(600);
static FOLLOWING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Watches the hub: when the local receiver drops, re-read run.json (each failed
/// reconnect, at most every 2 s), and when it names a new port, switch to it.
///
/// After a long outage the streams' backoff has grown to 30 s, which is a long time to
/// look at "Reconnecting…" once the receiver is back. A receiver writes run.json when it
/// listens, so while the local one is down (and the Mac is awake) the shell looks at that
/// one file once a second, for at most FOLLOW_FOR: a new stamp from the same receiver
/// reconnects now and the page resyncs (as on wake); a new port is followed.
pub fn watch<R: Runtime>(app: AppHandle<R>, hub: Hub) {
    let Some(state) = local_state_dir() else {
        return;
    };
    let mut rx = hub.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut last = Instant::now() - Duration::from_secs(10);
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            };
            let HubEvent::Disconnected { id, .. } = ev else {
                continue;
            };
            let Some(r) = hub.receiver(&id).filter(|r| r.local) else {
                continue;
            };
            if !FOLLOWING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                tauri::async_runtime::spawn(follow(
                    app.clone(),
                    hub.clone(),
                    state.clone(),
                    r.clone(),
                ));
            }
            if last.elapsed() < Duration::from_secs(2) {
                continue;
            }
            last = Instant::now();
            let (st, cur) = (state.clone(), r.origin.clone());
            let moved = tauri::async_runtime::spawn_blocking(move || moved_to(&st, &cur))
                .await
                .ok()
                .flatten();
            if let Some(origin) = moved {
                switch_to(&app, &hub, &r, &origin);
            }
        }
    });
}

fn switch_to<R: Runtime>(app: &AppHandle<R>, hub: &Hub, from: &ReceiverRef, origin: &str) -> bool {
    log::info!(target: "sessionpipe::lifecycle", "run.json: the local receiver moved to {origin}");
    let Some(new) = hub.add_transient(origin) else {
        return false;
    };
    // The window follows when it showed the old one.
    if hub.active().is_some_and(|a| a.id == from.id) {
        if let Err(e) = crate::actions::select_receiver(app, &new.id) {
            log::warn!(target: "sessionpipe::lifecycle", "switching to {origin}: {e}");
        }
    }
    true
}

/// While the local receiver `r` is down: a new run.json stamp means a receiver started.
async fn follow<R: Runtime>(app: AppHandle<R>, hub: Hub, state: PathBuf, r: ReceiverRef) {
    let st = state.clone();
    let mut seen = tauri::async_runtime::spawn_blocking(move || run_stamp(&st))
        .await
        .ok()
        .flatten();
    let until = Instant::now() + FOLLOW_FOR;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    while Instant::now() < until && !hub.is_connected(&r.id) {
        tick.tick().await;
        if super::power::asleep() {
            continue;
        }
        let st = state.clone();
        let now = tauri::async_runtime::spawn_blocking(move || run_stamp(&st))
            .await
            .ok()
            .flatten();
        if now.is_none() || now == seen {
            continue;
        }
        let (st, cur) = (state.clone(), r.origin.clone());
        match tauri::async_runtime::spawn_blocking(move || run_state(&st, &cur))
            .await
            .unwrap_or(RunState::Nothing)
        {
            RunState::Nothing => continue, // written, not answering yet: look again
            RunState::Back => {
                log::info!(target: "sessionpipe::lifecycle", "run.json: the local receiver is back; reconnecting now");
                crate::actions::on_wake(&app);
            }
            RunState::Moved(origin) => {
                if switch_to(&app, &hub, &r, &origin) {
                    break;
                }
            }
        }
        seen = now;
    }
    FOLLOWING.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Kills the dev child when the app exits, and starts the app again when a relaunch was
/// asked for (relaunch.rs).
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("sp-lifecycle")
        .on_event(|_app, ev| {
            if let tauri::RunEvent::Exit = ev {
                kill_dev_child();
                crate::lifecycle::relaunch::on_exit();
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    // The fake CLIs below are shell scripts made executable with Unix mode bits; the
    // tests that run one are Unix-only, the rest run everywhere.
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    struct Temp(PathBuf);
    impl Temp {
        fn new(tag: &str) -> Temp {
            let d = std::env::temp_dir().join(format!("sp-sup-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Temp(d)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[cfg(unix)]
    fn exe(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn parses_command_v() {
        let t = parse_command_v(
            "/opt/homebrew/bin/node\nnpx: aliased to foo\n/Users/m/.local/bin/sessionpipe-gui\n",
        );
        assert_eq!(t.node, Some(PathBuf::from("/opt/homebrew/bin/node")));
        assert_eq!(
            t.cli,
            Some(PathBuf::from("/Users/m/.local/bin/sessionpipe-gui"))
        );
        assert_eq!(t.npx, None);
    }

    #[test]
    #[cfg(unix)]
    fn finds_tools_under_a_temp_home() {
        let h = Temp::new("home");
        // Only nvm (two versions) and Volta: the newest nvm wins for node, Volta's npx is used.
        exe(
            &h.0.join(".nvm/versions/node/v20.11.0/bin/node"),
            "#!/bin/sh\n",
        );
        exe(
            &h.0.join(".nvm/versions/node/v22.3.1/bin/node"),
            "#!/bin/sh\n",
        );
        exe(&h.0.join(".volta/bin/npx"), "#!/bin/sh\n");
        std::fs::write(h.0.join(".volta/bin/sessionpipe-gui"), "not executable").unwrap();
        let dirs: Vec<PathBuf> = known_prefixes(&h.0)
            .into_iter()
            .filter(|d| d.starts_with(&h.0))
            .collect();
        let t = search(&dirs);
        assert_eq!(
            t.node,
            Some(h.0.join(".nvm/versions/node/v22.3.1/bin/node"))
        );
        assert_eq!(t.npx, Some(h.0.join(".volta/bin/npx")));
        assert_eq!(t.cli, None);
        // The login shell's answer wins where it has one.
        let login = format!("{}\n", h.0.join("bin/sessionpipe-gui").display());
        let merged = parse_command_v(&login).merge(t);
        assert_eq!(merged.cli, Some(h.0.join("bin/sessionpipe-gui")));
    }

    #[test]
    fn builds_the_install_command() {
        let o = InstallOpts {
            port: 7828,
            state: Some("/s".into()),
            dry_run: true,
            version: "0.3.0".into(),
        };
        let t = Tools {
            cli: Some("/c/sessionpipe-gui".into()),
            node: Some("/n/node".into()),
            npx: None,
        };
        let inv = install_invocation(&t, &o).unwrap();
        assert_eq!(inv.program, PathBuf::from("/n/node"));
        assert_eq!(
            inv.args,
            [
                "/c/sessionpipe-gui",
                "service",
                "install",
                "--port",
                "7828",
                "--state",
                "/s",
                "--dry-run"
            ]
        );
        assert!(inv.path.starts_with("/n:/c:"));
        let npx = Tools {
            cli: None,
            node: Some("/n/node".into()),
            npx: Some("/n/npx".into()),
        };
        let inv = install_invocation(
            &npx,
            &InstallOpts {
                dry_run: false,
                state: None,
                ..o
            },
        )
        .unwrap();
        assert_eq!(
            inv.args,
            [
                "-y",
                "--package=https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.3.0/sessionpipe-gui-0.3.0.tgz",
                "--",
                "sessionpipe-gui",
                "service",
                "install",
                "--port",
                "7828"
            ]
        );
        assert!(matches!(
            install_invocation(
                &Tools::default(),
                &InstallOpts {
                    port: 1,
                    state: None,
                    dry_run: false,
                    version: "x".into()
                }
            ),
            Err(StartError::NoNode)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn runs_a_fake_cli_and_reports_its_refusal() {
        let d = Temp::new("cli");
        let ok = d.0.join("ok");
        exe(&ok, "#!/bin/sh\necho \"installed $*\"\n");
        let inv = Invocation {
            program: ok,
            args: vec!["service".into(), "install".into()],
            path: "/usr/bin:/bin".into(),
        };
        let mut seen = Vec::new();
        assert_eq!(
            run(&inv, Duration::from_secs(5), |l| seen.push(l.to_string()))
                .unwrap()
                .trim(),
            "installed service install"
        );
        assert_eq!(seen, ["installed service install"]);
        let refuse = d.0.join("refuse");
        exe(
            &refuse,
            "#!/bin/sh\necho 'sessionpipe-gui: port 7828 is in use by another program (try --port)' >&2\nexit 1\n",
        );
        let inv = Invocation {
            program: refuse,
            args: vec![],
            path: "/usr/bin:/bin".into(),
        };
        match run(&inv, Duration::from_secs(5), |_| {}) {
            Err(StartError::Failed(m)) => {
                assert_eq!(m, "port 7828 is in use by another program (try --port)")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn streams_the_installer_s_lines_as_they_come() {
        let d = Temp::new("stream");
        let slow = d.0.join("slow");
        exe(
            &slow,
            "#!/bin/sh\necho 'updating dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0'\nsleep 0.3\necho 'starting on :7373… 283 sessions to load; a big board takes a minute'\n",
        );
        let inv = Invocation {
            program: slow,
            args: vec![],
            path: "/usr/bin:/bin".into(),
        };
        let t0 = Instant::now();
        let mut at = Vec::new();
        let out = run(&inv, Duration::from_secs(5), |l| {
            at.push((l.to_string(), t0.elapsed()))
        })
        .unwrap();
        assert_eq!(out.lines().count(), 2);
        assert_eq!(at.len(), 2);
        // The first line arrived while the script still slept before the second: the gap
        // between the two is the script's sleep, not zero (a spawn under load can itself
        // take a while, so the first line's absolute time proves nothing).
        let gap = at[1].1.saturating_sub(at[0].1);
        assert!(gap >= Duration::from_millis(200), "{at:?}");
    }

    #[test]
    fn words_for_the_welcome_from_the_installer_s_lines() {
        assert_eq!(
            progress_for("updating dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0").as_deref(),
            Some("Updating sessionpipe 0.4.1 → 0.6.0…")
        );
        assert_eq!(
            progress_for("updating dev.spacesheep.sessionpipe-gui: 0.6.0").as_deref(),
            Some("Updating sessionpipe to 0.6.0…")
        );
        assert_eq!(
            progress_for(
                "updated dev.spacesheep.sessionpipe-gui: 0.4.1 → 0.6.0 (~/Library/LaunchAgents/dev.spacesheep.sessionpipe-gui.plist)"
            )
            .as_deref(),
            Some("Updated sessionpipe 0.4.1 → 0.6.0; waiting for it to answer…")
        );
        assert_eq!(
            progress_for("already running 0.6.0 on http://127.0.0.1:7373").as_deref(),
            Some("sessionpipe 0.6.0 is already running")
        );
        assert_eq!(
            progress_for(
                "installed dev.spacesheep.sessionpipe-gui (~/Library/LaunchAgents/x.plist)"
            )
            .as_deref(),
            Some("Installed the background service; waiting for it to answer…")
        );
        assert_eq!(
            progress_for("starting on :7373… 283 sessions to load; a big board takes a minute")
                .as_deref(),
            Some("Starting… 283 sessions to load; this can take a minute")
        );
        assert_eq!(
            progress_for("starting on :7373… a big board takes a minute").as_deref(),
            Some("Starting… this can take a minute on a big board")
        );
        assert_eq!(
            progress_for("still starting after 30 s…").as_deref(),
            Some("Starting… this can take a minute on a big board")
        );
        assert_eq!(
            progress_for("running 0.6.0 on http://127.0.0.1:7373 · state ~/x"),
            None
        );
        assert_eq!(progress_for(""), None);
    }

    #[test]
    #[cfg(unix)]
    fn a_cli_that_hangs_times_out_and_is_killed() {
        let d = Temp::new("hang");
        let hang = d.0.join("hang");
        exe(&hang, "#!/bin/sh\nexec sleep 30\n");
        let inv = Invocation {
            program: hang,
            args: vec![],
            path: "/usr/bin:/bin".into(),
        };
        let t0 = Instant::now();
        assert!(
            matches!(run(&inv, Duration::from_millis(400), |_| {}), Err(StartError::Failed(m)) if m.contains("didn't finish"))
        );
        assert!(t0.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn waits_for_a_receiver_and_gives_up_on_silence() {
        use std::net::TcpListener;
        // Nothing listening: gives up at the deadline.
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let t0 = Instant::now();
        assert!(!wait_ready(free, Duration::from_millis(400)));
        assert!(
            t0.elapsed() >= Duration::from_millis(400) && t0.elapsed() < Duration::from_secs(3)
        );
        // A fake receiver that starts answering after 300 ms.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            for s in l.incoming().flatten() {
                let mut s = s;
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = r#"{"name":"sessionpipe-gui","version":"0.2.0"}"#;
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        assert!(wait_ready(port, Duration::from_secs(5)));
    }

    #[test]
    fn run_json_names_a_new_port_only_when_it_is_alive_and_different() {
        let d = Temp::new("run");
        let write = |pid: u32, port: u16| {
            std::fs::write(
                d.0.join("run.json"),
                format!(
                    r#"{{"port":{port},"pid":{pid},"version":"0.2.0","url":"http://127.0.0.1:{port}","startedAt":"x"}}"#
                ),
            )
            .unwrap()
        };
        assert_eq!(moved_to(&d.0, "http://127.0.0.1:7829"), None); // no file
        write(99_999_990, 7828); // dead pid
        assert_eq!(moved_to(&d.0, "http://127.0.0.1:7829"), None);
        write(std::process::id(), 7829); // same origin
        assert_eq!(moved_to(&d.0, "http://127.0.0.1:7829"), None);
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        write(std::process::id(), free); // alive but not answering
        assert_eq!(moved_to(&d.0, "http://127.0.0.1:7829"), None);
    }

    fn fake_receiver() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = r#"{"name":"sessionpipe-gui","version":"0.2.0"}"#;
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    #[test]
    fn the_default_state_dir_only_when_discovery_is_on() {
        let env = |k: &str| match k {
            "HOME" => Some("/h".to_string()),
            _ => None,
        };
        assert_eq!(local_state_dir_with(&env, false), None); // debug, or SP_RECEIVER_URL set
        assert_eq!(
            local_state_dir_with(&env, true),
            Some(PathBuf::from("/h/.local/state/sessionpipe-gui"))
        );
        let tests = |k: &str| (k == "SP_LOCAL_STATE").then(|| "/scratch/state".to_string());
        assert_eq!(
            local_state_dir_with(&tests, false),
            Some(PathBuf::from("/scratch/state"))
        );
    }

    #[test]
    fn a_fresh_run_json_tells_back_from_moved_and_changes_its_stamp() {
        let d = Temp::new("back");
        let write = |pid: u32, port: u16, at: &str| {
            std::fs::write(
                d.0.join("run.json"),
                format!(r#"{{"port":{port},"pid":{pid},"version":"0.2.0","url":"http://127.0.0.1:{port}","startedAt":"{at}"}}"#),
            )
            .unwrap()
        };
        assert_eq!(run_stamp(&d.0), None);
        let port = fake_receiver();
        let here = format!("http://127.0.0.1:{port}");
        write(std::process::id(), port, "t1");
        let first = run_stamp(&d.0);
        assert_eq!(first, Some((std::process::id(), "t1".into())));
        assert_eq!(run_state(&d.0, &here), RunState::Back);
        assert_eq!(
            run_state(&d.0, "http://127.0.0.1:7829"),
            RunState::Moved(here.clone())
        );
        write(std::process::id(), port, "t2"); // the same receiver, started again
        assert_ne!(run_stamp(&d.0), first);
        // A stale file: a dead pid is caught on Unix. pid_alive can't tell on Windows
        // (always true there), so the port probe alone decides, and this port answers.
        write(99_999_990, port, "t3");
        #[cfg(unix)]
        assert_eq!(run_state(&d.0, &here), RunState::Nothing);
    }
}
