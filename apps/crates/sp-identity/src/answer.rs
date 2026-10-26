//! The flows that need the receiver: which rp id a receiver is for (checked against its
//! URL), a machine's name for the prompt, a pairing read by Rust itself, and the native
//! answer from a notification (NATIVE-SPEC §3.4, §5.5): build the `permission.answer` or
//! `prompt`, sign it (the held grant, or one Touch ID for a new one) and post it to the same
//! route the page uses.
use crate::rp;
use crate::signer::{now_ms, Signer};
use crate::validate::Mode;
use crate::{b64, Error, ReceiverLookup};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};

/// The signer the plugin made, for answers from notifications (no webview involved).
pub(crate) static SIGNER: OnceLock<Arc<Signer>> = OnceLock::new();

pub const CONTROL: &str = "/api/ui/control";

/// The rp id a receiver signs for, and its host for the grant's prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub rp: String,
    pub host: String,
}

fn json(bytes: &[u8]) -> Result<Value, Error> {
    serde_json::from_slice(bytes)
        .map_err(|_| Error::new("failed", "the receiver sent something unreadable"))
}

/// Which rp id `receiver` is for: the one the shell knows, else its `/api/ui/info`. The
/// page may name it too, and then it must be that one. The WebAuthn rule against the
/// receiver's own URL holds either way (rp.rs).
pub async fn target(
    lookup: &dyn ReceiverLookup,
    receiver: &str,
    asked: Option<&str>,
) -> Result<Target, Error> {
    let r = lookup.receiver(receiver).ok_or_else(|| {
        Error::new(
            "unknown_receiver",
            "that receiver isn't one this app was given",
        )
    })?;
    let known = match r.rp_id.clone() {
        Some(rp) => rp,
        None => json(&lookup.get(receiver, "/api/ui/info").await?)?
            .pointer("/control/rpId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| Error::new("failed", "the receiver didn't say its rp id"))?,
    };
    if let Some(a) = asked {
        if a != known {
            return Err(Error::new(
                "rp_mismatch",
                format!("{} signs for {known}, not {a}", r.origin),
            ));
        }
    }
    rp::check(&known, &r.origin, r.local)?;
    let host = rp::split_origin(&r.origin)
        .map(|(_, h)| h)
        .unwrap_or_default();
    Ok(Target { rp: known, host })
}

/// A machine's name as the receiver lists it, for a prompt; its id's start when unknown.
pub async fn machine_name(lookup: &dyn ReceiverLookup, receiver: &str, machine: &str) -> String {
    let fallback = || format!("machine {}", machine.get(..10).unwrap_or(machine));
    let Ok(body) = lookup.get(receiver, &format!("{CONTROL}/machines")).await else {
        return fallback();
    };
    let Ok(v) = json(&body) else {
        return fallback();
    };
    v["machines"]
        .as_array()
        .and_then(|ms| ms.iter().find(|m| m["machineId"] == machine))
        .and_then(|m| m["name"].as_str())
        .map(str::to_string)
        .unwrap_or_else(fallback)
}

/// A pairing as Rust reads it: rp id, machine id and name, the six digits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub rp: String,
    pub machine_id: String,
    pub machine_name: String,
    pub check: String,
}

pub async fn pairing(
    lookup: &dyn ReceiverLookup,
    receiver: &str,
    code: &str,
) -> Result<Pairing, Error> {
    if !b64::is_b64url(code, 6, 32) {
        return Err(Error::refused("not a pairing code"));
    }
    let v = json(
        &lookup
            .get(receiver, &format!("{CONTROL}/pair/{code}"))
            .await?,
    )?;
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    let p = Pairing {
        rp: s("/rpId").ok_or_else(|| Error::new("failed", "the pairing has no rp id"))?,
        machine_id: s("/machine/id")
            .filter(|m| m.starts_with("m_"))
            .ok_or_else(|| Error::new("failed", "which machine?"))?,
        machine_name: s("/machine/name").unwrap_or_default(),
        check: s("/check").unwrap_or_default(),
    };
    if s("/status").as_deref() != Some("pending") {
        return Err(Error::refused(
            "this pairing is no longer waiting for approval",
        ));
    }
    Ok(p)
}

