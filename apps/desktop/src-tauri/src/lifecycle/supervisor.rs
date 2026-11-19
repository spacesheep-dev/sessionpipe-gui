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
    /// `service install` stopped the old receiver and the new one isn't running (exit 4);
    /// its line, which names the log.
    NotRunning(String),
    /// npx couldn't fetch the app's release (npm's last line); nothing was changed.
    Download(String),
    /// Our CLI is still at work past the app's wait: it is left to finish, never killed.
    StillRunning,
    /// Another install or update is already running from this app.
    Busy,
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
            StartError::NotRunning(m) => write!(f, "{m}"),
            StartError::Download(m) => write!(
                f,
                "couldn't download sessionpipe ({m}); nothing was changed"
            ),
            StartError::StillRunning => write!(
                f,
                "the update is still finishing; it carries on in the background"
            ),
            StartError::Busy => write!(f, "an install or update is already running"),
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
    cli_invocation(t, &o.version, install_args(o))
}

/// `service install --port N [--state D] [--dry-run]`.
pub fn install_args(o: &InstallOpts) -> Vec<String> {
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
    rest
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
    // Reads stdout to its end whatever becomes of the receiver: a pipe closed under a child
    // that still prints would kill it at its next write (Node doesn't handle EPIPE).
    let out_t = std::thread::spawn(move || {
        if let Some(o) = stdout {
            for line in BufReader::new(o).lines().map_while(Result::ok) {
                let _ = tx.send(line);
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
            // Our CLI has spoken (a line on stdout; npx prints none there while it downloads):
            // it may be between stopping the old receiver and starting the new one, so it is
            // never killed. The app stops waiting, says it is still finishing, and reaps it
            // when it ends (busy() stays true until then).
            Ok(None) if !out.is_empty() => {
                ORPHANS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut out = out;
                std::thread::spawn(move || {
                    // Both pipes are read until the child closes them (the readers never stop),
                    // then its verdict is logged and kept.
                    let status = child.wait();
                    let _ = out_t.join();
                    while let Ok(line) = rx.try_recv() {
                        out.push_str(&line);
                        out.push('\n');
                    }
                    let err = err_t.join().unwrap_or_default();
                    let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
                    let ran = Ran { code, out, err };
                    let said = if code == 0 {
                        ran.out
                            .lines()
                            .rfind(|l| !l.trim().is_empty())
                            .unwrap_or("")
                            .trim()
                            .to_string()
                    } else {
                        failure_line(code, &ran.out, &ran.err)
                    };
                    log::info!(target: "sessionpipe::lifecycle", "install: the installer the app stopped waiting for ended: exit {code}: {said}");
                    let mut ends = ORPHAN_ENDS.lock().unwrap();
                    ends.push(ran);
                    let extra = ends.len().saturating_sub(8);
                    ends.drain(..extra);
                    drop(ends);
                    ORPHANS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                });
                return Err(StartError::StillRunning);
            }
            // Nothing from our CLI yet (npx still downloading, or a program that hangs): it goes.
            Ok(None) => {
                kill_tree(&mut child);
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

/// Installers left to finish past the app's wait (wait_output): while any runs, busy().
static ORPHANS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// How the last few of them ended (their exit code and full output), as the log says it.
static ORPHAN_ENDS: Mutex<Vec<Ran>> = Mutex::new(Vec::new());

/// A child started in a group of its own (Unix): npx runs the CLI as its child, and a
/// timeout must stop both, not npx alone.
fn own_group(c: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c
}

/// Stops a child and what it started: its process group on Unix (own_group). On Windows
/// only the child: `taskkill /T` finds a tree by parent pid, and a process whose parent
/// died long ago with the same pid would be taken for one of ours; there is no cheap sure
/// way to tell. It is enough: a kill only ever comes before our CLI has spoken (npx still
/// downloading), and a CLI npx had just started then runs its install to the end on its own.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        const SIGKILL: i32 = 9;
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: kill(-pgid, SIGKILL) only sends a signal to that process group.
            unsafe {
                kill(-pid, SIGKILL);
            }
        }
    }
    let _ = child.kill();
}

/// `service install`: it stopped the old receiver and the new one isn't running.
pub const EXIT_NOT_RUNNING: i32 = 4;
/// `service install --if-installed`: it did nothing (no service, current, or newer).
pub const EXIT_NOTHING_DONE: i32 = 5;

/// What a finished child said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub code: i32,
    pub out: String,
    pub err: String,
}

impl Ran {
    /// Did sessionpipe-gui itself speak (a line on stdout, or one of its own on stderr), as
    /// against npx failing before it ran (offline, GitHub blocked: npm's lines only)?
    pub fn ours_spoke(&self) -> bool {
        self.out.lines().any(|l| !l.trim().is_empty())
            || self
                .err
                .lines()
                .any(|l| l.trim_start().starts_with("sessionpipe-gui: "))
    }

    fn into_result(self) -> Result<String, StartError> {
        if self.code == 0 {
            return Ok(self.out);
        }
        let line = failure_line(self.code, &self.out, &self.err);
        Err(if self.code == EXIT_NOT_RUNNING {
            StartError::NotRunning(line)
        } else {
            StartError::Failed(line)
        })
    }
}

/// Runs an invocation to its end (or the timeout); `on_line` sees each stdout line as the
/// program prints it.
pub fn run_capture(
    inv: &Invocation,
    timeout: Duration,
    on_line: impl FnMut(&str),
) -> Result<Ran, StartError> {
    let child = own_group(no_window(&mut Command::new(&inv.program)))
        .args(&inv.args)
        .env("PATH", &inv.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| StartError::Failed(format!("couldn't run {}: {e}", inv.program.display())))?;
    let (code, out, err) = wait_output(child, timeout, on_line)?;
    Ok(Ran { code, out, err })
}

/// Runs an invocation; Ok(stdout) on exit 0, else the last line it printed. `on_line`
/// sees each stdout line as the program prints it.
pub fn run(
    inv: &Invocation,
    timeout: Duration,
    on_line: impl FnMut(&str),
) -> Result<String, StartError> {
    run_capture(inv, timeout, on_line)?.into_result()
}

/// The last line a failed program printed, without our "sessionpipe-gui: " prefix.
/// stderr's last line first (where sessionpipe-gui and npm say what went wrong), else
/// stdout's: a failure after progress lines ("updating …", "starting on …") is its error.
fn failure_line(code: i32, out: &str, err: &str) -> String {
    let last = |t: &str| {
        t.lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .map(String::from)
    };
    let why = last(err).or_else(|| last(out)).unwrap_or_default();
    let why = why
        .strip_prefix("sessionpipe-gui: ")
        .unwrap_or(&why)
        .to_string();
    if why.is_empty() {
        format!("service install exited with {code}")
    } else {
        why
    }
}

/// The click path ("Start sessionpipe", and the page's "Update sessionpipe"): `rest` run by
/// the app's own version through npx when the CLI on PATH is older than the app (or there
/// is none). When npx fails before sessionpipe-gui said anything (offline, GitHub blocked)
/// the CLI on PATH runs it instead only where `may_fall_back()` says that can't make the
/// service older (asked then, not before); otherwise it is StartError::Download and
/// nothing was changed.
pub fn run_installer(
    tools: &Tools,
    cli_version: Option<&str>,
    app: &str,
    rest: Vec<String>,
    timeout: Duration,
    may_fall_back: impl FnOnce() -> bool,
    mut on_line: impl FnMut(&str),
) -> Result<String, StartError> {
    let cli_older = cli_version.is_some_and(|v| version_cmp(v, app).is_lt());
    if tools.npx.is_some() && (tools.cli.is_none() || cli_older) {
        let npx_only = Tools {
            cli: None,
            ..tools.clone()
        };
        let inv = cli_invocation(&npx_only, app, rest.clone())?;
        log::info!(target: "sessionpipe::lifecycle", "install: {} {}", inv.program.display(), inv.args.join(" "));
        let ran = run_capture(&inv, timeout, &mut on_line);
        let why = match ran {
            Ok(r) if r.code == 0 || r.ours_spoke() => return r.into_result(),
            Ok(r) => failure_line(r.code, &r.out, &r.err),
            // npx couldn't be started at all; a timeout may have half-run it, so it stands.
            Err(StartError::Failed(m)) if m.starts_with("couldn't run") => m,
            Err(e) => return Err(e),
        };
        if tools.cli.is_none() || !may_fall_back() {
            log::warn!(target: "sessionpipe::lifecycle", "install: npx failed before sessionpipe-gui ran ({why}); nothing changed");
            return Err(StartError::Download(why));
        }
        log::warn!(target: "sessionpipe::lifecycle", "install: npx failed before sessionpipe-gui ran ({why}); the one on PATH runs it");
    }
    let inv = cli_invocation(tools, app, rest)?;
    log::info!(target: "sessionpipe::lifecycle", "install: {} {}", inv.program.display(), inv.args.join(" "));
    run(&inv, timeout, on_line)
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
    let _busy = begin_install()?;
    progress("find", "Looking for Node…");
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let tools =
        tauri::async_runtime::spawn_blocking(move || discover_tools(&home, login_shell_lookup()))
            .await
            .map_err(|e| StartError::Failed(e.to_string()))?;
    log::info!(target: "sessionpipe::lifecycle", "start: cli {:?} node {:?} npx {:?}", tools.cli, tools.node, tools.npx);

    let debug = cfg!(debug_assertions);
    // An older CLI on PATH would install its own, older version: a release build prefers
    // the app's version through npx, and falls back to that CLI when npx can't run it
    // (run_installer). Debug builds keep the CLI: the dev child runs it.
    let cli_v = if debug {
        None
    } else {
        let t = tools.clone();
        tauri::async_runtime::spawn_blocking(move || cli_version(&t))
            .await
            .map_err(|e| StartError::Failed(e.to_string()))?
    };
    let port = if debug {
        env_port("SP_DEV_RECEIVER_PORT", DEV_PORT)
    } else {
        SERVICE_PORT
    };
    let state = debug.then(dev_state);
    let rest = install_args(&InstallOpts {
        port,
        state: state.clone(),
        dry_run: debug,
        version: version.into(),
    });
    // NoNode now rather than after the progress line.
    cli_invocation(&tools, version, rest.clone())?;
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
    let (t2, v2) = (tools.clone(), version.to_string());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let install = tauri::async_runtime::spawn_blocking(move || {
        // npx failing before our CLI ran falls back to the CLI on PATH only where that
        // can't make the service older (may_fall_back); a debug build's dry run never needs it.
        let t3 = t2.clone();
        let cv = cli_v.clone();
        let fall_back = move || {
            !debug
                && may_fall_back(
                    cv.as_deref(),
                    &installed_service(&t3, local_state_dir().as_deref()),
                )
        };
        run_installer(
            &t2,
            cli_v.as_deref(),
            &v2,
            rest,
            INSTALL_TIMEOUT,
            fall_back,
            |line| {
                let _ = tx.send(line.to_string());
            },
        )
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
// (the only place that runs `service install` unasked) is the welcome's, on a first run.
// The page then calls routes that server doesn't have. So once per launch, when this
// computer's receiver first connects, the app asks it its version, and when that is older
// than the app's own:
// - a `sessionpipe-gui` on PATH at the app's version or newer is there: it runs `service
//   install --if-installed` in the background (the service upgraded in place, with its
//   port and state dir; none installed where there was none). Nothing is downloaded.
// - otherwise bringing it current needs the app's release through npx, a download, which
//   needs a click: nothing runs, the log says so, and the page (rx_local_update) offers
//   "Update sessionpipe", which runs the click path (update_local_click).
// It is logged either way. A failure before the old receiver was stopped leaves it running;
// one after (`service install` exits 4: the new one never came up) is logged as such, and
// the page offers the click. Debug builds never do any of it (they keep away from :7373
// and ~/.local/state).

/// Orders two versions as `x.y.z[-pre][+build]`, as shared/version.ts's compareVersions
/// does (both are tested against shared/version-cases.json): build metadata dropped, a
/// part by its leading digits (none: 0), a missing part 0, a prerelease before its release.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| {
        let v = v.trim().trim_start_matches('v');
        let v = v.split('+').next().unwrap_or("");
        let (core, pre) = match v.split_once('-') {
            Some((c, _)) => (c, true),
            None => (v, false),
        };
        let nums: Vec<u64> = core
            .split('.')
            .map(|n| {
                let digits: String = n.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().unwrap_or(0)
            })
            .collect();
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

/// What the receiver at `origin` said of itself in /api/ui/info.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InfoSays {
    pub version: Option<String>,
    pub started_at: Option<String>,
}

/// The version this computer's receiver at `origin` runs, or None when nothing says it is
/// this computer's: its run.json (in this computer's state dir) must name the origin with
/// a live pid (a tunnel to another machine, a receiver on another state dir: None).
///
/// The info's version is used unless run.json describes the very process that answers:
/// its startedAt (written at listen) no earlier than the info's (taken when the process
/// built its app). Then run.json's version is the one: up to 0.8.0 the info read
/// package.json on every request and could name the new version while the old code ran.
/// A run.json left by an earlier process, whose pid was reused, is older than the info
/// and is not believed. The info only ever over-reports, so an info version already older
/// than the app is enough on its own.
pub fn running_version(
    origin: &str,
    info: &InfoSays,
    run: Option<&discovery::RunFile>,
    alive: impl Fn(u32) -> bool,
) -> Option<String> {
    let run = run.filter(|r| {
        sp_receivers::id::canonical_origin(&r.url).as_deref() == Some(origin) && alive(r.pid)
    })?;
    let said = info
        .version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let same_process = match info.started_at.as_deref() {
        Some(at) => !run.started_at.is_empty() && run.started_at.as_str() >= at,
        None => false,
    };
    let started_as = Some(run.version.trim()).filter(|v| !v.is_empty());
    match (said, started_as) {
        (Some(s), Some(r)) if same_process && version_cmp(r, s).is_lt() => Some(r.to_string()),
        (Some(s), _) => Some(s.to_string()),
        (None, r) => r.map(String::from),
    }
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

/// What to do about this computer's receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Nothing says it is this computer's receiver: never touched.
    NotThisComputers,
    /// It runs this version, not older than the app's.
    Current(String),
    /// Older (this version), and a CLI on PATH at the app's version or newer runs the update.
    Auto(String),
    /// Older (this version), and only the app's release through npx would bring it current:
    /// a download, so it waits for a click.
    Click(String),
}

/// The decision, from what is known: the receiver's version (running_version), the app's,
/// and the version of the CLI on PATH (None: there is none, or it says none). Never a
/// download: only a CLI already here is ever run unasked.
pub fn plan(running: Option<&str>, app: &str, cli_version: Option<&str>) -> Plan {
    let Some(v) = running else {
        return Plan::NotThisComputers;
    };
    if !version_cmp(v, app).is_lt() {
        return Plan::Current(v.into());
    }
    match cli_version {
        Some(c) if !version_cmp(c, app).is_lt() => Plan::Auto(v.into()),
        _ => Plan::Click(v.into()),
    }
}

/// The receiver the check is about: the first local one that is connected. Never a
/// spacesheep account: that is no receiver of this computer's, wherever it lives (the
/// Hub never calls one local; this does not rely on it).
pub fn first_local(
    receivers: &[ReceiverRef],
    connected: impl Fn(&str) -> bool,
) -> Option<ReceiverRef> {
    receivers
        .iter()
        .find(|r| r.local && r.account.is_none() && connected(&r.id))
        .cloned()
}

/// True the first time only: the check runs once per launch.
pub fn first_time(flag: &std::sync::atomic::AtomicBool) -> bool {
    !flag.swap(true, std::sync::atomic::Ordering::SeqCst)
}

/// Where the check left this computer's receiver, for the page (rx_local_update).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdate {
    /// The receiver checked.
    pub origin: String,
    /// The version it ran when checked.
    pub running: String,
    pub app: String,
    pub state: UpdateState,
    /// Why the last update didn't happen (Failed), or what the CLI said it left (Unchanged).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// An install or update is running now (from this app), and its last progress line.
    pub busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateState {
    /// Not older than the app.
    Current,
    /// Updated in the background by the CLI on PATH.
    Updated,
    /// Older, and the update needs a click (a download).
    Click,
    /// An update ran and failed; a click may try again.
    Failed,
    /// The background update ran and did nothing (`--if-installed` exit 5: no service of
    /// ours, or one already current or newer); `why` is its line.
    Unchanged,
}

/// What the background update did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Updated {
    Done,
    /// `--if-installed` did nothing (exit 5): its line.
    Nothing(String),
}

// ---- one install at a time ----

static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PROGRESS: Mutex<Option<String>> = Mutex::new(None);

/// Held while "Start sessionpipe", "Update sessionpipe" or the background update runs.
pub struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        *PROGRESS.lock().unwrap() = None;
        INSTALLING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The app's one install at a time: Busy while another runs, or while an installer left to
/// finish past the app's wait still runs (wait_output).
pub fn begin_install() -> Result<InstallGuard, StartError> {
    if ORPHANS.load(std::sync::atomic::Ordering::SeqCst) > 0
        || INSTALLING.swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(StartError::Busy);
    }
    Ok(InstallGuard)
}

/// Is an install or update running from this app now?
pub fn busy() -> bool {
    INSTALLING.load(std::sync::atomic::Ordering::SeqCst)
        || ORPHANS.load(std::sync::atomic::Ordering::SeqCst) > 0
}

fn note_progress(line: &str) {
    *PROGRESS.lock().unwrap() = Some(line.to_string());
}

// ---- the Start fallback ----

/// What this computer's service is known to run, for "Start sessionpipe"'s fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstalledService {
    /// No service of ours is installed (a first run).
    None,
    /// One is, and the newest version it is known to run is this.
    Runs(String),
    /// One may be, and nothing says what it runs.
    Unknown,
}

/// May the CLI on PATH run the install when npx couldn't? Only where it can't make the
/// service older: no service installed (a first run, as main did), or a CLI at least the
/// version the service runs. Unknown: no.
pub fn may_fall_back(cli_version: Option<&str>, installed: &InstalledService) -> bool {
    match installed {
        InstalledService::None => true,
        InstalledService::Runs(v) => cli_version.is_some_and(|c| !version_cmp(c, v).is_lt()),
        InstalledService::Unknown => false,
    }
}

/// The CLIs a service file names: plist `<string>`s, or the unit's ExecStart words, that
/// end in `cli.js` or are the `sessionpipe-gui` bin.
pub fn clis_in_service_file(text: &str) -> Vec<PathBuf> {
    let unescape = |w: &str| {
        w.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    };
    let mut words: Vec<String> = text
        .split("<string>")
        .skip(1)
        .filter_map(|r| r.split_once("</string>").map(|(w, _)| unescape(w)))
        .collect();
    if let Some(line) = text
        .lines()
        .find(|l| l.trim_start().starts_with("ExecStart="))
    {
        let rest = line.trim_start().trim_start_matches("ExecStart=");
        words.extend(rest.split('"').enumerate().flat_map(|(i, part)| {
            if i % 2 == 1 {
                vec![part.replace("\\\"", "\"").replace("\\\\", "\\")]
            } else {
                part.split_whitespace().map(String::from).collect()
            }
        }));
    }
    words
        .into_iter()
        .filter(|w| {
            w.ends_with("cli.js")
                || w.ends_with("/sessionpipe-gui")
                || w.ends_with("\\sessionpipe-gui")
        })
        .map(PathBuf::from)
        .collect()
}

/// The version in the package.json of the package a CLI belongs to (a bin is followed).
fn package_version_at(cli: &Path) -> Option<String> {
    let real = std::fs::canonicalize(cli).ok()?;
    let dir = real.parent()?.parent()?;
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("package.json")).ok()?).ok()?;
    (v.get("name")?.as_str()? == "sessionpipe-gui")
        .then(|| v.get("version")?.as_str().map(String::from))?
}

