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
    // The Swift is built here for every Apple target (macOS, an iPhone, its simulator):
    // the phone crate also links a dynamic library, so its symbols must resolve inside the
    // Rust build, not at the app's link in Xcode. The frameworks and the Swift runtime
    // follow through the objects' autolink entries and the search paths below.
    if target_os == "macos" {
        build_swift(Platform::MacOs, &arch);
    } else if target_os == "ios" {
        let sim = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "sim");
        build_swift(if sim { Platform::IosSim } else { Platform::Ios }, &arch);
    }
    #[cfg(feature = "plugin")]
    tauri_plugin::Builder::new(COMMANDS).build();
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Platform {
    MacOs,
    Ios,
    IosSim,
}

impl Platform {
    /// The SDK `xcrun` names, the Swift target suffix, and the toolchain's runtime folder.
    fn sdk(self) -> &'static str {
        match self {
            Platform::MacOs => "macosx",
            Platform::Ios => "iphoneos",
            Platform::IosSim => "iphonesimulator",
        }
    }
    fn target(self, swift_arch: &str) -> String {
        match self {
            Platform::MacOs => format!("{swift_arch}-apple-macosx11.0"),
            // The phone app's deployment target (gen/apple/project.yml).
            Platform::Ios => format!("{swift_arch}-apple-ios17.0"),
            Platform::IosSim => format!("{swift_arch}-apple-ios17.0-simulator"),
        }
    }
}

fn build_swift(platform: Platform, arch: &str) {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let swift_arch = if arch == "aarch64" { "arm64" } else { arch };
    let target = platform.target(swift_arch);
    let sdk_path = Command::new("xcrun")
        .args(["--sdk", platform.sdk(), "--show-sdk-path"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("xcrun --show-sdk-path (set DEVELOPER_DIR to Xcode)");
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
        .args([
            "-sdk",
            &sdk_path,
            "-target",
            &target,
            "swift/Identity.swift",
            "-o",
        ])
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
    if platform == Platform::MacOs {
        println!("cargo::rustc-link-search=native=/usr/lib/swift");
    }
    if let Ok(o) = Command::new("xcrun")
        .args(["--toolchain", "default", "--find", "swiftc"])
        .output()
    {
        let swiftc = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
        if let Some(usr) = swiftc.parent().and_then(|b| b.parent()) {
            println!(
                "cargo::rustc-link-search=native={}",
                usr.join("lib/swift").join(platform.sdk()).display()
            );
        }
    }
    println!("cargo::rustc-link-search=native={sdk_path}/usr/lib/swift");
    println!("cargo::rustc-cfg=spid_swift");
}
