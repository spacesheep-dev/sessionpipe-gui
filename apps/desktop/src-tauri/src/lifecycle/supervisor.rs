//! The local receiver: starting it (the welcome's "Start sessionpipe", NATIVE-SPEC §1.1,
//! §3.9) and finding it again when it moves (§4 "Receiver restarts on a new port").
//!
//! Starting runs `sessionpipe-gui service install` (a LaunchAgent / systemd unit / Windows
//! scheduled task: the receiver must outlive the window, so it is never the app's child),
//! found through a login shell, because an app opened from Finder has no user PATH, then the
//! known prefixes. On Windows the app has the user's PATH already: that, then the places
//! Node's installers put it. There npm's shims are .cmd files, which node can't run and Rust
//! runs only through cmd, so the CLI and npx are found as the scripts behind them and run
//! under node.
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
//!
//! A CLI on PATH older than the app is set aside for npx (release builds), so the app's
//! version is the one installed; and once per launch a local receiver older than the app
//! is brought up to it ("keeping it current" below).

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
    if cfg!(windows) {
        return search_windows(dirs);
    }
    let find = |name: &str| dirs.iter().map(|d| d.join(name)).find(|p| executable(p));
    Tools {
        cli: find("sessionpipe-gui"),
        node: find("node"),
        npx: find("npx"),
    }
}

// ---- Windows ----

/// The script behind an npm shim `<dir>\<name>.cmd`: npm puts the package under
/// `<dir>\node_modules` beside it.
fn shim_script(dir: &Path, name: &str, script: &[&str]) -> Option<PathBuf> {
    if !dir.join(format!("{name}.cmd")).is_file() {
        return None;
    }
    let p = script
        .iter()
        .fold(dir.join("node_modules"), |p, part| p.join(part));
    p.is_file().then_some(p)
}

/// node.exe; the CLI as `node_modules\sessionpipe-gui\dist\cli.js` beside its shim; npx
/// as `node_modules\npm\bin\npx-cli.js` beside npx.cmd (Node's installer, nvm-windows,
/// Scoop), or an npx.exe (Volta's shim) as it is.
pub fn search_windows(dirs: &[PathBuf]) -> Tools {
    Tools {
        cli: dirs.iter().find_map(|d| {
            shim_script(d, "sessionpipe-gui", &["sessionpipe-gui", "dist", "cli.js"])
        }),
        node: dirs
            .iter()
            .map(|d| d.join("node.exe"))
            .find(|p| p.is_file()),
        npx: dirs.iter().find_map(|d| {
            shim_script(d, "npx", &["npm", "bin", "npx-cli.js"])
                .or_else(|| Some(d.join("npx.exe")).filter(|p| p.is_file()))
        }),
    }
}

/// Where Node lives on Windows when PATH doesn't say: Node's installer (Program Files), npm's
/// global folder (%APPDATA%\npm), nvm-windows' active version (%NVM_SYMLINK%), Volta's shims
/// and Scoop's current version. A variable counts only when its value is an absolute folder
/// (`windows_absolute`), read as it is: a `nvm`, a `.` or an unexpanded `%X%\y` there is
/// left out as on PATH, and ProgramFiles then has its usual place, as when it is unset.
pub fn windows_prefixes(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let var = |k: &str| env(k).filter(|v| windows_absolute(v)).map(PathBuf::from);
    let mut v = vec![var("ProgramFiles")
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        .join("nodejs")];
    v.extend(var("APPDATA").map(|a| a.join("npm")));
    v.extend(var("NVM_SYMLINK"));
    v.extend(var("LOCALAPPDATA").map(|l| l.join("Volta").join("bin")));
    if let Some(home) = var("USERPROFILE") {
        let scoop = home
            .join("scoop")
            .join("apps")
            .join("nodejs")
            .join("current");
        v.push(scoop.join("bin"));
        v.push(scoop);
    }
    v
}

/// A Windows path that names one folder whatever the working directory and its drive are:
/// a drive and a root (`C:\x`, `C:/x`), or two separators first (a UNC share, `\\?\`,
/// `\\.\`). Not `.`, `bin`, `C:x` (that drive's own working directory) or `\x` (the
/// working directory's drive). Read from the text, so it answers the same on every platform.
fn windows_absolute(p: &str) -> bool {
    let sep = |b: &u8| matches!(b, b'\\' | b'/');
    match p.as_bytes() {
        [a, b, ..] if sep(a) && sep(b) => true,
        [drive, b':', root, ..] => drive.is_ascii_alphabetic() && sep(root),
        _ => false,
    }
}

