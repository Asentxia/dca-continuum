#!/usr/bin/env bash
# Sourced only by intentional disposable local tools. No live credentials accepted.
if [ "${NODE_ENV:-}" = production ] || [ "${CT_RUNTIME_ENV:-local-test}" != local-test ] || [ "${CT_DEPLOYMENT_ENV:-local-test}" != local-test ] || [ "${CT_CONSOLE_MODE:-LOCAL_FIXTURE}" != LOCAL_FIXTURE ];then
 echo 'Refusing local fixtures in staging/production or conflicting profiles.' >&2;return 2 2>/dev/null || exit 2
fi
for key in WORKOS_API_KEY WORKOS_COOKIE_PASSWORD WORKOS_CLIENT_ID DATABASE_URL CT_DATABASE_URL CT_PRODUCTION_CONFIG CT_STAGING_CONFIG;do
 if [ -n "${!key:-}" ];then echo 'Refusing local fixtures alongside live identity/database configuration.' >&2;return 2 2>/dev/null || exit 2;fi
done
if [ "${PGHOST:-127.0.0.1}" != 127.0.0.1 ] || [ "${PGPORT:-55432}" != 55432 ];then echo 'Refusing non-fixture database endpoint.' >&2;return 2 2>/dev/null || exit 2;fi
for key in PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS;do
 if [ -n "${!key:-}" ];then echo 'Refusing libpq connection override.' >&2;return 2 2>/dev/null || exit 2;fi
done
export CT_RUNTIME_ENV=local-test CT_ALLOW_LOCAL_FIXTURES=yes
