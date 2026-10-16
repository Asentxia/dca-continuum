#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PATH="${CT_PG_BIN:+$CT_PG_BIN:}$PATH"
CT_RESET_CONSOLE_FIXTURE=yes bash tools/setup-console-db.sh ct_console_dev
npm run build
node tools/console-dev.mjs
