#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PATH="${CT_PG_BIN:+$CT_PG_BIN:}$PATH"
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
DB=${1:?console database required}
case "$DB" in ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test);;*)echo 'Only named disposable console databases allowed.';exit 2;;esac
[ "$(realpath "$(psql -d postgres -Atc 'SHOW data_directory')")" = "$PWD/.local/pgdata" ] || { echo 'Refusing another cluster.';exit 2; }
if [ "${CT_CONSOLE_MIGRATION_PROBE_FAIL:-}" = yes ]; then
  echo 'migration probe failed' >&2
  exit 1
fi
mkdir -p .artifacts/canonical/backend
relation(){ psql -d "$DB" -Atc "SELECT to_regclass('$1') IS NOT NULL"; }
ledger_sql="CREATE TABLE IF NOT EXISTS ct.applied_console_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())"
record(){ psql -d "$DB" -c "$ledger_sql" >/dev/null; psql -d "$DB" -c "INSERT INTO ct.applied_console_migrations(filename) VALUES('$1') ON CONFLICT DO NOTHING" >/dev/null; }
recorded(){ [ "$(relation ct.applied_console_migrations)" = t ] && psql -d "$DB" -Atc "SELECT 1 FROM ct.applied_console_migrations WHERE filename='$1'" | grep -q 1; }
if [ "$(relation ct.tenants)" = t ] && [ "$(relation ct.e2_derivation_receipts)" != t ] && [ "$(relation ct.applied_console_migrations)" != t ]; then
  echo "Refusing incomplete console database $DB. Export CT_RESET_CONSOLE_FIXTURE=yes and run npm run dev:console:reset" >&2
  exit 2
fi
legacy=0
if [ "$(relation ct.e2_derivation_receipts)" = t ] && [ "$(relation ct.applied_console_migrations)" != t ]; then
  legacy=1
  psql -d "$DB" -c "$ledger_sql" >/dev/null
fi
for m in 001-foundation.sql 002-lock-privileges.sql 004-monotonic-fences.sql 005-identity-authority.sql 006-product-computers.sql 007-context-artifacts.sql 008-recovery-controls.sql 009-runtime-trigger-permissions.sql 010-resource-controls.sql 011-console-domain.sql 012-tenant-identity-fks.sql 013-recovery-import-guard.sql 014-recovery-observation-guard.sql 015-regency-foundation.sql 016-placement-generation.sql 017-context-cognition-binding.sql 018-tenant-notice-projection.sql 019-task-mandate-admission.sql 020-tool-manifest.sql 021-vera-profiles.sql 022-e2-derived-proposals.sql;do
  if [ "$legacy" = 1 ]; then
    record "$m"
    if [ "$m" = 022-e2-derived-proposals.sql ]; then legacy=0; fi
    continue
  fi
  if recorded "$m"; then continue; fi
  psql -v ON_ERROR_STOP=1 -d "$DB" -f "migrations/$m" >> ".artifacts/canonical/backend/$DB-MIGRATIONS.log" 2>&1
  record "$m"
done
printf 'Console schema for %s matches this checkout.\n' "$DB"