/// What the CLI on PATH's `service status` says, with the service file it names and this
/// computer's run.json: whether a service is installed and the newest version it is known
/// to run. Pure; installed_service() gathers its inputs.
pub fn installed_from(
    status: Option<&str>,
    file_text: Option<&str>,
    version_at: impl Fn(&Path) -> Option<String>,
    last_run: Option<&str>,
) -> InstalledService {
    let Some(status) = status else {
        return InstalledService::Unknown;
    };
    if status
        .lines()
        .next()
        .is_some_and(|l| l.contains("· not installed"))
    {
        return InstalledService::None;
    }
    let mut known: Vec<String> = file_text
        .map(clis_in_service_file)
        .unwrap_or_default()
        .iter()
        .filter_map(|c| version_at(c))
        .collect();
    known.extend(
        status
            .lines()
            .filter_map(|l| l.strip_prefix("run.json"))
            .filter_map(|l| l.split(" · ").nth(1))
            .map(|v| v.trim().to_string()),
    );
    known.extend(last_run.map(String::from));
    known.retain(|v| v.starts_with(|c: char| c.is_ascii_digit()));
    known.sort_by(|a, b| version_cmp(a, b));
    known
        .pop()
        .map(InstalledService::Runs)
        .unwrap_or(InstalledService::Unknown)
}

