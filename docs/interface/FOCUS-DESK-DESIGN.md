# Asentxia / Continuum — interface directions and contract baseline

2026-10-08 · Design review · No frontend implementation or deployment

## Decision

Recommend **Focus Desk**, the first displayed visual concept. Work is the everyday landing page: urgent conditions, decisions waiting, blocked work, important active work, and results requiring review. A contextual inspector reveals the exact agent, computer, action, authority, result and evidence without turning the default experience into an infrastructure console.

This recommendation is a design hypothesis, not a measured usability winner. Choose a visual direction before the complete screen specification and implementation plan. All generated screens contain illustrative data: their hashes, times, counts, icons and wording are not API contracts or execution evidence. The image generator introduced sample-value and styling inconsistencies; the written rules below govern implementation. Do not copy sample commits or expiry calculations from images. The actual read adapter is pinned to commit `9ac4723b5390d22ed2d6aed9cf984cb0a32731ca` and expected tree `dcd778fa3a539de0132c2a7ec32c36aaf876f94d`.

## Three product directions

| Display order | Direction | Product structure | Visual foundation | Strength | Tradeoff |
|---|---|---|---|---|---|
| 1 | Focus Desk — recommended | Stable sidebar, adaptive work list, contextual request inspector; details become full pages on narrow screens | Existing Staxions graphite/lime tokens; Linear typographic restraint; Mercury exact review structure | Fast triage with simple default and contextual technical depth | Requires careful list/inspector reflow and predictable attention ordering |
| 2 | Decision Ledger | Horizontal navigation, compact decision queue, spacious full-page approval document | Brex high-contrast hierarchy and Mercury patient review; Asentxia branding replaces reference-brand tokens | Most approachable for deliberate review | Slower for operators handling many related failures; wide navigation needs simplification on mobile |
| 3 | Continuity Workbench | Work navigator, selected task with linked operation trail, authority and continuity facts | Oxide precise surfaces and technical typography; existing Asentxia interactive accent | Strongest for investigating multi-step execution and recovery | Highest default cognitive load; should not become a wall of technical panels |

Use only one primary direction. The selected design can incorporate the others' narrow interaction lessons, but should not become an average of three visual systems. Do not add telemetry cards to fill the home screen. Keep brand accent separate from status semantics: lime indicates interaction/focus; verified success must have an explicit label and evidence. Uncertainty is amber, not failure-red. The third image's placement of unresolved setup under History is unsuitable: unresolved setup belongs in Needs attention. The second image's blue selection treatment is a reference-style drift; use the selected Asentxia token system.

## Source reconciliation

| Source inspected | Evidence used | Limit |
|---|---|---|
| Uploaded production-qualification handoff: `qualification/docs/PRODUCTION-QUALIFICATION-RESULT.md`, `.artifacts/qualification/FINAL-SUMMARY.json`, safety contracts, source and migrations | PostgreSQL domain truth; independent Effect Controller; identity/approvals/renewal; immutable public GitHub reads; uncertainty semantics | Reported 20 new test groups and 21 regressions, not rerun in this design phase. Production gates remain incomplete, scheduler HELD, canary NO-GO |
| Uploaded target-validation and original validation archives | Earlier implementation and historical source inventory | Historical code is not the latest release API; no automatic promotion of old state enums or tests |
| `Asentxia-Product-Interface-Specification-v1.md`, current saved contents | Work-first flow, contextual detail, honest mutation/read results, responsive shell | Its `/v1/*` routes and `AWAITING_APPROVAL`/`UNCERTAIN` enum vocabulary belong to an older inspected implementation; they cannot silently replace the new safety core |
| `ASENTXIA-PRODUCT-AUDIT-AND-DECISION-BRIEF.md`, current saved contents | Identity/computer separation, incident versus delivery lifecycle, maturity classification, journey coverage | Planning coverage and prior structural checks are not live UI acceptance |
| `Adaptive-Liquidity/floks-pc` main `08438f55b2081fd64e4aac1a0afaa5fc2c484845` | Tree, AGENTS, Next/React manifest, layout, CSS, client chrome | Repository review only; no running or signed-in app tested |
| `authkit-visual-system` `f4b74b89a9c83eb7e9abd93027af938fe65f3f05` | Branch tree and CSS inspected | Branch is implementation context, not a selected release or permission to modify it |

