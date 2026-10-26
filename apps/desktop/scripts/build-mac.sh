#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. The macOS app and dmg (NATIVE-SPEC §7.2).
#
#   build-mac.sh [--sign] [--universal] [--measure] [--features LIST] [--version X] [--out DIR]
#
#   --sign       sign with Developer ID (hardened runtime, Entitlements.plist) and sign the
#                dmg; without it the app is signed ad hoc ("-")
#   --universal  arm64 + x86_64 (needs the x86_64-apple-darwin target and ≥ 11 GB free)
#   --measure    tauri.measure.conf.json instead of tauri.release.conf.json: no URL scheme,
#                identifier dev.spacesheep.sessionpipe.dev-packaging, the local updater
#                endpoint and the throwaway key. The only variant anyone launches on a dev Mac
#   --features L cargo features of the shell; default `identity` (the Secure Enclave
#                signer, sp-identity), as the release ships it. `--features ""` builds
#                the app without the signer
#   --version X  override the version (the updater tests build 0.0.1-test and 0.0.2-test)
#   --out DIR    copy the .app, the dmg and the updater archive + .sig there
#
# Updater artifacts (.app.tar.gz + .sig) are made when TAURI_SIGNING_PRIVATE_KEY is set.
# TAURI_CLI overrides the tauri CLI (default: npx tauri, this package's devDependency).
# Notarization is a separate step (RELEASING.md, "The desktop app"); until it runs,
# `spctl` says "Unnotarized Developer ID".
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/.." && pwd)"
root="$(cd "$desktop/../.." && pwd)"
IDENTITY="Developer ID Application: Michael Petrov (QR7H8ARENW)"

sign=0; universal=0; variant=release; version=""; out=""; features=identity
while [ $# -gt 0 ]; do
  case "$1" in
    --sign) sign=1 ;;
    --universal) universal=1 ;;
    --measure) variant=measure ;;
    --version) version="$2"; shift ;;
    --features) features="$2"; shift ;;
    --out) out="$2"; shift ;;
    -h|--help) sed -n '3,22p' "$0"; exit 0 ;;
    *) echo "build-mac: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# The toolchain this repo's Macs use; already-set values win.
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
target_dir="${CARGO_TARGET_DIR:-$root/apps/target}"
export CARGO_TARGET_DIR="$target_dir"
# Non-interactive bundling: no Finder AppleScript to lay out the dmg window.
export CI=true

free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
need=8; [ $universal = 1 ] && need=11
if [ "$free_gb" -lt "$need" ]; then
  echo "build-mac: ${free_gb} GB free, this build needs ≥ ${need} GB (disk rule)" >&2
  exit 1
fi

"$here/assemble-frontend.sh"

configs=(--config "src-tauri/tauri.$variant.conf.json")
[ -n "$version" ] && configs+=(--config "{\"version\":\"$version\"}")
if [ $sign = 1 ]; then
  security find-identity -v -p codesigning | grep -q "$IDENTITY" || { echo "build-mac: no \"$IDENTITY\" in the keychain" >&2; exit 1; }
else
  configs+=(--config '{"bundle":{"macOS":{"signingIdentity":"-"}}}')
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  configs+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
fi
args=(--bundles app,dmg)
[ -n "$features" ] && args+=(--features "$features")
triple=""
if [ $universal = 1 ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  triple=universal-apple-darwin
  args+=(--target "$triple")
fi

cd "$desktop"
started=$(date +%s)
# TAURI_CLI names another tauri CLI (e.g. "node …/@tauri-apps/cli/tauri.js"); default: this
# package's devDependency through npx.
read -r -a tauri <<< "${TAURI_CLI:-npx tauri}"
# Apple's timestamp service sometimes says "not available"; the rebuild after it is quick.
blog="$(mktemp)"
for attempt in 1 2 3; do
  if "${tauri[@]}" build "${configs[@]}" "${args[@]}" 2>&1 | tee "$blog"; [ "${PIPESTATUS[0]}" = 0 ]; then break; fi
  if [ $attempt = 3 ] || ! grep -q "timestamp service is not available" "$blog"; then rm -f "$blog"; exit 1; fi
  echo "build-mac: the timestamp service was not available; again in 20 s (attempt $((attempt + 1)) of 3)"
  sleep 20
done
rm -f "$blog"
echo "build-mac: tauri build took $(( $(date +%s) - started )) s"

bundle="$target_dir/${triple:+$triple/}release/bundle"
app="$(find "$bundle/macos" -maxdepth 1 -name '*.app' -print -quit)"
dmg="$(find "$bundle/dmg" -maxdepth 1 -name '*.dmg' -print -quit)"
[ -d "$app" ] && [ -f "$dmg" ] || { echo "build-mac: no .app or .dmg under $bundle" >&2; exit 1; }

if [ $sign = 1 ]; then
  codesign --force --sign "$IDENTITY" --timestamp "$dmg"
fi

echo
echo "== codesign -dv --verbose=4 \"$app\""
codesign -dv --verbose=4 "$app" 2>&1 | grep -E '^(Identifier|Format|CodeDirectory|Authority|TeamIdentifier|Runtime Version|Timestamp|Signature size)' || true
echo "== codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | tail -2
echo "== entitlements"
codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -p - 2>/dev/null || echo "(none)"
echo "== spctl -a -vv (Unnotarized Developer ID is expected until notarization)"
spctl -a -vv "$app" 2>&1 || true

app_kb=$(du -sk "$app" | cut -f1)
dmg_bytes=$(stat -f %z "$dmg")
echo
echo "build-mac: $app  $(( app_kb / 1024 )).$(( (app_kb % 1024) * 10 / 1024 )) MB"
echo "build-mac: $dmg  $(echo "scale=2; $dmg_bytes / 1048576" | bc) MB ($dmg_bytes bytes)"

if [ -n "$out" ]; then
  mkdir -p "$out"
  rm -rf "$out/$(basename "$app")"
  cp -R "$app" "$out/"
  cp "$dmg" "$out/"
  find "$bundle/macos" -maxdepth 1 \( -name '*.app.tar.gz' -o -name '*.app.tar.gz.sig' \) -exec cp {} "$out/" \;
  echo "build-mac: copied to $out"
fi

# A bundle on disk gets registered with LaunchServices without ever being opened
# (Spotlight finds it), and the release one claims sessionpipe://. Unregister what this
# build left behind; keep copies in a folder named *.noindex, which Spotlight skips.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -u "$app" 2>/dev/null || true
if [ -n "$out" ]; then
  "$lsregister" -u "$out/$(basename "$app")" 2>/dev/null || true
  case "$out" in *.noindex|*.noindex/*) ;; *) echo "build-mac: note: name --out *.noindex so Spotlight doesn't register the copy" ;; esac
fi
if [ $variant = release ]; then
  rm -rf "$app"
  echo "build-mac: removed the release .app from the target dir (it claims sessionpipe://); the dmg${out:+ and $out} keep it"
fi
