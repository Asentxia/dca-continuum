#!/bin/bash
set -euo pipefail
mkdir -p .artifacts/core .artifacts/implementation .artifacts/qualification .artifacts/canonical
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
[ "${CT_RESET_LOCAL_FIXTURE:-}" = yes ] || { echo 'Explicit CT_RESET_LOCAL_FIXTURE=yes required for owned disposable test databases.';exit 2; }
mkdir -p .artifacts/implementation/final .artifacts/implementation/attempts .local/temporal-bin
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
bash tools/implementation-db.sh reset > .artifacts/implementation/final/SETUP.log 2>&1
# No remote host accepted. Reset only fixed names under the verified local cluster.
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ct_recovery_test' AND pid<>pg_backend_pid()" >/dev/null
dropdb --if-exists ct_recovery_test
for d in .local/computer-fixtures .local/context-artifact-objects .local/private-restores .local/recovery-anchors .local/recovery-test-fence;do rm -rf "$d";done
if [ -d .local/dr-lab ];then
 for d in primary standby restored;do if pg_ctl -D ".local/dr-lab/$d" status >/dev/null 2>&1;then pg_ctl -D ".local/dr-lab/$d" -m immediate stop;fi;done
 mv .local/dr-lab ".local/dr-lab-retained-$(date +%s)"