Keep the public/setup/payment/OAuth surface separate from the authenticated operating console in the same repository. Reuse useful React/TypeScript patterns and branding; do not inherit public navigation, global legal footer, scanlines or glow into the console. Inspected frontend manifest declares Next 15.5 and React 19.1 ranges. `ChromeProvider.authed` is a local visual flag, not an authentication or authorization source. The final release must select and pin its actual frontend revision.

The source CSS uses graphite `#131313`, floor `#0e0e0e`, foreground `#e5e2e1`, lime `#d3fd64`, Geist, JetBrains Mono and Space Grotesk. Use Geist and JetBrains Mono for the operational UI to avoid unnecessary font complexity. Existing token values are grounding, not proof of contrast compliance. Do not enable deferred memory engines, shared writable computers, or new portfolio integrations through design alone.

## References studied

Refero style references establish appearance; screens and flows establish interaction hypotheses. None proves user performance.

| Reference | Inspectable source | Adapt | Reject |
|---|---|---|---|
| Linear Changelog | https://linear.app/changelog — Refero style `11d3e58a-87d7-4a9a-bbf5-720f4fd3ffc6` | Restrained graphite surfaces, clear type hierarchy, fine dividers | Marketing-scale spacing, brand cloning, decorative glass |
| Brex | https://brex.com — Refero style `7471a4ea-ab61-4281-8f19-2d65352efc44` | Crisp light hierarchy and deliberate accent roles | Copying orange CTA or proprietary display type |
| Oxide | https://oxide.computer — Refero style `57399d2f-b94d-48df-a573-2c423077b16c` | Precise technical surfaces and identifiers differentiated from prose | Hardware hero imagery in an operating screen; unreadably dim technical text |
| Mercury exact payment review | https://refero.design/pages/21ecba85-f243-4f37-852e-04c32dddbd92 | Readable label/value summary and exact-action footer; screenshot inspected | Treating submission as settled outcome; adopting payment capabilities |
| Mercury recurring-payment flow | https://refero.design/flows/11038 | Intent, review, submission and subsequent result are distinct stages | Making financial transfer a supported Continuum action |
| Amie grouped inbox | https://refero.design/pages/23587f51-2fd3-4362-9a5b-4cf49063216e | Sparse grouped rows and direct selection; screenshot inspected | Treating a checkbox as verified completion |

Broad incident and execution-tool queries returned weak matches. No PagerDuty or Inngest product patterns are claimed as researched evidence. Recovery behavior is grounded in the supplied Continuum contracts and prior audit instead.

## Full product coverage to specify after selection

Every area receives responsive screens, a role/action matrix, real-data bindings and happy/failure journeys. “Designed” is not “available.” Availability must come from a trusted release/configuration read model, which is still required.

