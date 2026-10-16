# Asentxia Continuum — current completion plan

Status: repository planning baseline prepared for owner review on 2026-10-12.
Publication through this documentation PR establishes one roadmap; it does not
approve unresolved task designs, copying donor code, spending, merging product PRs
or releasing production. Read [START-HERE.md](START-HERE.md) and
[OWNER-DECISIONS.md](OWNER-DECISIONS.md).

Production stays BLOCKED. The scheduler stays HELD. Canary stays NO-GO.

Current `main`, fetched 2026-10-12: `18dc8ce5531f7cf57e8f2c9a508c8339d164d4c1`, the merge of pull request #22. Fetch `main` again before implementation.

This plan consolidates the prior acceptance map and later verified merge history.
The owner-approved D01–D04 scopes are recorded in OWNER-DECISIONS.md. D05–D12 are
recorded there on 2026-10-12 with their exact limits and the inputs still missing.
Those directions do not close every subdecision and do not prove qualification.
Earlier private revisions remain historical evidence; they neither reopen D01–D04
nor close unverified tasks. Task numbers are identifiers, not chronological steps. A row marked
partial is not complete merely because its first implementation PR merged.

No ENG requirement is dropped. NEXUS, AEON-IQ, VERA, and Regency remain. Donor test runs do not close Continuum acceptance tests.

## Active local implementation sprint — 2026-10-15

D13 in OWNER-DECISIONS.md authorizes actual isolated offline implementation and testing.
The local baseline is the recovered v7.1 tree
`dc25bacb7625a4c889eadb36cbdb8e47ea33c3c6`, not the older published main.
Original commit label d75928ca9a95cdddbbca9ee1a265c7f28395ce86 is recorded, but its
original commit object/parentage is not reconstructed or fabricated. The local import
preserves fetched public history and explicitly records snapshot/mode recovery commits.

Current work: E2 governed admission/withdrawal/recovery denial; narrow real NEXUS
bounded execution; AEON request-local memory selection behind ContextService/R1;
owned-fixture regression/native integration and final independent-audit Git handoff.
Implementation/test maturity must be reported from actual source/evidence; no status
is promoted merely by this authorization. The earlier main/status sections below
remain historical context, not current source identity. No ENG acceptance is dropped.
Real-model autonomy, full product completion and production remain separate gates.

## What the finished product must deliver

Asentxia is the institution. Continuum is the governed persistent environment. VERA is the durable accountable principal. A VERA is not a model, session, process, credential, host, or Computer. Focus Desk is the only human product interface. Regency is governance inside that interface, stored in PostgreSQL. There is no second governance database and no second primary application.

The finished development product, before live qualification, must do all of the following:

- Keep tenant, organization, workspace, VERA, workload identity, logical Computer, and physical placement distinct.
- Keep the VERA id, durable work, and admitted memory across interruption and replacement of the model or Computer. Principal epoch, enrollment version, and placement generation stay separate. An old placement cannot act. Consequential work needs fresh authority.
- Let a VERA plan and work inside permissions it received from the trusted authority. It cannot create, expand, or transfer effect authority. Exact approvals and final-send checks stay.
- Enforce consequential actions only in the Effect Controller. PostgreSQL is domain truth. A scheduler moves work forward and is not authority. Context and memory are not authority. Approval, execution, and verified external success stay separate. UNKNOWN stays a real state. There is no blind retry after a possibly completed effect.
- Provide contained computation that cannot mint authority, and governed memory that cannot admit facts except through PostgreSQL. The acceptance tests are ENG-013, ENG-014, ENG-019, and ENG-021. The approved architecture uses NEXUS at `e1c3d3c75d58f609c617e7a87cb05e84ea437d64` and AEON-IQ at `d5866e85edb3a7f7ea7186854655981ca73760f4`. These are evaluation pins, not qualified production integrations. D01 approves the direction; the adapter acceptance tests and remaining gates still apply.
- Keep an application build workspace separate from NEXUS. Calling that workspace NEXUS isolation would be false.
- Show Work, Projects, VERA and agents, Computers, Approvals, Authority, State, Context, Memory, Evidence, Recovery, Integrations, Notifications and incidents, Usage and limits, Security, Settings, and readiness in Focus Desk, with distinct truth states for pending, preparing, executing, blocked, denied, known-failed, outcome-uncertain, reconciling, verified success, and recovered.
- Reach the useful-autonomy milestone only after its own prerequisites below: one VERA plans, builds, and tests a small non-production application, then resumes after interruption on the same VERA id without a second send. An independent checker, not the producing worker or the model, checks artifact integrity, runs the application’s tests, and checks the stated objective.

Live identity, a protected provider action, managed Computers, recovery numbers, and a scheduler choice are later levels. Local success does not move the ledgers. Shadow and canary wait for a separate authorization. One tenant is the first profile. Later customers stay isolated.

## Owner-approved architecture

See OWNER-DECISIONS.md for the durable authorization record and exact boundaries.

| Decision | Approved scope |
|---|---|
| D01 | NEXUS bounded execution and AEON-IQ governed derived memory behind Continuum. PostgreSQL/ContextService own admitted facts; the Effect Controller owns effect enforcement. Acceptance tests remain mandatory. |
| D02 | Autonomous work within trusted permissions; no effect-authority delegation in v1. Existing exact approvals remain. |
| D03 | Stable VERA and logical Computer identities; separate principal epoch, enrollment version and placement generation; fence old placements. One tenant first, no automatic multi-Computer authorization. |
| D04 | Regency governance in PostgreSQL and Focus Desk, with separate Effect Controller enforcement. |

These are architecture approvals, not completion claims or permission to merge,
deploy, copy donor trees, provision resources, or relax frozen contracts.

## Directions recorded on 2026-10-12

D05–D12 are recorded in OWNER-DECISIONS.md. Each direction stops at the limit in
that record. These directions do not close every subdecision and do not prove
qualification. The missing inputs stay missing. Production stays BLOCKED. The
scheduler stays HELD. Canary stays NO-GO.

