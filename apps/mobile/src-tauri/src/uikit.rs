//! UIKit and WebKit touches Tauri doesn't make for us (arch-mobile §3.4). iOS only.

use crate::contract::{Haptic, Scheme};
use objc2::{class, msg_send, runtime::AnyObject, runtime::Bool};
use std::cell::RefCell;
use std::ffi::CString;

unsafe fn nsstring(s: &str) -> *mut AnyObject {
    let c = CString::new(s.replace('\0', "")).unwrap_or_default();
    msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
}

/// Fits the main WKWebView to an app:
/// - the page owns the safe areas (`viewport-fit=cover` + `env()`), so UIKit's automatic
///   content insets go (they doubled the band under the tab bar), and the outer scroll view
///   doesn't rubber-band the whole chrome;
/// - link previews off, so the web's own long-press menus win;
/// - the edge swipe goes back, as in every pushed page on the phone: the page is a
///   pushState app, and WebKit's back-forward list holds those entries too, so the swipe
///   pops the page and the router hears `popstate` as for the browser's own back;
/// - the launch screen's background (the skin's `--bg`, light and dark, from the asset
///   catalog) behind the page until its first paint: no white flash in dark mode.
///
/// # Safety
/// `wk` must be the live WKWebView, on the main thread.
pub unsafe fn fit(wk: *mut AnyObject) {
    if wk.is_null() {
        return;
    }
    let sv: *mut AnyObject = msg_send![wk, scrollView];
    let _: () = msg_send![sv, setContentInsetAdjustmentBehavior: 2isize]; // .never
    let _: () = msg_send![sv, setBounces: false];
    let _: () = msg_send![wk, setAllowsLinkPreview: false];
    let _: () = msg_send![wk, setAllowsBackForwardNavigationGestures: true];
    let color: *mut AnyObject =
        msg_send![class!(UIColor), colorNamed: nsstring("LaunchBackground")];
    if !color.is_null() {
        let _: () = msg_send![wk, setOpaque: false];
        let _: () = msg_send![wk, setBackgroundColor: color];
        let _: () = msg_send![sv, setBackgroundColor: color];
    }
}

/// Swaps the user script that starts with `marker` for `source` (first, at document start,
/// main frame only), keeping every other script (Tauri's IPC) in order, then loads `url`.
/// iOS can't replace the app's only window, so switching receivers renews the shell
/// contract in place and reloads the bundled UI.
///
/// # Safety
/// `wk` must be the live WKWebView, on the main thread.
pub unsafe fn renew_contract(wk: *mut AnyObject, marker: &str, source: &str, url: &str) {
    if wk.is_null() {
        return;
    }
    let config: *mut AnyObject = msg_send![wk, configuration];
    let ucc: *mut AnyObject = msg_send![config, userContentController];
    let scripts: *mut AnyObject = msg_send![ucc, userScripts];
    // Keep the others (retained in a copy: removeAllUserScripts releases the originals).
    let keep: *mut AnyObject = msg_send![class!(NSMutableArray), array];
    let n: usize = msg_send![scripts, count];
    let m = nsstring(marker);
    for i in 0..n {
        let us: *mut AnyObject = msg_send![scripts, objectAtIndex: i];
        let src: *mut AnyObject = msg_send![us, source];
        let mine: bool = msg_send![src, hasPrefix: m];
        if !mine {
            let _: () = msg_send![keep, addObject: us];
        }
    }
    let _: () = msg_send![ucc, removeAllUserScripts];
    let alloc: *mut AnyObject = msg_send![class!(WKUserScript), alloc];
    // WKUserScriptInjectionTimeAtDocumentStart = 0
    // +1, kept for the webview's life (one small object per receiver switch).
    let ours: *mut AnyObject = msg_send![alloc, initWithSource: nsstring(source), injectionTime: 0isize, forMainFrameOnly: true];
    let _: () = msg_send![ucc, addUserScript: ours];
    let kept: usize = msg_send![keep, count];
    for i in 0..kept {
        let us: *mut AnyObject = msg_send![keep, objectAtIndex: i];
        let _: () = msg_send![ucc, addUserScript: us];
    }
    let u: *mut AnyObject = msg_send![class!(NSURL), URLWithString: nsstring(url)];
    if !u.is_null() {
        let req: *mut AnyObject = msg_send![class!(NSURLRequest), requestWithURL: u];
        let _: *mut AnyObject = msg_send![wk, loadRequest: req];
    }
}

/// Opens an http(s) URL in Safari. Main thread.
pub fn open_external(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    open_url(url);
}

/// Opens the app's own page in Settings (UIApplicationOpenSettingsURLString): where
/// notifications are turned back on once refused. Main thread.
pub fn open_settings() {
    open_url("app-settings:");
}

