//! The menu bar item (NATIVE-SPEC.md §3.2) and what follows needs-you live: the Dock
//! badge (§3.3) and notifications (§3.4). Runs with or without a window.

use crate::Shell;
use sp_receivers::{HubEvent, NeedsYouItem, ReceiverRef};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "sessionpipe";
pub const MAX_ROWS: usize = 5;
/// A stale number is worse than none: the badge clears after this long with no receiver.
pub const BADGE_STALE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// `open:<receiver id>|<harness>|<session id>`
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    /// The count beside the icon: only when above 0.
    pub title: Option<String>,
    /// Disconnected from every receiver: dimmed, no number.
    pub dimmed: bool,
    pub rows: Vec<Row>,
    /// "and N more…"
    pub more: usize,
    /// Receivers that can't be reached, by name.
    pub unreachable: Vec<String>,
    pub update: Option<String>,
    pub hotkey: Option<String>,
    pub paused: bool,
}

/// One row's text: title, the machine when there are several receivers, then what it needs.
fn row_label(i: &NeedsYouItem, multi: bool, receivers: &[(ReceiverRef, bool)]) -> String {
    let title = crate::tools::one_line(&i.display_title(), 42);
    let what = crate::tools::item_short(i);
    if multi {
        let name = receivers
            .iter()
            .find(|(r, _)| r.id == i.receiver)
            .map(|(r, _)| r.name.as_str())
            .unwrap_or("");
        format!("{title}  ·  {name}\t{what}")
    } else {
        format!("{title}\t{what}")
    }
}

pub fn model(
    items: &[NeedsYouItem],
    receivers: &[(ReceiverRef, bool)],
    update: Option<&str>,
    hotkey: Option<&str>,
    paused: bool,
) -> Model {
    let connected = receivers.iter().any(|(_, c)| *c);
    let multi = receivers.len() > 1;
    let n = items.len();
    Model {
        title: (connected && n > 0).then(|| n.to_string()),
        dimmed: !connected,
        rows: items
            .iter()
            .take(MAX_ROWS)
            .map(|i| Row {
                id: format!("open:{}|{}|{}", i.receiver, i.harness, i.id),
                label: row_label(i, multi, receivers),
            })
            .collect(),
        more: n.saturating_sub(MAX_ROWS),
        unreachable: receivers
            .iter()
            .filter(|(_, c)| !c)
            .map(|(r, _)| {
                if r.local {
                    "This Mac".to_string()
                } else {
                    r.name.clone()
                }
            })
            .collect(),
        update: update.map(str::to_string),
        hotkey: hotkey.map(str::to_string),
        paused,
    }
}