| Decision | Recorded limit | What stays blocked |
|---|---|---|
| D05 | Reuse NEXUS and AEON through restricted, pinned integrations. Verify licensing and provenance before copying or distributing donor code. Do not change repository visibility or choose a new product license. | Licensing and provenance evidence. ENG-051 and ENG-052’s publication half |
| D06 | Use the existing WorkOS account for human sign-in. Keep separately enrolled, short-lived workload credentials for agents. Never place credentials in chat or Git. | WorkOS account settings and a secure way to supply credentials. Live sign-in. ENG-010’s live half, ENG-022’s live gateway, and ENG-037 |
| D07 | Build the first protected-action adapter around one controlled file write in a dedicated GitHub test repository, followed by authoritative read-back. | The test repository name, scope, credentials, and an exact authorization for that write. Live execution. ENG-017, ENG-039, and external channels for ENG-034 |
| D08 | Continue development and testing locally. A costed customer-hosting proposal may cover servers, databases, worker isolation, backups, region, and recovery targets. | Any new infrastructure purchase and any numeric recovery target. ENG-016 beyond a design note, ENG-038, and the managed halves of ENG-015 and ENG-040 |
| D09 | Evaluate pg-boss and Temporal against the required workload and recovery tests, and recommend the simplest qualifying option with measured evidence. Final selection waits for approved comparison criteria. | Those comparison criteria. Any scheduler selection. ENG-029 stays reference-only. ENG-041 may not choose. The scheduler ledger stays HELD |
| D10 | The first autonomy milestone requires a real model, one VERA completing a defined application objective, independent functionality checks, and safe resumption after interruption. Fixtures prove plumbing only. Propose broader numerical targets before evaluating against them. | That proposal and the milestone itself. ENG-025, ENG-036’s volume target, ENG-041’s measurement rule, ENG-045, ENG-046, ENG-048, ENG-049, and ENG-050 |
| D11 | Start with the isolated owner pilot. Keep Stripe billing disabled. Propose retention, deletion, backup, disclosure, and commercial policies before customer use. Do not invent an approved retention period. | Those policies. ENG-024’s retention policy, ENG-035, ENG-047, and ENG-051 |
| D12 | Require independent release review and mandatory qualification evidence. Live deployment, shadow, and canary require separate authorization. | That review and evidence. ENG-006’s live review, ENG-042, ENG-043’s live cutover, ENG-044, and ENG-052 |

ENG-026's six choices stay scoped to that task in OWNER-DECISIONS.md. They are not these D05–D12 directions, and they do not authorize donor copying, spending, or a live gate.

These product choices remain open:

1. Local autonomy versus ENG-022. Revision 3 says the local useful-autonomy milestone does not require D06. ENG-023 lists ENG-022 as a prerequisite, and ENG-022’s live gateway waits on D06 and D10. Do not start ENG-023 until you say whether a fixture gateway is enough for that local milestone.
2. D01 approves a restricted memory integration direction, not enabling a gated memory engine in production or shared writable Team Computers. Preserve the interface restrictions and pass ENG-019/021 before claiming integration. Any incompatible contract change needs a separately reviewed proposal.
3. The large live-database upgrade is a proposal. It is not accepted and it is not the next product pull request.
4. Publication and the remaining task designs. The choices above stay open. Pull request #19 merged only the ENG-026 work-admission behavior it demonstrated. Later ENG-026 project-command behavior remains open. Pull request #22 merged only the ENG-011 tool-manifest slice it demonstrated. Context and cognition binding remains the contract extension v3 slice from pull request #14. ENG-011 stays partial. The versioned adapter-interface recommendation is drafted and waiting for review. The private environment supplement stays outside Git.

## What is already built, tested, and merged

| Pull request | Merge | What landed | Left open |
|---|---|---|---|
| #1 | `a711861` | Canonical Continuum baseline and Focus Desk | Later product gaps |
| #10 | `e365150` | Phase A continuity for one fixture effect | Full ENG-015, ENG-018, and ENG-029 |
| #11 | `1f205a4` | ENG-007 records in PostgreSQL. A role or mandate is not effect authority | ENG-008’s future delegation features |
| #12 | `e0c9021` | MFA lock-wait | Not re-mapped to an audit id in this pass |
| #13 | `cdae724` | ENG-009 counter split for one Computer. Contract extension v2 | Suspend, retire, and a second Computer |
| #14 | `2cdf6aa` | ENG-011 context and cognition binding. Contract extension v3 | ENG-010 |
| #15 | `e52bb37` | ENG-012 for `TENANT_NOTICE` only. Migration 018 | Other event kinds and a bus |
| #16 | `5b3b2de` | Tracked agent startup instructions | Machine-specific settings stay outside Git |
| #17 | `21df0150` | Local test launcher and run evidence | The launcher does not install runtimes or start a database |
| #19 | `c6072dee` | ENG-026 work admission only. A new task names a current mandate and an active VERA with a `vera` membership in that organization. The task stores the organization, mandate, and accepted version. Historical tasks stay unbound. An identical authorized repeat returns the stored result, and a changed binding conflicts. Direct inserts share the same locks. Task and command records stay off the tenant-notice path. A mandate creates no grant, approval, workflow, or permission to send | Later ENG-026 project-command behavior. Live gates |
| #20 | `83626cd` | Recorded D05–D12 limits and the merged admission slice in the plan. No product code | Each direction stays inside its written limit. No donor copy and no live gate |
| #21 | `2372931` | The ENG-011 tool-manifest recommendation. No product code | Not an implementation. Pull request #22 later merged only the slice that document describes |
| #22 | `18dc8ce` | ENG-011 tool-manifest slice only. Contract extension v4 and migration 020. A proposal that names a tool stores that id and the current revision as version 4. A newer revision, a missing manifest, or a cross-tenant id denies admission and does not send. Rebuilding the index creates no grant, approval, or operation. Recovery keeps the original tool revision and does not rewrite a missing revision as an older contract version. Version 1, 2, and 3 rows stay unchanged. A tool revision is not a grant, an approval, or permission to send | The rest of ENG-011. Context and cognition binding remains pull request #14 and contract extension v3. No adapter. Live gates |

Pull requests #3, #4, #5, #8, and #9 are also on this `main`. They are CodeQL remediation, review and CI evidence, a dependency update, ENG-006 post-merge verification, and merge-evidence identity. ENG-001 through ENG-006 are recorded complete in revision 3 against older commits. This pass did not re-run them. Their acceptance text stays binding. ENG-006’s live independent review stays NOT RUN. D12 records that independent review is required; it does not supply the review.

Migrations on this `main` run from 001 through 020. Frozen M1 was not edited. Contract extension v4 records the tool binding only. Contract extension v3 remains context and cognition binding.

NEXUS and AEON-IQ integration has not started. Pull request #22 did not start it and did not copy donor source. The earlier donor counts, 192 NEXUS tests and 18 AEON tests, are donor evidence. They do not close ENG-013, ENG-014, ENG-019, or ENG-021. No Continuum adapter calls either donor. Those donor observations were not re-run for this draft.

