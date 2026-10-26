//! The signer itself: one device key per rp id (Touch ID each use), the day key and its
//! grant, and the three ways they sign (arch-identity §6.1, §6.5). Synchronous and free of
//! Tauri, so every rule here is tested with stand-in hardware.
use crate::device::{self, DeviceKey, Purpose};
use crate::rate::{Limits, Op};
use crate::se::Hardware;
use crate::validate::{self, Mode};
use crate::vault::{day_account, device_account, Vault};
use crate::{b64, prompt, Error};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A grant this close to its end is renewed first, so a command never lands outside it.
pub const RENEW_BEFORE_MS: u64 = 2 * 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DeviceRecord {
    /// The enclave blob (standard base64).
    blob: String,
    /// SPKI, base64url.
    spki: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DayRecord {
    blob: String,
    spki: String,
    /// The grant string, exactly as signed.
    str: String,
    /// The device key's signature over it (base64url r‖s).
    sig: String,
    exp: u64,
}

/// What `status` answers: nothing is made and no prompt shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<DeviceKey>,
    pub grant_exp: Option<u64>,
}

/// Why this device holds no key, in the app's words (NATIVE-SPEC §5.4, §6).
pub fn unavailable_reason() -> String {
    if cfg!(target_os = "ios") {
        "Sending needs a real iPhone".into()
    } else {
        "Sending needs a Mac with a Secure Enclave and Touch ID or a password".into()
    }
}

pub struct Signer {
    hw: Arc<dyn Hardware>,
    /// Device key records: the keychain, in every build.
    devices: Arc<dyn Vault>,
    /// Day keys and grants: the keychain in release builds, memory in dev builds.
    days: Arc<dyn Vault>,
    limits: Mutex<Limits>,
    prompting: AtomicBool,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// At most one Touch ID sheet at a time; a second request answers `busy`.
struct Prompting<'a>(&'a AtomicBool);
impl Drop for Prompting<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Signer {
    pub fn new(hw: Arc<dyn Hardware>, devices: Arc<dyn Vault>, days: Arc<dyn Vault>) -> Self {
        Self::with_clock(hw, devices, days, Arc::new(now_ms))
    }

