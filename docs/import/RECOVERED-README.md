# Asentxia Continuum

For new tasks and the completion roadmap, read
[the repository starting point](docs/plan/START-HERE.md),
[current plan](docs/plan/CURRENT-PLAN.md) and
[owner decision record](docs/plan/OWNER-DECISIONS.md).

Continuum is the governed operating environment for persistent autonomous intelligence. VERA is the durable accountable principal, not a model, session, credential or Computer. PostgreSQL owns domain truth; the scheduler owns workflow progression; the independent Effect Controller enforces consequential actions; authoritative provider observation establishes external truth.

**Development baseline only. P1/P2 PARTIAL · P3/P4/P5 NOT RUN · scheduler HELD · production BLOCKED · canary NO-GO · independent security review NOT RUN.** A passing local build does not clear these gates.

## Repository

- `src/`, `migrations/` — domain, identities/authority, effects, computers, context/artifacts, evidence/recovery and controls.
- `scheduler/` — supported workflow progression/adapters, not authorization.
- `web/` — the only product UI: authenticated Next.js/React/TypeScript Focus Desk.
- `tests/`, `tools/` — regressions and reproducible local validation.
- `qualification/` — unchanged live gate definitions, disabled staging configuration templates and runbooks.
- `internal/` — disposable local fixtures and the isolated operator regression harness; never product routes.
- `docs/` — current architecture, safety, interface, traceability/gap, audit and staging documentation.

Historical handoff/source/evidence copies are archived, not active product code. [Archive manifest and recovery](docs/audit/ARCHIVE-RECOVERY.md).

## Offline integration sprint

The recovered v7.1 foundation now has a local E2 governed admission implementation,
an opt-in real NEXUS WASM profile and a narrow native AEON ranking adapter. E2 results
remain private/quarantined/unverified; they are not automatically recallable facts.
No live model, donor server, external-action authority or production gate is enabled.
See [actual scope, reproducible setup, tests and limitations](docs/integrations/LOCAL-IMPLEMENTATION.md).
Final acceptance remains subject to the owner's independent audit. Exact measured
results belong to the source-bound evidence package, not an unqualified README badge.

## Prerequisites

Linux; Node **24** for backend, separately installed Node **22** for the frontend; PostgreSQL **17** tools; Python 3, OpenSSL, Chromium and local UID/network namespace privileges. Current pins are in the lockfile. The original baseline used Node 24.14.1/22.23.3 and PostgreSQL 17.10. No live account, cloud resource or production credential is needed for PR validation.

```bash
export CT_PG_BIN=/path/to/postgresql17/bin
export CT_NODE22_BIN=/path/to/node22/bin
export CT_CHROMIUM_PATH=/path/to/chromium
export PATH="$CT_PG_BIN:$PATH"   # retain Node 24 as the backend runtime
npm ci --ignore-scripts
CT_RESET_LOCAL_FIXTURE=yes CT_RESET_CONSOLE_FIXTURE=yes npm run test:canonical
```

The reset flags authorize only named disposable databases within the verified local workspace cluster. Test tools reject production/staging profiles, linked data directories and live identity/database configuration. Do not run them in a live environment. See [testing and evidence](docs/TESTING.md).

## Run the local console

```bash
npm run dev:console
CT_RESET_CONSOLE_FIXTURE=yes npm run dev:console:reset
```

`npm run dev:console` builds and runs a **LOCAL TEST** console/API on loopback and leaves an existing owned `ct_console_dev` in place. Gemini connections seal provider keys with `CT_MODEL_CREDENTIAL_KEK`, a 32-byte base64 key generated once with `openssl rand -base64 32` and stored outside Git with owner-only permissions. Reuse that same value on every start. A new value makes existing sealed keys unreadable, and losing it makes them unrecoverable. This environment variable is a local prototype, not production secret management. Do not print it, and leave `CT_ENABLE_GEMINI` unset so no live provider call is made. `npm run dev:console:reset` is the separate destructive command. It runs only when `CT_RESET_CONSOLE_FIXTURE=yes` is already set, and it still refuses a cluster that is not this checkout. Short-lived fixture identities are not real AuthKit or workload identity. Human commands record tasks, exact approvals/assignments/grants and acknowledgements; approval is never execution. UNKNOWN has no generic Retry action. Unsupported capabilities remain explicitly unavailable.

## Product builds — not deployment

```bash
npm run build:product          # backend excludes tests and internal executables
npm run typecheck:console
npm run test:console
npm run build:console          # ordinary PRODUCT frontend build, .next/
```

The dedicated E2E/local frontend build is separate (`.next-local-test/`), labelled test-only and must never be deployed. Runtime fixture switches cannot turn the ordinary PRODUCT build into test authentication. Staging authentication, workload identity, keys, networking, provider contracts and DR still require real qualification; empty secure configuration fails closed. Configuration templates contain no credentials.

## Current documentation

- [Implemented architecture](docs/ARCHITECTURE.md), [repository structure](docs/REPOSITORY-STRUCTURE.md).
- [Frozen safety contracts](docs/M1-SAFETY-CONTRACTS.md), [recovery extension](docs/RECOVERY-CONTRACT-v0.2.md).
- [Approved product interface](docs/interface/PRODUCT-CONTRACT.md), [Focus Desk direction](docs/interface/FOCUS-DESK-DESIGN.md).
- [40-contract traceability](docs/reconciliation/CANONICAL-TRACEABILITY.md), [current gaps](docs/reconciliation/CANONICAL-GAP-REGISTER.md).
- [Operator capability mapping](docs/reconciliation/OPERATOR-UI-CAPABILITY-MAPPING.md).
- [Production gate truth](qualification/PRODUCTION-GATES.json), [staging sequence](docs/REMAINING-STAGING-SEQUENCE.md).
- [Principal engineering/security review](docs/security/PRINCIPAL-REVIEW.md), [cleanup dispositions](docs/audit/DISPOSITION.md).
- [One owner checklist](OWNER-ACTION-CHECKLIST.md).

Generated logs, screenshots and results live in ignored `.artifacts/`; CI/release artifact retention is the intended model, not a claim that hosted CI has run. They are evidence, not source files or automatic production certification. No merge, production deployment, paid resource, shadow or canary is authorized here. Public/open-source policy and the project license remain owner decisions; public visibility alone is not an open-source license.
