#!/usr/bin/env bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
DB=${1:-ct_console_dev}
case "$DB" in ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test);;*)echo 'Only named disposable console databases allowed.';exit 2;;esac
bash tools/local-db.sh >/dev/null
[ "$(realpath "$(psql -d postgres -Atc 'SHOW data_directory')")" = "$PWD/.local/pgdata" ] || { echo 'Refusing another cluster.';exit 2; }
if psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
  printf 'Owned disposable %s already exists; left unchanged.\n' "$DB"
  exit 0
fi
createdb "$DB"
bash tools/apply-console-migrations.sh "$DB"
printf 'Prepared owned disposable %s (local/test only).\n' "$DB"
