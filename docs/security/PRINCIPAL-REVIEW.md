# Principal engineering and security review — PR #1

Reviewed baseline: `3c197ddb57c13db397e30c48e4ceb6949d3a8ee9`. Scope: canonical repository cleanup and actual implementation review, not a new design or production certification. Performed by the implementation lead with fresh verification; **external independent security review remains NOT RUN**.

## Decision

**NOT READY TO MERGE yet.** The product code is locally verified and the product tree is substantially cleaner. Before merge, revoke/rotate the exposed chat credential and apply/run credential-free PR CI on the final commit. Repository public/commercial policy and licensing require an explicit owner decision. No main merge, deployment, cloud resource, live account mutation, shadow, canary or history rewrite occurred.

Production remains **BLOCKED**; scheduler **HELD**; canary **NO-GO**. P1/P2 **PARTIAL**; P3/P4/P5 **NOT RUN**. Frozen safety contracts and live/release gate definitions are unchanged. Local green results do not clear any live gate.

## Ranked findings and disposition

| ID | Severity | Finding | Disposition / evidence |
|---|---|---|---|
| S01 | HIGH | Test authentication, signing and fixture services needed stronger deployment/profile boundaries | FIXED: explicit isolated local profile, loopback/named-DB checks, compile-time product/local frontend separation, public-key-only product controller. Eight negative boundary groups and three actual product-build/runtime isolation groups pass |
| S02 | HIGH — external | GitHub credential was exposed in chat and temporarily reused with explicit owner authorization | UNRESOLVED until owner revokes/rotates it. No value is stored in product source, reports, Git configuration or delivery artifacts; temporary local authentication is removed after publishing |
| S03 | MEDIUM | Product output could retain an obsolete compiled fixture from an earlier build | FIXED: verified non-linked output is cleared before product compilation. Original failing test retained; all three artifact-isolation tests then pass |
| S04 | MEDIUM | Historical Temporal SDK failure output disclosed 32 opaque local activity-completion tokens | Source FIXED with structured sensitive-metadata/Error/binary redaction and regressions. Original history preserved; exact historical fingerprints only are acknowledged. These are stopped disposable local-service tokens, not GitHub/provider tokens. No history rewrite or credential validity test performed |
| S05 | MEDIUM | BFF request limits were checked after body allocation | FIXED: streaming byte limits and strict UTF-8 decoding before JSON parsing; four frontend body-limit tests pass |
| S06 | MEDIUM | Hosted CI/artifact automation is absent | UNRESOLVED: design below; setup blocked/unapplied. Full existing local verification and scans ran; hosted CI NOT RUN |
| S07 | LOW | Future authentication timestamps should be rejected at verification | FIXED defensive validation. Existing enrolled-owner eligibility already rejected future MFA; this is not a newly demonstrated privilege escalation |
| S08 | LOW | Dense formatting, multiple entry points and historical/generated source clutter impaired review | FIXED: 88 existing files are formatting-only; source preserved, README is the single entry point, current documents consolidated, historical artifacts archived |

No unresolved HIGH **product-code** defect was demonstrated by this pass. This statement is bounded by the review and tests, not a proof of production safety. S02 remains a HIGH owner-controlled credential risk.

## Reviewed boundaries

- **Identity/session/BFF:** pinned issuer/JWKS/audience/algorithm, identity enrollment, fresh owner eligibility, expiry and subject binding; same-origin CSRF; bounded structured errors; server-only cookie/API custody. Fixture routes cannot become product authentication through runtime switches. Missing secure configuration fails closed.
- **Tenant/domain/authority:** composite tenant keys, forced RLS/non-owner roles, permission-filtered read/search/pagination/export, immutable action binding and approval history, current version/epoch/generation/recovery fence, CAS/locking, duplicate conflicts and final-send revocation checks. Human, VERA, machine identity and Computer remain separate.
- **Effects/provider:** separately enforced controller; no browser dispatch/renew/retry; no provider-wide key in ordinary workers; fixed URL/redirect policy, authoritative read-back, UNKNOWN without resend, read-only recovery observation separated from write grants. Compensation remains a new authorized operation.
- **Computers/context/evidence/recovery:** complete lifecycle projection and generation fences; restored work does not auto-send; human takeover is unavailable without its own qualified contract. Context has provenance/version/quarantine, not authority. Hash chains establish integrity, not external success. Backup activation and independent restore fencing remain fail-closed.
- **Resources/runtime:** bounded requests/jobs/storage and uncertainty reservations; local isolation tests, restricted controller socket, product build excludes internal/legacy executables. Trusted scheduler/coordinator database roles must never be issued to ordinary multi-tenant workers.

