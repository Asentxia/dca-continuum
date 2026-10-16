#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${1:?console database required}
case "$DB" in ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test);;*)echo 'Only named disposable console databases allowed.';exit 2;;esac
mkdir -p .artifacts/canonical/backend
for m in 001-foundation.sql 002-lock-privileges.sql 004-monotonic-fences.sql 005-identity-authority.sql 006-product-computers.sql 007-context-artifacts.sql 008-recovery-controls.sql 009-runtime-trigger-permissions.sql 010-resource-controls.sql 011-console-domain.sql 012-tenant-identity-fks.sql 013-recovery-import-guard.sql 014-recovery-observation-guard.sql 015-regency-foundation.sql 016-placement-generation.sql 017-context-cognition-binding.sql 018-tenant-notice-projection.sql 019-task-mandate-admission.sql 020-tool-manifest.sql 021-vera-profiles.sql 022-e2-derived-proposals.sql;do psql -v ON_ERROR_STOP=1 -d "$DB" -f "migrations/$m" >> ".artifacts/canonical/backend/$DB-MIGRATIONS.log" 2>&1;done