/// The folders on a PATH string, as Windows writes it (`;`, entries may be quoted): the
/// absolute ones only, as `parse_command_v` keeps absolute paths only, so a `.` or a `bin`
/// on PATH never runs a node.exe from the folder the app happened to be started in.
pub fn windows_path_dirs(path: &str) -> Vec<PathBuf> {
    path.split(';')
        .map(|d| d.trim().trim_matches('"'))
        .filter(|d| windows_absolute(d))
        .map(PathBuf::from)
        .collect()
}

/// The same folders as the words a child's PATH is joined from.
fn windows_child_dirs(path: &str) -> Vec<String> {
    windows_path_dirs(path)
        .into_iter()
        .map(|d| d.to_string_lossy().into_owned())
        .collect()
}

/// A child of the app runs with no console window (a GUI app's console child gets a new one).
#[cfg(windows)]
fn no_window(c: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    c.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn no_window(c: &mut Command) -> &mut Command {
    c
}

/// `/bin/zsh -lc 'command -v sessionpipe-gui node npx'` (the person's own PATH), with a
/// timeout: a login shell that waits on something must not hang the welcome. Windows has
/// none: the app already runs with the user's PATH.
fn login_shell_lookup() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
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

/// Login shell first, then the known prefixes for whatever it didn't find. Windows: the
/// app's PATH, then the places Node's installers use.
pub fn discover_tools(home: &Path, login_shell: Option<String>) -> Tools {
    if cfg!(windows) {
        let mut dirs = windows_path_dirs(&std::env::var("PATH").unwrap_or_default());
        dirs.extend(windows_prefixes(&|k| std::env::var(k).ok()));
        return search(&dirs);
    }
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
    if cfg!(windows) {
        // The rest of the app's own PATH (the installer runs schtasks and taskkill): its
        // absolute folders, as the search above takes them.
        let path = std::env::var("PATH").unwrap_or_default();
        dirs.extend(windows_child_dirs(&path));
    } else {
        dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs.join(if cfg!(windows) { ";" } else { ":" })
}

/// A script node runs (`cli.js`, `npx-cli.js`), as Windows finds them, not a program.
fn is_script(p: &Path) -> bool {
    p.extension().is_some_and(|e| e == "js")
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
    cli_invocation(t, &o.version, rest)
}

/// `sessionpipe-gui <rest…>` run by node, or by the CLI itself, or through npx with the
/// release tarball of `version`; NoNode when none of them is there.
pub fn cli_invocation(
    t: &Tools,
    version: &str,
    rest: Vec<String>,
) -> Result<Invocation, StartError> {
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
        (Some(cli), None, _) if !is_script(cli) => Ok(Invocation {
            program: cli.clone(),
            args: rest,
            path,
        }),
        (None, _, Some(npx)) => {
            // Not `sessionpipe-gui@<v>`: the GUI is not published on npm, so that is a 404.
            // The release that shipped this app carries the same version as a tarball.
            let mut args = vec![
                "-y".to_string(),
                format!("--package={}", release_tarball(version)),
                "--".to_string(),
                "sessionpipe-gui".to_string(),
            ];
            args.extend(rest);
            if is_script(npx) {
                let node = t.node.clone().ok_or(StartError::NoNode)?;
                args.insert(0, npx.to_string_lossy().into_owned());
                return Ok(Invocation {
                    program: node,
                    args,
                    path,
                });
            }
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
    let child = no_window(&mut Command::new(&inv.program))
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
    let child = no_window(&mut Command::new(node))
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
    // An older CLI on PATH would install its own, older version: a release build takes the
    // app's version through npx instead, when there is an npx. (Debug builds keep the CLI:
    // the dev child runs it.)
    let tools = if debug {
        tools
    } else {
        let v = version.to_string();
        tauri::async_runtime::spawn_blocking(move || prefer_current(tools, &v))
            .await
            .map_err(|e| StartError::Failed(e.to_string()))?
    };
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
    let home = discovery::home_dir(env)?;
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

// ---- keeping it current ----
//
// An app that updated itself (updater.rs) finds the receiver it attaches to still on the
// version it had: the service runs the CLI that installed it, and "Start sessionpipe"
// (the only place that runs `service install`) is the welcome's, on a first run. The page
// then calls routes that server doesn't have. So once per launch, when the local receiver
// first connects, the app asks it its version and, when that is older than the app's own,
// runs `service install --if-installed`, which upgrades the service in place, with its
// port and state dir, and never installs one. Nothing is shown: it is logged, and a
// failure leaves the old receiver running. Debug builds never do it (they keep away from
// :7373 and ~/.local/state).

/// Orders two versions as `x.y.z[-pre]` (shared/version.ts's compareVersions): a missing
/// or non-numeric part is 0, a prerelease comes before its release.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| {
        let v = v.trim().trim_start_matches('v');
        let (core, pre) = match v.split_once('-') {
            Some((c, _)) => (c, true),
            None => (v, false),
        };
        let nums: Vec<u64> = core.split('.').map(|n| n.parse().unwrap_or(0)).collect();
        (nums, pre)
    };
    let (x, xp) = parse(a);
    let (y, yp) = parse(b);
    for i in 0..x.len().max(y.len()) {
        let o = x.get(i).unwrap_or(&0).cmp(y.get(i).unwrap_or(&0));
        if o.is_ne() {
            return o;
        }
    }
    yp.cmp(&xp)
}

/// The version the local receiver at `origin` runs. Its run.json, when that names this
/// origin with a live pid: the receiver writes it once, when it starts (its /api/ui/info
/// up to 0.8.0 read package.json anew, so one whose package was replaced under it answered
/// with the new version). Else its info, but only on the default port, which discovery
/// takes as this computer's own. Else None: nothing here says it is this computer's
/// receiver (a tunnel to another one, a receiver on another state dir).
pub fn running_version(
    origin: &str,
    info_version: Option<&str>,
    run: Option<&discovery::RunFile>,
    alive: impl Fn(u32) -> bool,
) -> Option<String> {
    let named = run.filter(|r| {
        sp_receivers::id::canonical_origin(&r.url).as_deref() == Some(origin) && alive(r.pid)
    });
    if let Some(v) = named.map(|r| r.version.trim()).filter(|v| !v.is_empty()) {
        return Some(v.to_string());
    }
    let default = [
        format!("http://127.0.0.1:{SERVICE_PORT}"),
        format!("http://localhost:{SERVICE_PORT}"),
    ];
    if named.is_some() || default.iter().any(|d| d == origin) {
        return info_version
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from);
    }
    None
}

/// `sessionpipe-gui --version` of the CLI found, when it answers with one.
fn cli_version(t: &Tools) -> Option<String> {
    t.cli.as_ref()?;
    let inv = cli_invocation(t, "", vec!["--version".into()]).ok()?;
    let out = run(&inv, Duration::from_secs(15), |_| {}).ok()?;
    let v = out.lines().next()?.trim();
    v.starts_with(|c: char| c.is_ascii_digit())
        .then(|| v.to_string())
}

/// The CLI on PATH stays when it is at least the app's version (or says no version); an
/// older one is set aside, so npx brings the app's own version, when there is an npx.
pub fn prefer_current_with(t: Tools, cli_version: Option<&str>, app: &str) -> Tools {
    match cli_version {
        Some(v) if t.cli.is_some() && t.npx.is_some() && version_cmp(v, app).is_lt() => {
            log::info!(target: "sessionpipe::lifecycle", "the sessionpipe-gui on PATH is {v}, older than this app ({app}): npx brings {app}");
            Tools { cli: None, ..t }
        }
        _ => t,
    }
}

fn prefer_current(t: Tools, app: &str) -> Tools {
    let v = cli_version(&t);
    prefer_current_with(t, v.as_deref(), app)
}

/// Brings this computer's service up to the app's version: `service install
/// --if-installed` run by a CLI of at least that version (else npx with the release
/// tarball). Its lines go to the log; Ok is its output, Err why it didn't.
fn update_local_service(app: &str) -> Result<String, StartError> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    update_with(discover_tools(&home, login_shell_lookup()), app)
}