### Hosted checks

On current `main` `18dc8ce5531f7cf57e8f2c9a508c8339d164d4c1`, post-merge run `38321396636` succeeded. Compare merged code with pull request evidence succeeded. That job's decision was `full` because required pull request evidence is missing. Secret scan succeeded. Canonical local verification succeeded. Inside that canonical job, “Run guarded canonical verification” passed and “Confirm production gates remain blocked” passed.

The job “Confirm product build and blocked gates” was skipped because full verification ran. In `.github/workflows/main-verification.yml` that job runs only when the evidence decision is `reuse`. When the decision is not reuse, the workflow skips it and calls the full PR workflow instead. The skip is the designed branch, not a missing check.

The full canonical command covers the same product-build and gate questions that the reuse job would have run, and it covers more. `tools/run-canonical-tests.sh` builds the ordinary product frontend and runs `fixture-boundaries.test.js` and `product-build-isolation.test.js`. It also runs `npm test`, which is `tools/run-safe-implementation.sh` and includes `tests/tool-manifest.test.ts`. The following step requires qualification enforcement and release enforcement to exit 1. That gate-confirmation step passed inside the canonical job on `18dc8ce`. `docs/TESTING.md` describes the canonical command as including those builds and the unchanged gate enforcement.

The same designed skip appears on earlier merges, including pull request #15 run `38203399745`, `21df0150` run `38220893744`, pull request #19 run `38261032152`, and `83626cd` run `38267672705`. This revision read the job conclusions on `18dc8ce`.

Pull-request head runs also passed canonical verification and secret scan: #15 run `38202614789`, #16 run `38219028426`, #17 run `38220099430`. Pull request #19 merged after its required checks. The main evidence for this snapshot is run `38321396636`.

The tracked qualification file on this commit still says overall BLOCKED, scheduler HELD, and canary NO-GO. The release file still says production is not ready. A passing check that those commands exit 1 is evidence that the ledgers stayed blocked. It is not a promotion.

A private local canonical run on an earlier commit stays outside Git. It is not evidence for `18dc8ce` and does not move a live gate.

## Dependency order and task selection

Pull request #22 merged the ENG-011 tool-manifest slice at `18dc8ce`, and only
the behavior that pull request demonstrated. Context and cognition binding
remains pull request #14 and contract extension v3. ENG-011 stays partial. The
next plan item is the versioned adapter-interface recommendation,
[VERSIONED-ADAPTER-INTERFACES-PROPOSAL.md](VERSIONED-ADAPTER-INTERFACES-PROPOSAL.md).
It is waiting for review. It is not an owner approval, it does not implement an
interface, and it does not start the NEXUS adapter. D05 still requires
licensing and provenance evidence before any donor copy. Pull request #20
recorded D05–D12 at `83626cd`. Pull request #19 remains the ENG-026
work-admission slice, and only the behavior that pull request demonstrated.
This order is a priority guide, not authorization to code every row. A task is
ready only when its required **slices** are verified on current main, its
design is accepted, and its owner gates are satisfied. If a row is held, report
it; independent ready work may be proposed without skipping requirements.

Do not require completion of an entire umbrella task when a named local slice is
the prerequisite. Do not use a local slice to close its live/managed/retention half.
The individual catalog below retains the full acceptance obligations.

| Priority | Work | Prerequisites | Remaining boundary |
|---|---|---|---|
| 0 | Publish plan, starting point and decision record | Owner review of this focused documentation PR | No product implementation |
| 1 | ENG-026 work-admission slice, merged in #19 | Merged ENG-007 records and ENG-012 notice foundation | Merged only for the admission behavior pull request #19 demonstrated. Later project-command behavior and live gates stay open |
| 2 | ENG-011 tool-manifest slice, merged in #22, then versioned adapter interfaces | Merged ENG-007 and ENG-009 identity slice; D01–D04 | Tool slice merged only for the behavior pull request #22 demonstrated. ENG-011 stays partial. Context and cognition binding remains pull request #14 and contract extension v3. The adapter-interface recommendation is drafted and waiting for review. It is not an implementation and it does not start the NEXUS adapter |
| 3 | ENG-013 NEXUS adapter, then ENG-014 boundary tests | ENG-006 and the required ENG-011 bindings/interfaces; ENG-008 existing v1 safeguards | Not started. The adapter-interface recommendation does not start it. D05 still requires licensing and provenance evidence before any donor copy. Donor tests are not production qualification |
| 4 | Separate application workspace | ENG-014 credential boundary and runtime interfaces | Exec/filesystem/test isolation is distinct from NEXUS WASM; no secrets or unapproved network |
| 5 | ENG-020 fuller context admission, then ENG-019 restricted AEON interface, then ENG-021 recall/extraction | ENG-007/012 foundations; interfaces for ENG-019; ENG-013 plus ENG-019/020 for ENG-021 | D06 for live identity and D05 for donor copying; deterministic local tests do not close live gates |
| 6 | ENG-009 remaining lifecycle scopes, then ENG-015 local lifecycle and ENG-024 artifact integrity | ENG-007; ENG-014; ENG-020 | Separate suspend/retire/multi-Computer proposals. D08 for managed hosts, D11 for retention |
| 7 | Independent milestone checker slice | Separate workspace and artifact integrity | Reread digest, independently run application tests, and check objective; not full ENG-030 |
| 8 | ENG-010 identity seams and its approved live half; ENG-037 live identity qualification | ENG-006 | D06 before live identity. Offline seams remain partial; no invented issuer or credentials |
| 9 | ENG-022 model gateway, then ENG-023 typed plans | ENG-010, ENG-011 bindings, ENG-021; ENG-026 for ENG-023 | D06/D10 live gateway gates. A narrower fixture gateway for the local milestone still needs a scoped decision |
| 10 | Useful-autonomy milestone | Phase A continuity, ENG-014, ENG-023, ENG-024 integrity and independent checker slice | Hold while the model-gateway choice is unresolved; no full ENG-030 or scheduler choice required |
| 11 | ENG-028 dependencies/handoffs, then ENG-027 collectives | ENG-026 and ENG-009 relevant identity slice; ENG-007/008 safeguards for collectives | No pooled or transferred effect grants |
| 12 | ENG-017 protected provider, ENG-039 qualification, then ENG-018 remaining controller crash/race coverage | Current immutable bindings; ENG-003/008/011/014 for controller tests | D07 before protected external action; existing fixture evidence remains partial |
| 13 | ENG-029 reference scheduler coverage, then full ENG-030 goal acceptance | ENG-018, ENG-023 and ENG-028; full ENG-030 also needs ENG-023 | Implementing reference tests does not choose a scheduler; D09/D10 choice belongs to ENG-041 |
| 14 | ENG-025 semantic truth; ENG-031 governance screens; ENG-033 lineage; ENG-034 incidents | Their catalog prerequisites, including the relevant ENG-024 slice and full ENG-030 | D10 quality thresholds, D07 external notifications, D11 retention remain separate |
| 15 | ENG-016 human control leases, then ENG-032 Computer/recovery screens | ENG-015 local lifecycle and ENG-018 | D08 for managed control; disabled controls are not implementation |
| 16 | ENG-035 usage/reservations, then ENG-036 complete accessibility/volume acceptance | ENG-010, ENG-017 and ENG-024 relevant slices; ENG-031 through ENG-035 for ENG-036 | D11 billing, D10 numeric targets; native/manual accessibility must be verified |
| 17 | ENG-015 managed path, then ENG-038 managed isolation, ENG-040 live recovery and separately accepted live-database procedure | Verified local ENG-015 and approved managed/recovery design | D08/D11; upgrade proposal is not approved or the next product task |
| 18 | ENG-041 measured scheduler choice, then ENG-043 compatible retirement | ENG-029, declared workload/thresholds and existing binding versions | D09/D10 for choice, D12 for live cutover |
| 19 | ENG-042 independent release review, ENG-044 shadow/canary and ENG-052 release manifest | Every mandatory scoped qualification gate, including live identity/provider/host/recovery/scheduler where required | D12 and D05; separate owner authorization, no dual sender |