/// Gathers installed_from()'s inputs: `<CLI on PATH> service status`, the file it names (on
/// macOS and Linux), and `<state>/run.json`'s version.
fn installed_service(t: &Tools, state: Option<&Path>) -> InstalledService {
    let status = t.cli.as_ref().and_then(|_| {
        let inv = cli_invocation(t, "", vec!["service".into(), "status".into()]).ok()?;
        // exit 3 is "not running" (or not installed): its words are what count.
        run_capture(&inv, Duration::from_secs(15), |_| {})
            .ok()
            .map(|r| r.out)
    });
    let file_text = status.as_deref().and_then(|s| {
        let file = s.lines().find_map(|l| l.strip_prefix("file"))?.trim();
        let home = std::env::var("HOME").unwrap_or_default();
        let path = file
            .strip_prefix('~')
            .map(|r| format!("{home}{r}"))
            .unwrap_or(file.into());
        std::fs::read_to_string(path).ok()
    });
    let last = state.and_then(discovery::read_run_file).map(|r| r.version);
    installed_from(
        status.as_deref(),
        file_text.as_deref(),
        package_version_at,
        last.as_deref(),
    )
}

static CHECKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LOCAL: Mutex<Option<(ReceiverRef, LocalUpdate)>> = Mutex::new(None);

/// What the check last found, for the page, with whether an install runs now.
pub fn local_update() -> Option<LocalUpdate> {
    LOCAL.lock().unwrap().as_ref().map(|(_, u)| LocalUpdate {
        busy: busy(),
        progress: PROGRESS.lock().unwrap().clone(),
        ..u.clone()
    })
}

/// The CLI on PATH and the version it says: what the background update may run.
fn tools_here() -> (Tools, Option<String>) {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let t = discover_tools(&home, login_shell_lookup());
    let v = cli_version(&t);
    (t, v)
}

/// The background update: `service install --if-installed` by the CLI on PATH, never npx
/// (plan() only says Auto when that CLI is at the app's version or newer).
fn update_with_cli(t: &Tools, app: &str) -> Result<Updated, StartError> {
    let cli_only = Tools {
        npx: None,
        ..t.clone()
    };
    let inv = cli_invocation(
        &cli_only,
        app,
        ["service", "install", "--if-installed"]
            .map(String::from)
            .to_vec(),
    )?;
    log::info!(target: "sessionpipe::lifecycle", "update: {} {}", inv.program.display(), inv.args.join(" "));
    let ran = run_capture(
        &inv,
        INSTALL_TIMEOUT,
        |line| log::info!(target: "sessionpipe::lifecycle", "service install: {line}"),
    )?;
    if ran.code == EXIT_NOTHING_DONE {
        let line = ran
            .out
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim();
        return Ok(Updated::Nothing(line.to_string()));
    }
    ran.into_result().map(|_| Updated::Done)
}

/// Once per launch: the first local receiver that connects is checked (see above).
/// Called once from setup.
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
            if let Some(r) = first_local(&hub.receivers(), |id| hub.is_connected(id)) {
                break r;
            }
            match rx.recv().await {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        };
        if !first_time(&CHECKED) {
            return;
        }
        if let Some(u) =
            check_local(&hub, &r, &state, &app_version, tools_here, update_with_cli).await
        {
            *LOCAL.lock().unwrap() = Some((r, u));
        }
    });
}

/// The receiver's own word on its version and start.
async fn info_of(hub: &Hub, r: &ReceiverRef) -> InfoSays {
    let v: Option<serde_json::Value> = hub
        .get(&r.id, "/api/ui/info")
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let field = |k: &str| {
        v.as_ref()
            .and_then(|v| v.get(k))
            .and_then(|x| x.as_str())
            .map(String::from)
    };
    InfoSays {
        version: field("version"),
        started_at: field("startedAt"),
    }
}

