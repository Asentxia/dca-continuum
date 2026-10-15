#!/bin/bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
[ ! -L .local ] && [ ! -L .local/pgdata ] || { echo 'Refusing linked local fixture directories';exit 2; }
mkdir -p .local/pgsocket
chmod 700 .local/pgsocket
if [ ! -f .local/pgdata/PG_VERSION ]; then initdb -D .local/pgdata -U localtest -A trust --encoding=UTF8 --locale=C > .artifacts/core/initdb.log; fi
if ! pg_ctl -D .local/pgdata status >/dev/null 2>&1; then pg_ctl -D .local/pgdata -l "$PWD/.local/postgres.log" -o "-p 55432 -h 127.0.0.1 -k $PWD/.local/pgsocket" start; fi
actual=$(psql -d postgres -Atc 'SHOW data_directory')
[ "$(realpath "$actual")" = "$PWD/.local/pgdata" ] || { echo 'Refusing non-owned cluster before any fixture migration';exit 2; }
if ! psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='ct_test'" | grep -q 1; then
 createdb ct_test
 psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/001-foundation.sql > .artifacts/core/M2-migration.log
 psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/002-lock-privileges.sql >> .artifacts/core/M2-migration.log
 psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/004-monotonic-fences.sql >> .artifacts/core/M2-migration.log
fi
psql -d ct_test -Atc 'SELECT version(); SHOW fsync; SHOW synchronous_commit;' > .artifacts/core/postgres-version.txt