Full ENG-030 is later than the autonomy milestone, but its **milestone checker
slice** is earlier. This is a proposed decomposition of an existing requirement,
not permission to omit the remaining goal-versus-effect tests. The old ordering had
forward dependencies; it did not prove an intrinsic cycle in the task graph.

ENG-045 through ENG-051 remain individual research/portfolio requirements. They are
not deleted or blanket-approved as optional. Their owner gates and acceptance
definitions must be settled before execution. ENG-008 future delegation remains
unauthorized and is not made a dependency of non-delegating product work.

## ENG-001 through ENG-052

Each entry keeps the revision 3 requirement, acceptance test, dependency, and owner gate. Status is the prior read against `21df0150`, except the ENG-026 work-admission slice recorded from the merge at `c6072dee`, and the ENG-011 tool-manifest slice recorded from pull request #22 at `18dc8ce`. “Recorded complete” means revision 3 says the task was already done. This pass did not re-run those older tests. Recording the tool slice does not mark ENG-011 complete.

### ENG-001

Requirement: pin the real tree and reproduce the suite. Acceptance: SHA, lockfile, fixture reset, and command evidence. Dependencies: none. Status: recorded complete through the merged history ending at `ea2755d7`, and not repeated as new work. Owner gate: none.

### ENG-002

Requirement: gate checkers fail closed. Acceptance: six negative probes, and the current ledger exits 1. The six probes are not named in revision 3. Dependencies: ENG-001. Status: recorded complete. Ledgers stay BLOCKED, HELD, and NO-GO. Owner gate: none. Passing this task does not open the ledgers.

### ENG-003

Requirement: recovery import cannot create sendable work. Acceptance: role, digest, fence, and no second send. Dependencies: ENG-001. Status: recorded complete in migrations 013 and 014 and recovery tests. Owner gate: none.

### ENG-004

Requirement: bounded transport and exact bytes. Acceptance: Unicode split, bad UTF-8, oversized and stalled responses. Dependencies: ENG-001. Status: recorded complete in the merged controller and object-store fixes. Owner gate: none.

### ENG-005

Requirement: review fixes for redaction, Runloop mapping, and locked installs. Acceptance: refresh cannot submit a stale machine, and an unknown Runloop state stays truthful. Dependencies: ENG-001. Status: recorded complete in the merged review batches. Owner gate: none.

### ENG-006

Requirement: the product build rejects fixture sign-in. Acceptance: no fixture route in the product artifact, and local suites at the repaired SHA. Dependencies: ENG-002 through ENG-005. Status: local evidence was recorded on `dc5f5b34`. The canonical job on `21df0150` ran the product-build isolation and fixture-boundary tests and passed. That is later local evidence for the build check. It does not close the live independent review. Owner gate: D12, recorded 2026-10-12, requires independent release review and qualification evidence before live deployment, shadow, or canary. That review stays NOT RUN, and those live actions still need separate authorization.

### ENG-007

Requirement: tenant-qualified organizations, memberships, roles, mandates, and immutable mandate versions. Acceptance: cross-tenant and member guessing, last-owner removal, stale edit, and conflicting updates reject. A topology edit never changes a grant or an approval. Dependencies: ENG-006. The migration number had to be after 014. Status: merged in pull request #11 as migration 015. Role names do not grant effects. Owner gate: D02 and D03, in the revision 3 scopes.

### ENG-008

Requirement: versioned authority that a VERA cannot widen.

Authorized safeguards, which D02 requires now: v1 rejects unsupported delegation. Expired or revoked authority stops renewal and final send. Delegation cannot replace an exact approval. Revision 3 says today’s create, assign, approve, renew, revoke, and final-send tests cover this authorized capability. This pass did not re-run those tests. Their job is to keep failing closed. They are not a license to add delegation.

Unauthorized future features: child grants, a delegation DAG, delegation chains, coalition amplification, and a policy engine that lets a VERA narrow or pass on effect authority. Those acceptance tests stay written for a later contract. D02 does not authorize implementing them. No current pull request should add them.

Dependencies: ENG-007 for the phase that recorded the split. The future features also wait for a contract that does not exist. Status: authorized safeguards are existing behavior to preserve. Future delegation features are not started and are not authorized. Owner gate: D02, approved only as no delegation in v1.

### ENG-009

Requirement: a stable VERA id across model and Computer replacement, with separate epoch, enrollment version, and placement generation. Acceptance: replacement keeps the id. Suspended or retired principals get no new effects. A stale machine, principal, or placement rejects. Two Computers cannot reuse one placement grant. Dependencies: ENG-007. Status: partial. Pull request #13 merged the id and the counter split for one Computer. Suspend, retire, and a second Computer stayed out of that pull request. Phase A is only the identity and stale-worker slice. Owner gate: D03, in the revision 3 scope. That scope does not implement multi-Computer placement. D08, recorded 2026-10-12, keeps development local and allows a costed hosting proposal. No purchase and no numeric recovery target are approved, so a managed host stays blocked. The local slice does not need that purchase.