/// Checks the local receiver `r` and acts on plan(): `tools` finds the CLI on PATH and its
/// version (only asked when the receiver is older), `update` runs the background update
/// (off the async runtime). Logged; nothing fails. None: not this computer's receiver.
pub async fn check_local(
    hub: &Hub,
    r: &ReceiverRef,
    state: &Path,
    app: &str,
    tools: fn() -> (Tools, Option<String>),
    update: fn(&Tools, &str) -> Result<Updated, StartError>,
) -> Option<LocalUpdate> {
    // A spacesheep account is not this computer's receiver, whatever run.json says of
    // its address: it is not asked what a receiver is asked, and nothing is installed
    // or updated on its account.
    if r.account.is_some() {
        log::info!(target: "sessionpipe::lifecycle", "update: {} is a spacesheep account, not a receiver; left as it is", r.origin);
        return None;
    }
    let info = info_of(hub, r).await;
    let run_file = discovery::read_run_file(state);
    let running = running_version(&r.origin, &info, run_file.as_ref(), discovery::pid_alive);
    let older = running
        .as_deref()
        .is_some_and(|v| version_cmp(v, app).is_lt());
    let (found, cli_v) = if older {
        tauri::async_runtime::spawn_blocking(tools)
            .await
            .unwrap_or_default()
    } else {
        (Tools::default(), None)
    };
    let done = |running: &str, state: UpdateState, why: Option<String>| LocalUpdate {
        origin: r.origin.clone(),
        running: running.into(),
        app: app.into(),
        state,
        why,
        busy: false,
        progress: None,
    };
    match plan(running.as_deref(), app, cli_v.as_deref()) {
        Plan::NotThisComputers => {
            log::info!(target: "sessionpipe::lifecycle", "update: {} isn't known to be this computer's receiver; left as it is", r.origin);
            None
        }
        Plan::Current(v) => {
            log::info!(target: "sessionpipe::lifecycle", "update: the local receiver runs {v} ({}); nothing to do", r.origin);
            Some(done(&v, UpdateState::Current, None))
        }
        Plan::Click(v) => {
            log::info!(target: "sessionpipe::lifecycle", "update: the local receiver runs {v}, older than this app ({app}); bringing it to {app} needs the app's release through npx (a download), so it waits for \"Update sessionpipe\" in Settings › Data (the CLI on PATH: {})", cli_v.as_deref().unwrap_or("none"));
            Some(done(&v, UpdateState::Click, None))
        }
        Plan::Auto(v) => {
            log::info!(target: "sessionpipe::lifecycle", "update: the local receiver runs {v}, older than this app ({app}); the sessionpipe-gui on PATH ({}) updates it", cli_v.as_deref().unwrap_or(""));
            let Ok(_busy) = begin_install() else {
                log::info!(target: "sessionpipe::lifecycle", "update: another install runs; left to it");
                return Some(done(&v, UpdateState::Click, None));
            };
            let a = app.to_string();
            let res = tauri::async_runtime::spawn_blocking(move || update(&found, &a)).await;
            let why = match res {
                Ok(Ok(Updated::Done)) => {
                    log::info!(target: "sessionpipe::lifecycle", "update: done");
                    return Some(done(&v, UpdateState::Updated, None));
                }
                Ok(Ok(Updated::Nothing(line))) => {
                    log::info!(target: "sessionpipe::lifecycle", "update: nothing done: {line}");
                    return Some(done(&v, UpdateState::Unchanged, Some(line)));
                }
                Ok(Err(e)) => e.to_string(),
                Err(e) => e.to_string(),
            };
            log::warn!(target: "sessionpipe::lifecycle", "update: not done: {why}");
            Some(done(&v, UpdateState::Failed, Some(why)))
        }
    }
}

