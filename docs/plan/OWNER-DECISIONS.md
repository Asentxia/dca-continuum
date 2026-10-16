# Owner decision record

Recorded for the current roadmap on 2026-10-12. This document records the owner's
existing scope. It does not approve deployment, donor copying, spending, or live
gates. D01–D04 stay as recorded below. The ENG-026 choices stay scoped to that
task. D05–D12, recorded below on the same date, stop at the limit and missing
inputs in each section. They do not close every subdecision and do not prove
qualification.

## D01 — approved architecture, integration still unqualified

The owner supplied this authorization in the product-planning conversation:

> D01 proposal is approved, reuse NEXUS for bounded execution and adapt AEON for
> governed memory, with Continuum retaining authority and enforcement.

The owner then accepted the scoped plan record and directed correction of the draft
that had incorrectly reopened D01. Missing access to that conversation in a new
agent is a provenance gap, not a withdrawal of the owner's decision.

- NEXUS is the bounded execution direction. Evaluation pin:
  `e1c3d3c75d58f609c617e7a87cb05e84ea437d64`.
- AEON-IQ is the governed derived-memory candidate. Evaluation pin:
  `d5866e85edb3a7f7ea7186854655981ca73760f4`.
- Continuum keeps identities, grants, exact approvals, admitted facts, objectives,
  evidence and effect enforcement. PostgreSQL/ContextService own canonical admission.
- Expose restricted adapters, not the existing donor public/proxy/management servers.
  Workers and Focus Desk do not acquire donor management access or provider secrets.
- Extraction proposes facts; it does not admit them. A computation token is not an
  effect grant. ENG-013, ENG-014, ENG-019 and ENG-021 acceptance remains mandatory.
- The separate exec/filesystem/application workspace is not NEXUS WASM isolation.
- Donor tests are evaluation evidence, not Continuum integration qualification.
  A fallback requires evidence and a separately approved scoped proposal.
- D05 still governs donor copying, licensing, disclosure and supported packaging.
  D01 does not authorize copying donor trees, paid resources, merge or production.

## D02 — approved autonomous work, no effect-authority delegation in v1

Agents can plan and work inside permissions received from the trusted authority.
They cannot create, expand or transfer effect authority. Additional permission is
requested from that authority. Permissions remain scoped, expiring and revocable.
Preserve existing exact approvals and final-send checks. This adds no manual approval
for every harmless step and removes none already required by the contracts.
Child grants, delegation DAGs/chains and authority-passing policy engines remain
unauthorized. Preserve their future acceptance requirements without implementing them.

## D03 — approved durable identity and separate histories

VERA identity, durable work and governed memory persist across model/placement
replacement. Keep tenant, organization, workspace, VERA, workload, logical Computer
and physical placement distinct. Principal epoch, enrollment version and placement
generation are separate counters. Old placements are fenced; consequential work
needs fresh authority. One tenant is the first profile, with isolation for later
customers. This does not authorize managed hosts or a second Computer per VERA.

## D04 — approved unified Regency governance

Regency lives in Focus Desk and authoritative PostgreSQL governance records. The
Effect Controller separately enforces consequential actions. No competing governance
database or second primary interface. A role, membership or mandate is not an effect
grant or approval.

## ENG-026 — accepted for this task only, 2026-10-12

Cael approved these six choices for ENG-026 only. This is not an approval of
D05–D12, donor copying, spending, merge, deploy, or live gates. A mandate does
not create a grant, an approval, or permission to send. Creating a task does not
start a workflow or send an external action.

1. Every product task-creation path must supply a current mandate. The human
   command is not a special case, and the machine API is not exempt.
2. Eligibility is an active VERA principal who has a `vera` membership in the
   mandate's organization. An active principal with no membership is not enough.
   A human membership is not enough.
3. Store the organization, the mandate, and the accepted version on the new task.
4. Historical tasks stay unbound and cannot be backfilled.
5. The task and the human command stay in their own records. They are not stored
   through the ENG-012 tenant-notice path.