### ENG-010

Requirement: real human and workload identity seams. Acceptance: local wrong-subject, audience, expiry, replay, and tenant tests. An untrusted machine cannot enroll itself as owner. Dependencies: ENG-006. Status: not started as this task. Offline seams may be stubbed. Live sign-in stays NOT RUN. Owner gate: D06, recorded 2026-10-12, uses the existing WorkOS account for human sign-in and separately enrolled, short-lived workload credentials. Still missing: the WorkOS account settings and a secure way to supply credentials. Live sign-in stays blocked. Credentials stay out of chat and Git.

### ENG-011

Requirement: versioned tool, model, and context manifests. Acceptance: tool, model, or context drift denies execution when the approval binding cares. An index rebuild cannot create authority. Dependencies: ENG-007 and ENG-009. Status: partial. Pull request #14 merged context and cognition binding and contract extension v3. An explicit cognition revision of zero is rejected. Context is still not authority. Pull request #22, merge `18dc8ce`, implemented the accepted tool-manifest recommendation for that slice only. The record is [ENG-011-TOOL-MANIFEST-PROPOSAL.md](ENG-011-TOOL-MANIFEST-PROPOSAL.md). Contract extension v4 and migration 020 store a tool id and the current revision on a version 4 operation. A newer revision, a missing manifest, or a cross-tenant id denies admission and does not send. Rebuilding the tool index creates no grant, approval, or operation. Recovery keeps the original tool revision and does not rewrite a missing revision as an older contract version. Version 1, 2, and 3 rows stay unchanged. A tool revision is not a grant, an approval, or permission to send. The slice does not execute a tool and does not call an adapter. It does not complete ENG-011. Context and cognition binding remains the v3 slice from pull request #14. The versioned adapter interfaces are the separate recommendation [VERSIONED-ADAPTER-INTERFACES-PROPOSAL.md](VERSIONED-ADAPTER-INTERFACES-PROPOSAL.md). That recommendation is waiting for review. This documentation change does not implement it and does not approve it. Owner gate: D02 and D03, in the revision 3 scopes.

### ENG-012

Requirement: one tenant-qualified event envelope and rebuildable projections. Acceptance: concurrent append, rollback, duplicate delivery, and rebuild keep authority. Workers do not write provider truth. Dependencies: ENG-007 and ENG-011. Status: partial. Pull request #15 merged that acceptance for `TENANT_NOTICE` only. Existing event kinds keep their previous payload bytes. There is no event bus and no product consumer of the outbox. Later kinds belong to their own tasks, including ENG-026, ENG-020, ENG-033, and ENG-034. Owner gate: none beyond those prerequisites. Revision 5’s “not started” line is stale.

### ENG-013

Requirement: contained computation through a pinned runtime. Acceptance: denied module, path, fuel, memory, timeout, and fork. Rollback is local. A fake capsule is not provider success. A speculative branch does not send. Dependencies: ENG-006 and ENG-011. Status: not started. A fuel-meter unit test and the local UID test are evaluation evidence, not completion. The 192 donor tests are not this acceptance. The versioned adapter-interface recommendation does not start this adapter and does not copy donor source. Owner gate: D01 architecture approved; adapter design and acceptance remain separate. D05, recorded 2026-10-12, allows restricted, pinned reuse. Copying or distributing donor code still waits on licensing and provenance evidence. Visibility and the product license stay as they are.

### ENG-014

Requirement: the runtime cannot mint authority or read provider credentials. Acceptance: a compromised runtime cannot mint root authority, change tenant, reach provider credentials, or widen a negotiated subset. Dependencies: ENG-013 and ENG-008’s authorized v1 safeguards. Status: not started. Local UID isolation is evidence for a Linux process only. Owner gate: D02 for the no-delegation rule. D01 architecture is approved; declaring a qualified runtime still requires its integration evidence.

### ENG-015

Requirement: a logical Computer distinct from placement, with fenced replacement and no automatic resume. Acceptance: kill and reconstruct keep the Computer and VERA id, hashes, and pending work. A stale host or snapshot does not become a sender. Dependencies: ENG-009 and ENG-014. Status: partial. Phase A and pull request #13 cover identity and a stale worker for one Computer. They do not add suspend, retire, a second Computer, or managed-host destruction. Owner gate: D03 for the identity split. D08, recorded 2026-10-12, keeps development local and allows a costed hosting proposal. Managed-host destruction stays blocked because no purchase and no numeric recovery target are approved. Local lifecycle can proceed without that purchase.

### ENG-016

Requirement: human view and control leases. Acceptance: missing, expired, cross-tenant, stale-generation, and disconnect cases fail closed. Human input is not an autonomous effect. Dependencies: ENG-015. Status: design only. It is not a substitute for ENG-015. Owner gate: D08, recorded 2026-10-12, keeps development local and allows a costed hosting proposal. No purchase is approved, so managed control stays blocked. This design note is not that purchase.

### ENG-017

Requirement: a credentialled provider manifest and read-only observation. Acceptance: lost ack, timeout, mismatch, partial result, and stale key stay UNKNOWN or single-send. Observation cannot dispatch. SSRF and credential forwarding reject. Dependencies: the staging sequence’s protected-provider gate. Status: not started. The public GitHub GET is not this action. Owner gate: D07, recorded 2026-10-12, is one controlled file write in a dedicated GitHub test repository, followed by authoritative read-back. Still missing: the repository name, scope, credentials, and an exact authorization for that write. The adapter can be built but not executed live.

### ENG-018

Requirement: the controller keeps v1 bytes and current checks. Acceptance: crashes at admission, send, and verify. Revoke, expiry, context, and placement races do not admit stale work. One logical operation has at most one possible send. UNKNOWN cannot be hidden by a new id. Dependencies: ENG-003, ENG-008’s authorized safeguards, ENG-011, ENG-014, and ENG-017. Status: partial. Phase A covers UNKNOWN, read-back, and a stale generation on one fixture operation. It does not add an ActionBinding v2. The protected-provider half waits on ENG-017. Owner gate: D02 and D03 for the current checks. D07, recorded 2026-10-12, allows that one file-write adapter to be built. The protected-provider half stays blocked until the named repository, scope, credentials, and exact write authorization exist. Live execution is not authorized.

### ENG-019