/// "Control+Alt+N" → the menu accelerator string Tauri takes ("Ctrl+Alt+N").
fn accel(h: &str) -> String {
    h.replace("Control", "Ctrl")
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, m: &Model) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if !m.rows.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "hdr",
            "Needs You",
            false,
            None::<&str>,
        )?)?;
        for r in &m.rows {
            menu.append(&MenuItem::with_id(
                app,
                &r.id,
                &r.label,
                true,
                None::<&str>,
            )?)?;
        }
        if m.more > 0 {
            menu.append(&MenuItem::with_id(
                app,
                "open:inbox",
                format!("and {} more…", m.more),
                true,
                None::<&str>,
            )?)?;
        }
    } else if m.unreachable.is_empty() || !m.dimmed {
        menu.append(&MenuItem::with_id(
            app,
            "none",
            "Nothing needs you",
            false,
            None::<&str>,
        )?)?;
    }
    for name in &m.unreachable {
        menu.append(&MenuItem::with_id(
            app,
            "unreachable",
            format!("Can't reach {name}"),
            false,
            None::<&str>,
        )?)?;
    }
    if !m.unreachable.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "retry",
            "Retry",
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open",
        "Open sessionpipe",
        true,
        Some("CmdOrCtrl+O"),
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "new-session",
        "New Session…",
        true,
        m.hotkey.as_deref().map(accel).as_deref(),
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let pause = if m.paused {
        Submenu::with_items(
            app,
            "Pause Notifications",
            true,
            &[&MenuItem::with_id(
                app,
                "pause:resume",
                "Resume",
                true,
                None::<&str>,
            )?],
        )?
    } else {
        Submenu::with_items(
            app,
            "Pause Notifications",
            true,
            &[
                &MenuItem::with_id(app, "pause:hour", "For 1 Hour", true, None::<&str>)?,
                &MenuItem::with_id(app, "pause:tomorrow", "Until Tomorrow", true, None::<&str>)?,
            ],
        )?
    };
    menu.append(&pause)?;
    if let Some(v) = &m.update {
        menu.append(&MenuItem::with_id(
            app,
            "update:restart",
            format!("Restart to Update to {v}"),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "settings",
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit sessionpipe",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    Ok(menu)
}

/// A template image: a ring with a dot (placeholder until packaging's
/// icons/tray-template.png lands), 18 pt at 2×.
fn placeholder_icon() -> tauri::image::Image<'static> {
    let s = 36usize;
    let mut px = vec![0u8; s * s * 4];
    let c = (s as f32 - 1.0) / 2.0;
    for y in 0..s {
        for x in 0..s {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let ring = (d - 13.0).abs() < 2.2;
            let dot = d < 5.0;
            if ring || dot {
                let i = (y * s + x) * 4;
                px[i + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(px, s as u32, s as u32)
}

fn tray_icon() -> tauri::image::Image<'static> {
    // packaging's template image, when it is in icons/ at build time (build.rs).
    #[cfg(tray_template)]
    if let Ok(i) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))
    {
        return i.to_owned();
    }
    placeholder_icon()
}

pub fn current_model<R: Runtime>(app: &AppHandle<R>) -> Model {
    let shell = app.state::<Shell>();
    // A receiver on its first try counts as reachable until that try fails.
    let rx: Vec<(ReceiverRef, bool)> = shell
        .hub
        .receivers()
        .into_iter()
        .map(|r| {
            let up = !shell.hub.is_unreachable(&r.id);
            (r, up)
        })
        .collect();
    let s = shell.settings();
    let paused = crate::settings::paused(&s.notifications, &sp_receivers::status::iso_now());
    let update = shell.update.lock().unwrap().ready_version();
    model(
        &shell.hub.needs_you(),
        &rx,
        update.as_deref(),
        s.hotkey.as_deref(),
        paused,
    )
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let m = current_model(app);
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon())
        .icon_as_template(true)
        .tooltip("sessionpipe")
        .menu(&build_menu(app, &m)?)
        .show_menu_on_left_click(true)
        // Its items reach the app-wide menu handler (menu.rs), which passes them on.
        .build(app)?;
    apply(app, &m);
    Ok(())
}

pub fn uninstall<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.remove_tray_by_id(TRAY_ID);
}

fn apply<R: Runtime>(app: &AppHandle<R>, m: &Model) {
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_title(m.title.as_deref());
        if let Ok(menu) = build_menu(app, m) {
            let _ = t.set_menu(Some(menu));
        }
        #[cfg(target_os = "macos")]
        crate::macos::set_tray_dimmed(&t, m.dimmed);
    }
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let m = current_model(app);
    if cfg!(debug_assertions) {
        // Evidence for the menu bar item when macOS hides it on a crowded menu bar.
        static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
        let rows: Vec<&str> = m.rows.iter().map(|r| r.label.as_str()).collect();
        let line = format!(
            "tray: title={:?} dimmed={} rows={:?} more={} unreachable={:?} update={:?}",
            m.title, m.dimmed, rows, m.more, m.unreachable, m.update
        );
        let mut last = LAST.lock().unwrap();
        if *last != line {
            eprintln!("[shell] {line}");
            *last = line;
        }
    }
    let h = app.clone();
    let _ = app.run_on_main_thread(move || apply(&h, &m));
}

pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let shell = app.state::<Shell>();
    match id {
        "open" => crate::actions::show(app),
        "new-session" => crate::actions::new_session(app, None),
        "settings" => crate::actions::menu_action(app, "settings"),
        "quit" => app.exit(0),
        "retry" => shell.hub.reconnect_all(),
        "open:inbox" => crate::actions::navigate(app, "/inbox"),
        "update:restart" => crate::updater::restart(app.clone()),
        p if p.starts_with("pause:") => {
            let until = match p {
                "pause:hour" => Some(sp_receivers::status::iso(
                    std::time::SystemTime::now() + Duration::from_secs(3600),
                )),
                "pause:tomorrow" => Some(tomorrow_morning_iso()),
                _ => None,
            };
            let mut s = shell.settings.lock().unwrap();
            s.notifications.paused_until = until;
            let _ = crate::settings::save(&shell.home, &s);
            drop(s);
            refresh(app);
        }
        o if o.starts_with("open:") => {
            let mut parts = o["open:".len()..].splitn(3, '|');
            if let (Some(rx), Some(h), Some(sid)) = (parts.next(), parts.next(), parts.next()) {
                let _ = crate::actions::select_receiver(app, rx);
                let enc = |s: &str| {
                    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()
                };
                crate::actions::navigate(app, &format!("/s/{}/{}", enc(h), enc(sid)));
            }
        }
        _ => {}
    }
}

/// 08:00 local time tomorrow, as UTC ISO.
fn tomorrow_morning_iso() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Some(t) = crate::macos::tomorrow_at(8) {
            return sp_receivers::status::iso(t);
        }
    }
    sp_receivers::status::iso(std::time::SystemTime::now() + Duration::from_secs(16 * 3600))
}

/// Follows the hub: tray, badge and notifications, for the life of the app.
pub fn watch<R: Runtime>(app: AppHandle<R>) {
    let mut rx = app.state::<Shell>().hub.subscribe();
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        // Whatever happened before this task ran is in the hub's state already.
        refresh(&h);
        update_badge(&h, false);
        let mut last_connected = Some(Instant::now());
        let mut badge_cleared_stale = false;
        loop {
            // Wake up for the 60 s rule exactly when it falls due, not on the next 5 s tick.
            let wait = match last_connected {
                Some(t) if !badge_cleared_stale => BADGE_STALE
                    .saturating_sub(t.elapsed())
                    .clamp(Duration::from_millis(50), Duration::from_secs(5)),
                _ => Duration::from_secs(5),
            };
            let ev = tokio::time::timeout(wait, rx.recv()).await;
            let shell = h.state::<Shell>();
            match ev {
                Ok(Ok(e)) => {
                    match &e {
                        HubEvent::AttentionClosed { id, attention_id } => {
                            #[cfg(target_os = "macos")]
                            crate::macos::notify::remove(&format!("{id}:{attention_id}"));
                            let _ = (id, attention_id);
                        }
                        HubEvent::NeedsYou { id, items } => {
                            #[cfg(target_os = "macos")]
                            crate::macos::notify::on_needs_you(&h, id, items);
                            let _ = (id, items);
                        }
                        _ => {}
                    }
                    if shell.hub.any_connected() {
                        last_connected = None;
                        badge_cleared_stale = false;
                    } else if last_connected.is_none() {
                        last_connected = Some(Instant::now());
                    }
                    refresh(&h);
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => refresh(&h),
                Ok(Err(_)) => return,
                Err(_) => shell.hub.status().flush(),
            }
            // The 60 s rule, checked after every event too: reconnect attempts are events,
            // and they must neither delay the clearing nor bring a stale count back.
            let stale = !shell.hub.any_connected()
                && last_connected.is_some_and(|t| t.elapsed() >= BADGE_STALE);
            if stale != badge_cleared_stale || !stale {
                update_badge(&h, stale);
            }
            badge_cleared_stale = stale;
        }
    });
}

/// The Dock badge: the count, cleared at 0, when disconnected too long, or when off.
pub fn badge_count(n: usize, on: bool, stale: bool) -> Option<i64> {
    (on && !stale && n > 0).then_some(n as i64)
}