/// Run a blocking call (a Touch ID sheet waits for a finger) off the async runtime.
pub fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> impl Future<Output = T> {
    struct Slot<T> {
        value: Option<T>,
        waker: Option<Waker>,
    }
    struct Wait<T>(Arc<Mutex<Slot<T>>>);
    impl<T> Future for Wait<T> {
        type Output = T;
        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
            let mut s = self.0.lock().unwrap();
            match s.value.take() {
                Some(v) => Poll::Ready(v),
                None => {
                    s.waker = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }
    }
    let slot = Arc::new(Mutex::new(Slot {
        value: None,
        waker: None,
    }));
    let s2 = slot.clone();
    std::thread::Builder::new()
        .name("sp-identity".into())
        .spawn(move || {
            let v = f();
            let mut s = s2.lock().unwrap();
            s.value = Some(v);
            if let Some(w) = s.waker.take() {
                w.wake();
            }
        })
        .expect("a thread");
    Wait(slot)
}

/// An answer from a notification's action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeAnswer {
    Permission {
        machine: String,
        session: String,
        attention_id: String,
        decision: String,
    },
    Reply {
        machine: String,
        session: String,
        text: String,
    },
}

/// The command string for an answer, fields in the spec's order (CONTROL.md §3.1).
pub fn command(a: &NativeAnswer, nonce: &str, iat: u64) -> Result<String, Error> {
    #[derive(Serialize)]
    struct Cmd<'a> {
        v: u8,
        t: &'a str,
        machine: &'a str,
        kind: &'a str,
        session: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<&'a str>,
        #[serde(rename = "for", skip_serializing_if = "Option::is_none")]
        for_: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        decision: Option<&'a str>,
        nonce: &'a str,
        iat: u64,
    }
    let c = match a {
        NativeAnswer::Permission {
            machine,
            session,
            attention_id,
            decision,
        } => {
            if decision != "allow" && decision != "deny" {
                return Err(Error::refused("allow or deny?"));
            }
            Cmd {
                v: 1,
                t: "sessionpipe.control",
                machine,
                kind: "permission.answer",
                session,
                text: None,
                for_: Some(attention_id),
                decision: Some(decision),
                nonce,
                iat,
            }
        }
        NativeAnswer::Reply {
            machine,
            session,
            text,
        } => {
            if text.trim().is_empty() || text.chars().count() > 20_000 {
                return Err(Error::refused("a reply is 1 to 20 000 characters"));
            }
            Cmd {
                v: 1,
                t: "sessionpipe.control",
                machine,
                kind: "prompt",
                session,
                text: Some(text),
                for_: None,
                decision: None,
                nonce,
                iat,
            }
        }
    };
    Ok(serde_json::to_string(&c).expect("json"))
}

/// The grant was refused by the receiver's check: one fresh grant is worth a try.
const GRANT_FAULTS: [&str; 4] = ["bad_grant", "outside_grant", "bad_csig", "bad_assertion"];

/// Whether a notification for a receiver signing for `rp` may offer Allow / Deny and Reply:
/// the plugin is running and this Mac holds a device key for that rp id. Without one, an
/// answer could only fail, so the notification just opens the app.
pub fn holds_key(rp: &str) -> bool {
    SIGNER.get().is_some_and(|s| s.holds_key(rp))
}

/// Answer from a notification with no webview: build, sign (the held grant, or one Touch ID
/// for a new grant) and post to `POST /api/ui/control/send`, as the page would.
pub async fn answer(lookup: &dyn ReceiverLookup, rx: &str, a: NativeAnswer) -> Result<(), Error> {
    let signer = SIGNER
        .get()
        .cloned()
        .ok_or_else(|| Error::new("unavailable", "this app has no signer"))?;
    answer_with(&signer, lookup, rx, a).await
}

pub async fn answer_with(
    signer: &Arc<Signer>,
    lookup: &dyn ReceiverLookup,
    rx: &str,
    a: NativeAnswer,
) -> Result<(), Error> {
    let t = target(lookup, rx, None).await?;
    let machine = match &a {
        NativeAnswer::Permission { machine, .. } | NativeAnswer::Reply { machine, .. } => {
            machine.clone()
        }
    };
    let nonce = b64::enc(&signer_random(signer));
    let cmd = command(&a, &nonce, now_ms())?;
    for fresh in [false, true] {
        let (s, rp, host, c) = (signer.clone(), t.rp.clone(), t.host.clone(), cmd.clone());
        let signed = blocking(move || s.sign(&rp, &host, Some(&c), Mode::Grant, fresh, "")).await?;
        let mut body = signed;
        body["machineId"] = Value::from(machine.clone());
        let (status, reply) = lookup
            .post_json(
                rx,
                &format!("{CONTROL}/send"),
                serde_json::to_vec(&body).expect("json"),
            )
            .await?;
        if (200..300).contains(&status) {
            return Ok(());
        }
        let r: Value = serde_json::from_slice(&reply).unwrap_or(Value::Null);
        let code = r["code"].as_str().unwrap_or("");
        if fresh || !GRANT_FAULTS.contains(&code) {
            let why = r["reason"].as_str().unwrap_or(code);
            return Err(Error::new(
                "refused",
                format!(
                    "the receiver refused it ({status}{}{why})",
                    if why.is_empty() { "" } else { ": " }
                ),
            ));
        }
    }
    unreachable!("the loop returns")
}