| Area | User goal and surfaces | Inspected foundation / missing contract |
|---|---|---|
| Work / tasks | Attention queue, active work, task detail, outputs and review | Operations retain `task_id`; production task CRUD/read model and linkage need specification |
| Projects | Project list/detail, task list/board where supported, scoped ownership | New qualification package does not supply complete project APIs; older API is historical context |
| Agents / VERA | Persistent principal, status, epoch, assignments and authority | `ct.principals` and enrolled identities exist; human-facing list/detail/lifecycle APIs required |
| Computers / environments | Separate physical placement, generation, health, loss and replacement | Reuse Staxions ComputerService/ComputerProvider boundary; live isolation and recovery not qualified |
| Approvals | Exact request, impact, expiry, authority eligibility, reauthentication and result | `POST /approvals` and AuthorityService exist; production human read model, ingress/session integration and detailed safe errors required |
| Authority | Narrow grants, limits, expiry, version, revoke, assigned machine identity | `POST /grants`, `/assignments`, `/revoke`, `/renew` exist; no wildcard/delegation editor in this slice |
| State / memory / context | Source/version/digest, quarantine, missing/stale/corrupt explanation | `ct.context_items` and `readContext` exist; full ingestion/retrieval/retention/export UI API missing |
| Evidence | Decision, observation, domain result and verification scope | Transactional evidence events exist; permission-filtered pagination, joins, export and verification read model missing |
| Recovery | Original operation, last trusted observation, reconciliation progress, safe next step | Controller `/reconcile` seam exists; human recovery permissions/ownership APIs and post-revocation read-only observation path missing |
| Integrations | Actual configured provider, narrow actions, connection expiry and reconnect | Public GitHub pinned read adapter exists; protected writes and general connection administration unqualified |
| Notifications / incidents | Durable condition, owner, acknowledgement, delivery history and escalation | Incident/delivery APIs and detection integration need implementation; do not manufacture events in the browser |
| Usage / limits | Authoritative reserved/consumed/remaining limits and measurement age | Grant max cost/budget/reserved exist; aggregate usage, money units and billing truth require contracts |
| Security | Human sessions, machine identities, revocation, scoped incidents | Identity verifier/enrollment/owner checks exist; live provider MFA semantics and full session management unqualified |
| Settings | Account, preferences, integration/developer metadata, data lifecycle, support | Expose only actual settings; never store provider secrets in client persistence |
| Onboarding | Human sign-in, workspace, agent, computer, machine binding, grant, first verified task | Step-by-step authoritative readiness model missing; health endpoint alone cannot prove readiness |

## State and result contract

Backend operation state, approval status, work status, dependency health and recovery progress are separate axes. Never reduce them to one ambiguous colored dot.

| Backend or derived condition | Human label | Safe behavior |
|---|---|---|
| `REQUESTED` | Pending; Approval required only when current approval eligibility supports it | Recording request does not start execution |
| `RESERVED` | Preparing execution | Reservation does not prove send or completion |
| `SENDING` | Executing | No verified-result badge |
| `DENIED` | Denied | Show safe supported reason; do not offer a bypass |
| `FAILED_KNOWN_NO_EFFECT` | Failed — no effect confirmed | Distinguish from timeout; new work needs current authority and an explicit retry contract |
| `UNKNOWN` | Outcome uncertain | Retain original operation; no automatic resend or duplicate substitute operation |
| `UNKNOWN` with a recorded observation job active | Reconciling; outcome still uncertain | Reconciliation requires a real progress read model, not a spinner inferred from elapsed time |
| `COMMITTED` with matching authoritative observation | Verified success — named action and verification scope | Public read completion is not proof of an external write or proof that an earlier timed-out request ran |
| Verified result following `UNKNOWN` | Verified success · recovered through reconciliation | Recovered is a history qualifier, not a new database enum |
| Authority/dependency/resource prerequisite unavailable | Blocked, plus exact known prerequisite | Blocked is a work/eligibility condition, not an invented operation state |

Unknown backend values show “Status unavailable” and raw versioned detail where permitted. Missing evidence shows “Verification unavailable,” never a green fallback. Task completion requires its own accepted output predicate; operation COMMITTED does not automatically complete the project.

## Adaptive attention rules — proposed contract

Use a deterministic, permission-filtered projection of durable conditions. Proposed order: confirmed critical security/containment failure; uncertainty or recovery with consequence/deadline risk; expiring approvals; blocked work and revoked/expired permissions; agent/computer/integration faults; enforced limits; other approvals; important active work; results awaiting human review. Severity, impact, deadline and age determine ordering within a band; explain each item's reason. Do not use opaque model ranking as the only priority authority.

Each entry needs stable ID, source type/version, accessible object references, severity/reason, required role, owner where recorded, event time, observation time, safe next command, and resolution predicate. Group common-cause outages instead of flooding rows. Deduplicate notifications by condition identity; receiving another delivery is not another incident. Notification read, dismissal, acknowledgement and verified resolution remain distinct.

Freeze visible ordering while a user is reviewing or navigating it. Show a “New attention items” count and let the user apply new ordering; critical incidents may add a banner without stealing keyboard focus. Never hide critical unresolved conditions through snooze. Snooze affects reminders only. Pinning active work must not displace urgent conditions. Do not show “All clear” for a stale, offline or partial snapshot.

## Interruptions and approval mechanics

