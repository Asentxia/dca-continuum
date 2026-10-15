#!/usr/bin/env bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
DB=${1:-ct_console_dev}
case "$DB" in ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test);;*)echo 'Only named disposable console databases allowed.';exit 2;;esac
[ "${CT_RESET_CONSOLE_FIXTURE:-}" = yes ] || { echo 'Explicit CT_RESET_CONSOLE_FIXTURE=yes required.';exit 2; }
bash tools/local-db.sh >/dev/null
[ "$(realpath "$(psql -d postgres -Atc 'SHOW data_directory')")" = "$PWD/.local/pgdata" ] || { echo 'Refusing another cluster.';exit 2; }
mkdir -p .artifacts/canonical/backend
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid()" >/dev/null
dropdb --if-exists "$DB";createdb "$DB"
for m in 001-foundation.sql 002-lock-privileges.sql 004-monotonic-fences.sql 005-identity-authority.sql 006-product-computers.sql 007-context-artifacts.sql 008-recovery-controls.sql 009-runtime-trigger-permissions.sql 010-resource-controls.sql 011-console-domain.sql 012-tenant-identity-fks.sql 013-recovery-import-guard.sql 014-recovery-observation-guard.sql 015-regency-foundation.sql 016-placement-generation.sql 017-context-cognition-binding.sql 018-tenant-notice-projection.sql 019-task-mandate-admission.sql 020-tool-manifest.sql 021-vera-profiles.sql;do psql -v ON_ERROR_STOP=1 -d "$DB" -f "migrations/$m" >> ".artifacts/canonical/backend/$DB-MIGRATIONS.log" 2>&1;done
printf 'Prepared owned disposable %s (local/test only).\n' "$DB"