6. An authenticated, authorized repeat of an identical stored request returns the
   existing result and creates no new work even if the mandate has since advanced.
   A changed binding conflicts.

Affected task: ENG-026.

## D05 — restricted pinned reuse, 2026-10-12

Cael approved this direction on 2026-10-12. Reuse NEXUS and AEON through
restricted, pinned integrations. Verify licensing and provenance before copying
or distributing donor code. Do not change repository visibility or choose a new
product license.

This direction does not close every licensing or packaging subdecision and does
not prove qualification. Still missing: licensing and provenance evidence before
any donor copy or distribution. Visibility and the product license stay as they
are.

Affected tasks stay inside that limit: ENG-013, ENG-014, ENG-019, ENG-051, and
the publication half of ENG-052.

## D06 — existing WorkOS sign-in, separate workload credentials, 2026-10-12

Cael approved this direction on 2026-10-12. Use Cael's existing WorkOS account
for human sign-in. Keep separately enrolled, short-lived workload credentials
for agents. Identify the required account settings and obtain credentials
securely. Never place them in chat or Git.

This direction does not close every identity subdecision and does not prove
qualification. Still missing: the WorkOS account settings and a secure way to
supply credentials. Live sign-in stays blocked until then. Workload credentials
stay out of chat and Git.

Affected tasks stay inside that limit: the live half of ENG-010, the live
gateway of ENG-022, and ENG-037.

## D07 — one controlled file write, then read-back, 2026-10-12

Cael approved this direction on 2026-10-12. Build the first protected-action
adapter around one controlled file write in a dedicated GitHub test repository,
followed by authoritative read-back. Live execution requires the named
repository, scope, credentials, and an exact authorization for that one write.

This direction does not close every provider subdecision and does not prove
qualification. Still missing: the test repository name, scope, credentials, and
that exact authorization. Until then the adapter can be built but not executed
live.

Affected tasks stay inside that limit: ENG-017, ENG-039, and external channels
for ENG-034.

## D08 — local development and a costed hosting proposal, 2026-10-12

Cael approved this direction on 2026-10-12. Continue development and testing
locally. Prepare a costed customer-hosting proposal covering servers, databases,
worker isolation, backups, region, and recovery targets. New infrastructure
purchases remain unapproved.

This direction does not close every hosting subdecision and does not prove
qualification. A costed hosting proposal can be written. No purchase is
approved. No numeric recovery target is approved. The future live-database
procedure remains a separate unaccepted proposal.

Affected tasks stay inside that limit: ENG-016 beyond a design note, ENG-038,
and the managed halves of ENG-015 and ENG-040.

## D09 — compare schedulers without selecting one, 2026-10-12

Cael approved this direction on 2026-10-12. Evaluate pg-boss and Temporal
against the required workload and recovery tests. Recommend the simplest
qualifying option with measured evidence. Final selection waits for approved
comparison criteria.

This direction does not select a scheduler and does not prove qualification.
Still missing: comparison criteria for pg-boss and Temporal. No scheduler is
selected. The scheduler ledger stays HELD.

Affected tasks stay inside that limit: ENG-029 stays reference-only, and
ENG-041 may not choose.

## D10 — first autonomy milestone, 2026-10-12

Cael approved this direction on 2026-10-12. The first autonomy milestone
requires a real model, one VERA completing a defined application objective,
independent functionality checks, and safe resumption after interruption.
Fixtures prove plumbing only. Propose broader numerical targets before
evaluating against them.

This direction does not close every measurement subdecision and does not prove
qualification. Still missing: a proposal for broader numerical targets. The
autonomy milestone is not met by fixtures. Whether a fixture gateway is enough
to start ENG-023 remains open.

Affected tasks stay inside that limit: ENG-025, ENG-036's volume target,
ENG-041's measurement rule, ENG-045, ENG-046, ENG-048, ENG-049, and ENG-050.

