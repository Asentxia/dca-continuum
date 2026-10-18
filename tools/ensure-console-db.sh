#!/usr/bin/env bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PATH="${CT_PG_BIN:+$CT_PG_BIN:}$PATH"
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
DB=${1:-ct_console_dev}
case "$DB" in ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test);;*)echo 'Only named disposable console databases allowed.';exit 2;;esac
bash tools/local-db.sh >/dev/null
[ "$(realpath "$(psql -d postgres -Atc 'SHOW data_directory')")" = "$PWD/.local/pgdata" ] || { echo 'Refusing another cluster.';exit 2; }
created_here=0
if psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
  bash tools/apply-console-migrations.sh "$DB"
  printf 'Owned disposable %s was kept; existing rows were not dropped.\n' "$DB"
  exit 0
fi
createdb "$DB"
created_here=1
set +e
bash tools/apply-console-migrations.sh "$DB"
status=$?
set -e
if [ "$status" != 0 ]; then
  if [ "$created_here" = 1 ]; then
    dropdb --if-exists "$DB"
    echo "Migration failed; removed partially prepared $DB." >&2
  fi
  exit "$status"
fi
printf 'Prepared owned disposable %s (local/test only).\n' "$DB"
