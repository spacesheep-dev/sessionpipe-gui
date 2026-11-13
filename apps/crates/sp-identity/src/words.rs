//! Where the signer runs, for the words a person reads. The signer was written for the
//! Mac: its prompts are fragments macOS finishes ("sessionpipe is trying to <reason>"),
//! and its refusals say "Touch ID" and "this Mac". An iPhone shows a prompt's reason as
//! it is written, has Face ID, and is not a Mac. Every sentence that differs is chosen
//! here by `Device`, so both sets are tested on whichever machine runs the tests.

/// The device this build is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Mac,
    IPhone,
}

impl Device {
    pub const fn current() -> Device {
        if cfg!(target_os = "ios") {
            Device::IPhone
        } else {
            Device::Mac
        }
    }

    /// What the person proves they are there with.
    pub const fn auth(self) -> &'static str {
        match self {
            Device::Mac => "Touch ID",
            Device::IPhone => "Face ID",
        }
    }

    /// The device, in the middle of a sentence.
    pub const fn here(self) -> &'static str {
        match self {
            Device::Mac => "this Mac",
            Device::IPhone => "this iPhone",
        }
    }

    /// A prompt's reason as this device shows it. The Mac's sheet puts "sessionpipe is
    /// trying to" before it, so it is a fragment there; an iPhone's shows it alone, so
    /// there it is a sentence: a capital, a full stop.
    pub fn reason(self, fragment: String) -> String {
        match self {
            Device::Mac => fragment,
            Device::IPhone => {
                let mut c = fragment.chars();
                match c.next() {
                    Some(first) => first.to_uppercase().chain(c).chain(['.']).collect(),
                    None => fragment,
                }
            }
        }
    }

    /// A prompt is already open.
    pub fn busy(self) -> String {
        format!("Finish the {} prompt first", self.auth())
    }

    /// Too many prompts in a row.
    pub fn too_many_prompts(self) -> String {
        format!("Slow down: too many {} requests", self.auth())
    }

    pub fn cancelled(self) -> String {
        format!("{} was cancelled", self.auth())
    }

    pub fn locked_out(self) -> String {
        format!("{} is locked", self.auth())
    }

    /// Nothing here can hold a key that checks the person.
    pub const fn no_hardware(self) -> &'static str {
        match self {
            Device::Mac => "no Secure Enclave with Touch ID or a password here",
            Device::IPhone => "This iPhone has no Face ID or passcode set up",
        }
    }

    /// A key cannot be made while the device is locked.
    pub const fn unlock_first(self) -> &'static str {
        match self {
            Device::Mac => "unlock this Mac first: a key can't be made while it is locked",
            Device::IPhone => "Unlock this iPhone first: a key can't be made while it is locked",
        }
    }

    /// A command signed at a time this device's clock does not agree with.
    pub fn clock_off(self) -> String {
        format!(
            "the command's time is more than a minute off {}'s clock",
            self.here()
        )
    }

    /// Trusting a device is never signed under the day grant.
    pub fn key_add_needs_presence(self) -> String {
        format!(
            "a key.add is signed with {}, never under the day grant",
            self.auth()
        )
    }

    /// Nor are the pool's four heavier actions.
    pub fn pool_needs_presence(self) -> String {
        format!(
            "turning the pool on or off, removing an account and finishing a sign-in take {}",
            self.auth()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::Device::{IPhone, Mac};

    /// The Mac's sentences are what they were, to the letter.
    #[test]
    fn the_macs_words_are_unchanged() {
        assert_eq!(Mac.busy(), "Finish the Touch ID prompt first");
        assert_eq!(
            Mac.too_many_prompts(),
            "Slow down: too many Touch ID requests"
        );
        assert_eq!(Mac.cancelled(), "Touch ID was cancelled");
        assert_eq!(Mac.locked_out(), "Touch ID is locked");
        assert_eq!(
            Mac.no_hardware(),
            "no Secure Enclave with Touch ID or a password here"
        );
        assert_eq!(
            Mac.unlock_first(),
            "unlock this Mac first: a key can't be made while it is locked"
        );
        assert_eq!(
            Mac.clock_off(),
            "the command's time is more than a minute off this Mac's clock"
        );
        assert_eq!(
            Mac.key_add_needs_presence(),
            "a key.add is signed with Touch ID, never under the day grant"
        );
        assert_eq!(
            Mac.pool_needs_presence(),
            "turning the pool on or off, removing an account and finishing a sign-in take Touch ID"
        );
        assert_eq!(
            Mac.reason("send a message to a session on studio-mac".into()),
            "send a message to a session on studio-mac"
        );
    }

    /// An iPhone's: Face ID, this iPhone, and a prompt's reason as a sentence.
    #[test]
    fn an_iphones_words_name_face_id_and_the_iphone() {
        assert_eq!(IPhone.busy(), "Finish the Face ID prompt first");
        assert_eq!(
            IPhone.too_many_prompts(),
            "Slow down: too many Face ID requests"
        );
        assert_eq!(IPhone.cancelled(), "Face ID was cancelled");
        assert_eq!(IPhone.locked_out(), "Face ID is locked");
        assert_eq!(
            IPhone.no_hardware(),
            "This iPhone has no Face ID or passcode set up"
        );
        assert_eq!(
            IPhone.unlock_first(),
            "Unlock this iPhone first: a key can't be made while it is locked"
        );
        assert_eq!(
            IPhone.clock_off(),
            "the command's time is more than a minute off this iPhone's clock"
        );
        assert_eq!(
            IPhone.key_add_needs_presence(),
            "a key.add is signed with Face ID, never under the day grant"
        );
        assert_eq!(
            IPhone.reason("send a message to a session on studio-mac".into()),
            "Send a message to a session on studio-mac."
        );
        assert_eq!(IPhone.reason(String::new()), "");
        for d in [Mac, IPhone] {
            for s in [
                d.busy(),
                d.cancelled(),
                d.clock_off(),
                d.no_hardware().into(),
            ] {
                assert!(
                    !s.contains(if d == Mac { "iPhone" } else { "Mac" })
                        && !s.contains(if d == Mac { "Face ID" } else { "Touch ID" }),
                    "{s}"
                );
            }
        }
    }
}
