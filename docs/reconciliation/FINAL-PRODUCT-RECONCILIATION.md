# Final-product reconciliation

Status: proposed target, not canon. Owner decisions D01–D12 are not approved. Production stays BLOCKED, the scheduler stays HELD, and canary stays NO-GO.

The external engineering drop-in inspected commit `0d6c911`. This tree has moved. Remediation of the October 9 audit is `32f45fd`. This note maps the later handoff onto the code after that commit. It does not copy the private reference archive, install the proposed Cursor rules, or replace `OWNER-ACTION-CHECKLIST.md`.

## What already exists

PostgreSQL is the domain record. The Effect Controller is the only sender for a consequential action. A VERA is a principal, not a model, session, or Computer. Focus Desk in `web/` is the only product UI. Scheduler adapters move work; they do not grant authority. Frozen M1 safety bytes and the recovery extension stay in force. Delegation remains unsupported.

## Handoff findings

| Finding | Result |
|---|---|
| H01–L02 from the October 9 audit | Fixed in `32f45fd`, with regressions. Local canonical run on that working tree passed before the commit. Hosted CI has not run on it. |
| AUD-01 malformed gate ledgers | Fixed here. Empty, missing, and duplicate gate definitions exit 1. The real production and release ledgers still exit 1 as blocked, not as malformed. |
| AUD-02 recovery can insert REQUESTED work | Fixed by migration `013`. The recovery role is rejected. Ordinary REQUESTED inserts stay available to product roles. |
| AUD-03 local fence activation | Fixed. Activation now requires a blocked fence and a 64-character digest, matching the S3 adapter's check. A cloud race was not run. |
| AUD-04 unbounded controller response | Fixed for deadline and response size. The client does not send again. |
| AUD-05 full provider/object body allocation | GitHub and S3 reads now stop at a byte cap while streaming. A live oversized GitHub or AWS response was not executed. |
| AUD-06 UTF-8 decoded per chunk | Fixed. Request bytes are buffered and decoded once. A split multibyte character keeps the original text. Invalid UTF-8 is rejected. |
| AUD-07 GitHub token text | Fixed for the documented token shapes, using a synthetic value. No live token was used. |
| AUD-08 stale assignment selection | Fixed. A failed machine refresh clears the previous selection. Component test passed. |
| AUD-09 lifecycle installs | The legacy qualification and validation installers now use `npm ci --ignore-scripts`. |
| AUD-10 provider state and CI docs | Unknown Runloop statuses throw. `provisioning` stays STARTING. The repository structure note now says the workflow file exists and hosted execution is not qualified. A live Runloop call was not run. |
| AUD-11 AEON route authentication | Not in this repository. Not verified and not imported. |
| AUD-12 owner decisions | Open. Not treated as approved. |

## Does the proposed architecture fit?

It fits as the next product, not as a second codebase. Regency governance, durable VERAs, Computers, contained execution, and governed memory can sit on the current control plane if they use the same tenant, the same principal, the same approval binding, and the same controller.

These parts do not fit if they are copied in as their own authority:

- A NEXUS or AEON service must not own grants, evidence, or effect success. Those stay in PostgreSQL and the controller.
- AEON memory tables must not become a second fact store. Admitted context stays canonical. A cognition service can keep a derived projection.
- Regency membership must not widen a grant. Organization changes are not approval.
- Multi-Computer placement must not reuse the single generation field as if it were the principal epoch and the enrollment version. Those are different counters today.
- Donor dashboards, old Mongo or JSON authority, and Control Room are not a second UI.
- Migration `012` in this repository is the tenant identity migration. A proposed Regency migration must use a later number.

Named adoption of the NEXUS and AEON-IQ repositories is D01. Until that decision, do not merge those trees. Their credential enforcement was described as inactive in the handoff and was not re-tested here.

## Updated task order

1. Done locally: October 9 audit fixes (`32f45fd`) and the confirmed handoff defects (`9fa4292`, with the CI note in `39bca35`).
2. Next execution: hosted CI on the exact commit the owner chooses to push. That run is not a production qualification.
3. Then ENG-006 evidence review on that SHA: product build rejects fixture sign-in, and the local suites match the commit.
4. Stop before ENG-007. Regency tables, delegation, VERA lifecycle expansion, and named runtime adoption wait on D02 and D03, and D01 where a specific repository is required.
5. Live identity, a protected provider, managed computers, HA, and the 24-hour scheduler trial stay in the existing owner sequence. They are not started from this note.

## Owner decisions

Recommendations are not approvals.

| Decision | Plain English | Recommendation | Blocks |
|---|---|---|---|
| D01 | Whether to adopt the named NEXUS and AEON-IQ codebases or build equivalent boundaries without those names. | Keep the capability requirements. Do not merge those repositories until an owner picks the source and the pin. | ENG-013, ENG-019, ENG-021 |
| D02 | Whether agents may ever receive a smaller grant from a trusted issuer, or every effect stays individually approved. | Keep today's rule: no delegation. A later version can add bounded delegation only as a new contract. | ENG-008 and any policy engine |
| D03 | How an organization, a VERA, and more than one Computer are identified without mixing their histories. | Keep one tenant boundary and private VERA data. Do not overload Computer generation. | ENG-007, ENG-009, ENG-015, ENG-027 |
| D04 | Whether governance is a separate product surface. | Keep one Focus Desk. Regency is a responsibility inside it, not a second console. | ENG-031 |
| D05 | License, visibility, and what private research can be published. | Leave the repository as it is. Do not commit the private archive. | ENG-051, ENG-052 and publication of this drop-in |
| D06 | Real human sign-in and short-lived workload identity for staging. | Use the existing AuthKit direction only after the owner supplies issuer, audience, and redirect values. | ENG-010 and live P1 |
| D07 | One safe, reversible provider action whose result can be read back. | Do not treat the public GitHub GET as that action. | ENG-017 and live P2 |
| D08 | Where staging computers, databases, and backups run, and the recovery objectives. | No paid resources until the owner sets the account, region, and RPO/RTO. | ENG-015, ENG-016, ENG-038, ENG-040 |
| D09 | pg-boss or Temporal after a real measurement. | Keep both adapters. Do not choose from a short local timer. | ENG-029, ENG-041 |
| D10 | Numeric targets for product acceptance and the research phases. | Do not invent thresholds. Research mode cannot promote itself. | ENG-036, ENG-045–ENG-050 |
| D11 | Data retention, model disclosure, and whether billing or chain features exist. | Keep test units as test units. Optional economic features stay out of the core. | ENG-024, ENG-035, ENG-047 |
| D12 | Who reviews, and when a merge, shadow, or canary is allowed. | Development work is not release. Shadow and canary stay unauthorized. | ENG-006's live review, ENG-042–ENG-044, ENG-052 |