/// The page's "Update sessionpipe" (Settings › Data): the app's release through npx, with
/// its progress lines. Never the CLI on PATH instead: when npx can't download it, nothing is
/// changed and it says so (StartError::Download), since an older CLI there (one without
/// this version's gates) would put its own version in place of the service's. Then the
/// receiver's version is read again, waiting (up to 30 s) for the new one's run.json.
pub async fn update_local_click(
    hub: &Hub,
    app: &str,
    progress: impl Fn(&str, &str),
) -> Result<Option<LocalUpdate>, StartError> {
    if cfg!(debug_assertions) {
        return Err(StartError::Failed(
            "a debug build doesn't update this computer's receiver".into(),
        ));
    }
    let r = LOCAL
        .lock()
        .unwrap()
        .as_ref()
        .map(|(r, _)| r.clone())
        .ok_or_else(|| StartError::Failed("this computer's receiver wasn't checked yet".into()))?;
    let state =
        local_state_dir().ok_or_else(|| StartError::Failed("no state folder here".into()))?;
    let _busy = begin_install()?;
    let say = |step: &str, line: &str| {
        note_progress(line);
        progress(step, line);
    };
    say("find", "Looking for Node…");
    let (found, cli_v) = tauri::async_runtime::spawn_blocking(tools_here)
        .await
        .map_err(|e| StartError::Failed(e.to_string()))?;
    let found = update_tools(found, cli_v.as_deref(), app)?;
    say("install", "Updating the background service…");
    let a = app.to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let job = tauri::async_runtime::spawn_blocking(move || {
        run_installer(
            &found,
            cli_v.as_deref(),
            &a,
            ["service", "install"].map(String::from).to_vec(),
            INSTALL_TIMEOUT,
            || false,
            |line| {
                let _ = tx.send(line.to_string());
            },
        )
    });
    while let Some(line) = rx.recv().await {
        log::info!(target: "sessionpipe::lifecycle", "service install: {line}");
        if let Some(words) = progress_for(&line) {
            say("install", &words);
        }
    }
    let res = job.await.map_err(|e| StartError::Failed(e.to_string()))?;
    // The new receiver writes run.json when it listens: wait for it, a while, before saying
    // what runs (a big board takes a moment); the installer's own result decides otherwise.
    let mut now = None;
    if res.is_ok() {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let info = info_of(hub, &r).await;
            now = running_version(
                &r.origin,
                &info,
                discovery::read_run_file(&state).as_ref(),
                discovery::pid_alive,
            );
            if now.is_some() || Instant::now() >= until {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    let state_now = match (&res, now.as_deref()) {
        (Err(_), _) => UpdateState::Failed,
        (Ok(_), Some(v)) if version_cmp(v, app).is_lt() => UpdateState::Click,
        (Ok(_), Some(_)) => UpdateState::Current,
        (Ok(_), None) => UpdateState::Updated,
    };
    let u = LocalUpdate {
        origin: r.origin.clone(),
        running: now.unwrap_or_default(),
        app: app.into(),
        state: state_now,
        why: res.as_ref().err().map(|e| e.to_string()),
        busy: false,
        progress: None,
    };
    *LOCAL.lock().unwrap() = Some((r, u.clone()));
    res?;
    say("done", "sessionpipe is up to date");
    Ok(Some(u))
}

/// What "Update sessionpipe" may run: the CLI on PATH only when its version is known and at
/// least the app's (one from before this version has no downgrade gate, and a CLI whose
/// `--version` said nothing usable could be one), else the app's release through npx. With
/// neither, nothing can do it: said, and nothing is changed.
pub fn update_tools(
    found: Tools,
    cli_version: Option<&str>,
    app: &str,
) -> Result<Tools, StartError> {
    let cli_current = cli_version.is_some_and(|v| !version_cmp(v, app).is_lt());
    let t = if found.cli.is_some() && cli_current {
        found
    } else {
        Tools { cli: None, ..found }
    };
    if t.cli.is_none() && t.npx.is_none() {
        return Err(StartError::Failed(format!(
            "there is no sessionpipe-gui {app} or newer here, and no npx to download it; nothing was changed"
        )));
    }
    Ok(t)
}

/// What the page is told when "Update sessionpipe" didn't work.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    /// "notRunning" (the old receiver was stopped and the new one isn't running),
    /// "download" (npx couldn't fetch it; nothing changed), "stillRunning" (still at work in
    /// the background), "busy", or "failed".
    pub kind: &'static str,
    /// The installer's last line, or the app's.
    pub line: String,
    /// The service log a "notRunning" line names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

impl From<&StartError> for UpdateFailure {
    fn from(e: &StartError) -> Self {
        let kind = match e {
            StartError::NotRunning(_) => "notRunning",
            StartError::Download(_) => "download",
            StartError::StillRunning => "stillRunning",
            StartError::Busy => "busy",
            _ => "failed",
        };
        let line = e.to_string();
        let log = match e {
            StartError::NotRunning(m) => m.rsplit_once("see ").map(|(_, l)| l.trim().to_string()),
            _ => None,
        };
        UpdateFailure { kind, line, log }
    }
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

    /// The app's one-install guard (INSTALLING, ORPHANS) is the process's, and cargo runs
    /// tests side by side: the tests that take it, or leave an installer running past its
    /// wait, hold this while they run, and start only once nothing of an earlier one is
    /// still counted.
    static GUARD_TESTS: Mutex<()> = Mutex::new(());
    fn alone_with_the_guard() -> std::sync::MutexGuard<'static, ()> {
        let held = GUARD_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let until = Instant::now() + Duration::from_secs(10);
        while busy() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        held
    }

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
        // The one table shared/version.test.ts checks compareVersions against.
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../shared/version-cases.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() > 10);
        for c in cases {
            let (a, b, sign) = (
                c[0].as_str().unwrap(),
                c[1].as_str().unwrap(),
                c[2].as_i64().unwrap(),
            );
            let got = match version_cmp(a, b) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            };
            assert_eq!(got, sign, "{a:?} vs {b:?}");
        }
    }

    fn run_file(port: u16, pid: u32, version: &str, started_at: &str) -> discovery::RunFile {
        discovery::RunFile {
            port,
            pid,
            version: version.into(),
            url: format!("http://127.0.0.1:{port}"),
            started_at: started_at.into(),
        }
    }

    #[test]
    fn the_running_version_believes_run_json_only_for_the_process_that_answers() {
        let alive = |pid: u32| pid == 42;
        let o = "http://127.0.0.1:7380";
        let info = |v: &str, at: &str| InfoSays {
            version: Some(v.into()),
            started_at: Some(at.into()),
        };
        let t0 = "2026-11-12T10:00:00.000Z";
        let t1 = "2026-11-12T10:00:03.000Z";
        // run.json written by the process that answers (at listen, after its info's start):
        // the version it started as, though its info names the files' newer one.
        assert_eq!(
            running_version(
                o,
                &info("0.8.0", t0),
                Some(&run_file(7380, 42, "0.7.2", t1)),
                alive
            )
            .as_deref(),
            Some("0.7.2")
        );
        // A run.json from an earlier process whose pid lives on as another: older than the
        // info's start, not believed; the current receiver's info stands (no restart each launch).
        assert_eq!(
            running_version(
                o,
                &info("0.8.0", t1),
                Some(&run_file(7380, 42, "0.7.2", t0)),
                alive
            )
            .as_deref(),
            Some("0.8.0")
        );
        // The info older already: enough on its own (it only ever over-reports).
        assert_eq!(
            running_version(
                o,
                &info("0.7.2", t1),
                Some(&run_file(7380, 42, "0.9.0", t0)),
                alive
            )
            .as_deref(),
            Some("0.7.2")
        );
        // No info version: what run.json says.
        assert_eq!(
            running_version(
                o,
                &InfoSays::default(),
                Some(&run_file(7380, 42, "0.7.2", t0)),
                alive
            )
            .as_deref(),
            Some("0.7.2")
        );
        // Not this computer's: no run.json, another port, a dead pid; the default port alone
        // (a tunnel to another machine can sit there) is not enough.
        for run in [
            None,
            Some(run_file(7381, 42, "0.7.2", t1)),
            Some(run_file(7380, 7, "0.7.2", t1)),
        ] {
            assert_eq!(
                running_version(o, &info("0.7.2", t0), run.as_ref(), alive),
                None
            );
        }
        assert_eq!(
            running_version("http://127.0.0.1:7373", &info("0.7.2", t0), None, alive),
            None
        );
    }

    #[test]
    fn plans_never_a_download_unasked_and_never_for_another_machine() {
        assert_eq!(plan(None, "0.8.1", Some("0.8.1")), Plan::NotThisComputers);
        assert_eq!(
            plan(Some("0.8.1"), "0.8.1", None),
            Plan::Current("0.8.1".into())
        );
        assert_eq!(
            plan(Some("0.9.0"), "0.8.1", None),
            Plan::Current("0.9.0".into())
        );
        // A CLI here at the app's version or newer: it runs the update, nothing downloaded.
        assert_eq!(
            plan(Some("0.7.2"), "0.8.1", Some("0.8.1")),
            Plan::Auto("0.7.2".into())
        );
        assert_eq!(
            plan(Some("0.7.2"), "0.8.1", Some("0.9.0")),
            Plan::Auto("0.7.2".into())
        );
        // An older CLI, none, or one that says no version: only npx would do; that waits for a click.
        for cli in [Some("0.8.0"), None] {
            assert_eq!(
                plan(Some("0.7.2"), "0.8.1", cli),
                Plan::Click("0.7.2".into())
            );
        }
    }

    #[test]
    fn checks_the_first_connected_local_receiver_once() {
        let r = |id: &str, local: bool| ReceiverRef {
            id: id.into(),
            name: id.into(),
            origin: format!("http://{id}:7373"),
            local,
            ..Default::default()
        };
        let list = [r("remote", false), r("a", true), r("b", true)];
        assert_eq!(
            first_local(&list, |id| id != "a").map(|r| r.id),
            Some("b".into())
        );
        assert_eq!(first_local(&list, |id| id == "remote"), None);
        assert_eq!(first_local(&[], |_| true), None);
        let flag = std::sync::atomic::AtomicBool::new(false);
        assert!(first_time(&flag));
        assert!(!first_time(&flag));
        assert!(!first_time(&flag));
    }

    #[test]
    #[cfg(unix)]
    fn the_click_path_prefers_npx_and_falls_back_to_the_cli_when_npx_cannot_run_it() {
        let d = Temp::new("click");
        let cli = d.0.join("sessionpipe-gui");
        exe(&cli, "#!/bin/sh\necho \"cli $*\"\n");
        let offline = d.0.join("npx-offline");
        exe(
            &offline,
            "#!/bin/sh\necho 'npm error code ENOTFOUND' >&2\necho 'npm error network request failed' >&2\nexit 1\n",
        );
        let refuses = d.0.join("npx-ours");
        exe(
            &refuses,
            "#!/bin/sh\necho 'sessionpipe-gui: port 7373 is in use by another program (try --port)' >&2\nexit 1\n",
        );
        let works = d.0.join("npx-ok");
        exe(&works, "#!/bin/sh\necho \"npx $*\"\n");
        let rest = || ["service", "install"].map(String::from).to_vec();
        let tools = |npx: &Path| Tools {
            cli: Some(cli.clone()),
            node: None,
            npx: Some(npx.to_path_buf()),
        };
        let go_with = |t: &Tools, v: Option<&str>, fall_back: bool| {
            run_installer(
                t,
                v,
                "0.8.1",
                rest(),
                Duration::from_secs(5),
                move || fall_back,
                |_| {},
            )
        };
        let go = |t: &Tools, v: Option<&str>| go_with(t, v, true);
        // Older CLI: npx with the app's release.
        let out = go(&tools(&works), Some("0.7.2")).unwrap();
        assert!(out.starts_with("npx -y --package=https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.8.1/"), "{out}");
        // npx offline before ours ran, where falling back can't make the service older
        // ("Start sessionpipe" on a first run): the CLI on PATH runs it.
        assert_eq!(
            go(&tools(&offline), Some("0.7.2")).unwrap().trim(),
            "cli service install"
        );
        // Where it could ("Update sessionpipe", always; "Start" over a newer service): nothing
        // runs, and it says it couldn't download.
        match go_with(&tools(&offline), Some("0.7.2"), false) {
            Err(e @ StartError::Download(_)) => assert_eq!(
                e.to_string(),
                "couldn't download sessionpipe (npm error network request failed); nothing was changed"
            ),
            other => panic!("{other:?}"),
        }
        // Ours ran under npx and refused: that stands, no second try.
        match go(&tools(&refuses), Some("0.7.2")) {
            Err(StartError::Failed(m)) => {
                assert_eq!(m, "port 7373 is in use by another program (try --port)")
            }
            other => panic!("{other:?}"),
        }
        // No CLI and npx offline: npx's own line.
        let no_cli = Tools {
            cli: None,
            ..tools(&offline)
        };
        assert!(
            matches!(go(&no_cli, None), Err(StartError::Download(m)) if m.contains("network request failed"))
        );
        // A CLI at the app's version (or one that says none): it, not npx.
        for v in [Some("0.8.1"), None] {
            assert_eq!(go(&tools(&works), v).unwrap().trim(), "cli service install");
        }
    }

    #[test]
    #[cfg(unix)]
    fn the_background_update_runs_the_cli_and_never_npx() {
        let d = Temp::new("bg");
        let cli = d.0.join("sessionpipe-gui");
        exe(&cli, "#!/bin/sh\necho \"cli $*\"\n");
        let npx = d.0.join("npx");
        exe(&npx, "#!/bin/sh\necho npx\n");
        let t = Tools {
            cli: Some(cli),
            node: None,
            npx: Some(npx.clone()),
        };
        assert_eq!(update_with_cli(&t, "0.8.1").unwrap(), Updated::Done);
        // Exit 5: it did nothing, and says what it left.
        let nothing = d.0.join("sessionpipe-gui-nothing");
        exe(
            &nothing,
            "#!/bin/sh\necho 'no service dev.spacesheep.sessionpipe-gui installed: nothing to do'\nexit 5\n",
        );
        let t5 = Tools {
            cli: Some(nothing),
            ..t.clone()
        };
        assert_eq!(
            update_with_cli(&t5, "0.8.1").unwrap(),
            Updated::Nothing(
                "no service dev.spacesheep.sessionpipe-gui installed: nothing to do".into()
            )
        );
        // Exit 4: the old receiver stopped, the new one not running.
        let four = d.0.join("sessionpipe-gui-four");
        exe(
            &four,
            "#!/bin/sh\necho 'updating x: 0.7.2 → 0.8.1'\necho \"sessionpipe-gui: 0.8.1 isn't running on :7373 after 90 s, and the old receiver was stopped for the update: see ~/s/service.log\" >&2\nexit 4\n",
        );
        let t4 = Tools {
            cli: Some(four),
            ..t.clone()
        };
        let e = update_with_cli(&t4, "0.8.1").unwrap_err();
        assert!(matches!(e, StartError::NotRunning(_)));
        let f = UpdateFailure::from(&e);
        assert_eq!(
            (f.kind, f.log.as_deref()),
            ("notRunning", Some("~/s/service.log"))
        );
        let npx_only = Tools {
            cli: None,
            node: None,
            npx: Some(npx),
        };
        assert!(matches!(
            update_with_cli(&npx_only, "0.8.1"),
            Err(StartError::NoNode)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn a_timeout_stops_what_the_child_started_too() {
        let d = Temp::new("tree");
        let pidfile = d.0.join("grandchild.pid");
        let npx = d.0.join("npx");
        exe(
            &npx,
            &format!(
                "#!/bin/sh\nsleep 30 &\necho $! > {}\nwait\n",
                pidfile.display()
            ),
        );
        let inv = Invocation {
            program: npx,
            args: vec![],
            path: "/usr/bin:/bin".into(),
        };
        assert!(
            matches!(run(&inv, Duration::from_millis(600), |_| {}), Err(StartError::Failed(m)) if m.contains("didn't finish"))
        );
        let pid: u32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !discovery::pid_alive(pid),
            "the grandchild {pid} outlived the timeout"
        );
    }

    #[test]
    #[cfg(unix)]
    fn once_our_cli_has_spoken_a_timeout_stops_waiting_and_never_kills_it() {
        let _alone = alone_with_the_guard();
        let d = Temp::new("spoke");
        let done = d.0.join("finished");
        let cli = d.0.join("cli");
        exe(
            &cli,
            &format!(
                "#!/bin/sh\necho 'updating x: 0.7.2 → 0.8.1'\nsleep 1.2\ntouch {}\n",
                done.display()
            ),
        );
        let inv = Invocation {
            program: cli,
            args: vec![],
            path: "/usr/bin:/bin".into(),
        };
        assert!(matches!(
            run(&inv, Duration::from_millis(400), |_| {}),
            Err(StartError::StillRunning)
        ));
        // Busy while it finishes; nothing else may start meanwhile.
        assert!(busy());
        assert!(matches!(begin_install(), Err(StartError::Busy)));
        std::thread::sleep(Duration::from_millis(1600));
        assert!(done.exists(), "the installer was killed");
        assert!(!busy());
    }

    #[test]
    #[cfg(unix)]
    fn an_installer_the_app_stopped_waiting_for_keeps_printing_and_ends_with_its_verdict() {
        let _alone = alone_with_the_guard();
        let d = Temp::new("orphan-out");
        let done = d.0.join("ended");
        let cli = d.0.join("cli");
        // It speaks, outlives the wait, then prints on (a write to a closed pipe would kill
        // it), and ends normally with its last line.
        exe(
            &cli,
            &format!(
                "#!/bin/sh\necho 'updating x: 0.7.2 → 0.8.1'\nsleep 0.8\ni=0; while [ $i -lt 200 ]; do echo \"starting on :7373… line $i\"; i=$((i+1)); done\necho 'running 0.8.1 on http://127.0.0.1:7999 · orphan-test'\ntouch {}\nexit 0\n",
                done.display()
            ),
        );
        let inv = Invocation {
            program: cli,
            args: vec![],
            path: "/usr/bin:/bin".into(),
        };
        assert!(matches!(
            run(&inv, Duration::from_millis(300), |_| {}),
            Err(StartError::StillRunning)
        ));
        let until = Instant::now() + Duration::from_secs(5);
        while !done.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            done.exists(),
            "the installer died after the app stopped waiting"
        );
        // Its verdict: exit 0, every line, the last one intact.
        let until = Instant::now() + Duration::from_secs(5);
        let ended = loop {
            let found = ORPHAN_ENDS
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.out.contains("orphan-test"))
                .cloned();
            if let Some(r) = found {
                break r;
            }
            assert!(Instant::now() < until, "no verdict kept");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(ended.code, 0);
        assert_eq!(ended.out.lines().count(), 202);
        assert_eq!(
            ended.out.lines().last(),
            Some("running 0.8.1 on http://127.0.0.1:7999 · orphan-test")
        );
    }

    #[test]
    #[cfg(unix)]
    fn update_never_runs_a_cli_whose_version_is_unknown_or_older_and_says_so_with_nothing_to_run() {
        let d = Temp::new("update-tools");
        let ran = d.0.join("old-cli-ran");
        let cli = d.0.join("sessionpipe-gui");
        // A CLI from before this branch: no gates; if it runs, the service could move back.
        exe(
            &cli,
            &format!("#!/bin/sh\ntouch {}\necho \"cli $*\"\n", ran.display()),
        );
        let npx = d.0.join("npx");
        exe(&npx, "#!/bin/sh\necho \"npx $*\"\n");
        let with = |npx_here: bool| Tools {
            cli: Some(cli.clone()),
            node: None,
            npx: npx_here.then(|| npx.clone()),
        };
        let update = |t: &Tools, v: Option<&str>| -> Result<String, StartError> {
            let t = update_tools(t.clone(), v, "0.8.1")?;
            run_installer(
                &t,
                v,
                "0.8.1",
                ["service", "install"].map(String::from).to_vec(),
                Duration::from_secs(5),
                || false,
                |_| {},
            )
        };
        // Unknown version (its --version timed out or said nothing), or an older one, with
        // npx: npx, never the CLI.
        for v in [None, Some("0.7.2")] {
            let out = update(&with(true), v).unwrap();
            assert!(out.starts_with("npx -y --package="), "{v:?}: {out}");
        }
        // The same with no npx: nothing to run, said plainly, nothing changed.
        for v in [None, Some("0.7.2")] {
            match update(&with(false), v) {
                Err(e) => assert_eq!(
                    e.to_string(),
                    "there is no sessionpipe-gui 0.8.1 or newer here, and no npx to download it; nothing was changed"
                ),
                other => panic!("{v:?}: {other:?}"),
            }
        }
        assert!(!ran.exists(), "the old CLI ran");
        // A CLI known to be at the app's version: it may run it.
        assert_eq!(
            update(&with(false), Some("0.8.1")).unwrap().trim(),
            "cli service install"
        );
    }

    #[test]
    fn one_install_at_a_time_in_the_app() {
        let _alone = alone_with_the_guard();
        // (ORPHANS from another test may still be counted: wait for them.)
        let until = Instant::now() + Duration::from_secs(5);
        while busy() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let g = begin_install().unwrap();
        assert!(busy());
        assert!(matches!(begin_install(), Err(StartError::Busy)));
        note_progress("Updating sessionpipe 0.7.2 → 0.8.1…");
        drop(g);
        assert!(!busy());
        assert!(PROGRESS.lock().unwrap().is_none());
        drop(begin_install().unwrap());
    }

    #[test]
    fn start_falls_back_to_the_cli_on_path_only_where_that_cannot_make_the_service_older() {
        use InstalledService::{Runs, Unknown};
        let no_service = InstalledService::None;
        assert!(may_fall_back(Some("0.7.2"), &no_service));
        assert!(may_fall_back(None, &no_service));
        assert!(may_fall_back(Some("0.8.0"), &Runs("0.8.0".into())));
        assert!(!may_fall_back(Some("0.7.2"), &Runs("0.8.0".into())));
        assert!(!may_fall_back(None, &Runs("0.8.0".into())));
        assert!(!may_fall_back(Some("0.9.0"), &Unknown));
        // What `service status` says, the file it names and run.json.
        let not = "service   dev.spacesheep.sessionpipe-gui (launchd) · not installed\n          `sessionpipe-gui service install` runs the receiver at login\n";
        assert_eq!(
            installed_from(Some(not), None, |_| None, Some("0.9.0")),
            no_service
        );
        let installed = "service   dev.spacesheep.sessionpipe-gui (launchd) · stopped\nfile      ~/Library/LaunchAgents/x.plist\nport      7373\nrun.json  none (~/x/run.json)\n";
        let plist = "<array>\n\t<string>/usr/local/bin/node</string>\n\t<string>/Users/m/.npm/_npx/ab/node_modules/sessionpipe-gui/dist/cli.js</string>\n\t<string>--port</string>\n</array>";
        let at = |p: &Path| {
            p.to_string_lossy()
                .contains("_npx/ab")
                .then(|| "0.8.0".to_string())
        };
        assert_eq!(
            installed_from(Some(installed), Some(plist), at, Some("0.7.9")),
            Runs("0.8.0".into())
        );
        assert_eq!(
            installed_from(Some(installed), Some(plist), at, Some("0.8.2")),
            Runs("0.8.2".into())
        );
        let running = "service   x (launchd) · running · pid 7 · 0.8.1\nrun.json  pid 7 · 0.8.1 · since now\n";
        assert_eq!(
            installed_from(Some(running), None, |_| None, None),
            Runs("0.8.1".into())
        );
        assert_eq!(
            installed_from(Some(installed), None, |_| None, None),
            Unknown
        );
        assert_eq!(installed_from(None, None, |_| None, Some("0.8.0")), Unknown);
        // A systemd unit's ExecStart, quoted words and all.
        let unit = "[Service]\nExecStart=\"/usr/bin/node\" \"/home/m/.local/lib/node_modules/sessionpipe-gui/dist/cli.js\" \"--port\" \"7373\"\n";
        assert_eq!(
            clis_in_service_file(unit),
            [PathBuf::from(
                "/home/m/.local/lib/node_modules/sessionpipe-gui/dist/cli.js"
            )]
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
            env_receiver_url: Some(url.into()),
            user_agent: "sp-supervisor-test".into(),
            ..sp_receivers::HubConfig::new(home.to_path_buf(), sp_receivers::KeyStore::memory())
        })
    }

    fn receiver_answering(version: &'static str, started_at: &'static str) -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = format!(
                    r#"{{"name":"sessionpipe-gui","version":"{version}","startedAt":"{started_at}"}}"#
                );
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
    fn checks_this_computer_s_receiver_and_acts_only_on_an_older_one() {
        let _alone = alone_with_the_guard();
        let d = Temp::new("check");
        // Its info says 0.8.0 (its package was replaced under it); it started as 0.7.2.
        let port = receiver_answering("0.8.0", "2026-11-12T10:00:00.000Z");
        let origin = format!("http://127.0.0.1:{port}");
        let hub = hub_for(&origin, &d.0);
        let r = hub.active().unwrap();
        let state = d.0.join("state");
        std::fs::create_dir_all(&state).unwrap();
        let run_json = |version: &str| {
            std::fs::write(
                state.join("run.json"),
                format!(
                    r#"{{"port":{port},"pid":{},"version":"{version}","url":"{origin}","startedAt":"2026-11-12T10:00:02.000Z"}}"#,
                    std::process::id()
                ),
            )
            .unwrap()
        };
        type Up = fn(&Tools, &str) -> Result<Updated, StartError>;
        type Find = fn() -> (Tools, Option<String>);
        let check = |tools: Find, update: Up| {
            tauri::async_runtime::block_on(check_local(&hub, &r, &state, "0.8.1", tools, update))
        };
        fn current_cli() -> (Tools, Option<String>) {
            (
                Tools {
                    cli: Some("/c/sessionpipe-gui".into()),
                    ..Tools::default()
                },
                Some("0.8.1".into()),
            )
        }
        fn older_cli() -> (Tools, Option<String>) {
            (
                Tools {
                    cli: Some("/c/sessionpipe-gui".into()),
                    npx: Some("/n/npx".into()),
                    ..Tools::default()
                },
                Some("0.7.2".into()),
            )
        }
        fn unasked() -> (Tools, Option<String>) {
            panic!("the CLI looked for although the receiver isn't older")
        }
        fn ok(t: &Tools, app: &str) -> Result<Updated, StartError> {
            assert_eq!(app, "0.8.1");
            assert!(t.cli.is_some());
            Ok(Updated::Done)
        }
        fn nothing(_: &Tools, _: &str) -> Result<Updated, StartError> {
            Ok(Updated::Nothing(
                "no service x installed: nothing to do".into(),
            ))
        }
        fn exit4(_: &Tools, _: &str) -> Result<Updated, StartError> {
            Err(StartError::NotRunning("0.8.1 isn't running on :7373 after 90 s, and the old receiver was stopped for the update: see ~/x".into()))
        }
        fn never(_: &Tools, _: &str) -> Result<Updated, StartError> {
            panic!("the background update ran where it mustn't")
        }
        // No run.json naming it: not this computer's, never touched.
        assert_eq!(check(unasked, never), None);
        run_json("0.7.2");
        // The CLI ran and did nothing (exit 5): said as that, not as an update.
        let u = check(current_cli, nothing).unwrap();
        assert_eq!(
            (u.state, u.why.as_deref()),
            (
                UpdateState::Unchanged,
                Some("no service x installed: nothing to do")
            )
        );
        run_json("0.7.2");
        let u = check(current_cli, ok).unwrap();
        assert_eq!(
            (u.running.as_str(), u.state),
            ("0.7.2", UpdateState::Updated)
        );
        // A failure after the old receiver was stopped is a failure, with its line.
        let u = check(current_cli, exit4).unwrap();
        assert_eq!(u.state, UpdateState::Failed);
        assert!(u.why.unwrap().contains("the old receiver was stopped"));
        // Only npx would bring it current: nothing runs; the page is told a click is needed.
        let u = check(older_cli, never).unwrap();
        assert_eq!(
            (u.running.as_str(), u.state, u.app.as_str()),
            ("0.7.2", UpdateState::Click, "0.8.1")
        );
        assert_eq!(u.origin, origin);
        run_json("0.8.1");
        // run.json says 0.8.1 but the info 0.8.0: the info older is enough.
        assert_eq!(check(older_cli, never).unwrap().state, UpdateState::Click);
        run_json("0.9.1");
        let port2 = receiver_answering("0.9.1", "2026-11-12T10:00:00.000Z");
        let hub2 = hub_for(&format!("http://127.0.0.1:{port2}"), &d.0);
        let r2 = hub2.active().unwrap();
        std::fs::write(
            state.join("run.json"),
            format!(
                r#"{{"port":{port2},"pid":{},"version":"0.9.1","url":"http://127.0.0.1:{port2}","startedAt":"2026-11-12T10:00:02.000Z"}}"#,
                std::process::id()
            ),
        )
        .unwrap();
        let u = tauri::async_runtime::block_on(check_local(
            &hub2, &r2, &state, "0.8.1", unasked, never,
        ))
        .unwrap();
        assert_eq!(u.state, UpdateState::Current);
    }

    /// A server on loopback that answers as an OLDER receiver would (`/api/ui/info`) and
    /// as a spacesheep would (its machines door), and keeps every request line it was
    /// sent.
    fn answering_as_both() -> (u16, std::sync::Arc<Mutex<Vec<String>>>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = head.lines().next().unwrap_or("").to_string();
                let body = if line.contains("/api/ui/info") {
                    r#"{"name":"sessionpipe-gui","version":"0.7.2","startedAt":"2026-11-12T10:00:00.000Z"}"#
                } else {
                    r#"{"machines":[],"rp_id":"127.0.0.1"}"#
                };
                log.lock().unwrap().push(line);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (port, seen)
    }

    /// A spacesheep account in the Hub's list is never this computer's receiver: not
    /// picked by the launch check, not asked `/api/ui/info`, and nothing is installed or
    /// updated for it. Here everything else says "local and old": the account lives on
    /// loopback, run.json names its very address with a live pid and an older version,
    /// the server there would answer a receiver's info with that older version, and the
    /// account is connected with its key. A plain receiver at the same address, with the
    /// same run.json, IS checked: it is the account that makes the difference.
    #[test]
    fn a_spacesheep_account_is_never_this_computer_s_receiver() {
        let d = Temp::new("account");
        let (port, seen) = answering_as_both();
        let origin = format!("http://127.0.0.1:{port}");
        let id = sp_receivers::id::account_id(&origin, "misha@example.com");
        let entry = |local: bool| {
            serde_json::json!({
                "id": id, "name": "127.0.0.1", "origin": origin, "local": local,
                "kind": "spacesheep",
                "account": { "email": "misha@example.com", "connectedAt": "2026-11-12T08:00:00.000Z" }
            })
        };
        let home = |tag: &str, local: bool| {
            let home = d.0.join(tag);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("receivers.json"),
                serde_json::json!({ "receivers": [entry(local)], "active": id }).to_string(),
            )
            .unwrap();
            std::fs::write(
                home.join("account-keys.json"),
                serde_json::json!({
                    sp_receivers::registry::account_key_name(&id):
                        sp_receivers::account::kept_key(&origin, "ss_test-key-0123456789abcdef")
                })
                .to_string(),
            )
            .unwrap();
            home
        };
        // A Hub with the account mode ON (the phones' today), so that nothing here rests
        // on the desktop having it off.
        let hub_at = |home: &Path| {
            Hub::new(sp_receivers::HubConfig {
                account: sp_receivers::AccountConfig {
                    enabled: true,
                    keys: sp_receivers::KeyStore::File(home.join("account-keys.json")),
                    allow_local_http: true,
                    ..Default::default()
                },
                ..sp_receivers::HubConfig::new(home.to_path_buf(), sp_receivers::KeyStore::memory())
            })
        };
        let hub = hub_at(&home("hub", false));
        let r = hub.active().expect("the account is the active entry");
        assert!(
            r.account.is_some() && !r.local,
            "an account, and never local"
        );
        assert_eq!(r.origin, origin);

        // It is connected: the signer's question reaches it, through its machines door.
        // (That is the one thing a Hub ever asks an account when asked for "info".)
        let info = tauri::async_runtime::block_on(hub.get(&r.id, "/api/ui/info")).unwrap();
        assert!(String::from_utf8_lossy(&info).contains(r#""rpId":"127.0.0.1""#));
        assert!(hub.is_connected(&r.id));
        let asked = || seen.lock().unwrap().clone();
        assert_eq!(asked().len(), 1);
        assert!(asked()[0].starts_with("GET /api/sessionpipe/v1/relay/machines "));

        // run.json names its address, alive, as an older version than the app.
        let state = d.0.join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            state.join("run.json"),
            format!(
                r#"{{"port":{port},"pid":{},"version":"0.7.2","url":"{origin}","startedAt":"2026-11-12T10:00:02.000Z"}}"#,
                std::process::id()
            ),
        )
        .unwrap();
        fn unasked() -> (Tools, Option<String>) {
            panic!("the CLI was looked for on a spacesheep account's behalf")
        }
        fn never(_: &Tools, _: &str) -> Result<Updated, StartError> {
            panic!("service install ran for a spacesheep account")
        }
        fn older_cli() -> (Tools, Option<String>) {
            (
                Tools {
                    cli: Some("/c/sessionpipe-gui".into()),
                    npx: Some("/n/npx".into()),
                    ..Tools::default()
                },
                Some("0.7.2".into()),
            )
        }

        // Not picked as the local receiver: as the Hub lists it, connected or not…
        assert_eq!(
            first_local(&hub.receivers(), |id| hub.is_connected(id)),
            None
        );
        assert_eq!(first_local(&hub.receivers(), |_| true), None);
        // …and not even were a row to say `local` of it (the Hub never does).
        let claims_local = ReceiverRef {
            local: true,
            ..r.clone()
        };
        assert_eq!(
            first_local(std::slice::from_ref(&claims_local), |_| true),
            None
        );
        // Not checked, either way: no CLI looked for, no install, and nothing asked of it.
        for row in [&r, &claims_local] {
            let checked = tauri::async_runtime::block_on(check_local(
                &hub, row, &state, "0.8.1", unasked, never,
            ));
            assert_eq!(checked, None);
        }
        assert_eq!(
            asked().len(),
            1,
            "nothing was asked of the account: {:?}",
            asked()
        );
        assert!(!asked().iter().any(|l| l.contains("/api/ui/")));
        assert!(local_update().is_none_or(|u| u.origin != origin));

        // An entry rewritten to say the account is local is not an entry at all: the
        // Hub lists nothing, so there is nothing to pick.
        let tampered = hub_at(&home("tampered", true));
        assert!(tampered.receivers().is_empty() && tampered.active().is_none());
        assert_eq!(first_local(&tampered.receivers(), |_| true), None);

        // The same address as a plain receiver, with the same run.json, is this
        // computer's receiver: asked its info, found older, and waiting for a click.
        let plain_hub = hub_for(&origin, &d.0.join("plain"));
        let plain = plain_hub.active().unwrap();
        assert!(plain.local && plain.account.is_none());
        assert_eq!(
            first_local(&plain_hub.receivers(), |_| true).map(|p| p.id),
            Some(plain.id.clone())
        );
        let u = tauri::async_runtime::block_on(check_local(
            &plain_hub, &plain, &state, "0.8.1", older_cli, never,
        ))
        .expect("a receiver here is checked");
        assert_eq!((u.running.as_str(), u.state), ("0.7.2", UpdateState::Click));
        assert!(asked().iter().any(|l| l.starts_with("GET /api/ui/info ")));
    }

    /// The real thing against a service on a scratch label (stale-server e2e bed): a
    /// receiver started as an older version from `SP_STALE_CLI`'s path, whose package was
    /// then replaced there with `SP_STALE_APP`. Run with SP_SERVICE_LABEL, SP_LAUNCHCTL
    /// (a stand-in), HOME and the SP_STALE_* variables set:
    /// `cargo test -p sessionpipe-desktop live_brings -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_brings_an_older_service_up_to_the_app() {
        let _alone = alone_with_the_guard();
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} unset"));
        assert_ne!(var("SP_SERVICE_LABEL"), "dev.spacesheep.sessionpipe-gui");
        assert!(!var("SP_LAUNCHCTL").is_empty());
        let d = Temp::new("live-update");
        let hub = hub_for(&var("SP_STALE_URL"), &d.0);
        let r = hub.active().unwrap();
        let state = PathBuf::from(var("SP_STALE_STATE"));
        fn here() -> (Tools, Option<String>) {
            let t = Tools {
                cli: std::env::var_os("SP_STALE_CLI").map(PathBuf::from),
                node: std::env::var_os("SP_STALE_NODE").map(PathBuf::from),
                npx: None,
            };
            let v = cli_version(&t);
            eprintln!("the CLI here says {v:?}");
            (t, v)
        }
        fn update(t: &Tools, app: &str) -> Result<Updated, StartError> {
            let out = update_with_cli(t, app);
            eprintln!("{out:?}");
            out
        }
        let app = var("SP_STALE_APP");
        let got = tauri::async_runtime::block_on(check_local(&hub, &r, &state, &app, here, update));
        eprintln!("checked: {got:?}");
        let want = std::env::var("SP_STALE_WANT").unwrap_or_else(|_| "updated".into());
        let got = got.expect("this computer's receiver");
        assert_eq!(
            serde_json::to_value(got.state).unwrap(),
            serde_json::json!(want),
            "{got:?}"
        );
        if want == "updated" {
            let run = discovery::read_run_file(&state).unwrap();
            eprintln!("run.json now: pid {} started as {}", run.pid, run.version);
            assert_eq!(run.version, app);
            // Once current, the next check leaves it.
            let again =
                tauri::async_runtime::block_on(check_local(&hub, &r, &state, &app, here, update))
                    .unwrap();
            assert_eq!(again.state, UpdateState::Current);
        }
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