    pub fn with_clock(
        hw: Arc<dyn Hardware>,
        devices: Arc<dyn Vault>,
        days: Arc<dyn Vault>,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            hw,
            devices,
            days,
            limits: Mutex::new(Limits::default()),
            prompting: AtomicBool::new(false),
            clock,
        }
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn prompt_slot(&self) -> Result<Prompting<'_>, Error> {
        if self
            .prompting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Error::new("busy", "Finish the Touch ID prompt first"));
        }
        Ok(Prompting(&self.prompting))
    }

    fn limit(&self, rp: &str, op: Op, retry: bool) -> Result<(), Error> {
        self.limits
            .lock()
            .unwrap()
            .prompt(rp, op, self.now(), retry)
            .map_err(|_| Error::new("rate_limited", "Slow down: too many Touch ID requests"))
    }

    fn stored_device(&self, rp: &str) -> Option<DeviceRecord> {
        serde_json::from_slice(&self.devices.get(&device_account(rp))?).ok()
    }

    fn stored_day(&self, rp: &str) -> Option<DayRecord> {
        let d: DayRecord = serde_json::from_slice(&self.days.get(&day_account(rp))?).ok()?;
        (d.exp > self.now() + RENEW_BEFORE_MS).then_some(d)
    }

    pub fn status(&self, rp: &str) -> Status {
        let available = self.hw.available();
        Status {
            available,
            reason: (!available).then(unavailable_reason),
            key: self
                .stored_device(rp)
                .and_then(|d| b64::dec(&d.spki))
                .map(|s| DeviceKey::from_spki(&s)),
            grant_exp: self.stored_day(rp).map(|d| d.exp),
        }
    }

    /// The device key for `rp`, made on first use (one per rp id, so no two receivers see
    /// the same public key). Making one shows no prompt.
    fn device(&self, rp: &str) -> Result<DeviceRecord, Error> {
        if let Some(d) = self.stored_device(rp) {
            return Ok(d);
        }
        if !self.hw.available() {
            return Err(Error::new("unavailable", unavailable_reason()));
        }
        let (blob, spki) = self.hw.make(true)?;
        let d = DeviceRecord {
            blob: b64::std_enc(&blob),
            spki: b64::enc(&spki),
        };
        self.devices
            .set(&device_account(rp), &serde_json::to_vec(&d).expect("json"))?;
        log::info!(
            "identity: made the device key for {rp} ({})",
            device::key_id(&spki)
        );
        Ok(d)
    }

    pub fn key(&self, rp: &str) -> Result<DeviceKey, Error> {
        let d = self.device(rp)?;
        Ok(DeviceKey::from_spki(
            &b64::dec(&d.spki).expect("stored base64url"),
        ))
    }

    fn sign_with_device(
        &self,
        d: &DeviceRecord,
        msg: &[u8],
        reason: &str,
    ) -> Result<String, Error> {
        let blob = b64::std_dec(&d.blob)
            .ok_or_else(|| Error::new("failed", "the stored key is unreadable"))?;
        Ok(b64::enc(&self.hw.sign(&blob, msg, Some(reason))?))
    }

    /// The day grant for `rp`: the held one while it lasts, else a new day key vouched for
    /// with one Touch ID ("send to your machines through <host> for the next 24 hours").
    /// `fresh`: the verifier refused the last one; it allows one such retry.
    fn grant(&self, rp: &str, host: &str, fresh: bool) -> Result<DayRecord, Error> {
        if !fresh {
            if let Some(d) = self.stored_day(rp) {
                return Ok(d);
            }
        }
        self.limit(rp, Op::Grant, fresh)?;
        let dev = self.device(rp)?;
        let _slot = self.prompt_slot()?;
        let (blob, spki) = self.hw.make(false)?;
        let iat = self.now();
        let str = device::grant_string(&spki, iat, rp);
        let msg = device::message(Purpose::Grant, rp, &b64::sha256(str.as_bytes()));
        let sig = self.sign_with_device(&dev, &msg, &prompt::grant(host))?;
        let day = DayRecord {
            blob: b64::std_enc(&blob),
            spki: b64::enc(&spki),
            str,
            sig,
            exp: iat + device::GRANT_MS,
        };
        self.days
            .set(&day_account(rp), &serde_json::to_vec(&day).expect("json"))?;
        Ok(day)
    }

    /// Sign `cmd` for `rp`. Grant: the day key's csig plus the grant (one Touch ID a day).
    /// Confirm: one Touch ID over sha256(cmd), with words from the command and `machine`.
    /// `cmd` None with Grant only takes the grant ("Unlock now") and answers `{}`.
    pub fn sign(
        &self,
        rp: &str,
        host: &str,
        cmd: Option<&str>,
        mode: Mode,
        fresh: bool,
        machine: &str,
    ) -> Result<Value, Error> {
        let checked = match cmd {
            Some(c) => Some(validate::check(c, mode, self.now())?),
            None if mode == Mode::Grant => None,
            None => return Err(Error::refused("a confirm signs a command")),
        };
        match (mode, cmd, checked) {
            (Mode::Confirm, Some(cmd), Some(c)) => {
                self.limit(rp, Op::Confirm, false)?;
                let dev = self.device(rp)?;
                let _slot = self.prompt_slot()?;
                let msg = device::message(Purpose::Confirm, rp, &b64::sha256(cmd.as_bytes()));
                let sig = self.sign_with_device(&dev, &msg, &prompt::confirm(&c, machine))?;
                let id = device::key_id(&b64::dec(&dev.spki).expect("stored"));
                Ok(json!({ "cmd": cmd, "confirm": { "cred": id, "sig": sig } }))
            }
            (Mode::Grant, cmd, _) => {
                let day = self.grant(rp, host, fresh)?;
                let Some(cmd) = cmd else { return Ok(json!({})) };
                self.limits
                    .lock()
                    .unwrap()
                    .csig(rp, self.now())
                    .map_err(|_| {
                        Error::new("rate_limited", "Slow down: too many sends in a row")
                    })?;
                let blob = b64::std_dec(&day.blob)
                    .ok_or_else(|| Error::new("failed", "the day key is unreadable"))?;
                // The day key has no presence flag: no prompt, ~7 ms in the enclave.
                let csig = b64::enc(&self.hw.sign(&blob, cmd.as_bytes(), None)?);
                let dev = self
                    .stored_device(rp)
                    .ok_or_else(|| Error::new("failed", "the device key went missing"))?;
                let id = device::key_id(&b64::dec(&dev.spki).expect("stored"));
                Ok(
                    json!({ "cmd": cmd, "csig": csig, "grant": { "cred": id, "sig": day.sig, "str": day.str } }),
                )
            }
            _ => unreachable!("checked above"),
        }
    }

    /// Approve a pairing: the device key's signature for purpose `pair` over the challenge
    /// Rust computed from the pairing it read itself; the prompt shows machine and digits.
    pub fn pair(
        &self,
        rp: &str,
        machine_id: &str,
        machine_name: &str,
        code: &str,
        check: &str,
    ) -> Result<Value, Error> {
        self.limit(rp, Op::Pair, false)?;
        let dev = self.device(rp)?;
        let _slot = self.prompt_slot()?;
        let msg = device::message(Purpose::Pair, rp, &device::pair_challenge(machine_id, code));
        let sig = self.sign_with_device(&dev, &msg, &prompt::pair(machine_name, check))?;
        let key = DeviceKey::from_spki(&b64::dec(&dev.spki).expect("stored"));
        Ok(json!({ "proof": { "cred": key.id, "sig": sig }, "key": key }))
    }

    pub fn random(&self, n: usize) -> Vec<u8> {
        self.hw.random(n)
    }

    /// Whether this Mac holds a device key for `rp` (made when it was added to a machine,
    /// "Sign with Touch ID"). Reads the keychain only: no key is made, no prompt shows.
    pub fn holds_key(&self, rp: &str) -> bool {
        self.stored_device(rp).is_some()
    }

    /// Delete this rp id's keys from this Mac (the local "sign out of sending").
    pub fn forget(&self, rp: &str) -> Result<(), Error> {
        self.days.delete(&day_account(rp))?;
        self.devices.delete(&device_account(rp))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::vault::Memory;
    use std::sync::atomic::AtomicU64;

    /// Stand-in hardware: "keys" are random ids, "signatures" a hash of key and message, and
    /// every prompt is recorded with its words (no enclave, no finger).
    #[derive(Default)]
    pub struct Fake {
        pub prompts: Mutex<Vec<String>>,
        pub made: Mutex<Vec<bool>>,
        pub cancel: AtomicBool,
        pub none: AtomicBool,
    }
    impl Hardware for Fake {
        fn available(&self) -> bool {
            !self.none.load(Ordering::SeqCst)
        }
        fn make(&self, uv: bool) -> Result<(Vec<u8>, Vec<u8>), Error> {
            self.made.lock().unwrap().push(uv);
            let n = self.made.lock().unwrap().len() as u8;
            Ok((vec![n; 32], [vec![0x30, 0x59], vec![n; 89]].concat()))
        }
        fn sign(&self, blob: &[u8], msg: &[u8], reason: Option<&str>) -> Result<[u8; 64], Error> {
            if let Some(r) = reason {
                self.prompts.lock().unwrap().push(r.into());
                if self.cancel.load(Ordering::SeqCst) {
                    return Err(crate::se::status_error(crate::se::SPID_CANCELLED));
                }
            }
            let h = b64::sha256(&[blob, msg].concat());
            let mut s = [0u8; 64];
            s[..32].copy_from_slice(&h);
            s[32..].copy_from_slice(&h);
            Ok(s)
        }
        fn random(&self, n: usize) -> Vec<u8> {
            vec![9; n]
        }
    }

    pub const T: u64 = 1_790_800_000_000;
    pub const M: &str = "m_testmachine0000000001";

    pub fn signer() -> (Signer, Arc<Fake>, Arc<AtomicU64>) {
        let hw = Arc::new(Fake::default());
        let clock = Arc::new(AtomicU64::new(T));
        let c = clock.clone();
        let s = Signer::with_clock(
            hw.clone(),
            Arc::new(Memory::default()),
            Arc::new(Memory::default()),
            Arc::new(move || c.load(Ordering::SeqCst)),
        );
        (s, hw, clock)
    }

    pub fn prompt_cmd(iat: u64) -> String {
        format!(
            r#"{{"v":1,"t":"sessionpipe.control","machine":"{M}","kind":"prompt","session":"claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e","text":"hi","nonce":"pelZkFy2vRgrxlPqTKR6tA","iat":{iat}}}"#
        )
    }

    #[test]
    fn status_makes_nothing() {
        let (s, hw, _) = signer();
        let st = s.status("localhost");
        assert_eq!(
            st,
            Status {
                available: true,
                reason: None,
                key: None,
                grant_exp: None
            }
        );
        assert!(hw.made.lock().unwrap().is_empty());
        hw.none.store(true, Ordering::SeqCst);
        let st = s.status("localhost");
        assert!(!st.available);
        assert!(st.reason.unwrap().starts_with("Sending needs"));
        assert_eq!(s.key("localhost").unwrap_err().code, "unavailable");
    }

    #[test]
    fn one_device_key_per_rp_with_presence_and_the_device_shape() {
        let (s, hw, _) = signer();
        let a = s.key("localhost").unwrap();
        assert_eq!(s.key("localhost").unwrap(), a);
        let b = s.key("studio-mac.local").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(*hw.made.lock().unwrap(), vec![true, true]);
        assert_eq!(
            (a.alg, a.kind.as_str(), a.store.as_str(), a.uv.as_str()),
            (-7, "device", "hardware", "each-use")
        );
        assert_eq!(a.id, device::key_id(&b64::dec(&a.spki).unwrap()));
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["type"], "device");
        assert!(
            hw.prompts.lock().unwrap().is_empty(),
            "making a key asks nothing"
        );
    }

    #[test]
    fn a_grant_once_then_silent_csigs() {
        let (s, hw, _) = signer();
        let out = s
            .sign(
                "localhost",
                "127.0.0.1",
                Some(&prompt_cmd(T)),
                Mode::Grant,
                false,
                "studio-mac",
            )
            .unwrap();
        assert_eq!(out["cmd"], prompt_cmd(T));
        assert_eq!(out["csig"].as_str().unwrap().len(), 86);
        let g = &out["grant"];
        let str = g["str"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(str).unwrap();
        assert_eq!(parsed["t"], "sessionpipe.grant");
        assert_eq!(parsed["rp"], "localhost");
        assert_eq!(
            parsed["exp"].as_u64().unwrap() - parsed["iat"].as_u64().unwrap(),
            device::GRANT_MS
        );
        assert_eq!(
            g.as_object().unwrap().len(),
            3,
            "cred, sig, str and nothing else"
        );
        assert_eq!(
            *hw.prompts.lock().unwrap(),
            vec!["send to your machines through 127.0.0.1 for the next 24 hours".to_string()]
        );
        // The day key: made without presence. Then more sends: no prompt at all.
        assert_eq!(*hw.made.lock().unwrap(), vec![true, false]);
        for _ in 0..5 {
            s.sign(
                "localhost",
                "127.0.0.1",
                Some(&prompt_cmd(T)),
                Mode::Grant,
                false,
                "m",
            )
            .unwrap();
        }
        assert_eq!(hw.prompts.lock().unwrap().len(), 1);
        assert!(s.status("localhost").grant_exp.is_some());
    }

    #[test]
    fn a_refused_grant_gets_one_fresh_one_not_two() {
        let (s, hw, clock) = signer();
        s.sign(
            "localhost",
            "h",
            Some(&prompt_cmd(T)),
            Mode::Grant,
            false,
            "m",
        )
        .unwrap();
        clock.store(T + 30_000, Ordering::SeqCst);
        s.sign(
            "localhost",
            "h",
            Some(&prompt_cmd(T + 30_000)),
            Mode::Grant,
            true,
            "m",
        )
        .unwrap();
        let e = s
            .sign(
                "localhost",
                "h",
                Some(&prompt_cmd(T + 30_000)),
                Mode::Grant,
                true,
                "m",
            )
            .unwrap_err();
        assert_eq!(e.code, "rate_limited");
        assert_eq!(hw.prompts.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_grant_near_its_end_is_renewed() {
        let (s, hw, clock) = signer();
        s.sign("localhost", "h", None, Mode::Grant, false, "m")
            .unwrap();
        let later = T + device::GRANT_MS - RENEW_BEFORE_MS + 1;
        clock.store(later, Ordering::SeqCst);
        s.sign(
            "localhost",
            "h",
            Some(&prompt_cmd(later)),
            Mode::Grant,
            false,
            "m",
        )
        .unwrap();
        assert_eq!(hw.prompts.lock().unwrap().len(), 2);
    }

    #[test]
    fn confirms_and_key_add_always_prompt_with_words_from_the_command() {
        let (s, hw, _) = signer();
        let out = s
            .sign(
                "localhost",
                "h",
                Some(&prompt_cmd(T)),
                Mode::Confirm,
                false,
                "studio-mac",
            )
            .unwrap();
        assert_eq!(out["confirm"].as_object().unwrap().len(), 2);
        let spki = vec![7u8; 91];
        let add = format!(
            r#"{{"v":1,"t":"sessionpipe.control","machine":"{M}","kind":"key.add","session":"sessionpipe:keys","key":{{"id":"{}","alg":-7,"spki":"{}","type":"device","store":"hardware","uv":"each-use"}},"name":"iPhone","nonce":"pelZkFy2vRgrxlPqTKR6tA","iat":{T}}}"#,
            device::key_id(&spki),
            b64::enc(&spki)
        );
        assert_eq!(
            s.sign(
                "localhost",
                "h",
                Some(&add),
                Mode::Grant,
                false,
                "studio-mac"
            )
            .unwrap_err()
            .code,
            "refused"
        );
        s.sign(
            "localhost",
            "h",
            Some(&add),
            Mode::Confirm,
            false,
            "studio-mac",
        )
        .unwrap();
        assert_eq!(
            *hw.prompts.lock().unwrap(),
            vec![
                "send a message to a session on studio-mac".to_string(),
                "trust “iPhone” on studio-mac".to_string()
            ]
        );
    }

    #[test]
    fn a_cancelled_prompt_signs_nothing_and_frees_the_slot() {
        let (s, hw, _) = signer();
        hw.cancel.store(true, Ordering::SeqCst);
        let e = s
            .sign(
                "localhost",
                "h",
                Some(&prompt_cmd(T)),
                Mode::Grant,
                false,
                "m",
            )
            .unwrap_err();
        assert_eq!(e.code, "cancelled");
        assert!(s.status("localhost").grant_exp.is_none());
        hw.cancel.store(false, Ordering::SeqCst);
        assert!(s
            .sign(
                "localhost",
                "h",
                Some(&prompt_cmd(T)),
                Mode::Confirm,
                false,
                "m"
            )
            .is_ok());
    }

    #[test]
    fn one_prompt_at_a_time() {
        let (s, _, _) = signer();
        let held = s.prompt_slot().unwrap();
        let e = s
            .sign(
                "localhost",
                "h",
                Some(&prompt_cmd(T)),
                Mode::Confirm,
                false,
                "m",
            )
            .unwrap_err();
        assert_eq!(e.code, "busy");
        drop(held);
        assert!(s
            .sign(
                "localhost",
                "h",
                Some(&prompt_cmd(T)),
                Mode::Confirm,
                false,
                "m"
            )
            .is_ok());
    }

    #[test]
    fn pairing_names_machine_and_digits() {
        let (s, hw, _) = signer();
        let out = s
            .pair("localhost", M, "build-box", "K7Q2-9XMV", "482913")
            .unwrap();
        assert_eq!(out["key"]["type"], "device");
        assert_eq!(out["proof"]["cred"], out["key"]["id"]);
        assert_eq!(
            *hw.prompts.lock().unwrap(),
            vec!["pair build-box — check 482 913".to_string()]
        );
    }

    #[test]
    fn forget_deletes_both() {
        let (s, _, _) = signer();
        s.sign("localhost", "h", None, Mode::Grant, false, "m")
            .unwrap();
        assert!(s.status("localhost").key.is_some());
        s.forget("localhost").unwrap();
        let st = s.status("localhost");
        assert!(st.key.is_none() && st.grant_exp.is_none());
    }

    #[test]
    fn holds_key_only_once_one_is_made_and_until_forgotten() {
        let (s, hw, _) = signer();
        assert!(!s.holds_key("localhost"));
        // Asking makes nothing and prompts nobody.
        assert!(hw.prompts.lock().unwrap().is_empty());
        s.key("localhost").unwrap();
        assert!(s.holds_key("localhost"));
        assert!(!s.holds_key("spacesheep.dev"), "one key per rp id");
        s.forget("localhost").unwrap();
        assert!(!s.holds_key("localhost"));
    }

    #[test]
    fn a_confirm_needs_a_command() {
        let (s, _, _) = signer();
        assert_eq!(
            s.sign("localhost", "h", None, Mode::Confirm, false, "m")
                .unwrap_err()
                .code,
            "refused"
        );
    }
}