pub fn update_badge<R: Runtime>(app: &AppHandle<R>, stale: bool) {
    let shell = app.state::<Shell>();
    let s = shell.settings();
    let n = if shell.hub.any_connected() {
        shell.hub.needs_you().len()
    } else if stale {
        0
    } else {
        shell.hub.needs_you().len()
    };
    let v = badge_count(n, s.dock_badge && !s.menu_bar_only, stale);
    #[cfg(target_os = "macos")]
    {
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = &h;
            crate::macos::badge::set(v);
        });
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window(crate::window::MAIN) {
        let _ = w.set_badge_count(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sp_receivers::AttentionInfo;

    fn rx(id: &str, name: &str, local: bool) -> ReceiverRef {
        ReceiverRef {
            id: id.into(),
            name: name.into(),
            origin: format!("http://{name}:7373"),
            local,
            rp_id: None,
        }
    }
    fn item(rx: &str, n: usize, tool: &str) -> NeedsYouItem {
        NeedsYouItem {
            receiver: rx.into(),
            session: format!("claude:s{n}"),
            harness: "claude".into(),
            id: format!("s{n}"),
            title: Some(format!("Session {n}")),
            machine: None,
            cwd: None,
            state_since: format!("2026-10-25T00:00:{n:02}Z"),
            attentions: vec![AttentionInfo {
                attention_id: format!("a{n}"),
                kind: "permission".into(),
                tool: Some(tool.into()),
                message: None,
                at: String::new(),
                answerable: true,
            }],
        }
    }

    #[test]
    fn nothing_needs_you() {
        let m = model(&[], &[(rx("a", "studio", true), true)], None, None, false);
        assert_eq!(m.title, None, "no number at 0");
        assert!(!m.dimmed);
        assert!(m.rows.is_empty() && m.unreachable.is_empty());
    }

    #[test]
    fn up_to_five_rows_then_more() {
        let items: Vec<_> = (0..7)
            .map(|n| {
                item(
                    "a",
                    n,
                    if n == 1 {
                        "mcp__github__search_issues"
                    } else {
                        "Bash"
                    },
                )
            })
            .collect();
        let m = model(
            &items,
            &[(rx("a", "studio", true), true)],
            Some("0.3.1"),
            Some("Control+Alt+N"),
            false,
        );
        assert_eq!(m.title.as_deref(), Some("7"));
        assert_eq!(m.rows.len(), 5);
        assert_eq!(m.more, 2);
        assert_eq!(m.rows[0].label, "Session 0\tBash");
        assert_eq!(m.rows[1].label, "Session 1\tGitHub: search issues");
        assert_eq!(m.rows[0].id, "open:a|claude|s0");
        assert_eq!(m.update.as_deref(), Some("0.3.1"));
    }

    #[test]
    fn machines_named_when_several_receivers() {
        let m = model(
            &[item("b", 1, "Edit")],
            &[
                (rx("a", "studio", true), true),
                (rx("b", "build-box", false), true),
            ],
            None,
            None,
            false,
        );
        assert_eq!(m.rows[0].label, "Session 1  ·  build-box\tEdit");
    }

    #[test]
    fn unreachable_and_dimmed() {
        let m = model(
            &[item("a", 1, "Bash")],
            &[(rx("a", "studio", true), false)],
            None,
            None,
            false,
        );
        assert!(m.dimmed);
        assert_eq!(m.title, None, "no number when disconnected");
        assert_eq!(m.unreachable, vec!["This Mac".to_string()]);
        let m = model(
            &[],
            &[
                (rx("a", "studio", true), true),
                (rx("b", "build-box", false), false),
            ],
            None,
            None,
            true,
        );
        assert!(!m.dimmed);
        assert_eq!(m.unreachable, vec!["build-box".to_string()]);
        assert!(m.paused);
        let m = model(&[], &[], None, None, false);
        assert!(m.dimmed);
    }

    #[test]
    fn badge_rules() {
        assert_eq!(badge_count(3, true, false), Some(3));
        assert_eq!(badge_count(0, true, false), None);
        assert_eq!(badge_count(3, false, false), None);
        assert_eq!(badge_count(3, true, true), None);
    }
}