Requirement: audit and adapt the pinned AEON-IQ lineage. Acceptance: no tenant selected by header alone. Credential scope and ACL on every exposed route. No product-config dev bypass. No implicit default tenant. Dependencies: ENG-006 and ENG-011. Status: not started. At pin `d5866e85`, route handlers were observed not to read the constructed credential scope. The 14 donor scope tests do not close this task. Close the gap through a restricted authenticated interface with proven enforcement. Do not expose the donor proxy/management server to workers or Focus Desk; a front door alone is not proof that unsafe routes are unreachable. The original plan’s sentence that this task can be skipped if it only restates D01 is not followed. The acceptance stays. Owner gate: D01 architecture approved; integration acceptance remains required. D06, recorded 2026-10-12, names the existing WorkOS account and separate workload credentials; live identity stays blocked until account settings and a secure credential supply exist. D05, recorded 2026-10-12, allows restricted pinned reuse; copying source still waits on licensing and provenance evidence.

### ENG-020

Requirement: one admission path for context and memory. Acceptance: cross-tenant and private-VERA retrieval, forged provenance, a missing digest, and stale, erased, and quarantined facts, plus prompt injection, do not cross admission. Release does not confer a grant. Dependencies: ENG-007 and ENG-012. Status: not started as this fuller model. Current ContextService covers quarantine and digest for today’s objects. Owner gate: none named beyond those prerequisites. D01 is not a prerequisite of this row.

### ENG-021

Requirement: derived recall and extraction. Acceptance: two tenants with the same external name stay isolated. Restart and duplicate recall are safe. Index loss keeps canonical facts. Degraded recall is not knowledge and is not external success. Dependencies: ENG-019, ENG-020, and ENG-013. Status: not started. An index that is not AEON-IQ must still pass these tests. The original plan’s skip sentence is not followed. Owner gate: D01 architecture approved; integration acceptance remains required. The revision 5 acceptance also says duplicate extraction does not double-admit and no live model credential is required for the fixture proof.

### ENG-022

Requirement: a replaceable model gateway. Acceptance: malformed tool output, outage, truncation, and partial streams do not execute. A model swap keeps the principal and does not repeat an effect. Dependencies: ENG-010, ENG-011, and ENG-021. Status: not started. No hidden provider fallback. Owner gate: D06 and D10, both recorded 2026-10-12. D06 still lacks WorkOS account settings and a secure credential supply, so the live gateway stays blocked. D10 requires a real model for the first autonomy milestone and says fixtures prove plumbing only; broader numerical targets are still only a required proposal. Whether a fixture gateway is enough for the local milestone remains open.

### ENG-023

Requirement: typed plans. Acceptance: forged tenant, action, approval, completion, stale plan, and arbitrary tool requests reject. Harmless computation can proceed while consequential steps wait. Dependencies: ENG-022 and ENG-026. Status: not started. A model sentence is not a plan. The full adversarial protocol fixtures remain part of this task even after the milestone uses a plan. Owner gate: none of its own. It waits on the ENG-022 choice because of that dependency.

### ENG-024

Requirement: durable artifacts and retention. Acceptance: corrupt, missing, traversal, cross-tenant, duplicate, and quota failures reject. Erasure stops retrieval and derived resurrection. Legal holds stay explicit. Dependencies: ENG-020 and ENG-015. Status: partial for containment. Object-store digest tests cover today’s containment. The integrity path the milestone needs is the digest the checker rereads. Retention policy is still required and is not started. Owner gate: D11, recorded 2026-10-12, starts with the isolated owner pilot and keeps Stripe disabled. Retention, deletion, backup, disclosure, and commercial policies are still missing, and no retention period is approved. The milestone may use today’s quarantine and digests. It may not invent a retention policy.

### ENG-025

Requirement: semantic truth separate from retrieval. Acceptance: false or uncertain episodes do not become verified outcomes. Revoked readers cannot use a cache. Compacted state stays attributable and creates no authority. Dependencies: ENG-020, ENG-021, and ENG-024. Status: not started. Owner gate: D10, recorded 2026-10-12. Fixtures prove plumbing only. A proposal for broader numerical targets is still missing, so no numeric quality target is approved.

### ENG-026

Requirement: project and task commands that do not send effects. Acceptance: duplicate commands are looked up. Creating a task does not start a workflow or send. Admission needs an eligible VERA and a current mandate. Dependencies: ENG-007 and ENG-012. Status: partial. Pull request #19, merge `c6072dee`, merged the work-admission slice only. A new task requires a current mandate and an active VERA with a `vera` membership in that mandate's organization. The task stores the organization, mandate, and accepted version. Historical tasks stay unbound and are not backfilled. An identical authorized repeat returns the stored result after the mandate advances, and a changed binding conflicts. Direct inserts take the same share locks as product admission. Task and command records stay off the ENG-012 tenant-notice path. Creating a task does not start a workflow or send, and a mandate does not create a grant, an approval, or permission to send. Later project-command behavior is not started. This merge is not a live-gate change. Owner gate: D02, D03, and D04, in the revision 3 scopes. The six ENG-026 choices stay scoped to that task.

### ENG-027

Requirement: collectives without pooled grants. Acceptance: colluding peers and topology edits cannot enlarge an effect or read private memory. A removed member fails renewal. A handoff does not rewrite the original actor. Dependencies: ENG-007, ENG-008’s authorized safeguards, ENG-009, and ENG-028. Status: not started. Owner gate: D02 and D03. One tenant is the first profile. Isolation for later customers stays in the schema.

### ENG-028

Requirement: dependencies, claims, and handoffs. Acceptance: one winner for a race. Cycles and cross-tenant edges reject. Accepting work does not transfer someone else’s grant. Dependencies: ENG-026 and ENG-009. Status: not started as this command set. Some handoff compare-and-swap already exists and does not close this task. Owner gate: none named beyond those prerequisites. No silent reassignment.

### ENG-029

Requirement: both reference schedulers, as references only. Acceptance: long fixture waits, partial jobs, worker kills, and retained v1 and v2 keep ids and authority. History has no provider token. Local waits are not a 24-hour staging proof. Dependencies: ENG-018, ENG-023, and ENG-028. Status: partial. Reference scheduler code and Phase A’s single-effect continuity exist. They do not close this list and they do not choose an engine. Owner gate: D09, recorded 2026-10-12, allows evaluation of pg-boss and Temporal and a recommendation backed by measured evidence. Comparison criteria are still missing, so no scheduler is selected. The scheduler ledger stays HELD. Existing reference tests may be extended under a scoped task. D10’s broader numerical targets are also still only a required proposal, and both missing inputs stay required before ENG-041 may choose.

