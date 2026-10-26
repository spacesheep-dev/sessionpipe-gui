//! The Dock badge (NATIVE-SPEC.md §3.3) through NSApp.dockTile, so it works with the
//! window closed (Tauri's set_badge_count needs a window). Main thread only.

use objc2_app_kit::NSApplication;
use objc2_foundation::NSString;

pub fn set(count: Option<i64>) {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        log::warn!("badge: not on the main thread");
        return;
    };
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    match count {
        Some(n) if n > 0 => tile.setBadgeLabel(Some(&NSString::from_str(&n.to_string()))),
        _ => tile.setBadgeLabel(None),
    }
}
