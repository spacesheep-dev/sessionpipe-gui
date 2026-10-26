// The app's own commands are declared here, so each one needs an explicit permission
// in a capability (capabilities/main.json grants them to the main window only). A view
// window, which has no capability, can call none of them.
const COMMANDS: &[&str] = &[
    "rx_list",
    "rx_add",
    "rx_remove",
    "rx_select",
    "rx_discover",
    "rx_start_local",
    "rx_stream",
    "rx_stream_close",
    "app_settings_get",
    "app_settings_set",
    "app_notify_status",
    "app_notify_request",
    "app_notify_open_settings",
    "app_open_view",
    "app_open_external",
    "app_update_status",
    "app_update_check",
    "app_update_restart",
    "app_first_run_done",
    "app_shortcut_set",
    "app_mark",
    "debug_simulate",
];

fn main() {
    println!("cargo::rustc-check-cfg=cfg(tray_template)");
    println!("cargo::rerun-if-changed=icons");
    if std::path::Path::new("icons/tray-template@2x.png").exists() {
        println!("cargo::rustc-cfg=tray_template");
    }
    let mut attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    // capabilities/identity.json names the identity plugin's permissions, which exist only
    // when the `identity` feature links sp-identity; without it, main.json alone.
    if std::env::var_os("CARGO_FEATURE_IDENTITY").is_none() {
        attrs = attrs.capabilities_path_pattern("./capabilities/main.json");
    }
    tauri_build::try_build(attrs).expect("tauri build");
}
