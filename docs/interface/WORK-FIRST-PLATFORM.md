# Continuum — the work-first agent platform

## Decision and scope

**Product direction, not a replacement architecture or production approval.**
Grounding: `docs/PROVISIONAL-TARGET.md`, the existing Focus Desk design,
current source on main at `3ca2782d789ddf898c3f7909d7e48b63d42f89b8`,
and the merged Gemini connection work. The provisional target remains a
proposal with unqualified capabilities; its historical inventory is not
assumed to describe every current implementation.

**Promise:** give work to an accountable AI teammate, see what is happening,
decide only what requires your permission, and receive an attributable result.
Do not make the user learn infrastructure to use the product.

This PR implements the first **navigation, language and guided-entry** slice.
It does not implement the full platform below. It introduces no database
changes, workflow engine, model call, background job, paid service, credential
handling, release-policy change or new effect authority. It never upgrades
mock evidence to live verification.

## 1. One simple mental model

1. **Work:** the outcome to achieve, its owner, next step and result.
2. **Projects:** related work and shared context.
3. **VERAs:** accountable AI teammates, with replaceable model connections.
4. **Approvals:** exact consequential actions that need an eligible decision.
5. **Connections:** models and, later, independently qualified external accounts.

Everything else is progressive disclosure under **More workspace tools**.
Existing routes, deep links, authorization and detail inspectors remain.
Advanced sections open their own navigation automatically. Uncertain outcomes
remain a direct Work link; hiding clutter must never hide a known danger.
Notifications become delivery of conditions, not a second task or incident store.

Work remains the landing page. The three-step setup expands only when requested, rather than occupying the everyday work view. Keep **Needs attention / All work** and list/map
views. Do not introduce a second inbox with different truth, a decorative metric
dashboard, or a separate chat that loses the work and its decisions.

## 2. The intended everyday experience

### First useful outcome

Guided journey: workspace → name a VERA and its role → connect a model →
explicit connection test → bounded text task → visible answer and usage.
Preserve progress using authoritative records, not browser completion flags.
Allow users to skip optional project setup. Never ask them to choose a scheduler,
VM generation, database role or evidence format.

Current boundary: profile creation, connection management and bounded text
requests have existing contracts. They do not constitute autonomous task
execution, verified external work or production identity. This PR guides users
to those contracts; it does not merge the separate commands into one transaction.

### Daily work

- Say what you want, who it is for, and what a good result looks like.
- Choose a VERA and optional project using human names, not internal IDs.
- Review a plan and the actual permitted scope before admitting work.
- Follow a durable activity trail: planned, waiting, working, needs a decision,
  result available, or outcome uncertain. Backend distinctions remain intact.
- Inspect the output where you work; inspect evidence and raw bindings on demand.
- Continue related work without repeatedly setting up a model or permissions.

**Not yet delivered:** automatic planning/admission, durable multi-step jobs,
artifact creation, safe recurring work, rich context attachments or broad tools.
Do not replace missing capabilities with optimistic status text.

### Decisions that are understandable

Each approval must say: what will change, where, who requested it, why, exact
scope, expiry and how success can be checked. A model suggestion is attributed
as a suggestion. Explain the consequence before asking for a decision.

The owner does not need to review code to operate the product. Automated
engineering checks and qualified reviewers assess code; the owner still
controls meaningful business permission. Unknown-risk actions remain blocked,
not automatically approved by another model.

### Failure without panic or accidental duplicates

Show the last trusted state, what is unknown, what the system can check and the
one safe next step. Do not call timeout “nothing happened.” Do not offer retry
for a possibly sent effect. A stop/revoke control must explain that already
submitted requests can still finish or cost money.

## 3. Screen and interaction specification

| Surface | Default | Progressive detail / acceptance |
| --- | --- | --- |
| Work | Outcome-first heading, simple creation path, attention before general work | Exact state, freshness, owner, source and current inspector; no invented totals |
| Projects | Name, outcome, linked work | Dependencies and progress only when authoritative; no task completion inferred from one operation |
| VERAs | Name, role, connection, current restrictions | Identity, epochs, computer and context lineage on demand; model replacement preserves principal |
| Connections | Existing manageable connections, names, explicit test and revoke | Provider scope, usage units, verification label; account login is distinct from provider credentials |
| Approvals | Clear action/change and decision | Bound payload, digest, revisions and evidence; changed parameters invalidate the proposal |
| More workspace tools | History, recovery, security, permissions, usage, computers, context and settings | Existing direct links; role filtering never substitutes for server authorization |

Retain keyboard operation, explicit labels, visible focus, Back/deep links,
44px targets and narrow-screen single-column layouts. Do not capture global
shortcuts while a user types. Do not introduce drag-and-drop as the only way
to change work. Use saved preferences only for nonsecret presentation.

## 4. Quality-of-life backlog, ordered by user value

| Priority | Capability | Why / prerequisite |
| --- | --- | --- |
| Now | Five everyday destinations, contextual guidance, plain-language boundaries | Implemented in this slice; exact review and safety messages remain |
| Next | One guided VERA setup with resumable server-backed steps | Compose current records; missing permissions remain missing |
| Next | Task form with named VERA/project choices and outcome expectations | Add fields/contracts deliberately; no fake “Run” button |
| Next | Work detail with conversation, files, result, next step and evidence in one place | Typed outputs and attachment storage/retention contracts |
| Next | Connection setup and failure repair without secrets in chat or logs | Maintain existing server credential and dispatch boundaries |
| Then | Small template library: summarize, draft, compare | Templates create drafts and disclose allowed actions; not autonomous privileges |
| Then | Safe work search and helpful empty states | Tenant-scoped search, freshness, pagination; no full-workspace claims from one page |
| Then | Notifications grouped by durable condition | Clear ownership and acknowledgment; no false resolution |
| Later | Recurring work, long waits and multi-step plans | Qualified scheduler, versioning, budgets, cancellation and recovery |
| Later | Multiple collaborating VERAs | Explicit task ownership/delegation; no authority merging through chat |
| Later | Model choice optimized for task quality/cost | Measured evals and explicit selection; no silent provider fallback after an uncertain send |