fi
npm ci --ignore-scripts > .artifacts/implementation/final/DEPENDENCIES.log 2>&1
npm run build > .artifacts/implementation/final/BUILD.log 2>&1
run(){ local name=$1;shift;printf 'Running %s\n' "$name"; local tap=".artifacts/implementation/final/$name.tap"; if ! node --test --test-reporter=tap --test-concurrency=1 "$@" > "$tap" 2>&1; then echo "Suite $name failed"; grep -n -A 35 '^not ok ' "$tap" || tail -n 80 "$tap"; mkdir -p .artifacts/canonical/final/baseline; cp "$tap" ".artifacts/canonical/final/baseline/$name.tap"; return 1; fi; }
run BASELINE-FOUNDATION dist/tests/foundation.test.js
bash tools/backup-domain.sh > .artifacts/implementation/final/LOGICAL-BACKUP.log 2>&1
python3 tests/backup-target-guards.py > .artifacts/implementation/final/BACKUP-TARGET-GUARDS.json
createdb ct_restore;pg_restore --exit-on-error -d ct_restore .local/domain-backup.dump > .artifacts/implementation/final/LOGICAL-RESTORE.log 2>&1
[ "$(psql -d ct_restore -Atc 'SELECT count(*) FROM ct.control')" = 0 ]
printf 'restored activation rows = 0; dispatch remains blocked\n' > .artifacts/implementation/final/LOGICAL-RESTORE-STATUS.txt
psql -d ct_test -Atc 'SELECT count(*),max(seq) FROM ct.evidence_events' > .local/pre-final-crash.txt
pg_ctl -D .local/pgdata stop -m immediate > .artifacts/implementation/final/LOCAL-DATABASE-CRASH.log 2>&1
bash tools/local-db.sh >> .artifacts/implementation/final/LOCAL-DATABASE-CRASH.log 2>&1
psql -d ct_test -Atc 'SELECT count(*),max(seq) FROM ct.evidence_events' > .local/post-final-crash.txt
diff .local/pre-final-crash.txt .local/post-final-crash.txt >> .artifacts/implementation/final/LOCAL-DATABASE-CRASH.log
run BASELINE-CONTROLLER dist/tests/controller.test.js
run BASELINE-IDENTITY dist/tests/production-identity.test.js
run BASELINE-LEGACY dist/tests/legacy-hotfix.test.js
python3 tests/legacy-hotfix-probe.py > .artifacts/implementation/final/LEGACY-PYTHON.json
run BASELINE-RELEASE-LOCAL dist/tests/release-local.test.js
# D1 requires clean canonical context heads; run before the first context writer.
run CONTEXT-ADMISSION dist/tests/context-admission.test.js
run PRODUCT-BACKEND dist/tests/product-backend.test.js
run AUDIT-REGRESSIONS dist/tests/audit-regressions.test.js
run CONTINUITY dist/tests/continuity.test.js
run PLACEMENT-BINDING dist/tests/placement-binding.test.js
run MANIFEST-BINDING dist/tests/manifest-binding.test.js
run BOUNDED-COMPUTATION dist/tests/bounded-computation-contract.test.js
run MODEL-PROTOCOL dist/tests/model-protocol.test.js
run RESTRICTED-MEMORY-PROTOCOL dist/tests/restricted-memory-protocol.test.js
run RECALL-SERVICE dist/tests/recall-service.test.js
run E2-DERIVED-PROPOSALS dist/tests/e2-derived-proposals.test.js
run AEON-OFFLINE dist/tests/aeon/offline.test.js
run NEXUS-LOCAL dist/tests/nexus/local.test.js
run CONSOLE-E2-REDACTION dist/tests/console-e2-redaction.test.js
run OFFLINE-FUNCTIONAL-INTEGRATION dist/tests/offline-functional-integration.test.js
run TOOL-MANIFEST dist/tests/tool-manifest.test.js
run EVENT-ENVELOPE dist/tests/event-envelope.test.js
run TASK-ADMISSION dist/tests/task-admission.test.js
run PROJECT-COMMANDS dist/tests/project-commands.test.js
run VERA-PROFILE dist/tests/vera-profile.test.js
run VERA-CONSOLE-COMMANDS dist/tests/vera-console-commands.test.js
run VERA-PROFILE-BACKUP dist/tests/vera-profile-backup.test.js
run FONT-NOTICES dist/tests/font-notices.test.js
run REVIEW-REMEDIATION dist/tests/review-remediation.test.js
run DEPENDENCY-OVERRIDES dist/tests/dependency-overrides.test.js
run OBJECT-CONTAINMENT dist/tests/object-store-containment.test.js
CT_FIXTURE_NODE="$(command -v node)" python3 tests/fixture-priv-bounds.py > .artifacts/implementation/final/FIXTURE-PRIV.json
run COMPUTER-ISOLATION dist/tests/computer-isolation.test.js
python3 tests/wal-archive-publish.py > .artifacts/implementation/final/WAL-ARCHIVE.json
if ! CT_LOCAL_DR_LAB=yes python3 tools/local-ha-pitr-lab.py > .artifacts/implementation/final/HA-PITR-LAB.log 2>&1; then cat .artifacts/implementation/final/HA-PITR-LAB.log >&2; exit 1; fi
psql -v ON_ERROR_STOP=1 -d ct_test -f migrations/003-scheduler-fixture.sql > .artifacts/implementation/final/SCHEDULER-SCHEMA.log
export CT_REFERENCE_DB_FILE="$PWD/.local/reference-temporal-final-$(date +%s).sqlite"
run REFERENCE-SCHEDULER dist/tests/reference-scheduler.test.js
run CONTEXT-ARTIFACT dist/tests/context-artifact.test.js
createdb ct_recovery_test
for m in 001-foundation.sql 002-lock-privileges.sql 004-monotonic-fences.sql 005-identity-authority.sql 006-product-computers.sql 007-context-artifacts.sql 008-recovery-controls.sql 009-runtime-trigger-permissions.sql 010-resource-controls.sql 012-tenant-identity-fks.sql 013-recovery-import-guard.sql 014-recovery-observation-guard.sql 016-placement-generation.sql 017-context-cognition-binding.sql 015-regency-foundation.sql 019-task-mandate-admission.sql 020-tool-manifest.sql 022-e2-derived-proposals.sql;do psql -v ON_ERROR_STOP=1 -d ct_recovery_test -f "migrations/$m" >> .artifacts/implementation/final/RECOVERY-SCHEMA.log 2>&1;done
CT_DATABASE=ct_recovery_test run EVIDENCE-RECOVERY dist/tests/evidence-recovery.test.js
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ct_recovery_test' AND pid<>pg_backend_pid()" >/dev/null
dropdb --if-exists ct_recovery_test
createdb ct_recovery_test
for m in 001-foundation.sql 002-lock-privileges.sql 004-monotonic-fences.sql 005-identity-authority.sql 006-product-computers.sql 007-context-artifacts.sql 008-recovery-controls.sql 009-runtime-trigger-permissions.sql 010-resource-controls.sql 012-tenant-identity-fks.sql 013-recovery-import-guard.sql 014-recovery-observation-guard.sql 016-placement-generation.sql 017-context-cognition-binding.sql 015-regency-foundation.sql 019-task-mandate-admission.sql 020-tool-manifest.sql 022-e2-derived-proposals.sql;do psql -v ON_ERROR_STOP=1 -d ct_recovery_test -f "migrations/$m" >> .artifacts/implementation/final/AUDIT-RECOVERY-SCHEMA.log 2>&1;done
CT_DATABASE=ct_recovery_test run AUDIT-RECOVERY dist/tests/audit-recovery.test.js
run OPERATOR-DESK dist/tests/desk-frontend.test.js
run SECURITY-RESOURCE dist/tests/security-resource.test.js
run MIGRATION-PREPARATION dist/tests/migration-preparation.test.js
run STAGING-PREPARATION dist/tests/staging-preparation.test.js
run CONTROLLER-HTTPS dist/tests/controller-https.test.js
python3 - <<'PY'
from pathlib import Path
import re,json
s=[]
for p in sorted(Path('.artifacts/implementation/final').glob('*.tap')):
 t=p.read_text();values={k:int(re.search(r'^# '+k+r' (\d+)',t,re.M).group(1)) for k in ['tests','pass','fail','skipped']};s.append({'suite':p.stem,'evidence':str(p),'environment':'LOCAL_FIXTURE',**values})
x={'scope':'local/test-only; no live identity, VM, cloud DR or 24-hour gate passed','suites':s,'nodeGroups':sum(r['tests'] for r in s),'passed':sum(r['pass'] for r in s),'failed':sum(r['fail'] for r in s),'skipped':sum(r['skipped'] for r in s),'nativeDrCases':json.load(open('.artifacts/implementation/dr-lab/RESULT.json'))['cases'],'P1':'PARTIAL','liveIdentity':'NOT RUN','scheduler':'HELD','production':'BLOCKED','canary':'NO-GO'}
Path('.artifacts/implementation/FINAL-SUMMARY.json').write_text(json.dumps(x,indent=2)+'\n');print(f"{x['passed']}/{x['nodeGroups']} Node groups; {x['failed']} failures; {x['skipped']} skipped. All are local/test evidence.")
PY
printf 'Completed safe offline implementation validation. No production or canary executed.\n'