/// The same with the tools already found.
pub fn update_with(found: Tools, app: &str) -> Result<String, StartError> {
    let cli_v = cli_version(&found);
    let tools = prefer_current_with(found, cli_v.as_deref(), app);
    if let Some(v) = cli_v.filter(|v| tools.cli.is_some() && version_cmp(v, app).is_lt()) {
        return Err(StartError::Failed(format!(
            "the sessionpipe-gui on PATH is {v}, older than this app, and there is no npx to bring {app}"
        )));
    }
    let inv = cli_invocation(
        &tools,
        app,
        ["service", "install", "--if-installed"]
            .map(String::from)
            .to_vec(),
    )?;
    log::info!(target: "sessionpipe::lifecycle", "update: {} {}", inv.program.display(), inv.args.join(" "));
    run(
        &inv,
        INSTALL_TIMEOUT,
        |line| log::info!(target: "sessionpipe::lifecycle", "service install: {line}"),
    )
}

static CHECKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Once per launch: the first local receiver that connects is asked its version, and an
/// older one than the app is brought up to it (see above). Called once from setup.
pub fn keep_current(hub: Hub, app_version: String) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(state) = local_state_dir() else {
        return;
    };
    let mut rx = hub.subscribe();
    tauri::async_runtime::spawn(async move {
        let r = loop {
            // One that connected before this listened counts too.
            if let Some(r) = hub
                .receivers()
                .into_iter()
                .find(|r| r.local && hub.is_connected(&r.id))
            {
                break r;
            }
            match rx.recv().await {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        };
        if CHECKED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        check_local(&hub, &r, &state, &app_version, update_local_service).await;
    });
}

