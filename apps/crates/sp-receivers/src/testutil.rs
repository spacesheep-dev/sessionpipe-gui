//! Test helpers: a temp dir that cleans up, and a tiny HTTP server.

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
