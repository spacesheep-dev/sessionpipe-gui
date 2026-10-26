#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. NATIVE-SPEC §8's budgets on a built measurement app:
#
#   measure.sh --app <sessionpipe.app> [--dmg <dmg>] --home <scratch dir> --out budgets.json
#              [--port 7827] [--runs 5] [--idle-closed 300] [--idle-open 60] [--replay-200 file.jsonl]
#              [--quiet-replay file.jsonl] [--shots DIR] [--only quiet|live]
#
# Sizes from the build output; launch from the shell's own marks (main() → window built →
# page load → first contentful paint) over --runs launches, median; board-live from the
# page's "live" mark when it reports one, else the page's live stream opening at the
# receiver (/api/ui/viewers); reopen after ⌘W through the test hook; RAM as phys
# footprint summed over the app and its WebKit helpers (Web Content, Graphics and Media,
# Networking); idle CPU from cumulative CPU time per process, wakeups from top. Idle means
# a quiet receiver (--quiet-replay, no --demo): the demo changes something every second or
# two. --only reruns one pass into an earlier --out. The app runs with SP_RECEIVER_URL (a
# demo receiver on --port), its own SP_SHELL_HOME and SP_TEST_HOOKS=1, and is
# unregistered from LaunchServices at the end.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/measure.py" "$@"
