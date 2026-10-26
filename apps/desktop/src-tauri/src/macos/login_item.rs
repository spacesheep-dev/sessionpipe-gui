//! Launch at login (NATIVE-SPEC.md §3.8): `SMAppService.mainApp`, the modern way (System
//! Settings › General › Login Items). **Never called unless SP_ALLOW_LOGIN_ITEM=1** in
//! this round (rule 24: nothing registered for real on this Mac).

use objc2_service_management::{SMAppService, SMAppServiceStatus};

pub fn allowed() -> bool {
    std::env::var("SP_ALLOW_LOGIN_ITEM").as_deref() == Ok("1")
}

fn available() -> bool {
    objc2::runtime::AnyClass::get(c"SMAppService").is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
    Unavailable,
}

pub fn status() -> Status {
    if !available() {
        return Status::Unavailable;
    }
    // SAFETY: SMAppService exists (macOS 13+); these are plain property reads.
    let s = unsafe { SMAppService::mainAppService().status() };
    match s {
        SMAppServiceStatus::Enabled => Status::Enabled,
        SMAppServiceStatus::RequiresApproval => Status::RequiresApproval,
        SMAppServiceStatus::NotFound => Status::NotFound,
        _ => Status::NotRegistered,
    }
}

pub fn set(on: bool) -> Result<(), String> {
    if !allowed() {
        return Err("Open at login is off in this development build.".into());
    }
    if !available() {
        return Err("Open at login needs macOS 13 or later.".into());
    }
    // SAFETY: as above; register/unregister report errors through NSError.
    let r = unsafe {
        let svc = SMAppService::mainAppService();
        if on {
            svc.registerAndReturnError()
        } else {
            svc.unregisterAndReturnError()
        }
    };
    r.map_err(|e| e.localizedDescription().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn refuses_without_the_env_switch() {
        // Never registers in tests: the switch is off here.
        if std::env::var("SP_ALLOW_LOGIN_ITEM").is_err() {
            assert!(super::set(true).is_err());
            assert!(super::set(false).is_err());
        }
    }
}
