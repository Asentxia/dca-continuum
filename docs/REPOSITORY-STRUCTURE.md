# Canonical repository structure

```text
README.md
OWNER-ACTION-CHECKLIST.md
package.json / package-lock.json / tsconfig*.json
src/                         product backend and validated shared console contracts
migrations/                  authoritative PostgreSQL domain/roles/constraints
scheduler/                   workflow progression; authority remains outside it
web/                         sole primary Focus Desk product UI
  app/                       authenticated routes and narrow same-origin BFF
  lib/server/                session custody and pinned API transport
  lib/deployment-profile.ts  product/local build trust separation
  tests/                     units/components/profile regressions
tests/                       domain/fault/isolation/browser regression suites
  fixtures/legacy-fail-closed/ minimum historical refusal fixtures, not products
tools/                       reproducible local validation/backup/DR/quality tools
qualification/
  config/                    disabled credential-free staging templates
  runbooks/                  ordered identity/VM/DR/scheduler/migration preparation
  PRODUCTION-GATES.json      honest live gate truth, not local test output
internal/                    local test executables/operator regressions only
docs/
  interface/                 approved current product contract/plan/Focus Desk
  reconciliation/            current delta, 40 interactions, gaps and capability map
  security/                  principal self-review and controls; not independent clearance
  audit/                     archival recovery and concise disposition record
.artifacts/                  ignored fresh results (never committed)
.local/                      ignored owned disposable DB/keys/runtime (never uploaded)
```

`dist/` is the engineering/test build, not a deployable product tree. `dist-product/` excludes all `tests/` and `internal/` executable fixtures. `web/.next/` is the ordinary PRODUCT build; `.next-local-test/` is an isolated test-only build. Product and local-test builds are deliberately not interchangeable.

The approved detailed provisional target is retained as requirements context in `PROVISIONAL-TARGET.md`; the concise implemented topology is `ARCHITECTURE.md`. Neither substitutes for production evidence or promotes a scheduler/canon decision. Historical source packets/generated outputs are outside the active product tree, recoverable through the archived reviewed commit.

A credential-free PR workflow is in `.github/workflows/ci.yml`. Hosted execution of that workflow is not qualified: the latest observed run on the prior head did not start a runner. Bot review is not a substitute. The design notes remain in [principal review](security/PRINCIPAL-REVIEW.md#ci-design-and-unapplied-setup).
