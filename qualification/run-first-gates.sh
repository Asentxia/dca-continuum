#!/bin/bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
[ "${CT_RESET_LOCAL_FIXTURE:-}" = yes ] || { echo 'Explicit local-fixture reset required'; exit 2; }
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
bash tools/local-db.sh
for db in ct_restore ct_test; do dropdb --if-exists "$db"; done
bash tools/local-db.sh
psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/005-identity-authority.sql > .artifacts/qualification/IDENTITY-MIGRATION.log
psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/006-product-computers.sql >> .artifacts/qualification/MIGRATION-006.log
npm ci --ignore-scripts > .artifacts/qualification/NPM-REPRODUCE.log 2>&1
npm run build > .artifacts/qualification/BUILD-REPRODUCE.log 2>&1
node --test --test-concurrency=1 dist/tests/foundation.test.js > .artifacts/qualification/BASELINE-FOUNDATION.tap 2>&1
bash tools/backup-domain.sh
createdb ct_restore
pg_restore --exit-on-error -d ct_restore .local/domain-backup.dump > .artifacts/qualification/RESTORE-REGRESSION.log 2>&1
node --test --test-concurrency=1 dist/tests/controller.test.js > .artifacts/qualification/BASELINE-CONTROLLER.tap 2>&1
node --test --test-concurrency=1 dist/tests/production-identity.test.js > .artifacts/qualification/IDENTITY-TESTS.tap 2>&1
node --test --test-concurrency=1 dist/tests/real-provider.test.js > .artifacts/qualification/REAL-PROVIDER-TESTS.tap 2>&1
printf 'Baseline regressions and first qualification implementation tests passed. Production gates remain PARTIAL/NOT RUN.\n'