Use persistent banners for workspace-wide blocked/degraded/stale conditions; rows and inline alerts for object-specific problems; side sheets for request inspection; notification center for delivery history. Use a modal for deliberate high-impact confirmation, reauthentication or genuinely urgent blocking intervention, not routine incoming approvals. Never auto-approve from a notification toast. Deep links must load the current authorized request before enabling a decision.

Approval summary: action, reason with attribution, affected resource, principal, computer/generation, exact scope, impact/change preview, expiry, grant/policy version where actually stored, verification method, and what approval will do. All parameters are read-only. Changed parameters or grant invalidate approval; require a new exact proposal rather than silently updating approved bytes. Expandable full payload/digest is available to developers. A summary cannot conceal changed fields.

Latest owner checks require an independently enrolled user owner, recent authentication within five minutes and an MFA method claim; live issuer claim semantics remain unqualified. The frontend must follow server eligibility, never decide ownership from a client flag. Command `/approvals` accepts `{operation,digest,expires}`. Successful approval is an authorization record, not execution success. The current API returns generic 403: do not guess whether it means expiry, wrong tenant, recovery fence or MFA. A safe structured eligibility/error read contract must be added before richer explanations can be reliable.

Worker `/dispatch` and `/reconcile` are trusted controller seams, not public browser endpoints. Browser controls must call reviewed human APIs; no controller signing material, provider credentials or machine capability issuance belongs in the UI. `/renew` is a machine lifecycle operation, not an “expand access” button. Deny/cancel/resume/isolate/compensate require separate reviewed backend commands; do not invent them from visual controls. Revocation blocks subsequent admissions under the tested contract; it does not undo already-sent actions.

## Failure, accessibility and responsive acceptance

Required shared states: loading, empty, stale, offline, degraded, denied, expired session, revoked access, provider failure, duplicate request, computer loss, uncertain outcome and restored state. Preserve nonsecret unsent text where safe; clear account-sensitive data on logout/tenant change. Lost write responses become unconfirmed commands, not automatic retries. Same operation delivery returns current state; conflicting binding shows conflict. Browser Back and deep links preserve the selected durable object. Restore does not automatically resume effects; old generation remains fenced until actual safe activation.

Design target: WCAG 2.2 AA, verified later rather than claimed now. Status announcements must work without stealing focus; sticky banners must not obscure focused controls. Use labels/icons alongside color, visible focus, semantic lists/tables, keyboard-accessible detail and return focus, no essential hover-only content, reduced motion and readable error associations. Design for 320 CSS-pixel reflow and 200%/400% zoom; wide raw payloads may scroll in clearly labeled technical regions. Aim for 44px touch controls. Desktop inspector becomes a full-width detail route below a proposed 1100px breakpoint; mobile uses list → detail rather than squeezing two panes. Validate breakpoints with actual content.

Official sources read: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html and https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html. Automated checks alone will not establish accessibility.

## Next deliverable after direction selection

Produce the complete implementation-ready specification as a master coverage map plus bounded modules: shell/onboarding; Work/Projects; Agents/Computers; Approvals/Authority; Evidence/Recovery; Integrations/Incidents; Usage/Security/Settings. For every screen specify layouts, actual object fields, source revision, read and command contract, required role, state mapping, invalidation/freshness, cancellation/backpressure where relevant, failure and mobile behavior, and measurable journey acceptance.

Mark each control as existing inspected, proposed contract required, or unavailable/deferred. Define missing read APIs before frontend wiring. Reconcile the old `/v1/*` application against the newer `ct.*` foundation rather than combining incompatible endpoint families. The scheduler remains an internal interchangeable coordinator until qualification selects it; users should see their work, not a vendor choice they cannot safely make.

Usability falsifier for the recommendation: compare equivalent scenarios across the three layouts with general users and developers. Ask participants to find the urgent item, describe exact approval scope, distinguish uncertain from failed, explain what revocation cannot undo, and find verified evidence. Record completion time, wrong-action attempts and comprehension errors. Revise any direction that encourages resend of UNKNOWN or confuses approval with completion. No participant study, frontend build, live API binding, mobile QA, accessibility pass or production release occurred in this phase.