/// Hands a URL to UIKit. Main thread.
fn open_url(url: &str) {
    unsafe {
        let u: *mut AnyObject = msg_send![class!(NSURL), URLWithString: nsstring(url)];
        if u.is_null() {
            return;
        }
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        let opts: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        let done: Option<&block2::Block<dyn Fn(Bool)>> = None;
        let _: () = msg_send![app, openURL: u, options: opts, completionHandler: done];
    }
}

/// The webview's window (tao doesn't make its window the application's key window in the
/// UIKit sense, so start from the webview; the key window is the fallback).
unsafe fn window_of(wk: *mut AnyObject) -> *mut AnyObject {
    let mut win: *mut AnyObject = if wk.is_null() {
        std::ptr::null_mut()
    } else {
        msg_send![wk, window]
    };
    if win.is_null() {
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        win = msg_send![app, keyWindow];
    }
    win
}

/// Gives the window the page's scheme: light or dark whatever the phone is set to, or
/// `Auto` to hand it back. The status bar's style is the root view controller's
/// `.default` (Info.plist: `UIViewControllerBasedStatusBarAppearance`), which reads the
/// window's style, so its text flips with the page; the nudge after is for the frame the
/// trait change lands in. Main thread.
///
/// # Safety
/// `wk` must be the live WKWebView, on the main thread.
pub unsafe fn set_appearance(wk: *mut AnyObject, scheme: Scheme) {
    let win = window_of(wk);
    if win.is_null() {
        return;
    }
    let _: () = msg_send![win, setOverrideUserInterfaceStyle: scheme.ui_user_interface_style()];
    let vc: *mut AnyObject = msg_send![win, rootViewController];
    if !vc.is_null() {
        let _: () = msg_send![vc, setNeedsStatusBarAppearanceUpdate];
    }
}

/// The feedback generators, one of each kind, made once on the main thread and kept for
/// the app's life. Apple's advice: a generator you `prepare` plays the moment it is asked
/// (a cold one can land a frame after the touch), so each is prepared when made and again
/// after every play; the engine idles on its own after a few seconds.
struct Generators {
    selection: *mut AnyObject,
    light: *mut AnyObject,
    medium: *mut AnyObject,
    notification: *mut AnyObject,
}

thread_local! {
    // Main thread only (`run_on_main_thread`), as UIKit wants; a thread local says so.
    static GENERATORS: RefCell<Option<Generators>> = const { RefCell::new(None) };
}

impl Generators {
    fn new() -> Generators {
        unsafe {
            let prepared = |g: *mut AnyObject| {
                let _: () = msg_send![g, prepare];
                g
            };
            let selection: *mut AnyObject = msg_send![class!(UISelectionFeedbackGenerator), alloc];
            let selection: *mut AnyObject = msg_send![selection, init];
            let notification: *mut AnyObject =
                msg_send![class!(UINotificationFeedbackGenerator), alloc];
            let notification: *mut AnyObject = msg_send![notification, init];
            // UIImpactFeedbackStyle: light 0, medium 1.
            let light: *mut AnyObject = msg_send![class!(UIImpactFeedbackGenerator), alloc];
            let light: *mut AnyObject = msg_send![light, initWithStyle: 0isize];
            let medium: *mut AnyObject = msg_send![class!(UIImpactFeedbackGenerator), alloc];
            let medium: *mut AnyObject = msg_send![medium, initWithStyle: 1isize];
            Generators {
                selection: prepared(selection),
                light: prepared(light),
                medium: prepared(medium),
                notification: prepared(notification),
            }
        }
    }
}

fn with_generators(f: impl FnOnce(&Generators)) {
    GENERATORS.with(|g| f(g.borrow_mut().get_or_insert_with(Generators::new)));
}

/// Makes the generators and prepares them, so the first haptic is on time. Main thread.
pub fn prepare_haptics() {
    with_generators(|_| {});
}

/// Plays `kind` and prepares its generator for the next. Main thread.
pub fn haptic(kind: Haptic) {
    with_generators(|g| unsafe {
        let used = match kind {
            Haptic::Selection => {
                let _: () = msg_send![g.selection, selectionChanged];
                g.selection
            }
            Haptic::Light => {
                let _: () = msg_send![g.light, impactOccurred];
                g.light
            }
            Haptic::Medium => {
                let _: () = msg_send![g.medium, impactOccurred];
                g.medium
            }
            // UINotificationFeedbackType: success 0, warning 1, error 2.
            Haptic::Success | Haptic::Warning | Haptic::Error => {
                let kind: isize = match kind {
                    Haptic::Success => 0,
                    Haptic::Warning => 1,
                    _ => 2,
                };
                let _: () = msg_send![g.notification, notificationOccurred: kind];
                g.notification
            }
        };
        let _: () = msg_send![used, prepare];
    });
}

