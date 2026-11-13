//! Test helpers: a temp dir that cleans up, a tiny HTTP server, and every log line the
//! crate wrote (to check that a secret is in none of them).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "sp-receivers-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A request as the fake server saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub head: String,
    pub body: Vec<u8>,
}

impl Seen {
    /// `GET`, `POST`…
    pub fn method(&self) -> &str {
        self.head.split(' ').next().unwrap_or("")
    }
    /// The path and query of the request line.
    pub fn target(&self) -> &str {
        self.head.split(' ').nth(1).unwrap_or("")
    }
    /// A header's value (any case), when it was sent.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

/// A reply with headers of its own, optionally late, optionally without saying its length.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Option<std::time::Duration>,
    /// No `Content-Length`: the body ends when the connection does.
    pub unsized_body: bool,
}

impl Reply {
    pub fn json(status: u16, body: impl Into<Vec<u8>>) -> Reply {
        Reply {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.into(),
            delay: None,
            unsized_body: false,
        }
    }
    /// A status and nothing else (a 204).
    pub fn empty(status: u16) -> Reply {
        Reply {
            status,
            headers: vec![],
            body: vec![],
            delay: None,
            unsized_body: false,
        }
    }
    pub fn no_length(mut self) -> Reply {
        self.unsized_body = true;
        self
    }
    pub fn header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.into(), value.into()));
        self
    }
    pub fn after(mut self, d: std::time::Duration) -> Reply {
        self.delay = Some(d);
        self
    }
}

/// `serve`, with the reply's own headers (a redirect, a `Retry-After`, a cookie).
pub async fn serve_replies<F>(reply: F) -> u16
where
    F: Fn(&Seen) -> Reply + Send + Sync + 'static,
{
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let reply = std::sync::Arc::new(reply);
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else {
                return;
            };
            let reply = reply.clone();
            tokio::spawn(async move {
                let Some(seen) = read_request(&mut s).await else {
                    return;
                };
                let r = reply(&seen);
                if let Some(d) = r.delay {
                    tokio::time::sleep(d).await;
                }
                let mut head = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", r.status);
                if !r.unsized_body {
                    head.push_str(&format!("content-length: {}\r\n", r.body.len()));
                }
                for (k, v) in &r.headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                head.push_str("\r\n");
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(&r.body).await;
                let _ = s.shutdown().await;
            });
        }
    });
    port
}

async fn read_request(s: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let len: usize = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse().unwrap_or(0))
        })
        .unwrap_or(0);
    while buf.len() < head_end + len {
        let n = s.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    Some(Seen {
        head,
        body: buf[head_end..].to_vec(),
    })
}

struct Capture;

static LINES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        LINES
            .lock()
            .unwrap()
            .push(format!("{} {}", record.level(), record.args()));
    }
    fn flush(&self) {}
}

/// Every line logged in this process from the first call on, at every level. Tests run
/// side by side, so a test looks for its own secrets in all of them.
pub fn logged() -> Vec<String> {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = log::set_logger(&Capture);
        log::set_max_level(log::LevelFilter::Trace);
    });
    LINES.lock().unwrap().clone()
}

/// Serves `body` as JSON to every request, forever, on an ephemeral loopback port.
pub async fn serve_once_forever(body: &'static str) -> u16 {
    serve(
        move |_| (200, "application/json", body.as_bytes().to_vec()),
        None,
    )
    .await
}

/// A loopback server: `reply(seen) -> (status, content-type, body)`. Every request is
/// also sent to `log` when given.
pub async fn serve<F>(reply: F, log: Option<tokio::sync::mpsc::UnboundedSender<Seen>>) -> u16
where
    F: Fn(&Seen) -> (u16, &'static str, Vec<u8>) + Send + Sync + 'static,
{
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let reply = std::sync::Arc::new(reply);
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else {
                return;
            };
            let reply = reply.clone();
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    let Ok(n) = s.read(&mut tmp).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap_or(0))
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + len {
                    let Ok(n) = s.read(&mut tmp).await else {
                        return;
                    };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let seen = Seen {
                    head,
                    body: buf[head_end..].to_vec(),
                };
                if let Some(l) = &log {
                    let _ = l.send(seen.clone());
                }
                let (status, ct, body) = reply(&seen);
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: {ct}\r\ncontent-length: {}\r\nx-secret: no\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.write_all(&body).await;
                let _ = s.shutdown().await;
            });
        }
    });
    port
}
