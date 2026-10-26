//! Integration tests against a real demo receiver. Ignored by default; run with the
//! shell's demo receiver up:
//!
//! ```sh
//! node dist/cli.js --demo --test-door --no-outbox --host 127.0.0.1 --quiet --port 7811 \
//!   --state "$(mktemp -d)"
//! SP_LIVE_URL=http://127.0.0.1:7811 cargo test -p sp-receivers --test live -- --ignored
//! ```

use sp_receivers::{proxy, Hub, HubConfig, HubEvent, KeyStore, StatusFile};
use std::time::{Duration, Instant};

fn live_url() -> String {
    std::env::var("SP_LIVE_URL").unwrap_or_else(|_| "http://127.0.0.1:7811".into())
}

fn hub(tag: &str, status: Option<std::path::PathBuf>) -> (Hub, std::path::PathBuf) {
    let home = std::env::temp_dir().join(format!("sp-live-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let h = Hub::new(HubConfig {
        home: home.clone(),
        keys: KeyStore::memory(),
        env_receiver_url: Some(live_url()),
        allowed_origins: proxy::default_allowed_origins(None),
        status: StatusFile::new(status, "live"),
        user_agent: "sp-live-test".into(),
    });
    (h, home)
}

#[tokio::test]
#[ignore]
async fn rx_proxies_ui_info() {
    let (h, home) = hub("info", None);
    let id = h.active().unwrap().id;
    let req = http::Request::builder()
        .uri(format!("rx://localhost/{id}/api/ui/info"))
        .header("origin", "tauri://localhost")
        .body(Vec::new())
        .unwrap();
    let res = h.proxy(req).await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["access-control-allow-origin"],
        "tauri://localhost"
    );
    assert!(res.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    let v: serde_json::Value = serde_json::from_slice(res.body()).unwrap();
    assert_eq!(v["name"], "sessionpipe-gui");
    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test]
#[ignore]
async fn the_stream_yields_a_snapshot_within_a_second() {
    let (h, home) = hub("snap", None);
    let id = h.active().unwrap().id;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let t = Instant::now();
    let sid = h
        .open_stream(&id, "/api/ui/stream", "test", move |f| tx.send(f).is_ok())
        .unwrap();
    let mut events = vec![];
    while let Ok(Some(f)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
        events.push(f.event.clone());
        if f.event == "snapshot" {
            let v: serde_json::Value = serde_json::from_str(f.data.as_deref().unwrap()).unwrap();
            assert!(v["snapshot"]["sessions"]
                .as_array()
                .is_some_and(|s| !s.is_empty()));
            break;
        }
    }
    assert_eq!(events.first().map(String::as_str), Some("open"));
    assert_eq!(
        events.last().map(String::as_str),
        Some("snapshot"),
        "{events:?}"
    );
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    eprintln!("snapshot after {:?}", t.elapsed());
    assert!(h.close_stream(sid));
    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn the_demo_needs_you_count_changes_within_60_s() {
    let status = std::env::temp_dir().join(format!("sp-live-status-{}.json", std::process::id()));
    let (h, home) = hub("needs", Some(status.clone()));
    let mut events = h.subscribe();
    h.start(tokio::runtime::Handle::current());
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut first: Option<usize> = None;
    let mut connected = false;
    let mut closed = 0;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let Ok(Ok(ev)) = tokio::time::timeout(left, events.recv()).await else {
            break;
        };
        match ev {
            HubEvent::Connected { .. } => connected = true,
            HubEvent::AttentionClosed { .. } => closed += 1,
            HubEvent::NeedsYou { items, .. } => match first {
                None => {
                    first = Some(items.len());
                    eprintln!("needs-you at start: {}", items.len());
                }
                Some(n) if n != items.len() => {
                    eprintln!(
                        "needs-you changed {n} → {} (attentions closed so far: {closed})",
                        items.len()
                    );
                    let doc: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(&status).unwrap()).unwrap();
                    assert_eq!(doc["needsYou"], items.len());
                    assert_eq!(doc["receivers"][0]["connected"], true);
                    let _ = std::fs::remove_dir_all(home);
                    let _ = std::fs::remove_file(status);
                    return;
                }
                _ => {}
            },
            _ => {}
        }
    }
    panic!("no change in 60 s (connected: {connected}, first: {first:?})");
}
