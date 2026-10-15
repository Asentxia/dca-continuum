#!/bin/bash
# Destructive ONLY to this local project's explicitly named fixture databases.
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
if [ "${CT_RESET_LOCAL_FIXTURE:-}" != 'yes' ]; then echo 'Set CT_RESET_LOCAL_FIXTURE=yes to reset ct_test and ct_restore local fixtures.'; exit 2; fi
mkdir -p .local/temporal-bin evidence
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
./tools/local-db.sh
for d in ct_restore ct_test; do dropdb --if-exists "$d"; done
bash tools/implementation-db.sh
npm ci --ignore-scripts > .artifacts/core/reproduce-npm.log 2>&1
npm run build > .artifacts/core/reproduce-build.log 2>&1
node --test --test-concurrency=1 dist/tests/foundation.test.js > .artifacts/core/M2-foundation-tests.tap 2>&1
./tools/backup-domain.sh
createdb ct_restore
pg_restore --exit-on-error -d ct_restore .local/domain-backup.dump > .artifacts/core/M2-restore.log 2>&1
psql -d ct_restore -Atc 'SELECT count(*) FROM ct.control;' > .artifacts/core/restored-control-count.txt
test "$(cat .artifacts/core/restored-control-count.txt)" = '0'
psql -d ct_test -Atc 'SELECT count(*),max(seq) FROM ct.evidence_events' > .local/pre-crash-count.txt
pg_ctl -D .local/pgdata stop -m immediate > .artifacts/core/M2-database-crash.log 2>&1
./tools/local-db.sh >> .artifacts/core/M2-database-crash.log 2>&1
psql -d ct_test -Atc 'SELECT count(*),max(seq) FROM ct.evidence_events' > .local/post-crash-count.txt
diff .local/pre-crash-count.txt .local/post-crash-count.txt >> .artifacts/core/M2-database-crash.log
node --test --test-concurrency=1 dist/tests/controller.test.js > .artifacts/core/M3-controller-tests.tap 2>&1
psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/003-scheduler-fixture.sql > .artifacts/core/M4-scheduler-migration.log
node dist/tests/scheduler-comparison.js > .artifacts/core/M4-scheduler-run.log 2>&1
python3 tests/legacy-hotfix-probe.py > .artifacts/core/legacy-python-guard-tests.json
node --test --test-concurrency=1 dist/tests/legacy-hotfix.test.js > .artifacts/core/legacy-typescript-guard-tests.tap 2>&1
node --test --test-concurrency=1 dist/tests/release-local.test.js > .artifacts/core/local-release-gates.tap 2>&1
printf 'All implemented LOCAL validation tests passed. Production release gates are not cleared.\n'