## D11 — isolated owner pilot, billing disabled, 2026-10-12

Cael approved this direction on 2026-10-12. Start with the isolated owner
pilot. Keep Stripe billing disabled. Propose retention, deletion, backup,
disclosure, and commercial policies before customer use. Do not invent an
approved retention period.

This direction does not close every commercial subdecision and does not prove
qualification. Still missing: those proposed policies. No retention period is
approved. Stripe stays disabled.

Affected tasks stay inside that limit: ENG-024's retention policy, ENG-035,
ENG-047, and ENG-051.

## D12 — independent review before any live release, 2026-10-12

Cael approved this direction on 2026-10-12. Require independent release review
and mandatory qualification evidence. Live deployment, shadow, and canary
require separate authorization.

This direction does not prove qualification. Still missing: that independent
review and the qualification evidence. No live deployment, shadow, or canary is
authorized.

Affected tasks stay inside that limit: ENG-006's live review, ENG-042,
ENG-043's live cutover, ENG-044, and ENG-052.

## Open decisions

D05–D12 above are the directions Cael approved on 2026-10-12. Each one stops at
the limit and missing inputs in its section. They do not close every
subdecision and do not prove qualification. ENG-026's six choices above stay
limited to that task.

These choices also remain open: whether a fixture gateway is enough for the
local ENG-023 milestone, and the future live-database procedure. A documentation
merge does not settle the remaining decisions or promote a ledger. Record later
owner decisions here with date, exact scope, evidence reference and affected
tasks. A newer file or an agent recommendation is not approval.

Production BLOCKED; scheduler HELD; canary NO-GO. Merges, releases and live gate
activation require their own authorization and evidence.


## D13 — authorized offline implementation sprint, 2026-10-15

The owner explicitly authorizes isolated local development, ordinary pinned development
dependencies without spending, owned disposable fixtures, additive E2 migration and
tests, restricted pinned NEXUS/AEON integration after file-level rights/dependency/security
review, and small local Git commits/portable bundle for the owner's independent audit.
This supersedes earlier report-only/implementation-held instructions **within this scope**.
It does not waive the frozen safety/recovery contracts or change D01–D12 architecture.

- E2 first slice: one exact source, one PRIVATE/quarantined/UNVERIFIED result;
  ContextService/PostgreSQL remain authoritative. No release/share/effect permission.
- Logical withdrawal/access denial and fail-closed recovery interfaces are authorized.
  Preserve provisional90-day ordinary content-free audit and30-day verified completed
  disposable retry defaults, excluding immutable safety/replay/unresolved/legal material.
  No irreversible physical purge or invented backup deadline.
- Offline deterministic integration is the milestone; it is **not** D10 real-model
  autonomy or live authentication. The missing live model/WorkOS/hosting inputs do not
  block this scoped offline work.
- Donor pins remain NEXUS e1c3d3c75d58f609c617e7a87cb05e84ea437d64 and
  AEON-IQ d5866e85edb3a7f7ea7186854655981ca73760f4 in their historical recovery
  mirrors. File/dependency clearance precedes reuse; public redistribution remains held.
- Subagents and separate internal reviewers are authorized. They supplement, not replace,
  the owner's final independent audit. No change is accepted/merged solely by its author.
- Official destination is Asentxia/dca-continuum. Existing public history/README/PR work
  must be preserved. No first public code push, merge, visibility/history/license change
  is authorized by this sprint; deliver a local Git branch/bundle unless separately cleared.
- No spending, live provider/model calls, new live credentials, protected external writes,
  production/shared database reset, deployment, shadow or canary.

ENG-001–052 retain their acceptance requirements. Sprint-specific coverage/evidence must
be bound to actual source and executed tests; related work does not close whole tasks.
Production BLOCKED; scheduler HELD; canary NO-GO.
