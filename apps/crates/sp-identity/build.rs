// Builds swift/Identity.swift into a static library (swiftc -emit-library -static) and
// links it with the frameworks it needs, on macOS. Elsewhere the crate compiles with no
// enclave (se.rs answers "unavailable"). With the `plugin` feature it also generates the
// plugin's permissions (identity:default = the five commands).
use std::path::PathBuf;
use std::process::Command;

#[cfg(feature = "plugin")]
const COMMANDS: &[&str] = &["status", "key", "sign", "pair", "forget"];

fn main() {
    println!("cargo::rerun-if-changed=swift/Identity.swift");
    println!("cargo::rustc-check-cfg=cfg(spid_swift)");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_os == "macos" {
        build_swift(&arch);
    }
    #[cfg(feature = "plugin")]
    tauri_plugin::Builder::new(COMMANDS).build();
}

fn build_swift(arch: &str) {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let swift_arch = if arch == "aarch64" { "arm64" } else { arch };
    let target = format!("{swift_arch}-apple-macosx11.0");
    let lib = out.join("libspid.a");
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-emit-library",
            "-static",
            "-module-name",
            "spid",
            "-parse-as-library",
            "-O",
        ])
        .args(["-target", &target, "swift/Identity.swift", "-o"])
        .arg(&lib)
        .status()
        .expect("xcrun swiftc (set DEVELOPER_DIR to Xcode)");
    assert!(status.success(), "swiftc failed");
    println!("cargo::rustc-link-search=native={}", out.display());
    println!("cargo::rustc-link-lib=static=spid");
    for fw in ["CryptoKit", "LocalAuthentication", "Security", "Foundation"] {
        println!("cargo::rustc-link-lib=framework={fw}");
    }
    // The Swift runtime: the OS's (/usr/lib/swift) and the toolchain's compatibility shims.
    println!("cargo::rustc-link-search=native=/usr/lib/swift");
    if let Ok(o) = Command::new("xcrun")
        .args(["--toolchain", "default", "--find", "swiftc"])
        .output()
    {
        let swiftc = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
        if let Some(usr) = swiftc.parent().and_then(|b| b.parent()) {
            println!(
                "cargo::rustc-link-search=native={}",
                usr.join("lib/swift/macosx").display()
            );
        }
    }
    if let Ok(o) = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
    {
        let sdk = String::from_utf8_lossy(&o.stdout).trim().to_string();
        println!("cargo::rustc-link-search=native={sdk}/usr/lib/swift");
    }
    println!("cargo::rustc-cfg=spid_swift");
}
