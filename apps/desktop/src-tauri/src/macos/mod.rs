//! macOS-only pieces with no Tauri API: notifications (UNUserNotificationCenter), the
//! login item (SMAppService), the Dock badge with no window, small system reads.

pub mod badge;
pub mod login_item;
pub mod notify;

use objc2_foundation::NSString;

/// The system appearance is Dark (read before the window exists, for its background).
pub fn system_dark() -> bool {
    let d = objc2_foundation::NSUserDefaults::standardUserDefaults();
    let v = d.stringForKey(&NSString::from_str("AppleInterfaceStyle"));
    v.is_some_and(|s| s.to_string().eq_ignore_ascii_case("dark"))
}

/// Unhides and activates the app. On the main thread it acts at once (Tauri's
/// AppHandle::show/hide wait for the event loop, which hangs when called from inside
/// it: a menu, the tray, a second launch); elsewhere it is posted to the main thread.
pub fn activate<R: tauri::Runtime>(app: &tauri::AppHandle<R>, show: bool) {
    let act = move || {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let ns = objc2_app_kit::NSApplication::sharedApplication(mtm);
            if show {
                ns.unhide(None);
                #[allow(deprecated)]
                ns.activateIgnoringOtherApps(true);
            } else {
                ns.hide(None);
            }
        }
    };
    if objc2::MainThreadMarker::new().is_some() {
        act();
    } else {
        let _ = app.run_on_main_thread(act);
    }
}

/// Dims the menu bar item when no receiver is connected (one signal: no number, grey).
pub fn set_tray_dimmed<R: tauri::Runtime>(t: &tauri::tray::TrayIcon<R>, dimmed: bool) {
    let _ = t.with_inner_tray_icon(move |inner| {
        if let Some(item) = inner.ns_status_item() {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                if let Some(button) = item.button(mtm) {
                    button.setAppearsDisabled(dimmed);
                }
            }
        }
    });
}

#[repr(C)]
struct Tm {
    sec: i32,
    min: i32,
    hour: i32,
    mday: i32,
    mon: i32,
    year: i32,
    wday: i32,
    yday: i32,
    isdst: i32,
    gmtoff: std::ffi::c_long,
    zone: *mut std::ffi::c_char,
}

extern "C" {
    fn localtime_r(t: *const i64, out: *mut Tm) -> *mut Tm;
    fn mktime(tm: *mut Tm) -> i64;
}

/// `hour`:00 local time tomorrow.
pub fn tomorrow_at(hour: i32) -> Option<std::time::SystemTime> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let mut tm: Tm = unsafe { std::mem::zeroed() };
    // SAFETY: plain libc calls on stack values.
    unsafe {
        if localtime_r(&now, &mut tm).is_null() {
            return None;
        }
        tm.mday += 1;
        tm.hour = hour;
        tm.min = 0;
        tm.sec = 0;
        tm.isdst = -1;
        let t = mktime(&mut tm);
        (t > 0).then(|| std::time::UNIX_EPOCH + std::time::Duration::from_secs(t as u64))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tomorrow_is_in_the_future_and_within_two_days() {
        let t = super::tomorrow_at(8).unwrap();
        let d = t.duration_since(std::time::SystemTime::now()).unwrap();
        assert!(d.as_secs() > 0 && d.as_secs() < 2 * 86_400 + 3600);
    }
}
