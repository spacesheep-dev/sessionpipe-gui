#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. Notarize and staple a dmg that build-mac.sh --sign made:
#
#   notarize-mac.sh <sessionpipe_X.Y.Z_aarch64.dmg> [--profile sessionpipe-notary]
#
# Needs a notarytool keychain profile, made once by a person (RELEASING.md, "Notarizing by
# hand"); this script never asks for or stores an Apple ID or password. Without the profile
# it says so and exits 3, changing nothing. CI notarizes through tauri-action instead.
set -euo pipefail
dmg=""; profile="${SP_NOTARY_PROFILE:-sessionpipe-notary}"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="$2"; shift ;;
    -h|--help) sed -n '3,9p' "$0"; exit 0 ;;
    -*) echo "notarize-mac: unknown option $1" >&2; exit 2 ;;
    *) dmg="$1" ;;
  esac
  shift
done
[ -f "$dmg" ] || { echo "notarize-mac: name the dmg to notarize" >&2; exit 2; }
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if ! xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
  echo "notarize-mac: no notarytool profile \"$profile\" in the keychain; make it once with"
  echo "  xcrun notarytool store-credentials $profile --key AuthKey_<id>.p8 --key-id <id> --issuer <issuer>"
  echo "(or --apple-id <id> --team-id QR7H8ARENW, which prompts for an app-specific password)"
  exit 3
fi

codesign --verify --strict "$dmg"
echo "== notarytool submit (minutes)"
out="$(xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait 2>&1)" || true
echo "$out"
id="$(printf '%s\n' "$out" | awk '/^ *id:/ {print $2; exit}')"
if ! printf '%s\n' "$out" | grep -q 'status: Accepted'; then
  [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$profile" || true
  echo "notarize-mac: not accepted" >&2
  exit 1
fi
echo "== stapler staple"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
echo "== spctl (expect: accepted, source=Notarized Developer ID)"
spctl -a -vv -t open --context context:primary-signature "$dmg" 2>&1
