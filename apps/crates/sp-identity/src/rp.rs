//! The WebAuthn rp rule, enforced natively (arch-identity §6.3 rule 1). A browser gives a
//! passkey this for free: a page can only use a credential for its own site. The app has no
//! origin of its own, so Rust holds the receiver's URL and checks the rp id the receiver
//! claims against it: `host == rp` or `host` ends with `"." + rp`, over https, and plain
//! http only for `localhost`. A receiver at `evil.example` that declares
//! `rp_id: "spacesheep.dev"` gets nothing signed.
//!
//! One addition: a receiver the shell found itself on this Mac's loopback (`local`) is
//! reached at `http://127.0.0.1:<port>` while its rp id is `localhost` or this Mac's own
//! `.local` name (TLS mode). That receiver is this person's own process on this Mac; the
//! rp id still binds every signature (CONTROL.md §3.2), and only names a browser here
//! could also use are allowed.
use crate::Error;

/// `(scheme, host)` of an origin, lower-cased; None when it is not `http(s)://host[:port]`.
pub fn split_origin(origin: &str) -> Option<(String, String)> {
    let (scheme, rest) = origin.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        format!("[{}]", v6.split(']').next()?)
    } else {
        authority.split(':').next()?.to_string()
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme, host.to_ascii_lowercase()))
}

fn loopback(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "[::1]"
        || host.starts_with("127.")
}

/// A well-formed rp id: a DNS name, lower case, no scheme, port or path.
pub fn rp_wellformed(rp: &str) -> bool {
    !rp.is_empty()
        && rp.len() <= 253
        && !rp.starts_with('.')
        && !rp.ends_with('.')
        && rp
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
}

/// May the app sign for `rp` through the receiver at `origin`?
pub fn check(rp: &str, origin: &str, local: bool) -> Result<(), Error> {
    let refuse = || {
        Error::new(
            "rp_mismatch",
            format!("{origin} can't ask for signatures for {rp}"),
        )
    };
    if !rp_wellformed(rp) {
        return Err(refuse());
    }
    let (scheme, host) = split_origin(origin).ok_or_else(refuse)?;
    let under = host == rp || host.ends_with(&format!(".{rp}"));
    if under && (scheme == "https" || rp == "localhost") {
        return Ok(());
    }
    if local && loopback(&host) && (rp == "localhost" || rp.ends_with(".local")) {
        return Ok(());
    }
    Err(refuse())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_webauthn_rule() {
        assert!(check("spacesheep.dev", "https://spacesheep.dev", false).is_ok());
        assert!(check("spacesheep.dev", "https://app.spacesheep.dev:8443", false).is_ok());
        // A receiver claiming someone else's rp id.
        assert_eq!(
            check("spacesheep.dev", "https://evil.example", false)
                .unwrap_err()
                .code,
            "rp_mismatch"
        );
        // A look-alike that only ends with the rp id.
        assert!(check("spacesheep.dev", "https://notspacesheep.dev", false).is_err());
        // Plain http only for localhost.
        assert!(check("spacesheep.dev", "http://spacesheep.dev", false).is_err());
        assert!(check("localhost", "http://localhost:7373", false).is_ok());
        assert!(check("studio-mac.local", "https://studio-mac.local:7373", false).is_ok());
        assert!(check("studio-mac.local", "http://studio-mac.local:7373", false).is_err());
    }

    #[test]
    fn the_local_receiver_on_loopback() {
        assert!(check("localhost", "http://127.0.0.1:7373", true).is_ok());
        assert!(check("studio-mac.local", "http://127.0.0.1:7373", true).is_ok());
        assert!(check("localhost", "http://[::1]:7373", true).is_ok());
        // Not found by the shell on loopback: the plain rule.
        assert!(check("localhost", "http://127.0.0.1:7373", false).is_err());
        // Loopback still can't claim a public name.
        assert!(check("spacesheep.dev", "http://127.0.0.1:7373", true).is_err());
        // A LAN address is not loopback.
        assert!(check("localhost", "http://192.168.1.20:7373", true).is_err());
    }

    #[test]
    fn malformed_ids_and_origins() {
        for rp in [
            "",
            "Spacesheep.dev",
            "spacesheep.dev:443",
            "https://spacesheep.dev",
            ".dev",
            "a/b",
        ] {
            assert!(check(rp, "https://spacesheep.dev", false).is_err(), "{rp}");
        }
        for o in [
            "spacesheep.dev",
            "ftp://spacesheep.dev",
            "https://",
            "https://user@spacesheep.dev",
            "tauri://localhost",
        ] {
            assert!(check("spacesheep.dev", o, false).is_err(), "{o}");
        }
        assert_eq!(
            split_origin("HTTPS://Studio-Mac.LOCAL:7373/x"),
            Some(("https".into(), "studio-mac.local".into()))
        );
    }
}
