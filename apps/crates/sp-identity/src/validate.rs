//! What Rust checks before it signs (arch-identity §6.3 rule 2–3): a cheap structural
//! subset of sessionpipe's verifier, so an XSS or a compromised dependency in the page can
//! ask for nothing strange. The machine stays the gate; this only narrows what the app will
//! put its name to. The bytes signed are exactly the bytes handed in.
use crate::{b64, device, Error};
use serde_json::{Map, Value};

/// CONTROL.md §3.1: the whole command, in UTF-16 code units.
pub const CMD_MAX: usize = 48_000;
/// `iat` must be this close to the signer's own clock: nobody stockpiles commands.
pub const IAT_SLACK_MS: i64 = 60_000;
pub const KINDS: [&str; 5] = ["prompt", "permission.answer", "cancel", "start", "key.add"];
pub const KEY_STORE_SESSION: &str = "sessionpipe:keys";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Grant,
    Confirm,
}

/// The fields the prompt and the rate limits need, read from a command that passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub kind: String,
    pub machine: String,
    pub session: String,
    pub decision: Option<String>,
    /// key.add: what the device is called.
    pub name: Option<String>,
}

fn refuse(why: impl Into<String>) -> Error {
    Error::refused(why)
}

fn machine_ok(s: &str) -> bool {
    s.strip_prefix("m_")
        .is_some_and(|r| b64::is_b64url(r, 16, 40))
}

/// A key a key.add may carry: a passkey `{id, alg, spki}`, or a device key with exactly
/// `type: device`, `store: hardware`, `uv: each-use`, alg -7 and id = SHA-256(spki).
pub fn key_ok(k: &Map<String, Value>) -> bool {
    let id = k.get("id").and_then(Value::as_str).unwrap_or("");
    let spki = k.get("spki").and_then(Value::as_str).unwrap_or("");
    let alg = k.get("alg").and_then(Value::as_i64);
    if !b64::is_b64url(id, 16, 1400)
        || !b64::is_b64url(spki, 40, 2000)
        || !matches!(alg, Some(-7) | Some(-257))
    {
        return false;
    }
    match k.get("type") {
        None => k
            .keys()
            .all(|f| matches!(f.as_str(), "id" | "alg" | "spki")),
        Some(t) => {
            t == "device"
                && alg == Some(-7)
                && k.get("store").and_then(Value::as_str) == Some("hardware")
                && k.get("uv").and_then(Value::as_str) == Some("each-use")
                && k.keys()
                    .all(|f| matches!(f.as_str(), "id" | "alg" | "spki" | "type" | "store" | "uv"))
                && b64::dec(spki).is_some_and(|b| device::key_id(&b) == id)
        }
    }
}

