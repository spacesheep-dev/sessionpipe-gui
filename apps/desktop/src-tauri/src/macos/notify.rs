//! Notifications on UNUserNotificationCenter (NATIVE-SPEC.md §3.4): our own small module,
//! because tauri-plugin-notification on macOS uses the deprecated NSUserNotificationCenter
//! and folds two actions into "Options".
//!
//! - categories: permission (Allow, Deny; neither destructive; Allow needs authentication),
//!   question and idle (Reply…, a text input), error (no actions)
//! - one notification per attention, `<rx>:<attentionId>`, thread `<rx>:<session>`,
//!   removed when the attention closes anywhere
//! - Allow / Deny / Reply answered natively through identity (no webview); on failure,
//!   one "Couldn't answer"
//! - permission is asked only from `app_notify_request`, never at launch
//!
//! UNUserNotificationCenter needs a bundled app with a bundle id: run unbundled (`tauri
//! dev`), this module does nothing and reports "denied".

use crate::notifications::{
    self as content, Content, ACTION_ALLOW, ACTION_DENY, ACTION_REPLY, CAT_IDLE, CAT_PERMISSION,
    CAT_QUESTION,
};
use crate::Shell;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSArray, NSBundle, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNTextInputNotificationAction,
    UNTextInputNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use sp_receivers::NeedsYouItem;
use std::collections::{HashMap, HashSet};
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, Runtime};

/// What a delivered notification answers, by identifier.
#[derive(Debug, Clone)]
struct Meta {
    rx: String,
    path: String,
    machine: Option<String>,
    session: String,
    attention_id: String,
}

struct State {
    meta: HashMap<String, Meta>,
    /// Attention ids seen per receiver (None: not seeded yet; the first list only seeds).
    known: HashMap<String, HashSet<String>>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
type OnResponse = Box<dyn Fn(String, String, Option<String>) + Send + Sync>;
static ON_RESPONSE: OnceLock<OnResponse> = OnceLock::new();

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            meta: HashMap::new(),
            known: HashMap::new(),
        })
    })
}

/// A real .app with a bundle id: the only place UNUserNotificationCenter works.
pub fn available() -> bool {
    let b = NSBundle::mainBundle();
    b.bundleIdentifier().is_some() && b.bundlePath().to_string().ends_with(".app")
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    available().then(UNUserNotificationCenter::currentNotificationCenter)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "SessionpipeNotifyDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// The app is in front: still show it (the window may be on another session;
        /// the shell already skipped the one on screen).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _n: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            r: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let id = r.notification().request().identifier().to_string();
            let action = r.actionIdentifier().to_string();
            let text = r
                .downcast_ref::<UNTextInputNotificationResponse>()
                .map(|t| t.userText().to_string());
            if let Some(f) = ON_RESPONSE.get() {
                f(id, action, text);
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's init on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
}

fn ns(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

/// Categories and the delegate. Asks for nothing.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let h = app.clone();
    let _ = ON_RESPONSE.set(Box::new(move |id, action, text| {
        on_response(&h, id, action, text)
    }));
    let Some(c) = center() else {
        log::info!("notifications: not a bundled app; off");
        return;
    };
    let auth = UNNotificationActionOptions::AuthenticationRequired;
    let allow = UNNotificationAction::actionWithIdentifier_title_options(
        &ns(ACTION_ALLOW),
        &ns("Allow"),
        auth,
    );
    // Not destructive: Deny is never red.
    let deny = UNNotificationAction::actionWithIdentifier_title_options(
        &ns(ACTION_DENY),
        &ns("Deny"),
        UNNotificationActionOptions::empty(),
    );
    let reply = || {
        Retained::into_super(UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
            &ns(ACTION_REPLY),
            &ns("Reply…"),
            auth,
            &ns("Send"),
            &ns("Reply"),
        ))
    };
    let none: Retained<NSArray<NSString>> = NSArray::new();
    let cat = |id: &str, actions: &[Retained<UNNotificationAction>]| {
        UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &ns(id),
            &NSArray::from_retained_slice(actions),
            &none,
            UNNotificationCategoryOptions::empty(),
        )
    };
    let cats = NSSet::from_retained_slice(&[
        cat(CAT_PERMISSION, &[allow, deny]),
        cat(CAT_QUESTION, &[reply()]),
        cat(CAT_IDLE, &[reply()]),
    ]);
    c.setNotificationCategories(&cats);
    let d = Delegate::new();
    c.setDelegate(Some(ProtocolObject::from_ref(&*d)));
    // The center holds its delegate weakly: keep ours for the life of the app.
    std::mem::forget(d);
}

fn ask_status() -> Option<tokio::sync::oneshot::Receiver<UNAuthorizationStatus>> {
    let c = center()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let block = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
        // SAFETY: the framework passes a valid settings object.
        let st = unsafe { s.as_ref() }.authorizationStatus();
        if let Some(t) = tx.lock().unwrap().take() {
            let _ = t.send(st);
        }
    });
    c.getNotificationSettingsWithCompletionHandler(&block);
    Some(rx)
}

pub async fn status() -> &'static str {
    let Some(rx) = ask_status() else {
        return "denied";
    };
    match rx.await {
        Ok(
            UNAuthorizationStatus::Authorized
            | UNAuthorizationStatus::Provisional
            | UNAuthorizationStatus::Ephemeral,
        ) => "granted",
        Ok(UNAuthorizationStatus::Denied) => "denied",
        _ => "undetermined",
    }
}