### ENG-030

Requirement: goal acceptance separate from effect state.

Earlier checker slice, which is not this full task: the checker’s functionality and objective result, as specified in the dependency section. The useful-autonomy milestone depends on that slice. Completing the slice does not complete ENG-030.

Full-task acceptance, still required after the milestone: a verified send must not auto-complete an unrelated goal. UNKNOWN blocks a claim of goal success. Seeded false positives are rejected. Compensation is a new approved operation. Dependencies of the full task: ENG-023 and ENG-029. Status: not started, neither the slice nor the full task. Owner gate: none named on the full task beyond those prerequisites.

### ENG-031

Requirement: Focus Desk shows Regency. Acceptance: the existing console contracts plus the added workflows. Stale data never says all clear. Exact approval values are read-only. Dependencies: ENG-007, ENG-008’s authorized safeguards, ENG-009, ENG-020, ENG-026, ENG-028, and full ENG-030. Status: not started as these Regency screens. One console already exists. Owner gate: D02 and D04. No second primary application.

### ENG-032

Requirement: honest Computer and recovery screens. Acceptance: a stale frame, a lost Computer, a revoked observation, and an incomplete manifest stay distinguishable. Hand-back does not mean resumed execution. Dependencies: ENG-015, ENG-016, and ENG-018. Status: not started as this screen set. Owner gate: none named beyond those prerequisites. Lifecycle controls stay disabled until the boundary is qualified.

### ENG-033

Requirement: evidence lineage and recovery ownership. Acceptance: cross-tenant leaks reject. A valid chain without observation is not success. An export page is not a complete archive. Dependencies: ENG-012, ENG-018, ENG-024, and full ENG-030. Status: not started as this lineage. The `TENANT_NOTICE` projection does not close it. Owner gate: none named beyond those prerequisites. UNKNOWN investigation does not revive a write grant.

### ENG-034

Requirement: incidents and notifications. Acceptance: repeated delivery does not resolve an incident or duplicate an effect. A channel timeout stays unknown. Dependencies: ENG-012 and full ENG-030. Status: partial for in-app dedup, acknowledgement, and read separation, as recorded in the older gap register. That register was not re-audited against this commit. External delivery is not started. Owner gate: D07, recorded 2026-10-12, for external channels. The one file-write adapter can be built, but live execution and external delivery stay blocked until the test repository, scope, credentials, and exact write authorization exist. In-app notices can exist before a live channel.

### ENG-035

Requirement: reservations, usage, and commercial readiness. Acceptance: concurrent reservations do not overspend. Unmeasured money is labeled unknown. Refunds need new authority. Billing controls stay absent until configured. Dependencies: ENG-010, ENG-017, and ENG-024. Status: partial for test-unit reservations. Real token, money, and billing freshness are not qualified. Owner gate: D11, recorded 2026-10-12. The isolated owner pilot keeps Stripe disabled. Retention, deletion, backup, disclosure, and commercial policies are still missing, and no retention period is approved. Test units stay test units.

### ENG-036

Requirement: accessible high-volume behavior. Acceptance: no optimistic success, color-only status, or inaccessible exact-action text. Dependencies: ENG-031 through ENG-035. Status: partial for the older local Chromium, axe, keyboard, and reflow evidence. Native screen-reader review and manual zoom review stay NOT RUN. Owner gate: D10, recorded 2026-10-12. Broader numerical targets still need a proposal. Do not invent a latency or volume target.

### ENG-037

Requirement: live staging identity. Acceptance: real stale, audience, subject, replay, and cross-tenant cases deny. A disabled machine cannot use an already-issued capability. Dependencies: ENG-010’s live half. Status: not started. Owner gate: D06, recorded 2026-10-12. Live sign-in stays blocked until WorkOS account settings and a secure credential supply exist. Workload credentials stay out of chat and Git.

### ENG-038

Requirement: live managed Computer isolation. Acceptance: a compromised worker cannot bypass the controller. Old host credentials are fenced. A restored host does not dispatch by itself. Dependencies: ENG-015’s managed path. Status: not started. Owner gate: D08, recorded 2026-10-12. Development stays local. A costed hosting proposal may be written. No purchase is approved, so live managed isolation stays blocked.

### ENG-039

Requirement: protected provider qualification. Acceptance: no unapproved, duplicate, or fallback send. A 404 is not proof of no effect. An observer can reconcile and cannot send. Dependencies: ENG-017. Status: not started. Owner gate: D07, recorded 2026-10-12. The adapter direction is one controlled file write followed by authoritative read-back. Qualification and live execution stay blocked until the test repository name, scope, credentials, and exact write authorization exist.

### ENG-040

Requirement: HA, PITR, and independent fencing. Acceptance: a restored snapshot cannot resurrect authority or resend. An incomplete journal stays blocked. Dependencies: the local recovery work already on `main` is not this live gate. Status: local recovery guards exist. Live HA and PITR are NOT RUN. Owner gate: D08 and D11, both recorded 2026-10-12. No purchase is approved, and no numeric recovery target or retention period is approved. Live HA and PITR stay NOT RUN. No numeric RPO or RTO is invented here.

### ENG-041

Requirement: a measured scheduler choice. Acceptance: choose only after the real workload and the stated simplicity rule. An undecided result stays HELD. Dependencies: ENG-029. Status: not started. The scheduler ledger stays HELD. Owner gate: D09 and D10, both recorded 2026-10-12. D09 allows a measured comparison and withholds selection until comparison criteria exist. D10 withholds numerical targets until a proposal exists. Neither input is supplied. The scheduler ledger stays HELD. No scheduler is selected.

### ENG-042

Requirement: release gates and independent review. Acceptance: every mandatory gate has scoped evidence. PARTIAL does not pass. Production approval stays separate. Dependencies: the gates it reviews. Status: not started. Owner gate: D12, recorded 2026-10-12, requires independent release review and mandatory qualification evidence. That review and evidence are still missing. Live deployment, shadow, and canary require separate authorization.

### ENG-043

Requirement: compatible retirement. Acceptance: old and new bindings stay readable. Incompatible versions gain no authority. Unresolved effects stay UNKNOWN. Dependencies: the binding versions already on `main` for the readable-history rule. Status: not started as a retirement cutover. Owner gate: D03 is approved for the identity rule. D12, recorded 2026-10-12, still requires independent review, qualification evidence, and separate authorization before any live cutover. No live cutover.

### ENG-044

