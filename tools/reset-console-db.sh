#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Destructive reset of one named console database. The caller must confirm it.
# This script does not set CT_RESET_CONSOLE_FIXTURE.
[ "${CT_RESET_CONSOLE_FIXTURE:-}" = yes ] || { echo 'Refusing reset. Export CT_RESET_CONSOLE_FIXTURE=yes to confirm.';exit 2; }
exec bash tools/setup-console-db.sh "${1:-ct_console_dev}"