/// The system's permission prompt. Only ever from `app_notify_request` (the person
/// turned notifications on).
pub async fn request() -> &'static str {
    let Some(rx) = ask_permission() else {
        return "denied";
    };
    match rx.await {
        Ok(true) => "granted",
        Ok(false) => "denied",
        Err(_) => "undetermined",
    }
}

fn ask_permission() -> Option<tokio::sync::oneshot::Receiver<bool>> {
    let c = center()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let block = RcBlock::new(move |granted: Bool, _e: *mut NSError| {
        if let Some(t) = tx.lock().unwrap().take() {
            let _ = t.send(granted.as_bool());
        }
    });
    c.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &block,
    );
    Some(rx)
}

/// Removes a delivered (or pending) notification: its attention closed somewhere.
pub fn remove(identifier: &str) {
    state().lock().unwrap().meta.remove(identifier);
    let Some(c) = center() else { return };
    let ids = NSArray::from_retained_slice(&[ns(identifier)]);
    c.removeDeliveredNotificationsWithIdentifiers(&ids);
    c.removePendingNotificationRequestsWithIdentifiers(&ids);
}

fn post(c: &Content) {
    let Some(center) = center() else { return };
    let n = UNMutableNotificationContent::new();
    n.setTitle(&ns(&c.title));
    if !c.subtitle.is_empty() {
        n.setSubtitle(&ns(&c.subtitle));
    }
    n.setBody(&ns(&c.body));
    if !c.thread.is_empty() {
        n.setThreadIdentifier(&ns(&c.thread));
    }
    if let Some(cat) = c.category {
        n.setCategoryIdentifier(&ns(cat));
    }
    if c.sound {
        n.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let req =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&ns(&c.identifier), &n, None);
    let id = c.identifier.clone();
    let done = RcBlock::new(move |e: *mut NSError| {
        if !e.is_null() {
            log::warn!("notification {id} not delivered");
        }
    });
    center.addNotificationRequest_withCompletionHandler(&req, Some(&done));
}

/// The needs-you list of one receiver changed: notify each attention that is new since
/// the last list (the first list only seeds, as the web does).
pub fn on_needs_you<R: Runtime>(app: &AppHandle<R>, rx: &str, items: &[NeedsYouItem]) {
    let ids: HashSet<String> = items
        .iter()
        .flat_map(|i| i.attentions.iter().map(|a| a.attention_id.clone()))
        .collect();
    let fresh: Vec<(&NeedsYouItem, &sp_receivers::AttentionInfo)> = {
        let mut st = state().lock().unwrap();
        let prev = st.known.insert(rx.to_string(), ids);
        let Some(prev) = prev else { return };
        items
            .iter()
            .flat_map(|i| i.attentions.iter().map(move |a| (i, a)))
            .filter(|(_, a)| !prev.contains(&a.attention_id))
            .collect()
    };
    if fresh.is_empty() || center().is_none() {
        return;
    }
    let shell = app.state::<Shell>();
    let s = shell.settings().notifications;
    if !s.enabled || crate::settings::paused(&s, &sp_receivers::status::iso_now()) {
        return;
    }
    // The window in front shows needs-you itself.
    let focused = app
        .get_webview_window(crate::window::MAIN)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    let signs = crate::identity_glue::can_answer(&shell.hub, rx);
    for (item, a) in fresh {
        if !content::kind_on(&s.kinds, &a.kind) {
            continue;
        }
        let can_answer = signs && item.machine.is_some();
        let c = content::content(rx, item, a, can_answer);
        state().lock().unwrap().meta.insert(
            c.identifier.clone(),
            Meta {
                rx: rx.to_string(),
                path: c.path.clone(),
                machine: item.machine.clone(),
                session: item.session.clone(),
                attention_id: a.attention_id.clone(),
            },
        );
        post(&c);
    }
}

fn on_response<R: Runtime>(app: &AppHandle<R>, id: String, action: String, text: Option<String>) {
    let meta = state().lock().unwrap().meta.get(&id).cloned();
    // SAFETY: a framework-provided static NSString.
    let default = unsafe { UNNotificationDefaultActionIdentifier }.to_string();
    let Some(m) = meta else {
        if action == default {
            crate::actions::navigate(app, "/inbox");
        }
        return;
    };
    if action == default {
        let _ = crate::actions::select_receiver(app, &m.rx);
        crate::actions::navigate(app, &m.path);
        return;
    }
    let answer = match (action.as_str(), m.machine.clone()) {
        (ACTION_ALLOW | ACTION_DENY, Some(machine)) => crate::identity_glue::Answer::Permission {
            machine,
            session: m.session.clone(),
            attention_id: m.attention_id.clone(),
            allow: action == ACTION_ALLOW,
        },
        (ACTION_REPLY, Some(machine)) => crate::identity_glue::Answer::Reply {
            machine,
            session: m.session.clone(),
            text: text.unwrap_or_default(),
        },
        _ => return,
    };
    let hub = app.state::<Shell>().hub.clone();
    tauri::async_runtime::spawn(async move {
        let r = crate::identity_glue::answer(&hub, &m.rx, answer).await;
        remove(&id);
        if let Err(e) = r {
            log::warn!("answer from a notification failed: {e}");
            post(&content::couldnt_answer(&id));
        }
    });
}