/// What the check found and did, as the log says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// Nothing says the receiver is this computer's: left as it is.
    NotThisComputers,
    /// It runs this version, not older than the app's.
    Current(String),
    /// It ran this version, older than the app's, and `service install` succeeded.
    Updated(String),
    /// It ran this version and still does: why the update didn't happen.
    Failed(String, String),
}

/// Asks the local receiver `r` its version and, when it is older than `app`, runs
/// `update` (off the async runtime). Everything is logged; nothing fails.
pub async fn check_local(
    hub: &Hub,
    r: &ReceiverRef,
    state: &Path,
    app: &str,
    update: fn(&str) -> Result<String, StartError>,
) -> Checked {
    let info: Option<serde_json::Value> = hub
        .get(&r.id, "/api/ui/info")
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let info_version = info
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str());
    let run_file = discovery::read_run_file(state);
    let Some(running) = running_version(
        &r.origin,
        info_version,
        run_file.as_ref(),
        discovery::pid_alive,
    ) else {
        log::info!(target: "sessionpipe::lifecycle", "update: {} isn't known to be this computer's receiver; left as it is", r.origin);
        return Checked::NotThisComputers;
    };
    if !version_cmp(&running, app).is_lt() {
        log::info!(target: "sessionpipe::lifecycle", "update: the local receiver runs {running} ({}); nothing to do", r.origin);
        return Checked::Current(running);
    }
    log::info!(target: "sessionpipe::lifecycle", "update: the local receiver runs {running}, older than this app ({app}); updating it");
    let a = app.to_string();
    let why = match tauri::async_runtime::spawn_blocking(move || update(&a)).await {
        Ok(Ok(_)) => {
            log::info!(target: "sessionpipe::lifecycle", "update: done");
            return Checked::Updated(running);
        }
        Ok(Err(e)) => e.to_string(),
        Err(e) => e.to_string(),
    };
    log::warn!(target: "sessionpipe::lifecycle", "update: not done, {running} keeps running: {why}");
    Checked::Failed(running, why)
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
        // node's and the CLI's folders first, in the platform's PATH form.
        let sep = if cfg!(windows) { ";" } else { ":" };
        assert!(inv.path.starts_with(&format!("/n{sep}/c{sep}")));
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
    fn finds_node_and_the_scripts_behind_npm_shims_on_windows() {
        let h = Temp::new("win");
        let file = |p: &Path| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "").unwrap();
        };
        // Node's installer: node.exe, npx.cmd and npm under node_modules.
        let nodejs = h.0.join("Program Files").join("nodejs");
        file(&nodejs.join("node.exe"));
        file(&nodejs.join("npx.cmd"));
        file(&nodejs.join("node_modules/npm/bin/npx-cli.js"));
        // npm's global folder: the GUI's shim and its package.
        let npm = h.0.join("AppData/Roaming/npm");
        file(&npm.join("sessionpipe-gui.cmd"));
        file(&npm.join("node_modules/sessionpipe-gui/dist/cli.js"));
        // A shim whose package is gone is no CLI.
        let stale = h.0.join("stale");
        file(&stale.join("sessionpipe-gui.cmd"));
        let t = search_windows(&[stale.clone(), npm.clone(), nodejs.clone()]);
        assert_eq!(
            t.cli,
            Some(npm.join("node_modules/sessionpipe-gui/dist/cli.js"))
        );
        assert_eq!(t.node, Some(nodejs.join("node.exe")));
        assert_eq!(t.npx, Some(nodejs.join("node_modules/npm/bin/npx-cli.js")));
        // Volta's npx is an .exe, run as it is.
        let volta = h.0.join("Volta/bin");
        file(&volta.join("npx.exe"));
        assert_eq!(
            search_windows(std::slice::from_ref(&volta)).npx,
            Some(volta.join("npx.exe"))
        );
        assert_eq!(search_windows(&[stale]), Tools::default());
    }

    #[test]
    fn looks_where_windows_installers_put_node() {
        let env = |k: &str| {
            match k {
                "ProgramFiles" => Some(r"C:\Program Files"),
                "APPDATA" => Some(r"C:\Users\c\AppData\Roaming"),
                "NVM_SYMLINK" => Some(r"C:\nvm4w\nodejs"),
                "LOCALAPPDATA" => Some(r"C:\Users\c\AppData\Local"),
                "USERPROFILE" => Some(r"C:\Users\c"),
                _ => None,
            }
            .map(String::from)
        };
        let dirs = windows_prefixes(&env);
        assert_eq!(dirs[0], PathBuf::from(r"C:\Program Files").join("nodejs"));
        assert!(dirs.contains(&PathBuf::from(r"C:\Users\c\AppData\Roaming").join("npm")));
        assert!(dirs.contains(&PathBuf::from(r"C:\nvm4w\nodejs")));
        assert!(dirs.contains(
            &PathBuf::from(r"C:\Users\c\AppData\Local")
                .join("Volta")
                .join("bin")
        ));
        assert_eq!(dirs.len(), 6);
        // Nothing set: Program Files' default only.
        assert_eq!(
            windows_prefixes(&|_| None),
            [PathBuf::from(r"C:\Program Files").join("nodejs")]
        );
        assert_eq!(
            windows_path_dirs(r#"C:\a;;"C:\Program Files\nodejs";C:\b "#),
            [
                PathBuf::from(r"C:\a"),
                PathBuf::from(r"C:\Program Files\nodejs"),
                PathBuf::from(r"C:\b")
            ]
        );
    }

    #[test]
    fn takes_a_windows_prefix_only_from_an_absolute_variable() {
        let abs = |k: &str| {
            match k {
                "ProgramFiles" => Some(r"D:\Programs"),
                "APPDATA" => Some(r"C:\Users\c\AppData\Roaming"),
                "NVM_SYMLINK" => Some(r"C:\nvm4w\nodejs"),
                "LOCALAPPDATA" => Some(r"C:\Users\c\AppData\Local"),
                "USERPROFILE" => Some(r"C:\Users\c"),
                _ => None,
            }
            .map(String::from)
        };
        let scoop = PathBuf::from(r"C:\Users\c")
            .join("scoop")
            .join("apps")
            .join("nodejs")
            .join("current");
        // Every variable absolute: each one's folder, in this order.
        let all = windows_prefixes(&abs);
        assert_eq!(
            all,
            [
                PathBuf::from(r"D:\Programs").join("nodejs"),
                PathBuf::from(r"C:\Users\c\AppData\Roaming").join("npm"),
                PathBuf::from(r"C:\nvm4w\nodejs"),
                PathBuf::from(r"C:\Users\c\AppData\Local")
                    .join("Volta")
                    .join("bin"),
                scoop.join("bin"),
                scoop,
            ]
        );
        // What ProgramFiles gives when it is unset: the only folder left with no variable.
        let default = PathBuf::from(r"C:\Program Files").join("nodejs");
        // The folders each variable gives, by their place in `all`.
        let from = [
            ("ProgramFiles", 0..1),
            ("APPDATA", 1..2),
            ("NVM_SYMLINK", 2..3),
            ("LOCALAPPDATA", 3..4),
            ("USERPROFILE", 4..6),
        ];
        // A value that depends on where the app was started, or names no folder at all. A
        // variable holds one folder, not a list: quotes and a space before it are part of
        // the value, as they are for everything else that reads it.
        for rel in [
            ".",
            "nvm",
            "C:rel",
            r"\rooted",
            "",
            r"%X%\y",
            r".\nodejs",
            r#""C:\nvm4w\nodejs""#,
            r" C:\nvm4w\nodejs",
        ] {
            // In every variable: nothing from any of them.
            assert_eq!(
                windows_prefixes(&|_| Some(rel.to_string())),
                std::slice::from_ref(&default),
                "{rel:?} everywhere"
            );
            // In one, the others absolute: the others' folders, as they were.
            for (bad, gone) in &from {
                let dirs = windows_prefixes(&|k| {
                    if k == *bad {
                        Some(rel.to_string())
                    } else {
                        abs(k)
                    }
                });
                let mut want = all.clone();
                want.drain(gone.clone());
                if *bad == "ProgramFiles" {
                    want.insert(0, default.clone());
                }
                assert_eq!(dirs, want, "{bad}={rel:?}");
            }
        }
        // A mix, and the other ways a value is absolute: a share, a forward slash, a
        // separator at the end. Each is taken as it is written.
        let mix = windows_prefixes(&|k| {
            match k {
                "ProgramFiles" => Some("Program Files"),
                "APPDATA" => Some(r"\\server\profiles\c\AppData\Roaming"),
                "NVM_SYMLINK" => Some("d:/nvm4w/nodejs/"),
                "LOCALAPPDATA" => Some("%LOCALAPPDATA%"),
                "USERPROFILE" => Some(r"C:Users\c"),
                _ => None,
            }
            .map(String::from)
        });
        assert_eq!(
            mix,
            [
                default,
                PathBuf::from(r"\\server\profiles\c\AppData\Roaming").join("npm"),
                PathBuf::from("d:/nvm4w/nodejs/"),
            ]
        );
        // Windows' own answer is the same one: nothing here hangs on the working directory.
        #[cfg(windows)]
        for d in all.iter().chain(&mix) {
            assert!(d.is_absolute(), "{d:?} (std)");
        }
    }

    #[test]
    fn keeps_only_the_absolute_folders_of_a_windows_path() {
        // `.`, a relative `bin`, an empty entry, a drive with no root and a root with no
        // drive all depend on where the app was started: none is searched.
        assert_eq!(
            windows_path_dirs(
                r"C:\tools\node;.;bin;;.\node_modules\.bin;..;C:rel;\rooted;\\server\share\node;d:/node/"
            ),
            [
                PathBuf::from(r"C:\tools\node"),
                PathBuf::from(r"\\server\share\node"),
                PathBuf::from("d:/node/"),
            ]
        );
        // The PATH handed to the installer is joined from the same folders.
        assert_eq!(
            windows_child_dirs(r#".;"C:\Program Files\nodejs";bin;C:\Windows\System32"#),
            [r"C:\Program Files\nodejs", r"C:\Windows\System32"]
        );
        // Quotes and spaces around an entry come off before it is judged.
        assert_eq!(
            windows_path_dirs(r#" "." ; "C:\Program Files\nodejs\" ;"bin""#),
            [PathBuf::from(r"C:\Program Files\nodejs\")]
        );
        for (p, absolute) in [
            (r"C:\", true),
            (r"C:\Program Files\nodejs", true),
            ("c:/nodejs", true),
            (r"\\server\share", true),
            (r"\\?\C:\nodejs", true),
            (r"\\.\C:\nodejs", true),
            ("", false),
            (".", false),
            ("..", false),
            ("bin", false),
            (r".\bin", false),
            ("C:", false),
            ("C:nodejs", false),
            (r"\nodejs", false),
            ("/nodejs", false),
            (r"1:\nodejs", false),
        ] {
            assert_eq!(windows_absolute(p), absolute, "{p:?}");
            // Windows' own answer is the same one.
            #[cfg(windows)]
            assert_eq!(Path::new(p).is_absolute(), absolute, "{p:?} (std)");
        }
    }

    #[test]
    fn runs_a_script_under_node_and_never_a_script_alone() {
        let o = InstallOpts {
            port: 7373,
            state: None,
            dry_run: false,
            version: "0.7.5".into(),
        };
        // npx found as npx-cli.js: node runs it.
        let t = Tools {
            cli: None,
            node: Some("/n/node.exe".into()),
            npx: Some("/n/node_modules/npm/bin/npx-cli.js".into()),
        };
        let inv = install_invocation(&t, &o).unwrap();
        assert_eq!(inv.program, PathBuf::from("/n/node.exe"));
        assert_eq!(inv.args[0], "/n/node_modules/npm/bin/npx-cli.js");
        assert_eq!(inv.args[1], "-y");
        // …and with no node there is nothing to run it with.
        let no_node = Tools { node: None, ..t };
        assert!(matches!(
            install_invocation(&no_node, &o),
            Err(StartError::NoNode)
        ));
        // The CLI's cli.js with no node is not a program either.
        let js = Tools {
            cli: Some("/g/node_modules/sessionpipe-gui/dist/cli.js".into()),
            node: None,
            npx: None,
        };
        assert!(matches!(
            install_invocation(&js, &o),
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

    #[test]
    fn orders_versions_as_the_page_and_the_cli_do() {
        use std::cmp::Ordering::*;
        assert_eq!(version_cmp("0.7.2", "0.8.0"), Less);
        assert_eq!(version_cmp("0.10.0", "0.9.9"), Greater);
        assert_eq!(version_cmp("v0.8.0", "0.8"), Equal);
        assert_eq!(version_cmp("0.9.0-rc.1", "0.9.0"), Less);
        assert_eq!(version_cmp("0.9.0-rc.1", "0.8.5"), Greater);
        assert_eq!(version_cmp("", "0.0.0"), Equal);
    }

    #[test]
    fn the_running_version_is_run_json_s_when_it_names_the_receiver() {
        let run = |port: u16, pid: u32, version: &str| discovery::RunFile {
            port,
            pid,
            version: version.into(),
            url: format!("http://127.0.0.1:{port}"),
            started_at: "x".into(),
        };
        let alive = |pid: u32| pid == 42;
        let o = "http://127.0.0.1:7380";
        // run.json names it, alive: the version it started with, whatever the info says.
        assert_eq!(
            running_version(o, Some("0.8.0"), Some(&run(7380, 42, "0.7.2")), alive).as_deref(),
            Some("0.7.2")
        );
        // Another port, or a dead pid: nothing says this receiver is this computer's.
        assert_eq!(
            running_version(o, Some("0.8.0"), Some(&run(7381, 42, "0.7.2")), alive),
            None
        );
        assert_eq!(
            running_version(o, Some("0.8.0"), Some(&run(7380, 7, "0.7.2")), alive),
            None
        );
        assert_eq!(running_version(o, Some("0.8.0"), None, alive), None);
        // The default port is this computer's (as discovery takes it): its info, when no
        // run.json says more.
        for d in ["http://127.0.0.1:7373", "http://localhost:7373"] {
            assert_eq!(
                running_version(d, Some("0.7.2"), None, alive).as_deref(),
                Some("0.7.2")
            );
        }
        assert_eq!(
            running_version("http://127.0.0.1:7373", None, None, alive),
            None
        );
        // run.json names it with no version (a receiver too old to write one): the info.
        assert_eq!(
            running_version(o, Some("0.7.2"), Some(&run(7380, 42, "")), alive).as_deref(),
            Some("0.7.2")
        );
    }

    #[test]
    fn an_older_cli_on_path_gives_way_to_npx_with_the_app_s_version() {
        let t = Tools {
            cli: Some("/g/bin/sessionpipe-gui".into()),
            node: Some("/n/node".into()),
            npx: Some("/n/npx".into()),
        };
        // Older: set aside, so the install goes through npx and the 0.8.1 tarball.
        let older = prefer_current_with(t.clone(), Some("0.7.2"), "0.8.1");
        assert_eq!(older.cli, None);
        let inv = install_invocation(
            &older,
            &InstallOpts {
                port: 7373,
                state: None,
                dry_run: false,
                version: "0.8.1".into(),
            },
        )
        .unwrap();
        assert_eq!(inv.program, PathBuf::from("/n/npx"));
        assert!(inv.args[1].ends_with("/v0.8.1/sessionpipe-gui-0.8.1.tgz"));
        // The same, a newer one, one that says no version, or no npx to go to: it stays.
        for (v, npx) in [
            (Some("0.8.1"), true),
            (Some("0.9.0"), true),
            (None, true),
            (Some("0.7.2"), false),
        ] {
            let t = Tools {
                npx: npx.then(|| PathBuf::from("/n/npx")),
                ..t.clone()
            };
            assert_eq!(
                prefer_current_with(t.clone(), v, "0.8.1"),
                t,
                "{v:?} npx={npx}"
            );
        }
        // The update's command: install --if-installed, with no port and no state of its own.
        let inv = cli_invocation(
            &t,
            "0.8.1",
            ["service", "install", "--if-installed"]
                .map(String::from)
                .to_vec(),
        )
        .unwrap();
        assert_eq!(
            inv.args,
            [
                "/g/bin/sessionpipe-gui",
                "service",
                "install",
                "--if-installed"
            ]
        );
    }

    #[test]
    #[cfg(unix)]
    fn reads_the_cli_s_version() {
        let d = Temp::new("ver");
        let node = d.0.join("node");
        // node <cli> --version
        exe(
            &node,
            "#!/bin/sh\n[ \"$2\" = --version ] && echo 0.7.2 || exit 9\n",
        );
        let t = Tools {
            cli: Some(d.0.join("cli.js")),
            node: Some(node.clone()),
            npx: None,
        };
        assert_eq!(cli_version(&t).as_deref(), Some("0.7.2"));
        exe(&node, "#!/bin/sh\necho 'unknown option'\n");
        assert_eq!(cli_version(&t), None);
        assert_eq!(cli_version(&Tools { cli: None, ..t }), None);
    }

    /// A hub that knows one receiver, at `url`, as SP_RECEIVER_URL would give it.
    fn hub_for(url: &str, home: &Path) -> Hub {
        Hub::new(sp_receivers::HubConfig {
            home: home.to_path_buf(),
            keys: sp_receivers::KeyStore::memory(),
            env_receiver_url: Some(url.into()),
            allowed_origins: sp_receivers::proxy::default_allowed_origins(None),
            status: sp_receivers::StatusFile::new(None, "test"),
            user_agent: "sp-supervisor-test".into(),
        })
    }

    fn receiver_answering(version: &'static str) -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = format!(r#"{{"name":"sessionpipe-gui","version":"{version}"}}"#);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    #[test]
    fn checks_the_local_receiver_and_updates_only_an_older_one() {
        let d = Temp::new("check");
        // Its info says 0.8.0 (its package was replaced under it); it started as 0.7.2.
        let port = receiver_answering("0.8.0");
        let origin = format!("http://127.0.0.1:{port}");
        let hub = hub_for(&origin, &d.0);
        let r = hub.active().unwrap();
        let state = d.0.join("state");
        std::fs::create_dir_all(&state).unwrap();
        let run_json = |version: &str| {
            std::fs::write(
                state.join("run.json"),
                format!(
                    r#"{{"port":{port},"pid":{},"version":"{version}","url":"{origin}","startedAt":"x"}}"#,
                    std::process::id()
                ),
            )
            .unwrap()
        };
        let check = |update: fn(&str) -> Result<String, StartError>| {
            tauri::async_runtime::block_on(check_local(&hub, &r, &state, "0.8.0", update))
        };
        fn ok(app: &str) -> Result<String, StartError> {
            assert_eq!(app, "0.8.0");
            Ok(String::new())
        }
        fn fails(_: &str) -> Result<String, StartError> {
            Err(StartError::Failed("boom".into()))
        }
        fn never(_: &str) -> Result<String, StartError> {
            panic!("update run for a receiver that isn't older")
        }
        // No run.json and not the default port: nothing says it is this computer's.
        assert_eq!(check(never), Checked::NotThisComputers);
        run_json("0.7.2");
        assert_eq!(check(ok), Checked::Updated("0.7.2".into()));
        assert_eq!(check(fails), Checked::Failed("0.7.2".into(), "boom".into()));
        run_json("0.8.0");
        assert_eq!(check(never), Checked::Current("0.8.0".into()));
        run_json("0.9.1");
        assert_eq!(check(never), Checked::Current("0.9.1".into()));
    }

    /// The real thing against a service on a scratch label (stale-server e2e bed): a
    /// receiver started as an older version from `SP_STALE_CLI`'s path, whose package was
    /// then replaced there with `SP_STALE_APP`. Run with SP_SERVICE_LABEL, SP_LAUNCHCTL
    /// (a stand-in), HOME and the SP_STALE_* variables set:
    /// `cargo test -p sessionpipe-desktop live_brings -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_brings_an_older_service_up_to_the_app() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} unset"));
        assert_ne!(var("SP_SERVICE_LABEL"), "dev.spacesheep.sessionpipe-gui");
        assert!(!var("SP_LAUNCHCTL").is_empty());
        let d = Temp::new("live-update");
        let hub = hub_for(&var("SP_STALE_URL"), &d.0);
        let r = hub.active().unwrap();
        let state = PathBuf::from(var("SP_STALE_STATE"));
        fn update(app: &str) -> Result<String, StartError> {
            let t = Tools {
                cli: std::env::var_os("SP_STALE_CLI").map(PathBuf::from),
                node: std::env::var_os("SP_STALE_NODE").map(PathBuf::from),
                npx: None,
            };
            let out = update_with(t, app);
            eprintln!("{out:?}");
            out
        }
        let app = var("SP_STALE_APP");
        let got = tauri::async_runtime::block_on(check_local(&hub, &r, &state, &app, update));
        eprintln!("checked: {got:?}");
        assert!(matches!(got, Checked::Updated(_)), "{got:?}");
        let run = discovery::read_run_file(&state).unwrap();
        eprintln!("run.json now: pid {} started as {}", run.pid, run.version);
        assert_eq!(run.version, app);
        // Once current, the next check leaves it.
        let again = tauri::async_runtime::block_on(check_local(&hub, &r, &state, &app, update));
        assert_eq!(again, Checked::Current(app));
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
        // Windows: no HOME, the receiver's home is USERPROFILE.
        let win = |k: &str| (k == "USERPROFILE").then(|| "/u".to_string());
        assert_eq!(
            local_state_dir_with(&win, true),
            Some(PathBuf::from("/u/.local/state/sessionpipe-gui"))
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
        write(99_999_990, port, "t3"); // a stale file
        assert_eq!(run_state(&d.0, &here), RunState::Nothing);
    }
}