## Fresh verification

Local canonical runner on Node 24.14.1 (backend), Node 22.23.3 (frontend), PostgreSQL 17.10 and system Chromium:

- **165/165 backend groups**: original 121, console domain 23, semantics 5, fixture boundaries 8, security regressions 2, public immutable GitHub read 6.
- **25/25 frontend tests**, typecheck and optimized ordinary product build PASS; separate test build PASS.
- **22/22 Chromium E2E**, **3/3 actual product artifact/runtime isolation**, **5 native local HA/PITR cases**, **2 Python immediate-refusal probes**. Separately counted, not additional production gates.
- Axe: zero selected-rule violations on Work and approval. Keyboard/focus return, 320/390/768/1024/1440 widths, 200% text, equivalent 400%-zoom reflow and reduced motion exercised. Native screen reader and native browser zoom NOT RUN; no WCAG certification claim.
- 10,000-task local fixture; 60 rows/page; 10-second bounded polling; 12 samples, local page-read p95 **25.08 ms**. Not a production latency/SLA benchmark.
- Production and complete dev+production dependency audits: zero reported advisories at audit time. Pinned secret scanner: no active-tree findings. History findings are S04; heuristics cannot prove absence of all secrets.
- Qualification and release enforcement each exit **1**, intentionally. No ledger edited to turn an expected block green.

Final evidence and the tested-source fingerprint are generated outside Git in `.artifacts/` and the downloadable audit archive. Current source is tied to that fingerprint after the documentation-only finalization.

## Operator UI

Focus Desk is the only product interface. `internal/operator/ui` and its server are deliberately retained as six-test regression tooling, excluded from product compilation/routes and rejected outside the local fixture profile. Production endpoint-isolation tests pass. Cancellation and exact quarantined-context release remain **internal test-tool operations**; a live administrative surface is DEFERRED. Capability mapping and acceptance references are in `docs/reconciliation/OPERATOR-UI-CAPABILITY-MAPPING.md`.

## CI design and unapplied setup

**Setup BLOCKED / NOT APPLIED; hosted execution NOT RUN.** Do not treat a proposed workflow as installed. The attempted CI/scanner scaffolding was denied by the execution safety boundary; it was not bypassed. Independent scans of existing source and the complete existing local test runner were still completed.

Minimal ordinary PR CI, with no live credentials:
1. Checkout the exact PR commit with minimal read permissions; pin trusted actions by SHA.
2. Install pinned Node 24 and Node 22, PostgreSQL 17 tools, Python/OpenSSL, Chromium and required disposable local namespace privileges; `npm ci --ignore-scripts`.
3. Run the guarded canonical runner: baseline/migrations/domain/security, frontend typecheck/units/product build, actual product-isolation and Chromium E2E/axe/performance fixtures. Preserve prerequisite failures as NOT RUN, never PASS.
4. Run production and complete dependency audits; pinned redacted source/history secret scans with only the 32 exact historical acknowledgements. No broad path/rule exclusions.
5. Run qualification/release enforcement and assert the currently expected blocked result; do not change gate truth or require live provider credentials in PR CI.
6. Upload bounded `.artifacts/` logs, screenshots and summaries as workflow artifacts with controlled retention/access; never private keys, `.local/`, DB/WAL/dumps, dependencies or secrets. Do not commit generated outputs.

## Remaining qualification / owner decisions

Live AuthKit/MFA/renewable workload semantics, protected provider idempotency/truth, managed VM/browser/worker containment, cloud HA/PITR/region fencing, complete independent restore inventory, object retention/deletion, real billing/resource control and the real 24-hour scheduler/native versioning trial remain unqualified. Semantic/vector/model memory behavior and production administrative tools are not silently simulated.

Repository is public with no project license selected. Public visibility is not an open-source license. Decide public versus private commercial ownership and review all third-party distribution notices, including dependency/font licenses. A later visibility change cannot erase already-published Git history. No visibility/license change or legal clearance is claimed.

One external action list: `OWNER-ACTION-CHECKLIST.md`. Owner staging sequence: sign-in/workload/secure injection → safe protected provider → managed Computer isolation → HA/PITR/DR → real 24-hour paired scheduler/metrics → remaining release gates and independent review → separate shadow/canary authorization. No automatic progression to live effects.
