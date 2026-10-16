#!/usr/bin/env bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PATH="${CT_PG_BIN:+$CT_PG_BIN:}$PATH"
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
DB=${1:-ct_console_dev}
case "$DB" in ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test);;*)echo 'Only named disposable console databases allowed.';exit 2;;esac
[ "${CT_RESET_CONSOLE_FIXTURE:-}" = yes ] || { echo 'Explicit CT_RESET_CONSOLE_FIXTURE=yes required.';exit 2; }
bash tools/local-db.sh >/dev/null
[ "$(realpath "$(psql -d postgres -Atc 'SHOW data_directory')")" = "$PWD/.local/pgdata" ] || { echo 'Refusing another cluster.';exit 2; }
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid()" >/dev/null
dropdb --if-exists "$DB";createdb "$DB"
bash tools/apply-console-migrations.sh "$DB"
printf 'Prepared owned disposable %s (local/test only).\n' "$DB"