Requirement: shadow and a one-principal canary. Acceptance: owner sign-off before activation. No dual sender. Rollback preserves UNKNOWN. Dependencies: ENG-042’s release evidence. Status: not started. Owner gate: D12, recorded 2026-10-12. Shadow and canary require separate authorization, which is still missing. Canary stays NO-GO.

### ENG-045

Requirement: discovery and negative evidence. Acceptance: research checks AC-1 through AC-3. A self-certified report is not proof. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D10, recorded 2026-10-12. Broader numerical targets still need a proposal before evaluation.

### ENG-046

Requirement: acceptance-gated repair. Acceptance: AC-4 through AC-7. The verifier catches seeded faults. Uncertainty is not a retry. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D10, recorded 2026-10-12. Broader numerical targets still need a proposal before evaluation.

### ENG-047

Requirement: verifier-supervised learning. Acceptance: B-AC1 through B-AC7, including seeded false positives equal to zero. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D10 and D11, both recorded 2026-10-12. Numerical targets still need a proposal. Retention, deletion, backup, disclosure, and commercial policies are still missing, and no retention period is approved. Stripe stays disabled.

### ENG-048

Requirement: a goal-graph envelope. Acceptance: C-AC1 through C-AC8. Finite trials are not universal proof. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D10, recorded 2026-10-12. Broader numerical targets still need a proposal. D02’s no-delegation rule still bounds any suballocation. That rule does not authorize ENG-008’s future delegation features.

### ENG-049

Requirement: recursive improvement without trust expansion. Acceptance: independent lift, zero base regressions, and rejection of a candidate that edits the gate. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D10 and D12, both recorded 2026-10-12. Numerical targets still need a proposal. Independent release review, qualification evidence, and separate live authorization are still missing.

### ENG-050

Requirement: portable continuity. Acceptance: the declared kill, move, evict, and rotate matrix keeps identity and stops old-host effects. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D08 and D10, both recorded 2026-10-12. No purchase or numeric recovery target is approved. Broader numerical targets still need a proposal.

### ENG-051

Requirement: optional portfolio adapters. Acceptance: every named component has a disposition. No silent install of old projects. Dependencies: none that put it on the product path. Status: not started. It stays out of the product path. Owner gate: D05 and D11, both recorded 2026-10-12. Donor copy or distribution still waits on licensing and provenance evidence. Visibility and the product license stay as they are. Commercial and retention policies are still missing, and no retention period is approved.

### ENG-052

Requirement: one recoverable release manifest. Acceptance: a clean checkout reproduces the build. Adopted dependencies have provenance and license records. Dependencies: the release gate it packages. Status: not started. Owner gate: D05 and D12, both recorded 2026-10-12. Provenance and license records are still required before copying or distributing donor code. Visibility and the product license stay as they are. Independent review, qualification evidence, and separate live authorization are still missing.

## Conflicts and limits

1. Earlier private drafts lost the owner's D01 authorization because they searched
   only older files. OWNER-DECISIONS.md records the conversation authorization and
   scoped architecture. Earlier pending recommendations are historical, not a reversal.
2. Revision 5's main SHA and ENG-012 status were stale. The snapshot above corrects
   them against merged code. Current main must still be fetched before each task.
3. ENG-009, ENG-011 and ENG-012 are partial umbrella tasks. A merged scoped PR does
   not complete multi-Computer support, the whole of ENG-011, or all future event
   kinds. Pull request #22 merged the tool-manifest slice only. Context and
   cognition binding remains the v3 slice from pull request #14. The
   adapter-interface recommendation is a document. Merging it does not implement
   an adapter or complete ENG-011.
4. The interface's gated-memory and shared-writable-Computer restrictions remain.
   D01 does not turn on a live engine or remove them. Propose a versioned amendment
   if a later design conflicts; never silently weaken a frozen safety contract.
5. The local autonomy versus live model-gateway choice remains open. Fixture tests
   can prove a protocol slice but do not demonstrate live model quality or full
   autonomous engineering. Do not declare that milestone complete from stub output.
6. The gap/traceability registers contain historical local dispositions. They were
   not fully re-audited against this snapshot. A later demonstrated failure reopens
   the finding; an older PASS is not fresh evidence.
7. Research acceptance labels (AC/B-AC/C-AC) preserve the source requirements, but
   labels alone are not executable specifications. Before the research task, publish
   reviewed public-safe criteria from its source and obtain the required thresholds;
   do not invent numbers or claim completion from labels.
8. The skipped main reuse-confirmation job is intentional when full verification
   runs. Check the actual branch and equivalent inner steps, not a skipped badge alone.
9. Donor counts, README assertions, test fixtures and architecture approval do not
   close Continuum adapter acceptance. Restricted credentials, route denial, erasure,
   tenant/VERA isolation and authoritative admission must be demonstrated in adapters.
10. No new product feature, model/provider call, paid resource or live migration was
    implemented for this documentation change.

## Where agents start

Read [START-HERE.md](START-HERE.md), the repository starting-point index. It names only repository documents and the rules for fetching `main`, opening one small pull request, and reading the tracked test docs. Machine paths, the shared test command, and private history are in the private environment supplement, which stays outside Git.

On current `main`, before product code, read `AGENTS.md`, `docs/AGENT-START.md`, `docs/ARCHITECTURE.md`, `docs/M1-SAFETY-CONTRACTS.md`, `docs/M1-CONTRACT-EXTENSION-v2.md`, `docs/M1-CONTRACT-EXTENSION-v3.md`, `docs/M1-CONTRACT-EXTENSION-v4.md`, `docs/RECOVERY-CONTRACT-v0.2.md`, `docs/TESTING.md`, `docs/LOCAL-TEST-LAUNCHER.md`, `docs/interface/PRODUCT-CONTRACT.md`, `docs/interface/FOCUS-DESK-DESIGN.md`, `docs/reconciliation/CANONICAL-GAP-REGISTER.md`, `docs/reconciliation/CANONICAL-TRACEABILITY.md`, `qualification/PRODUCTION-GATES.json`, `docs/RELEASE-GATES.json`, and `OWNER-ACTION-CHECKLIST.md`.

Agents update implemented/tested status in the task PR, naming its exact evidence. Mark it merged only after observing the merge and required main checks; until then say awaiting owner merge. Update the merged record in the next scoped documentation/task change or approved project status update. They do not revive an older revision as the current list. Hosted CI on the pull-request head is separate from a local run. A local run on an earlier commit, or on uncommitted bytes, is not evidence for that head.
