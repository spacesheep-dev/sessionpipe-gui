//! The app menu (NATIVE-SPEC.md §3.10). Items with an action id emit `menu { action }`
//! to the page; the rest are native. Key equivalents follow web/src/lib/shortcuts.ts.
//! A Mac's bar starts with the app's own menu and has a Window menu. Windows and Linux
//! have neither: Settings and Exit are File's there, updates and About are Help's.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The pages' chord: ⌃⌘ on a Mac. Elsewhere Ctrl and Cmd are one key, so it would collapse
/// to Ctrl+1 (the list's own key): Ctrl+Shift there, as in web/src/native/menu.ts. Not
/// Ctrl+Alt: Windows reports AltGr as Ctrl+Alt, so it would take the characters AltGr types
/// (² and @ on the 2, ś on the S), and Ctrl+Alt+1…7 are the colour labels. GTK 3 shows
/// Shift+Ctrl+1 but does not answer it where Shift+1 types "!"; the page does then
/// (menu.ts, `installKeyFilter`).
#[cfg(target_os = "macos")]
macro_rules! page {
    ($k:literal) => {
        concat!("Ctrl+CmdOrCtrl+", $k)
    };
}
#[cfg(not(target_os = "macos"))]
macro_rules! page {
    ($k:literal) => {
        concat!("CmdOrCtrl+Shift+", $k)
    };
}

/// Toggle Sidebar: ⌃⌘S on a Mac, Ctrl+B elsewhere (never Ctrl+Alt+S, which AltGr types).
#[cfg(target_os = "macos")]
const SIDEBAR: &str = "Ctrl+CmdOrCtrl+S";
#[cfg(not(target_os = "macos"))]
const SIDEBAR: &str = "CmdOrCtrl+B";

