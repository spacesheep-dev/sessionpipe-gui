// The identity "plugin" here is our own inline one (status only: no signer in the
// simulator), so it needs its permission set declared at build time.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "identity",
            tauri_build::InlinedPlugin::new()
                .commands(&["status"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
