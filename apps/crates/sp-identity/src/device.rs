//! The device key's fixed formats (sessionpipe CONTROL.md §2, §3.2): its record, its id, the
//! message it signs, and the grant string the day key is vouched for with.
use crate::b64;
use serde::Serialize;

pub const DEVICE_CONTEXT: &str = "sessionpipe.device.v1";
pub const GRANT_TYPE: &str = "sessionpipe.grant";
/// A grant lasts a day less a minute, so clock slack never makes it longer than one.
pub const GRANT_MS: u64 = 24 * 3_600_000 - 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Grant,
    Confirm,
    Pair,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Purpose::Grant => "grant",
            Purpose::Confirm => "confirm",
            Purpose::Pair => "pair",
        }
    }
}

/// The exact bytes a device key signs: four lines, no newline at the end, the challenge in
/// base64url without padding.
pub fn message(purpose: Purpose, rp: &str, challenge: &[u8; 32]) -> Vec<u8> {
    format!(
        "{DEVICE_CONTEXT}\n{}\n{rp}\n{}",
        purpose.as_str(),
        b64::enc(challenge)
    )
    .into_bytes()
}

/// The pairing challenge a passkey would sign: sha256("sessionpipe.pair:<machine>:<code>").
pub fn pair_challenge(machine: &str, code: &str) -> [u8; 32] {
    b64::sha256(format!("sessionpipe.pair:{machine}:{code}").as_bytes())
}

/// A device key's id: the SHA-256 of its SPKI, base64url, 43 characters.
pub fn key_id(spki: &[u8]) -> String {
    b64::enc(&b64::sha256(spki))
}

/// The device key as a machine stores it (control-key.json, the device shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct DeviceKey {
    pub id: String,
    pub alg: i32,
    pub spki: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub store: String,
    pub uv: String,
}

impl DeviceKey {
    pub fn from_spki(spki: &[u8]) -> Self {
        Self {
            id: key_id(spki),
            alg: -7,
            spki: b64::enc(spki),
            kind: "device".into(),
            store: "hardware".into(),
            uv: "each-use".into(),
        }
    }
}

/// The grant string, written here and never by the webview:
/// `{"v":1,"t":"sessionpipe.grant","pub":…,"iat":…,"exp":…,"rp":…}` in that order.
pub fn grant_string(day_spki: &[u8], iat: u64, rp: &str) -> String {
    #[derive(Serialize)]
    struct G<'a> {
        v: u8,
        t: &'a str,
        #[serde(rename = "pub")]
        public: String,
        iat: u64,
        exp: u64,
        rp: &'a str,
    }
    serde_json::to_string(&G {
        v: 1,
        t: GRANT_TYPE,
        public: b64::enc(day_spki),
        iat,
        exp: iat + GRANT_MS,
        rp,
    })
    .expect("a grant serialises")
}