/// Check `cmd` for signing in `mode` at `now_ms`.
pub fn check(cmd: &str, mode: Mode, now_ms: u64) -> Result<Checked, Error> {
    if cmd.is_empty() || cmd.encode_utf16().count() > CMD_MAX {
        return Err(refuse(format!("a command is 1 to {CMD_MAX} characters")));
    }
    let v: Value = serde_json::from_str(cmd).map_err(|_| refuse("the command is not JSON"))?;
    let c = v
        .as_object()
        .ok_or_else(|| refuse("the command is not an object"))?;
    if c.get("v") != Some(&Value::from(1))
        || c.get("t").and_then(Value::as_str) != Some("sessionpipe.control")
    {
        return Err(refuse("not a sessionpipe control command"));
    }
    let s = |k: &str| c.get(k).and_then(Value::as_str);
    let kind = s("kind")
        .filter(|k| KINDS.contains(k))
        .ok_or_else(|| refuse("a kind the app doesn't sign"))?;
    let machine = s("machine")
        .filter(|m| machine_ok(m))
        .ok_or_else(|| refuse("which machine?"))?;
    let session = s("session")
        .filter(|x| !x.is_empty() && x.len() <= 170)
        .ok_or_else(|| refuse("which session?"))?;
    if !s("nonce").is_some_and(|n| b64::is_b64url(n, 22, 64)) {
        return Err(refuse("the nonce is missing or malformed"));
    }
    let iat = c
        .get("iat")
        .and_then(Value::as_u64)
        .ok_or_else(|| refuse("the command has no signing time"))?;
    if (iat as i64 - now_ms as i64).abs() > IAT_SLACK_MS {
        return Err(refuse(
            "the command's time is more than a minute off this Mac's clock",
        ));
    }
    let mut name = None;
    if kind == "key.add" {
        // Trusting a device always takes Touch ID, with its name in the prompt (app policy,
        // NATIVE-SPEC §5.3): never under the day grant.
        if mode != Mode::Confirm {
            return Err(refuse(
                "a key.add is signed with Touch ID, never under the day grant",
            ));
        }
        if session != KEY_STORE_SESSION {
            return Err(refuse("a key.add names sessionpipe:keys"));
        }
        let k = c
            .get("key")
            .and_then(Value::as_object)
            .ok_or_else(|| refuse("a key.add carries a key"))?;
        if !key_ok(k) {
            return Err(refuse("the key is in a shape no machine takes"));
        }
        name = s("name").map(str::to_string);
    } else if c.contains_key("key") {
        return Err(refuse("only a key.add carries a key"));
    }
    Ok(Checked {
        kind: kind.into(),
        machine: machine.into(),
        session: session.into(),
        decision: s("decision").map(str::to_string),
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: u64 = 1_790_800_000_000;
    const M: &str = "m_testmachine0000000001";

    fn cmd(over: Value) -> String {
        let mut base = json!({"v":1,"t":"sessionpipe.control","machine":M,"kind":"prompt",
            "session":"claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e","text":"hi",
            "nonce":"pelZkFy2vRgrxlPqTKR6tA","iat":NOW});
        for (k, v) in over.as_object().unwrap() {
            if v.is_null() {
                base.as_object_mut().unwrap().remove(k);
            } else {
                base[k] = v.clone();
            }
        }
        base.to_string()
    }
    fn device_key() -> Value {
        let spki = vec![7u8; 91];
        json!({"id": device::key_id(&spki), "alg": -7, "spki": b64::enc(&spki), "type":"device","store":"hardware","uv":"each-use"})
    }

    #[test]
    fn a_good_command_passes_and_says_what_it_is() {
        let c = check(&cmd(json!({})), Mode::Grant, NOW).unwrap();
        assert_eq!((c.kind.as_str(), c.machine.as_str()), ("prompt", M));
        let pa =
            cmd(json!({"kind":"permission.answer","text":null,"for":"perm-1","decision":"allow"}));
        assert_eq!(
            check(&pa, Mode::Grant, NOW).unwrap().decision.as_deref(),
            Some("allow")
        );
    }

    #[test]
    fn iat_within_a_minute_of_this_clock() {
        assert!(check(&cmd(json!({"iat": NOW + 60_000})), Mode::Grant, NOW).is_ok());
        assert!(check(&cmd(json!({"iat": NOW - 60_000})), Mode::Grant, NOW).is_ok());
        assert!(check(&cmd(json!({"iat": NOW + 60_001})), Mode::Grant, NOW).is_err());
        assert!(check(&cmd(json!({"iat": NOW - 3_600_000})), Mode::Grant, NOW).is_err());
        assert!(check(&cmd(json!({"iat": 1.5})), Mode::Grant, NOW).is_err());
        assert!(check(&cmd(json!({"iat": null})), Mode::Grant, NOW).is_err());
    }

    #[test]
    fn the_shape() {
        for bad in [
            json!({"v": 2}),
            json!({"t": "ss-machine-cmd"}),
            json!({"kind": "shell"}),
            json!({"machine": "m_short"}),
            json!({"machine": "x_testmachine0000000001"}),
            json!({"nonce": "short"}),
            json!({"nonce": "a+b/c=====================" }),
            json!({"session": ""}),
            json!({"key": device_key()}),
        ] {
            assert!(check(&cmd(bad.clone()), Mode::Grant, NOW).is_err(), "{bad}");
        }
        assert!(check("not json", Mode::Grant, NOW).is_err());
        assert!(check("[1]", Mode::Grant, NOW).is_err());
        assert!(check("", Mode::Grant, NOW).is_err());
    }

    #[test]
    fn the_size_limit_counts_utf16_units() {
        let long = "x".repeat(CMD_MAX);
        assert!(check(&cmd(json!({"text": long})), Mode::Grant, NOW).is_err());
        // 15 000 astral characters are 30 000 UTF-16 units: under the cap.
        let astral = "😀".repeat(15_000);
        assert!(check(&cmd(json!({"text": astral})), Mode::Grant, NOW).is_ok());
    }

    #[test]
    fn key_add_only_as_a_confirm_and_only_good_keys() {
        let add = |key: Value| {
            cmd(
                json!({"kind":"key.add","session":KEY_STORE_SESSION,"text":null,"key":key,"name":"iPhone"}),
            )
        };
        let ok = add(device_key());
        assert_eq!(check(&ok, Mode::Grant, NOW).unwrap_err().code, "refused");
        assert_eq!(
            check(&ok, Mode::Confirm, NOW).unwrap().name.as_deref(),
            Some("iPhone")
        );
        let passkey = json!({"id":"AAAAAAAAAAAAAAAAAAAAAA","alg":-257,"spki":"A".repeat(60)});
        assert!(check(&add(passkey.clone()), Mode::Confirm, NOW).is_ok());
        let mut bad = vec![];
        for (k, v) in [
            ("store", json!("software")),
            ("uv", json!("once")),
            ("alg", json!(-257)),
            ("type", json!("tpm")),
            ("extra", json!(1)),
        ] {
            let mut key = device_key();
            key[k] = v;
            bad.push(key);
        }
        let mut wrong_id = device_key();
        wrong_id["id"] = json!(b64::enc(&[0u8; 32]));
        bad.push(wrong_id);
        let mut pk_store = passkey.clone();
        pk_store["store"] = json!("hardware");
        bad.push(pk_store);
        for key in bad {
            assert!(
                check(&add(key.clone()), Mode::Confirm, NOW).is_err(),
                "{key}"
            );
        }
        let other_session = cmd(json!({"kind":"key.add","text":null,"key":device_key()}));
        assert!(check(&other_session, Mode::Confirm, NOW).is_err());
    }
}