/// (action id, title, accelerator), per menu, in order. None = separator.
pub type Entry = Option<(&'static str, &'static str, Option<&'static str>)>;

#[cfg(target_os = "macos")]
pub const FILE: &[Entry] = &[Some(("new-session", "New Session", Some("CmdOrCtrl+N")))];
#[cfg(not(target_os = "macos"))]
pub const FILE: &[Entry] = &[
    Some(("new-session", "New Session", Some("CmdOrCtrl+N"))),
    None,
    Some(("settings", "Settings…", Some("CmdOrCtrl+,"))),
    None,
    QUIT,
];
/// The way out, off a Mac: a plain item with the tray's id, which `on_menu` hands to the
/// tray's Quit. Not the predefined Quit, which GTK 3 does not have. Windows calls it Exit
/// and gives it no key (Alt+F4 closes the window); Linux calls it Quit, Ctrl+Q.
#[cfg(target_os = "windows")]
const QUIT: Entry = Some(("quit", "Exit", None));
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const QUIT: Entry = Some(("quit", "Quit", Some("CmdOrCtrl+Q")));
pub const EDIT_FIND: Entry = Some(("find", "Find", Some("CmdOrCtrl+F")));
pub const VIEW: &[Entry] = &[
    Some(("go-board", "Board", Some(page!("1")))),
    Some(("go-inbox", "Inbox", Some(page!("2")))),
    Some(("go-feed", "Feed", Some(page!("3")))),
    Some(("go-review", "Review", Some(page!("4")))),
    Some(("go-machines", "Machines", Some(page!("5")))),
    None,
    Some(("palette", "Command Palette", Some("CmdOrCtrl+K"))),
    Some(("toggle-sidebar", "Toggle Sidebar", Some(SIDEBAR))),
];
pub const GO: &[Entry] = &[
    Some(("back", "Back", Some("CmdOrCtrl+["))),
    Some(("forward", "Forward", Some("CmdOrCtrl+]"))),
];
#[cfg(target_os = "macos")]
pub const HELP: &[Entry] = &[
    Some(("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))),
    Some(("help:github", "sessionpipe on GitHub", None)),
];
#[cfg(not(target_os = "macos"))]
pub const HELP: &[Entry] = &[
    Some(("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))),
    Some(("help:github", "sessionpipe on GitHub", None)),
    None,
    Some(("check-updates", "Check for Updates…", None)),
];
/// The bar off a Mac, in order. The letter after & is a menu's access key: Alt+F opens File.
#[cfg(not(target_os = "macos"))]
pub const BAR: [&str; 5] = ["&File", "&Edit", "&View", "&Go", "&Help"];

/// Every item the tables hold, whichever menu it is in.
fn entries() -> impl Iterator<Item = &'static (&'static str, &'static str, Option<&'static str>)> {
    FILE.iter()
        .chain(VIEW)
        .chain(GO)
        .chain(HELP)
        .chain(std::iter::once(&EDIT_FIND))
        .flatten()
}

/// Every action id the page may receive from the menu. Not a link (`help:…`), and not
/// `quit`, which is the tray's.
pub fn action_ids() -> Vec<&'static str> {
    let mut v = vec!["settings", "check-updates"];
    for e in entries() {
        if !e.0.contains(':') && e.0 != "quit" && !v.contains(&e.0) {
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

/// About, with the app's version: the app's own menu has it on a Mac, Help elsewhere.
fn about<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PredefinedMenuItem<R>> {
    let meta = AboutMetadata {
        name: Some("sessionpipe".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    PredefinedMenuItem::about(app, Some("About sessionpipe"), Some(meta))
}

/// Edit is the same everywhere: the system's own items, then Find.
fn edit<R: Runtime>(app: &AppHandle<R>, title: &str) -> tauri::Result<Submenu<R>> {
    let m = Submenu::with_items(
        app,
        title,
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
    add(app, &m, &[EDIT_FIND])?;
    Ok(m)
}

#[cfg(target_os = "macos")]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        app,
        "sessionpipe",
        true,
        &[
            &about(app)?,
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
    let edit = edit(app, "Edit")?;
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

/// Windows' and Linux's bar. No menu named after the app (Services, Hide, Hide Others and
/// Show All are a Mac's), no Window menu, no Full Screen, and no Close Window: the title
/// bar and Alt+F4 close the window, and Ctrl+W stays the side panel's "Close the tab".
#[cfg(not(target_os = "macos"))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let [file, edit_title, view, go, help] = BAR;
    let file = Submenu::new(app, file, true)?;
    add(app, &file, FILE)?;
    let edit = edit(app, edit_title)?;
    let view = Submenu::new(app, view, true)?;
    add(app, &view, VIEW)?;
    let go = Submenu::new(app, go, true)?;
    add(app, &go, GO)?;
    let help = Submenu::new(app, help, true)?;
    add(app, &help, HELP)?;
    help.append(&PredefinedMenuItem::separator(app)?)?;
    help.append(&about(app)?)?;
    Menu::with_items(app, &[&file, &edit, &view, &go, &help])
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
        "check-updates" => crate::updater::check_from_menu(app.clone()),
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
        // Exit is the tray's Quit, never an event for the page.
        assert!(!ids.contains(&"quit"));
    }

    #[test]
    fn no_accelerator_twice() {
        let mut seen = std::collections::HashSet::new();
        for a in entries().filter_map(|e| e.2) {
            assert!(seen.insert(a), "{a} twice");
        }
    }

    /// Windows reports AltGr as Ctrl+Alt, so a menu key with both would take the characters
    /// AltGr types; Ctrl+Alt+1…7 and 0 are also the web's colour labels.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_ctrl_alt_off_mac() {
        for a in entries().filter_map(|e| e.2) {
            let keys: Vec<&str> = a.split('+').collect();
            let ctrl = keys
                .iter()
                .any(|k| matches!(*k, "Ctrl" | "Control" | "CmdOrCtrl"));
            assert!(!(ctrl && keys.contains(&"Alt")), "{a}");
        }
    }

    /// Off a Mac the app has no menu of its own: File holds Settings and the way out, Help
    /// holds the update check, and every title has an access key.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn off_mac_file_ends_with_the_way_out() {
        assert_eq!(BAR, ["&File", "&Edit", "&View", "&Go", "&Help"]);
        let ids = |m: &[Entry]| m.iter().map(|e| e.map(|e| e.0)).collect::<Vec<_>>();
        assert_eq!(
            ids(FILE),
            [
                Some("new-session"),
                None,
                Some("settings"),
                None,
                Some("quit")
            ]
        );
        assert_eq!(ids(HELP).last(), Some(&Some("check-updates")));
        let quit = QUIT.unwrap();
        if cfg!(target_os = "windows") {
            assert_eq!((quit.1, quit.2), ("Exit", None));
        } else {
            assert_eq!((quit.1, quit.2), ("Quit", Some("CmdOrCtrl+Q")));
        }
    }

    /// ⌘1…⌘9 are the web's list.jump / panel.tab keys, so the pages take ⌃⌘1…5 on a Mac and
    /// Ctrl+Shift+1…5 elsewhere (web/src/native/menu.ts); the menu must claim the same
    /// chords. Not Ctrl+Alt there: Windows reports AltGr as Ctrl+Alt.
    fn page_chord(n: usize) -> String {
        if cfg!(target_os = "macos") {
            format!("Ctrl+CmdOrCtrl+{n}")
        } else {
            format!("CmdOrCtrl+Shift+{n}")
        }
    }

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
            assert_eq!(e.2, Some(page_chord(i + 1).as_str()), "{id}");
        }
        assert!(!entries().any(|e| e
            .2
            .is_some_and(|a| a.starts_with("CmdOrCtrl+") && a[10..].parse::<u8>().is_ok())));
    }
}
