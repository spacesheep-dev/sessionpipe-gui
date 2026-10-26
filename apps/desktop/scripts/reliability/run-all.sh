#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. Every reliability script against one measurement app.
#   run-all.sh --app <sessionpipe.app> --home <scratch> [--cli <cli.js>]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
for t in no-receiver single-instance sleep-wake receiver-restart run-json-port; do
  echo "== $t"
  python3 "$here/$t.py" "$@" || fail=1
done
exit $fail
