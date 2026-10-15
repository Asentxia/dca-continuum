#!/usr/bin/env bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
[ "${CT_RESET_LOCAL_FIXTURE:-}" = yes ] && [ "${CT_RESET_CONSOLE_FIXTURE:-}" = yes ] || { echo 'Explicit CT_RESET_LOCAL_FIXTURE=yes and CT_RESET_CONSOLE_FIXTURE=yes required for owned disposable fixtures.';exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || { echo 'Run backend verification with Node 24; web wrapper uses separately installed Node 22.';exit 2; }
export PATH="${CT_PG_BIN:+$CT_PG_BIN:}$PATH" NEXT_TELEMETRY_DISABLED=1
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=.artifacts/canonical/final
mkdir -p .artifacts/canonical/attempts
if [ -d "$OUT" ];then mv "$OUT" ".artifacts/canonical/attempts/final-$STAMP";fi
mkdir -p "$OUT/backend" "$OUT/frontend" "$OUT/baseline" "$OUT/browser"
trap 'printf "Verification stopped at line %s; exit %s. See retained raw evidence.\n" "$LINENO" "$?" > "$OUT/INCOMPLETE.txt"' ERR
sha256sum qualification/PRODUCTION-GATES.json docs/M1-SAFETY-CONTRACTS.md > "$OUT/FROZEN-INPUTS.sha256"
python3 tools/canonical-source-digest.py > "$OUT/TESTED-SOURCE.json"
printf 'Re-running accepted backend groups, native local HA/PITR and legacy guards.\n'
npm test > "$OUT/baseline/RUN.log" 2>&1
cp -a .artifacts/implementation/final "$OUT/baseline/suites"
cp -a .artifacts/implementation/dr-lab "$OUT/baseline/dr-lab"
cp .artifacts/implementation/FINAL-SUMMARY.json "$OUT/baseline/SUMMARY.json"
# Import evidence remains historical. Fresh results are isolated above.
true # Results are ignored artifacts, not tracked source.
printf 'Testing new canonical domain contracts from a fresh database.\n'
bash tools/setup-console-db.sh ct_console_test > "$OUT/backend/SETUP.log" 2>&1
CT_DATABASE=ct_console_test node --test --test-concurrency=1 --test-reporter=tap dist/tests/console-domain.test.js > "$OUT/backend/CONSOLE-DOMAIN.tap" 2>&1
node --test --test-concurrency=1 --test-reporter=tap dist/tests/console-semantics.test.js > "$OUT/backend/CONSOLE-SEMANTICS.tap" 2>&1
CT_DATABASE=ct_console_test node --test --test-concurrency=1 --test-reporter=tap dist/tests/security-regressions.test.js > "$OUT/backend/SECURITY-REGRESSIONS.tap" 2>&1
if [ "${CT_RUN_PUBLIC_READ_FIXTURE:-}" = yes ];then
 printf 'Verifying the existing fixed, unauthenticated GitHub public-read adapter; no provider mutation.\n'
 bash tools/setup-console-db.sh ct_provider_read_test > "$OUT/backend/PUBLIC-READ-SETUP.log" 2>&1
 CT_DATABASE=ct_provider_read_test node --test --test-concurrency=1 --test-reporter=tap dist/tests/real-provider.test.js > "$OUT/backend/REAL-PUBLIC-READ.tap" 2>&1
 cp .artifacts/qualification/REAL-PROVIDER-REQUESTS.json "$OUT/backend/REAL-PUBLIC-READ-RESPONSES.json"
 true # Preserve generated public-read evidence.
else
 printf 'NOT RUN: fixed public-read checks require explicit CT_RUN_PUBLIC_READ_FIXTURE=yes.\n' > "$OUT/backend/REAL-PUBLIC-READ-NOT-RUN.txt"
fi
printf 'Checking and building the authenticated Focus Desk on Node 22.\n'
bash tools/web-node22.sh typecheck > "$OUT/frontend/TYPECHECK.log" 2>&1
bash tools/web-node22.sh test > "$OUT/frontend/UNIT-COMPONENT.log" 2>&1
bash tools/web-node22.sh build > "$OUT/frontend/PRODUCTION-BUILD.log" 2>&1
npm run build:product > "$OUT/backend/PRODUCT-BUILD.log" 2>&1
CT_RUNTIME_ENV=local-test CT_ALLOW_LOCAL_FIXTURES=yes node --test --test-reporter=tap dist/tests/fixture-boundaries.test.js > "$OUT/backend/FIXTURE-BOUNDARIES.tap" 2>&1
node --test --test-concurrency=1 --test-reporter=tap dist/tests/product-build-isolation.test.js > "$OUT/backend/PRODUCT-ISOLATION.tap" 2>&1
bash tools/web-node22.sh build:local-test > "$OUT/frontend/LOCAL-TEST-BUILD.log" 2>&1
printf 'Exercising the optimized frontend, backend and 10,000-task fixtures in Chromium.\n'
bash tools/setup-console-db.sh ct_console_browser > "$OUT/backend/BROWSER-SETUP.log" 2>&1
if [ -d .artifacts/canonical/browser ];then cp -a .artifacts/canonical/browser ".artifacts/canonical/attempts/browser-$STAMP";fi
node --test --test-concurrency=1 --test-reporter=tap dist/tests/console-browser.test.js > "$OUT/frontend/BROWSER.tap" 2>&1
cp -a .artifacts/canonical/browser/. "$OUT/browser/"
npm audit --omit=dev --json > "$OUT/DEPENDENCY-AUDIT.json"
set +e
if npm run qualification-check > "$OUT/QUALIFICATION-CHECK.log" 2>&1; then Q=0; else Q=$?; fi
if npm run release-check > "$OUT/RELEASE-CHECK.log" 2>&1; then R=0; else R=$?; fi
set -e
[ "$Q" = 1 ] && [ "$R" = 1 ] || { echo 'Expected qualification/release enforcement to remain blocked.';exit 1; }
sha256sum -c "$OUT/FROZEN-INPUTS.sha256" > "$OUT/FROZEN-INPUTS-UNCHANGED.log"
python3 tools/canonical-source-digest.py > "$OUT/SOURCE-AFTER.json"
cmp "$OUT/TESTED-SOURCE.json" "$OUT/SOURCE-AFTER.json"
python3 tools/summarize-canonical-evidence.py
rm -f "$OUT/INCOMPLETE.txt"
printf 'Canonical local verification passed. Production BLOCKED; scheduler HELD; canary NO-GO.\n' > "$OUT/COMPLETE.txt"
printf 'Canonical local verification passed. Production BLOCKED; scheduler HELD; canary NO-GO.\n'