Do not lead with an agent marketplace, prompt editor, graph of infrastructure,
model leaderboard or “unlimited autopilot.” Reuse existing components before
adding another UI library or a parallel application.

## 5. Complete target reconciliation

| Provisional target domain | User-facing value | Build / integration boundary |
| --- | --- | --- |
| VERA/principal identity | A teammate that survives model/runtime replacement | Keep current durable identity and enrollment contracts |
| Regency/governance | “What may this teammate do?” | Thin domain rules and exact approvals; no second authority master |
| PostgreSQL | Work and decisions survive restarts | Integrate storage/HA; preserve additive migrations, tenant keys, leases and locks |
| Durable orchestration | Work can wait and continue safely | Temporal is the proposal's full-target default, not a UI decision or qualified rollout; evaluate bounded alternatives at the stated gate |
| Effect Controller/broker | No consequential action outside current permission | Independent enforcement, credential custody and durable dispatch; never a client-only toggle |
| Model gateway | Replace models without replacing the teammate | Current Gemini slice first; qualify additional adapters independently |
| Computers/Runloop | Isolated execution when a task needs it | Managed provider, generation fencing, checkpoint/export and no-bypass proof before exposure |
| Memory/context | Reuse attributable information | Tenant-scoped facts and lineage; never hidden authority or universal auto-injection |
| Artifacts | Useful deliverables attached to work | Object storage, retention, safe previews, manifests and permission checks |
| Evidence/proof packaging | Explain what happened and how we know | One observation/evidence pipeline; a signature or model claim is not external truth |
| Recovery/DR | Survive failure without repeating consequences | UNKNOWN/reconciliation, restore fencing and non-resurrection qualification |
| Security/identity | Trust the right people and sessions | Real OIDC/MFA, separate human/provider accounts, secret custody and tenant isolation |
| Usage/resources | See and control consumption | Units, reservations and source age; dollars only with reliable pricing and enforceable limits |
| Observability/support | Understand and diagnose problems | Redacted telemetry alongside authoritative state, not instead of it |
| NEXUS/AEON/Genesis/Context Kernel | Optional specialized execution/retrieval | Reuse only independently qualified subsets; no mandatory portfolio stack |
| Legacy Mongo/SQLite/UI trees | Preserve history and migration knowledge | No duplicate writable truth; no destructive retirement in a UI PR |
| Distributed actors/chains/custom hypervisors | No initial everyday requirement | Defer until measured need; do not add product complexity for architecture branding |

## 6. Delivery sequence and release gates

1. **This PR: work-first shell and guide.** Accessible five-item navigation,
   retained technical routes, honest guidance and unchanged command guards.
2. **Setup and bounded work UX.** Compose a simple journey over existing
   contracts. Test reopening, tenant changes, stale sessions and secrets.
3. **One real useful deliverable.** Pick a safe, explicitly approved use case,
   quality rubric, cost/resource limit and source of truth. No broad autonomy.
4. **Durable jobs and one external adapter.** Qualify scheduler and isolated
   execution; exact-action approval, provider read-back and uncertain recovery.
5. **Production foundation.** Real identity, managed credentials/database,
   tenancy, backups/restore fencing, accessibility and independent security.
6. **Expansion.** More providers, templates, collaboration and recurring work
   only after their independent failure, cost and permission gates pass.

No paid infrastructure, migration of everyday data, live provider request,
merge, deployment or production approval is authorized by this design.
Avoid the phrase “full platform ready” until every advertised capability has
current implementation and acceptance evidence.

## 7. Acceptance and honest measurement

Automated slice acceptance:
- Exactly five daily destinations; every original route still reachable.
- Advanced deep links visible and keyboard-operable; one current-page marker.
- Guides invoke existing commands only on explicit clicks.
- Stale/offline/unauthorized/unconfirmed/busy protections remain.
- No made-up metrics, completion indicators, live verification or all-clear.
- No model/tool call or credentials introduced by navigation/guidance.
- Existing workspace, model connection, appearance and workflow tests pass.

Full journey acceptance in subsequent slices:
- New user can create a named VERA, connect a model and obtain a bounded answer
  without typing IDs, reading source code or changing environment settings.
- User can explain an approval and distinguish “requested,” “accepted,”
  “verified” and “unknown” before approving a consequential action.
- Closing/reopening or restarting preserves work, connection and decision state.
- Disconnect, expired authority, duplicate requests and uncertain responses
  cannot become hidden retries or wider privileges.

Usability targets (hypotheses, not measured results): an existing signed-in user
finds the next step in 30 seconds; a newcomer completes bounded setup within
five minutes once credentials are available. Record failures, comprehension,
keyboard use and task success with representative users, not invented scores.
Validate 320-CSS-pixel reflow, 200%/400% native zoom and screen readers separately.

**Production BLOCKED · scheduler HELD · canary NO-GO.**