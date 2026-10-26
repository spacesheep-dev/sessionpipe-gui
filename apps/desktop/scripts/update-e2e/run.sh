#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. The updater end to end (see run.py):
#   run.sh --key <throwaway minisign key> --out <scratch dir> [--skip-build] [--cli <cli.js>]
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run.py" "$@"
