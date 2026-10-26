//! The app menu (NATIVE-SPEC.md §3.10). Items with an action id emit `menu { action }`
//! to the page; the rest are native. Key equivalents follow web/src/lib/shortcuts.ts.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The pages' chord: ⌃⌘ on a Mac. Elsewhere Ctrl and Cmd are one key, so it would collapse
/// to Ctrl+1 (the list's own key) and Ctrl+S: Ctrl+Alt there, as in web/src/native/menu.ts.
#[cfg(target_os = "macos")]
macro_rules! page {
    ($k:literal) => {
        concat!("Ctrl+CmdOrCtrl+", $k)
    };
}
#[cfg(not(target_os = "macos"))]
macro_rules! page {
    ($k:literal) => {
        concat!("Ctrl+Alt+", $k)
    };
}

/// (action id, title, accelerator), per menu, in order. None = separator.
pub type Entry = Option<(&'static str, &'static str, Option<&'static str>)>;

pub const FILE: &[Entry] = &[Some(("new-session", "New Session", Some("CmdOrCtrl+N")))];
pub const EDIT_FIND: Entry = Some(("find", "Find", Some("CmdOrCtrl+F")));
pub const VIEW: &[Entry] = &[
    Some(("go-board", "Board", Some(page!("1")))),
    Some(("go-inbox", "Inbox", Some(page!("2")))),
    Some(("go-feed", "Feed", Some(page!("3")))),
    Some(("go-review", "Review", Some(page!("4")))),
    Some(("go-machines", "Machines", Some(page!("5")))),
    None,
    Some(("palette", "Command Palette", Some("CmdOrCtrl+K"))),
    Some(("toggle-sidebar", "Toggle Sidebar", Some(page!("S")))),
];
pub const GO: &[Entry] = &[
    Some(("back", "Back", Some("CmdOrCtrl+["))),
    Some(("forward", "Forward", Some("CmdOrCtrl+]"))),
];
pub const HELP: &[Entry] = &[
    Some(("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))),
    Some(("help:github", "sessionpipe on GitHub", None)),
];

/// Every action id the page may receive from the menu.
pub fn action_ids() -> Vec<&'static str> {
    let mut v = vec!["settings", "check-updates"];
    for e in FILE
        .iter()
        .chain(VIEW)
        .chain(GO)
        .chain(HELP)
        .chain(std::iter::once(&EDIT_FIND))
        .flatten()
    {
        if !e.0.contains(':') {
            v.push(e.0);
        }
    }
    v
}

fn add<R: Runtime>(app: &AppHandle<R>, m: &Submenu<R>, entries: &[Entry]) -> tauri::Result<()> {
    for e in entries {
        match e {
            Some((id, title, acc)) => {
                m.append(&MenuItem::with_id(app, *id, *title, true, *acc)?)?
            }
            None => m.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = "sessionpipe";
    let about = AboutMetadata {
        name: Some(name.into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About sessionpipe"), Some(about))?,
            &MenuItem::with_id(
                app,
                "check-updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit sessionpipe"))?,
        ],
    )?;
    let file = Submenu::new(app, "File", true)?;
    add(app, &file, FILE)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&PredefinedMenuItem::close_window(app, None)?)?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
        ],
    )?;
    add(app, &edit, &[EDIT_FIND])?;
    let view = Submenu::new(app, "View", true)?;
    add(app, &view, VIEW)?;
    view.append(&PredefinedMenuItem::separator(app)?)?;
    view.append(&PredefinedMenuItem::fullscreen(app, None)?)?;
    let go = Submenu::new(app, "Go", true)?;
    add(app, &go, GO)?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let help = Submenu::new(app, "Help", true)?;
    add(app, &help, HELP)?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window, &help])
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()));
    Ok(())
}

pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "help:github" => {
            crate::actions::open_external("https://github.com/spacesheep-dev/sessionpipe-gui")
        }
        "check-updates" => crate::updater::check_now(app.clone()),
        "new-session" => crate::actions::new_session(app, None),
        a if action_ids().contains(&a) => crate::actions::menu_action(app, a),
        // Tray items share the global menu-event stream on some platforms.
        other => crate::tray::on_menu(app, other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_ids_match_the_spec_table() {
        let ids = action_ids();
        for a in [
            "settings",
            "new-session",
            "find",
            "go-board",
            "go-inbox",
            "go-feed",
            "go-review",
            "go-machines",
            "palette",
            "toggle-sidebar",
            "back",
            "forward",
            "shortcuts",
        ] {
            assert!(ids.contains(&a), "{a}");
        }
        assert!(!ids.iter().any(|a| a.contains(':')));
    }

    #[test]
    fn no_accelerator_twice() {
        let mut seen = std::collections::HashSet::new();
        for e in FILE
            .iter()
            .chain(VIEW)
            .chain(GO)
            .chain(HELP)
            .chain(std::iter::once(&EDIT_FIND))
            .flatten()
        {
            if let Some(a) = e.2 {
                assert!(seen.insert(a), "{a} twice");
            }
        }
    }

    /// ⌘1…⌘9 are the web's list.jump / panel.tab keys, so the pages take ⌃⌘1…5
    /// (web/src/native/menu.ts); the menu must claim the same chords.
    #[test]
    fn pages_are_ctrl_cmd_digits() {
        for (i, id) in [
            "go-board",
            "go-inbox",
            "go-feed",
            "go-review",
            "go-machines",
        ]
        .iter()
        .enumerate()
        {
            let e = VIEW.iter().flatten().find(|e| e.0 == *id).unwrap();
            assert_eq!(
                e.2,
                Some(format!("Ctrl+CmdOrCtrl+{}", i + 1).as_str()),
                "{id}"
            );
        }
        assert!(!FILE
            .iter()
            .chain(VIEW)
            .chain(GO)
            .chain(HELP)
            .flatten()
            .any(|e| e
                .2
                .is_some_and(|a| a.starts_with("CmdOrCtrl+") && a[10..].parse::<u8>().is_ok())));
    }
}
