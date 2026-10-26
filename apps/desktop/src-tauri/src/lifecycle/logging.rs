//! `<logs>/shell.log`, rotated at 1 MB, three files kept (shell.log, .1, .2): NATIVE-SPEC
//! §4 "Shell crash". No crash reporter and no telemetry: panics and errors go here and
//! nowhere else. `<logs>` is `$SP_SHELL_HOME/logs` when set (dev), else the app's log dir
//! (`~/Library/Logs/<identifier>` on macOS).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_BYTES: u64 = 1024 * 1024;
pub const KEEP: usize = 3;
pub const FILE: &str = "shell.log";

pub struct RotatingFile {
    dir: PathBuf,
    max: u64,
    keep: usize,
    inner: Mutex<Option<(File, u64)>>,
}

impl RotatingFile {
    pub fn new(dir: &Path, max: u64, keep: usize) -> std::io::Result<Self> {
        fs::create_dir_all(dir)?;
        let f = RotatingFile {
            dir: dir.to_path_buf(),
            max,
            keep: keep.max(1),
            inner: Mutex::new(None),
        };
        f.open()?;
        Ok(f)
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    fn nth(&self, n: usize) -> PathBuf {
        if n == 0 {
            self.path()
        } else {
            self.dir.join(format!("{FILE}.{n}"))
        }
    }

    fn open(&self) -> std::io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path())?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        *self.inner.lock().unwrap() = Some((file, len));
        Ok(())
    }

    /// shell.log.1 → .2 (the oldest dropped), shell.log → .1, a fresh shell.log.
    fn rotate(&self, slot: &mut Option<(File, u64)>) {
        *slot = None;
        for n in (1..self.keep).rev() {
            let _ = fs::rename(self.nth(n - 1), self.nth(n));
        }
        if self.keep == 1 {
            let _ = fs::remove_file(self.path());
        }
        if let Ok(f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path())
        {
            *slot = Some((f, 0));
        }
    }

    pub fn write_line(&self, line: &str) {
        let mut g = self.inner.lock().unwrap();
        let need = line.len() as u64 + 1;
        if g.as_ref()
            .is_none_or(|(_, len)| *len > 0 && len + need > self.max)
        {
            self.rotate(&mut g);
        }
        if let Some((f, len)) = g.as_mut() {
            if writeln!(f, "{line}").is_ok() {
                *len += need;
            }
        }
    }
}

/// Lines logged before the log dir is known (between `install` and `set_dir`), bounded.
const EARLY_MAX: usize = 200;

struct Logger {
    file: Mutex<Option<RotatingFile>>,
    early: Mutex<Vec<String>>,
    /// Echo to stderr: debug builds, or RUST_LOG=info|debug.
    echo: log::LevelFilter,
}

impl Logger {
    fn write(&self, line: String) {
        if let Some(f) = self.file.lock().unwrap().as_ref() {
            f.write_line(&line);
            return;
        }
        let mut e = self.early.lock().unwrap();
        if e.len() < EARLY_MAX {
            e.push(line);
        }
    }
}

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        let ours = m.target().starts_with("sessionpipe") || m.target().starts_with("sp_");
        // Ours from info up; dependencies' chatter only from warn up.
        m.level()
            <= if ours {
                log::Level::Info
            } else {
                log::Level::Warn
            }
            || m.level() <= self.echo
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let line = format!(
            "{} {:5} {}: {}",
            sp_receivers::status::iso_now(),
            r.level(),
            r.target(),
            r.args()
        );
        if r.level() <= self.echo {
            eprintln!("{line}");
        }
        let ours = r.target().starts_with("sessionpipe") || r.target().starts_with("sp_");
        if r.level()
            <= if ours {
                log::Level::Info
            } else {
                log::Level::Warn
            }
        {
            self.write(line);
        }
    }
    fn flush(&self) {}
}

static LOGGER: std::sync::OnceLock<&'static Logger> = std::sync::OnceLock::new();

/// Where the log goes: SP_SHELL_HOME/logs, else the platform's log dir for the app.
pub fn log_dir(app_log_dir: Option<PathBuf>) -> Option<PathBuf> {
    match std::env::var_os("SP_SHELL_HOME").filter(|s| !s.is_empty()) {
        Some(h) => Some(PathBuf::from(h).join("logs")),
        None => app_log_dir,
    }
}

/// The process's logger, installed first thing in `run()` (before Tauri, so nothing is
/// lost): stderr per RUST_LOG (always in debug builds), and shell.log once `set_dir` names
/// the folder. Panics are logged too (release builds abort on panic, so the log is the only
/// trace). Calling it twice is harmless.
pub fn install() {
    let echo = match std::env::var("RUST_LOG").as_deref() {
        Ok("debug") => log::LevelFilter::Debug,
        Ok("info") => log::LevelFilter::Info,
        _ if cfg!(debug_assertions) => log::LevelFilter::Info,
        _ => log::LevelFilter::Warn,
    };
    let logger: &'static Logger = Box::leak(Box::new(Logger {
        file: Mutex::new(None),
        early: Mutex::new(Vec::new()),
        echo,
    }));
    if log::set_logger(logger).is_err() {
        return;
    }
    let _ = LOGGER.set(logger);
    log::set_max_level(log::LevelFilter::Debug);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(target: "sessionpipe::panic", "{info}");
        previous(info);
    }));
}

/// Opens `<dir>/shell.log` and writes what was logged before it. Returns its path.
pub fn set_dir(dir: &Path) -> Option<PathBuf> {
    let logger = LOGGER.get()?;
    let file = RotatingFile::new(dir, MAX_BYTES, KEEP).ok()?;
    for l in logger.early.lock().unwrap().drain(..) {
        file.write_line(&l);
    }
    let path = file.path();
    *logger.file.lock().unwrap() = Some(file);
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sp-log-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn rotates_at_the_limit_and_keeps_three() {
        let d = temp("rot");
        let f = RotatingFile::new(&d, 100, 3).unwrap();
        let line = "x".repeat(39); // 40 bytes with the newline
        for i in 0..20 {
            f.write_line(&format!("{line}{}", i % 10));
        }
        let mut names: Vec<String> = fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["shell.log", "shell.log.1", "shell.log.2"]);
        for n in &names {
            assert!(
                fs::metadata(d.join(n)).unwrap().len() <= 100,
                "{n} over the limit"
            );
        }
        // The newest line is in shell.log.
        assert!(fs::read_to_string(d.join("shell.log"))
            .unwrap()
            .ends_with(&format!("{line}9\n")));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn appends_across_restarts_and_rotates_a_full_file_on_open() {
        let d = temp("reopen");
        RotatingFile::new(&d, 100, 3).unwrap().write_line("first");
        let f = RotatingFile::new(&d, 100, 3).unwrap();
        f.write_line("second");
        assert_eq!(
            fs::read_to_string(d.join("shell.log")).unwrap(),
            "first\nsecond\n"
        );
        fs::write(d.join("shell.log"), "y".repeat(150)).unwrap();
        let f = RotatingFile::new(&d, 100, 3).unwrap();
        f.write_line("third");
        assert_eq!(fs::read_to_string(d.join("shell.log")).unwrap(), "third\n");
        assert_eq!(fs::metadata(d.join("shell.log.1")).unwrap().len(), 150);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn dev_home_wins() {
        // Read-only check of the rule; the env is process-global, so only the None case.
        if std::env::var_os("SP_SHELL_HOME").is_none() {
            assert_eq!(log_dir(Some("/l".into())), Some(PathBuf::from("/l")));
        }
    }
}
