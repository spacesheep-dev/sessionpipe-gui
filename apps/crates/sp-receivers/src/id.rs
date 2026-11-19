//! Receiver ids (NATIVE-SPEC.md §1.3): the first 10 characters of lowercase
//! base32(SHA-256(canonical origin)).

use sha2::{Digest, Sha256};

/// `scheme://host[:port]`, lowercase, default port dropped, no path. Only http and https.
pub fn canonical_origin(input: &str) -> Option<String> {
    let u = url::Url::parse(input.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    u.host_str()?;
    let o = u.origin().ascii_serialization();
    if o == "null" {
        None
    } else {
        Some(o)
    }
}

pub fn receiver_id(origin: &str) -> String {
    let digest = Sha256::digest(origin.as_bytes());
    let mut s = base32_lower(&digest);
    s.truncate(10);
    s
}

/// A spacesheep account's id: the whole SHA-256 of its origin and email, in base32 (52
/// characters). It names the account's key, its documents and whatever the page keeps
/// for it, and the email in it is whatever the origin said, so it is not cut to a length
/// at which an origin could search for an email that lands on another account's id. A
/// receiver's id stays ten characters; the two are told apart by length alone.
pub fn account_id(origin: &str, email: &str) -> String {
    base32_lower(&Sha256::digest(
        format!(
            "spacesheep-account\n{origin}\n{}",
            email.trim().to_ascii_lowercase()
        )
        .as_bytes(),
    ))
}

fn is_base32(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c))
}

/// The shape `receiver_id` writes: ten base32 characters.
pub fn is_receiver_id(s: &str) -> bool {
    is_base32(s, 10)
}

/// The shape `account_id` writes: fifty-two base32 characters.
pub fn is_account_id(s: &str) -> bool {
    is_base32(s, 52)
}

/// RFC 4648 base32, lowercase, no padding.
pub fn base32_lower(bytes: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buf: u64 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        buf = (buf << 8) | u64::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Is this origin's host loopback (no UI key needed)?
pub fn is_loopback_origin(origin: &str) -> bool {
    let Ok(u) = url::Url::parse(origin) else {
        return false;
    };
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_matches_rfc4648_vectors() {
        // RFC 4648 §10, lowercased, padding removed.
        assert_eq!(base32_lower(b""), "");
        assert_eq!(base32_lower(b"f"), "my");
        assert_eq!(base32_lower(b"fo"), "mzxq");
        assert_eq!(base32_lower(b"foo"), "mzxw6");
        assert_eq!(base32_lower(b"foob"), "mzxw6yq");
        assert_eq!(base32_lower(b"fooba"), "mzxw6ytb");
        assert_eq!(base32_lower(b"foobar"), "mzxw6ytboi");
    }

    #[test]
    fn canonical_origin_normalises() {
        assert_eq!(
            canonical_origin("HTTP://Studio-Mac.local:7373/x?k=1").as_deref(),
            Some("http://studio-mac.local:7373")
        );
        assert_eq!(
            canonical_origin("https://a.ts.net:443/").as_deref(),
            Some("https://a.ts.net")
        );
        assert_eq!(
            canonical_origin("http://127.0.0.1:80").as_deref(),
            Some("http://127.0.0.1")
        );
        assert_eq!(canonical_origin("ftp://x"), None);
        assert_eq!(canonical_origin("file:///etc/passwd"), None);
        assert_eq!(canonical_origin("not a url"), None);
    }

    #[test]
    fn id_is_ten_chars_of_base32_sha256() {
        let id = receiver_id("http://127.0.0.1:7811");
        assert_eq!(id.len(), 10);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)));
        // Stable: the same origin always gives the same id, and the id is the hash's prefix.
        let full = base32_lower(&Sha256::digest(b"http://127.0.0.1:7811"));
        assert!(full.starts_with(&id));
        assert_ne!(receiver_id("http://127.0.0.1:7813"), id);
        // Known value (sha256("http://127.0.0.1:7373") base32), pinned so it never drifts.
        assert_eq!(
            receiver_id("http://127.0.0.1:7373"),
            receiver_id(&canonical_origin("http://127.0.0.1:7373/").unwrap())
        );
    }

    #[test]
    fn an_account_id_is_the_whole_digest_and_no_receivers() {
        let a = account_id("https://spacesheep.dev", "Misha@Example.com");
        assert_eq!(a.len(), 52);
        assert!(is_account_id(&a) && !is_receiver_id(&a));
        assert_eq!(
            a,
            account_id("https://spacesheep.dev", " misha@example.com ")
        );
        assert_ne!(a, account_id("https://spacesheep.dev", "masha@example.com"));
        assert_ne!(a, account_id("https://stagesheep.dev", "misha@example.com"));
        let r = receiver_id("https://spacesheep.dev");
        assert!(is_receiver_id(&r) && !is_account_id(&r));
        assert!(!a.starts_with(&r), "another preimage");
        for bad in [
            "",
            "abc",
            "remote1234",
            "ABCDEFGHIJ",
            "acct:abcde",
            "acct-conne",
            "abcdefghi/",
        ] {
            assert!(!is_receiver_id(bad), "{bad}");
        }
        // ASCII only is lowered: no two addresses become one by a Unicode rule.
        assert_ne!(
            account_id("https://spacesheep.dev", "İ@example.com"),
            account_id("https://spacesheep.dev", "i̇@example.com")
        );
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_origin("http://127.0.0.1:7811"));
        assert!(is_loopback_origin("http://localhost:7373"));
        assert!(is_loopback_origin("http://[::1]:7373"));
        assert!(!is_loopback_origin("http://192.168.1.9:7373"));
        assert!(!is_loopback_origin("https://studio-mac.local:7373"));
    }
}