fn signer_random(s: &Signer) -> Vec<u8> {
    s.random(16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::tests::{signer, M};
    use crate::{BoxFuture, ReceiverRef};
    use std::sync::Mutex;

    struct Rx {
        origin: String,
        rp: Option<String>,
        local: bool,
        posts: Mutex<Vec<(String, Value)>>,
        answers: Mutex<Vec<(u16, Value)>>,
    }
    impl ReceiverLookup for Rx {
        fn receiver(&self, id: &str) -> Option<ReceiverRef> {
            (id == "rx1").then(|| ReceiverRef {
                id: id.into(),
                origin: self.origin.clone(),
                rp_id: self.rp.clone(),
                local: self.local,
            })
        }
        fn get(&self, _id: &str, path: &str) -> BoxFuture<'_, crate::Result<Vec<u8>>> {
            let body = match path {
                "/api/ui/info" => serde_json::json!({"control": {"rpId": "localhost"}}),
                "/api/ui/control/machines" => {
                    serde_json::json!({"machines": [{"machineId": M, "name": "studio-mac"}]})
                }
                "/api/ui/control/pair/K7Q29XMV" => {
                    serde_json::json!({"status":"pending","rpId":"localhost","check":"482913","machine":{"id":M,"name":"build-box"}})
                }
                "/api/ui/control/pair/DONE0000" => {
                    serde_json::json!({"status":"done","rpId":"localhost","check":"1","machine":{"id":M,"name":"x"}})
                }
                _ => return Box::pin(async { Err(crate::Error::network("HTTP 404".into())) }),
            };
            Box::pin(async move { Ok(serde_json::to_vec(&body).unwrap()) })
        }
        fn post_json(
            &self,
            _id: &str,
            path: &str,
            body: Vec<u8>,
        ) -> BoxFuture<'_, crate::Result<(u16, Vec<u8>)>> {
            self.posts
                .lock()
                .unwrap()
                .push((path.into(), serde_json::from_slice(&body).unwrap()));
            let (s, v) = self
                .answers
                .lock()
                .unwrap()
                .pop()
                .unwrap_or((201, serde_json::json!({})));
            Box::pin(async move { Ok((s, serde_json::to_vec(&v).unwrap())) })
        }
    }
    fn rx(origin: &str, rp: Option<&str>, local: bool) -> Rx {
        Rx {
            origin: origin.into(),
            rp: rp.map(Into::into),
            local,
            posts: Mutex::default(),
            answers: Mutex::default(),
        }
    }

    /// A minimal executor: the futures here finish on their own threads.
    fn run<F: Future>(f: F) -> F::Output {
        struct W(std::thread::Thread);
        impl std::task::Wake for W {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = Waker::from(Arc::new(W(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let mut f = std::pin::pin!(f);
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
            std::thread::park();
        }
    }

    #[test]
    fn target_holds_the_rp_rule_against_the_receiver_url() {
        let local = rx("http://127.0.0.1:7819", None, true);
        assert_eq!(
            run(target(&local, "rx1", None)).unwrap(),
            Target {
                rp: "localhost".into(),
                host: "127.0.0.1".into()
            }
        );
        assert_eq!(
            run(target(&local, "rx1", Some("spacesheep.dev")))
                .unwrap_err()
                .code,
            "rp_mismatch"
        );
        assert_eq!(
            run(target(&local, "nope", None)).unwrap_err().code,
            "unknown_receiver"
        );
        let evil = rx("https://evil.example", Some("spacesheep.dev"), false);
        assert_eq!(
            run(target(&evil, "rx1", None)).unwrap_err().code,
            "rp_mismatch"
        );
        let good = rx("https://app.spacesheep.dev", Some("spacesheep.dev"), false);
        assert_eq!(
            run(target(&good, "rx1", Some("spacesheep.dev")))
                .unwrap()
                .host,
            "app.spacesheep.dev"
        );
    }

    #[test]
    fn pairing_is_read_by_rust() {
        let r = rx("http://127.0.0.1:7819", Some("localhost"), true);
        let p = run(pairing(&r, "rx1", "K7Q29XMV")).unwrap();
        assert_eq!(
            (
                p.machine_id.as_str(),
                p.machine_name.as_str(),
                p.check.as_str()
            ),
            (M, "build-box", "482913")
        );
        assert!(run(pairing(&r, "rx1", "DONE0000")).is_err());
        assert!(run(pairing(&r, "rx1", "../x")).is_err());
        assert_eq!(run(machine_name(&r, "rx1", M)), "studio-mac");
        assert_eq!(
            run(machine_name(&r, "rx1", "m_unknownmachine000001")),
            "machine m_unknownm"
        );
    }

    #[test]
    fn the_answer_commands() {
        let p = NativeAnswer::Permission {
            machine: M.into(),
            session: "claude-code:s".into(),
            attention_id: "perm-1".into(),
            decision: "allow".into(),
        };
        let c = command(&p, "pelZkFy2vRgrxlPqTKR6tA", 5).unwrap();
        assert_eq!(
            c,
            format!(
                r#"{{"v":1,"t":"sessionpipe.control","machine":"{M}","kind":"permission.answer","session":"claude-code:s","for":"perm-1","decision":"allow","nonce":"pelZkFy2vRgrxlPqTKR6tA","iat":5}}"#
            )
        );
        let r = NativeAnswer::Reply {
            machine: M.into(),
            session: "claude-code:s".into(),
            text: "ok go".into(),
        };
        assert!(command(&r, "n", 5)
            .unwrap()
            .contains(r#""kind":"prompt","session":"claude-code:s","text":"ok go""#));
        let bad = NativeAnswer::Permission {
            machine: M.into(),
            session: "s".into(),
            attention_id: "a".into(),
            decision: "maybe".into(),
        };
        assert!(command(&bad, "n", 5).is_err());
        assert!(command(
            &NativeAnswer::Reply {
                machine: M.into(),
                session: "s".into(),
                text: "  ".into()
            },
            "n",
            5
        )
        .is_err());
    }

    #[test]
    fn answer_posts_through_the_page_route_and_retries_a_refused_grant_once() {
        let (s, hw, clock) = signer();
        clock.store(now_ms(), std::sync::atomic::Ordering::SeqCst);
        let s = Arc::new(s);
        let r = rx("http://127.0.0.1:7819", Some("localhost"), true);
        let a = NativeAnswer::Permission {
            machine: M.into(),
            session: "claude-code:s".into(),
            attention_id: "perm-1".into(),
            decision: "deny".into(),
        };
        run(answer_with(&s, &r, "rx1", a.clone())).unwrap();
        {
            let posts = r.posts.lock().unwrap();
            let (path, body) = &posts[0];
            assert_eq!(path, "/api/ui/control/send");
            assert_eq!(body["machineId"], M);
            assert!(body["cmd"]
                .as_str()
                .unwrap()
                .contains(r#""decision":"deny""#));
            assert!(body["csig"].is_string() && body["grant"]["str"].is_string());
        }
        assert_eq!(
            hw.prompts.lock().unwrap().len(),
            1,
            "one Touch ID for the grant"
        );
        // The receiver refuses the grant: one fresh grant, then a second refusal is final.
        r.answers.lock().unwrap().extend([
            (422, serde_json::json!({"code":"bad_grant"})),
            (422, serde_json::json!({"code":"bad_grant"})),
        ]);
        assert_eq!(
            run(answer_with(&s, &r, "rx1", a.clone())).unwrap_err().code,
            "refused"
        );
        assert_eq!(r.posts.lock().unwrap().len(), 3);
        assert_eq!(hw.prompts.lock().unwrap().len(), 2);
        // Any other refusal is final at once.
        r.answers.lock().unwrap().push((
            422,
            serde_json::json!({"code":"no_attention","reason":"gone"}),
        ));
        assert!(run(answer_with(&s, &r, "rx1", a))
            .unwrap_err()
            .message
            .contains("gone"));
    }
}
