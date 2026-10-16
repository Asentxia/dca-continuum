#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=${CT_NODE22_BIN:-}
[ -x "$BIN/node" ] || { echo 'Set CT_NODE22_BIN to an installed approved Node 22 bin directory.';exit 2; }
[ "$("$BIN/node" -p 'process.versions.node.split(".")[0]')" = 22 ] || { echo 'Frontend requires Node 22; backend remains Node 24.';exit 2; }
export PATH="$BIN:$PATH" NEXT_TELEMETRY_DISABLED=1
COMMAND=${1:-build}
if [ "$COMMAND" = build ];then
 env -u CT_RUNTIME_ENV -u CT_ALLOW_LOCAL_FIXTURES -u CT_CONSOLE_MODE -u CT_FIXTURE_SERVER_KEY -u CT_LOCAL_TEST_BUILD npm run build --workspace web -- "${@:2}"
else
 npm run "$COMMAND" --workspace web -- "${@:2}"
fi
