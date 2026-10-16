# Operator UI → Focus Desk capability mapping
Recorded BEFORE retirement/move of any operator asset. Final production frontend authority is the reconciled interface packet + Focus Desk handoff, not the local operator layout.

| Previous operator capability | Backend contract | Focus Desk surface | Disposition | Acceptance |
|---|---|---|---|---|
| Fixture owner sign-in | Signed test issuer + independently enrolled human; AuthKit server bridge | Entry/account + session projection | Migrated as clearly labelled test auth; real AuthKit configuration required | A01/A11, browser sign-in/isolation |
| List/refresh tasks | ProductService + R-WORK/R-FOCUS snapshot | Work + deterministic Needs attention | Migrated; bounded pagination replaces unbounded debug queue | A03–06/A38/A39 |
| Inspect task/exact operation | Immutable ct.operations binding + current authoritative read | Task inspector → Approvals | Migrated; separate business/workflow/effect axes | A05/A16/A22 |
| Exact approval | AuthorityService + atomic human ledger + append-only history | Approval inspector | Migrated, fresh MFA/current version; never dispatch button | A17/A18/A21 |
| SHA/digest disclosure | Canonical binding, provider observation vs chain integrity | Technical disclosure + Evidence | Migrated with distinct truth/integrity labels | A16/A24 |
| Cancel later task admissions | Existing ProductService.cancel CAS/final-send guard | Internal operator fixture only | INTERNAL-ONLY; no unreviewed primary cancellation control | Existing backend cancellation/race tests |
| UNKNOWN/status/read-back information | Controller UNKNOWN/read-only observation/recovery contracts | Recovery + linked operation detail | Migrated read-only; no browser resend/reconcile/renew | A22/A31 |
| Context quarantine inspection | ContextService provenance/version/quarantine | State / Context metadata | Migrated narrow read-only facts | A15 |
| Release quarantined exact context | ContextService.approve(version,digest) | Internal operator fixture only | INTERNAL-ONLY; not a new memory mutation by implication | Existing context/version/isolation tests |
| Gate status banners | Canonical qualification ledger | Persistent banner + readiness/settings | Migrated; no local PASS → live promotion | A02/A33/A37 |
| Fixture scenario IDs/process probes | Test harness and raw evidence | Internal/debug tests, not main product | INTERNAL-ONLY | Baseline/namespace/fixture suites |

The legacy assets are retained under `internal/operator/ui` and their server (`internal/operator/server.ts`) is test-only and excluded from the product backend build. The canonical product starts only the new Next.js console. There is no competing primary UI or live legacy command path.

## Cleanup audit disposition

Cancellation and exact quarantined-context release remain **INTERNAL TEST TOOL** behavior, not public administrative capabilities. Existing ProductService/ContextService CAS/tenant/authority tests and the six operator integration regressions are retained. The old UI is not bundled into Next or exposed by public routes. A production administrative tool requires its own authenticated contract and qualification; it is DEFERRED, not silently simulated. Current task/approval/UNKNOWN/evidence/context-read/gate functions are reimplemented in Focus Desk; fixture scenario probes stay engineering-only.
