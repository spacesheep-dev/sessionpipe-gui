//! The system's keychain behind `KeyStore::Keychain`: generic passwords, one per name,
//! under a service of the app's own.
//!
//! - macOS: the login keychain, as the Mac app has always kept receiver keys.
//! - iOS: the data protection keychain, each item made
//!   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable once the phone has been
//!   unlocked since it started (the Hub reads a key while the screen is locked, for a poll
//!   still in flight), never part of a backup or of iCloud Keychain, and gone with the
//!   phone. An item that can't be written is an error; nothing falls back to a file.
//! - elsewhere: no store yet (keys stay where `KeyStore::File` or `Memory` put them).
//!
//! This file uses only `std` and `security-framework`, so it can be type-checked for an
//! iPhone on its own, without the rest of the crate's build.

#[cfg(any(target_os = "macos", target_os = "ios"))]
use security_framework::passwords::delete_generic_password;

/// `errSecItemNotFound`.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
pub fn get(service: &str, account: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(service, account)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

#[cfg(target_os = "macos")]
pub fn set(service: &str, account: &str, key: &str) -> std::io::Result<()> {
    security_framework::passwords::set_generic_password(service, account, key.as_bytes())
        .map_err(std::io::Error::other)
}

#[cfg(target_os = "ios")]
pub fn get(service: &str, account: &str) -> Option<String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    generic_password(PasswordOptions::new_generic_password(service, account))
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

/// Deleted, then added: an item's protection is fixed when it is made, so an older item
/// is never updated into keeping a weaker one.
#[cfg(target_os = "ios")]
pub fn set(service: &str, account: &str, key: &str) -> std::io::Result<()> {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{set_generic_password_options, PasswordOptions};
    delete(service, account)?;
    // No flags: the protection class alone, no Face ID on every read (the Hub reads the
    // key for each request it forwards).
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
        0,
    )
    .map_err(std::io::Error::other)?;
    let mut options = PasswordOptions::new_generic_password(service, account);
    options.set_access_control(access);
    set_generic_password_options(key.as_bytes(), options).map_err(std::io::Error::other)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn delete(service: &str, account: &str) -> std::io::Result<()> {
    match delete_generic_password(service, account) {
        Ok(()) => Ok(()),
        // Nothing to delete.
        Err(e) if e.code() == NOT_FOUND => Ok(()),
        Err(e) => Err(std::io::Error::other(e)),
    }
}

/// Deletes every item under `service`. An iPhone keeps keychain items when the app is
/// deleted, while the list that named them goes with the app's container: on the first
/// start with no list, whatever is under the account service belongs to an install that
/// is gone, and nothing here could ever find it again to delete it.
#[cfg(target_os = "ios")]
pub fn delete_all(service: &str) -> std::io::Result<()> {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    let done = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .delete();
    match done {
        Ok(()) => Ok(()),
        Err(e) if e.code() == NOT_FOUND => Ok(()),
        Err(e) => Err(std::io::Error::other(e)),
    }
}

/// Not on a Mac: the login keychain is the person's, an app does not sweep it, and the
/// Hub keeps no account there (the desktop's account mode is off).
#[cfg(not(target_os = "ios"))]
pub fn delete_all(_: &str) -> std::io::Result<()> {
    Ok(())
}

// Windows, Linux and Android credential stores come with their own builds; until then
// there is none, and a caller that asked for one is told so.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get(_: &str, _: &str) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn set(_: &str, _: &str, _: &str) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "no credential store on this platform yet",
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn delete(_: &str, _: &str) -> std::io::Result<()> {
    Ok(())
}