/// The view controller on top of the webview's window.
unsafe fn top_view_controller(wk: *mut AnyObject) -> *mut AnyObject {
    let win = window_of(wk);
    if win.is_null() {
        return std::ptr::null_mut();
    }
    let mut vc: *mut AnyObject = msg_send![win, rootViewController];
    while !vc.is_null() {
        let next: *mut AnyObject = msg_send![vc, presentedViewController];
        if next.is_null() {
            break;
        }
        vc = next;
    }
    vc
}

/// A two-button alert; `done` gets true for the confirming button. Main thread.
pub fn alert(
    wk: *mut AnyObject,
    a: &crate::confirm::Ask,
    done: tokio::sync::oneshot::Sender<bool>,
) {
    use block2::RcBlock;
    use std::sync::{Arc, Mutex};
    let done = Arc::new(Mutex::new(Some(done)));
    let answer = |v: bool| {
        let done = done.clone();
        RcBlock::new(move |_action: *mut AnyObject| {
            if let Some(tx) = done.lock().unwrap().take() {
                let _ = tx.send(v);
            }
        })
    };
    unsafe {
        let vc = top_view_controller(wk);
        if vc.is_null() {
            if let Some(tx) = done.lock().unwrap().take() {
                let _ = tx.send(false);
            }
            return;
        }
        // UIAlertControllerStyleAlert = 1; UIAlertActionStyleDefault = 0, Cancel = 1.
        let ac: *mut AnyObject = msg_send![class!(UIAlertController), alertControllerWithTitle: nsstring(&a.title), message: nsstring(&a.message), preferredStyle: 1isize];
        let (yes, no) = (answer(true), answer(false));
        let cancel: *mut AnyObject = msg_send![class!(UIAlertAction), actionWithTitle: nsstring(a.cancel), style: 1isize, handler: &*no];
        let ok: *mut AnyObject = msg_send![class!(UIAlertAction), actionWithTitle: nsstring(a.ok), style: 0isize, handler: &*yes];
        let _: () = msg_send![ac, addAction: cancel];
        let _: () = msg_send![ac, addAction: ok];
        let _: () = msg_send![ac, setPreferredAction: ok];
        let none: Option<&block2::Block<dyn Fn()>> = None;
        let _: () = msg_send![vc, presentViewController: ac, animated: true, completion: none];
    }
}

/// Closes whatever alert is up (the simulator's scripted runs). Main thread.
#[cfg(target_env = "sim")]
pub fn dismiss_alert(wk: *mut AnyObject) {
    unsafe {
        let vc = top_view_controller(wk);
        if vc.is_null() {
            return;
        }
        let is_alert: bool = msg_send![vc, isKindOfClass: class!(UIAlertController)];
        if is_alert {
            let none: Option<&block2::Block<dyn Fn()>> = None;
            let _: () = msg_send![vc, dismissViewControllerAnimated: true, completion: none];
        }
    }
}

static BG_TASK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0); // UIBackgroundTaskInvalid

/// Calls `on_change(true)` when the app goes to the background and `false` when it comes
/// back. Going to the background asks iOS for the usual grace period (about 30 s) so the
/// receivers' streams can still turn a new needs-you into a notification; when it ends,
/// the app suspends as any other. Main thread, once.
pub fn watch_background(on_change: impl Fn(bool) + Send + Sync + 'static) {
    use block2::RcBlock;
    use std::sync::{atomic::Ordering, Arc};
    let on_change = Arc::new(on_change);
    unsafe {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
        let nil: *mut AnyObject = std::ptr::null_mut();
        let f = on_change.clone();
        let entered = RcBlock::new(move |_n: *mut AnyObject| {
            f(true);
            let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            let end = RcBlock::new(|| end_background_task());
            let id: usize = msg_send![app, beginBackgroundTaskWithName: nsstring("sessionpipe.streams"), expirationHandler: &*end];
            let old = BG_TASK.swap(id, Ordering::SeqCst);
            if old != 0 {
                let _: () = msg_send![app, endBackgroundTask: old];
            }
        });
        let f = on_change.clone();
        let back = RcBlock::new(move |_n: *mut AnyObject| {
            end_background_task();
            f(false);
        });
        let _: *mut AnyObject = msg_send![center, addObserverForName: nsstring("UIApplicationDidEnterBackgroundNotification"), object: nil, queue: main_queue, usingBlock: &*entered];
        let _: *mut AnyObject = msg_send![center, addObserverForName: nsstring("UIApplicationWillEnterForegroundNotification"), object: nil, queue: main_queue, usingBlock: &*back];
    }
}

fn end_background_task() {
    let id = BG_TASK.swap(0, std::sync::atomic::Ordering::SeqCst);
    if id != 0 {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            let _: () = msg_send![app, endBackgroundTask: id];
        }
    }
}
