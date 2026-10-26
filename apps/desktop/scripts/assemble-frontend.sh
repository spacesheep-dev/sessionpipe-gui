#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. The app's own UI (NATIVE-SPEC §2): the web build (dist/web) plus the
# views that ship with the GUI (Canvas, Office) at the path the receiver serves them from
# (/themes/<id>/…), copied into apps/desktop/dist-app without source maps. Run after
# `npm run build` at the repo root; `tauri build` bundles dist-app.
#   assemble-frontend.sh [--out DIR]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
out="$root/apps/desktop/dist-app"
[ "${1:-}" = "--out" ] && out="$2"

web="$root/dist/web"
views="$root/dist/bundled/views"
[ -f "$web/index.html" ] || { echo "assemble-frontend: no $web/index.html (run npm run build first)" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/themes"
cp -R "$web/." "$out/"
for id in canvas office; do
  src="$views/$id"
  if [ ! -f "$src/theme.json" ]; then
    echo "assemble-frontend: $id is not in $views (a bare clone builds without it)" >&2
    continue
  fi
  mkdir -p "$out/themes/$id"
  cp "$src/theme.json" "$out/themes/$id/"
  [ -d "$src/dist" ] && cp -R "$src/dist" "$out/themes/$id/"
done
find "$out" -name '*.map' -type f -delete
# Reported so a size jump shows in the build log.
files=$(find "$out" -type f | wc -l | tr -d ' ')
kb=$(du -sk "$out" | cut -f1)
echo "assemble-frontend: $out ($files files, ${kb} KB)"
