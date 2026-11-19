// On iOS the identity plugin is sp-identity's (the signer), whose own build declares its
// five commands. Elsewhere (Android, the host) the "plugin" is our inline one (status
// only: no signer there), so it needs its permission set declared at build time.
fn main() {
    let ios = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "ios");
    let attrs = if ios {
        tauri_build::Attributes::new()
    } else {
        tauri_build::Attributes::new().plugin(
            "identity",
            tauri_build::InlinedPlugin::new()
                .commands(&["status"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        )
    };
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
