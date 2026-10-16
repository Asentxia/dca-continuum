# Continuum Focus Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after workflow approval. Steps use checkbox syntax for tracking. No delegation is required for this plan.

**Goal:** Build the approved Focus Desk operating console in floks-pc with truthful state, reviewed human contracts and no privileged browser seams.

**Architecture:** Next.js human routes are clients of a reviewed server-only BFF and domain read/command services. PostgreSQL owns identity/authority/operation truth, the selected scheduler owns progression, and provider observations determine supported results. New read models and command adapters remain disabled until their contracts are reviewed; local fixtures prove presentation only.

**Tech Stack:** Existing Next.js/React/strict TypeScript/Zod, Node >=22.12.0 <23 in floks-pc; independent controller runtime retained. Reuse existing auth, billing, ComputerService/ComputerProvider and graphite/paper/lime design tokens selectively.

**Spec:** CONTINUUM-PRODUCTION-INTERFACE-SPEC.md, with CONTINUUM-UI-CONTRACT-TRACEABILITY.md and CONTINUUM-UI-GAP-REGISTER.md alongside it.

## Global constraints

- Node >=22.12.0 <23 for this frontend; no unreviewed runtime/framework rewrite.
- Human account != VERA principal != workload/machine identity != model != Computer.
- Per-operation capability lifetime is at most 90000 ms, further bounded by identity/grant/deadline/assignment/approval expiry; browser never renews.
- Exact current operation enums: REQUESTED, RESERVED, SENDING, COMMITTED, UNKNOWN, DENIED, FAILED_KNOWN_NO_EFFECT.
- UNKNOWN has no resend/retry control. Logs, model output, HTTP 2xx and cryptographic integrity are not provider truth.
- Computer raw states and generation/fence remain explicit; workspaceRevision is not placement generation.
- Production BLOCKED, scheduler HELD, canary NO-GO. P1/P2 PARTIAL; P3–P5 NOT RUN.
- Browser never calls controller /dispatch, /reconcile or machine /renew; provider/signing/workload credentials stay server-only.
- Preserve memory hard locks and deferred shared writable Team Computers. No writes to Floks-main.
- All changes stay in floks-pc on an isolated feature branch; no merge/deployment without applicable release workflow.

## Review focus

1. Out-of-order response after account/tenant switch must not restore private or stale data — B02 test tenant_switch_and_late_response.
2. Lost approval/revocation acknowledgement must not create a second decision or imply external completion — B05 test lost_reply_command_lookup.
3. Multi-tab takeover, server restart or missing lease row must deny stale control and retain local keyboard navigation — B08 test missing_lease_and_multitab.
4. Long Unicode/markup fields and expiry during 400% zoom review must preserve complete exact approval content and block stale action — B05/B10 test exact_preview_zoom_expiry.
5. Shared-provider symptoms with different causes and incomplete snapshots must not suppress urgent work or overstate counts — B03 test common_cause_partial_snapshot.

## Workflow and file map

This is a reviewable plan, not code execution evidence. Concrete spec/plan approval is still NOT RUN. The user's blanket tool authorization permits tools/resources; it does not review the newly produced packet. The invoked writing-plans skill requires review before implementation, and the user's execution prompt explicitly requires internal consistency and approved workflow first. Complete B00 preparation now; execute B01 onward only after that review. Read AGENTS/AUTHORITY/PHASES and relevant Computer provider instructions at the fresh pinned head before edits; owner scope overrides obsolete phase scope, not isolation locks.

Proposed new files below are names to create after approval, not files claimed to exist. Keep console code together under `web/lib/continuum` and `web/components/continuum`; page routes live under `web/app/console`, human API handlers under `web/app/api/continuum/v1`. Auth routing stays separate from public marketing. Do not copy a second writable authority database into the frontend.

| File / area | Responsibility |
|---|---|
| web/lib/continuum/contracts.ts | Zod schema-version-1 envelopes, resource payloads, eligibility, command receipts, exact enums |
| web/lib/continuum/server.ts | Server-only verified human session and tenant adapter, redaction, current read model access |
| web/lib/continuum/commands.ts | Reviewed human-only command transport, ledger lookup, immutable binding and CSRF |
| web/lib/continuum/client.ts | Typed read/command requests, version ordering, pending result lookup; no secret storage |
| web/lib/continuum/focus.ts | Pure deterministic causal grouping/order and selection snapshot behavior |
| web/components/continuum/ConsoleShell.tsx, StatusAxes.tsx, Availability.tsx | Responsive shell, shared status and truthful availability |
| web/components/continuum/WorkView.tsx, TaskDetail.tsx, ProjectDetail.tsx | Work/Projects with bounded dependency/ownership context |
| web/components/continuum/IdentityDetail.tsx, VeraDetail.tsx, ContextDetail.tsx | Distinct safe identity, cognition and context facts |
| web/components/continuum/ApprovalReview.tsx, AuthorityDetail.tsx | Immutable preview, owner eligibility, grant/assignment/revoke |
| web/components/continuum/EvidenceDetail.tsx, RecoveryDetail.tsx | Evidence hierarchy and owned uncertainty |
| web/components/continuum/ComputerDetail.tsx, ManualSession.tsx | Precise lifecycle/recovery, gated manual session boundary |
| web/components/continuum/OperationsSettings.tsx | Integration/incident/delivery/usage/deployment metadata |
| web/tests/continuum/*.test.ts[x], web/e2e/continuum.spec.ts | Meaningful contract/component/adversarial/browser coverage |

Test harness proposal: add locked development-only Vitest/Testing Library and Playwright/axe tooling if equivalent harness is absent at the fresh head. Resolve and pin exact versions through the lockfile when executing; this plan does not invent version numbers or claim compatibility was tested. Add scripts `test:console` (Vitest run), `test:e2e:console` (Playwright for console) in web/package.json. Keep current typecheck/build and root domain tests. Never provision paid resources from tests. Fixture URLs/tokens are test-only and must not become production config.

## B00 — Freeze evidence and review boundary

**Files:** Spec, traceability, gap register and owner checklist; existing AGENTS.md read-only.

**Interfaces:** Produces reviewed source pins and acceptance catalogue A01–A40; no runtime code.

- [x] Read exact v2 routing and verify four source hashes before refreshing frontend.
- [x] Pin frontend tree at 87f4da5e678a1260133f0141e8a6a59f00025457; inspect legacy lifecycle/manual boundaries.
- [x] Reconcile every enabled/deferred interaction and record precise production gates.
- [x] Run document/source consistency checks; retain separate current-run report.
- [ ] Receive review of the concrete specification and plan under the execution workflow.
- [ ] At execution time re-read the mutable branch head and detect changed relevant blobs. Create isolated worktree/feature branch using the invoked Superpowers worktree workflow; no force reset or unrelated changes.

## B01 — Runtime contracts and truthful availability

**Files:** Create contracts.ts, shared StatusAxes/Availability components and web/tests/continuum/contracts.test.ts; modify web/package.json/lock only for the required harness.

**Interfaces:** Export `ConsoleResource` union for session/readiness/focus/work/projects/vera/identities/computers/operations/authority/context/evidence/integrations/incidents/notifications/usage/deployment; `PayloadByResource` maps each to its typed specification payload. Export `ReadEnvelope<K extends ConsoleResource>` with the specification's common metadata; `ActionAvailability` with six availability values plus separate eligibility/qualification; `CommandReceipt` with command_id/status/result_ref; `parseEnvelope<K>(resource: K, input: unknown): ReadEnvelope<K>` and `isActionEligible(action: ActionAvailability, serverNow: number): boolean`.

- [ ] Write contracts.test assertions: unknown operation enum rejected; all 15 ComputerState values preserved; absent generation not coerced from workspaceRevision; stale eligibility false; public_read PASS/protected_write qualification_pending stay separate; reservation has explicit unit/source.
- [ ] Run `npm --prefix web run test:console -- contracts.test.ts`; expect failures before implementation.
- [ ] Implement runtime schemas and typed separate status axes, no unsafe any or frontend authority inference. BFF outputs minimal safe fields and never credential values.
- [ ] Run contract tests and `npm --prefix web run typecheck`; expect zero failures/errors.
- [ ] Review diff and commit focused contract/harness change. Covers A02/11/19/26/33/35/37/39; closes G01/G10 foundation.

## B02 — Reviewed human reads, session adapter and client freshness

**Files:** Create server.ts/client.ts; human GET handlers under `web/app/api/continuum/v1/[resource]/route.ts`, console layout and shell; reuse actual `web/lib/auth/request-session.ts` rather than guessed auth module; tests read-boundary.test.ts.

**Interfaces:** `readConsole<K>(session: HumanConsoleSession, resource: K, query: ConsoleQuery): Promise<ReadEnvelope<K>>`; `HumanConsoleSession` is server verified human ID/tenant/enrollment/expiry, never caller-selected role. `ConsoleQuery` has object_id?, cursor?, filters? with resource schemas. `loadConsole<K>(resource: K, query: ConsoleQuery, signal: AbortSignal): Promise<ReadEnvelope<K>>`. `acceptSnapshot<K>(current: ReadEnvelope<K> | null, next: ReadEnvelope<K>): ReadEnvelope<K>` rejects older version/scope changes. The server session type stays server-only.

- [ ] Write read-boundary tests tenant_switch_and_late_response, cross_tenant_generic_denial, stale_authority_no_action, cursor_filter_scope and unknown_schema: no object existence leak, private no-store cache, no unsafe fallback on missing backend.
- [ ] Run targeted console tests and confirm failure before changes.
- [ ] Implement server-only reads through authenticated domain service connections. Do not trust client authed flags, email seat ownership as final enrollment, raw DB tenant input or metadata logs. Return typed authorized unavailable snapshots if a domain service is absent; never seed production data.
- [ ] Implement shared shell/back/filter/disclosure behavior and version-aware client cancellation/refresh. Preserve unsent intent but never auto-approve after session renewal.
- [ ] Run console tests/typecheck/build, review diff and commit. Covers A01/02/38/39; closes G02 read boundary.

## B03 — Work, Projects and deterministic Focus

**Files:** Create focus.ts, WorkView/TaskDetail/ProjectDetail, console work/projects routes and work-focus.test.tsx.

**Interfaces:** `groupFocus(snapshot: ReadEnvelope<'focus'>): FocusGroup[]` and `sortFocus(groups: readonly FocusGroup[]): FocusGroup[]`; `FocusGroup` contains authorized cause ID/version, distinct task IDs, severity, deadline, created_at and completeness. Components consume typed work/projects/focus envelopes and safe selection IDs; no client execution authority.

- [ ] Write common_cause_partial_snapshot assertions: one task in two causes counts once in distinct totals; unrelated causes share provider but do not merge; missing deadlines follow known; selected list order freezes; new critical event announces without replacing approval. Write single_accountable_owner and cross_tenant_dependency assertions.
- [ ] Run targeted tests; expect failure before implementation.
- [ ] Build task/project domain adapter reads. Where task registry is absent, show requires_setup/unsupported; do not create another scheduler or use operation.task_id as proof of a full task record.
- [ ] Implement list-first Work and bounded coordination inspector. Keep new-task/handoff/archive/drag controls absent until their reviewed domain commands exist; plan extensions require A06/07/09 before enablement.
- [ ] Run tests/typecheck/build and commit. Covers A03–09; closes G11/G12 presentation and records command subgaps explicitly.

## B04 — Identity, VERA, context and cognition read surfaces

**Files:** Create IdentityDetail/VeraDetail/ContextDetail, agent/identity detail routes and identity-surfaces.test.tsx.

**Interfaces:** Components consume ReadEnvelope<'vera'|'identities'|'context'>; safe model binding is part of VERA payload, with independent ID/version. `formatFreshness(observedAt: string | null, freshUntil: string | null, serverNow: number): 'fresh'|'stale'|'unknown'` in client.ts.

- [ ] Write identity separation/disabled_version/no_secrets assertions; issuance expiry <=90000 ms and earlier assignment expiry; missing issuance metadata unknown; quarantined/stale context not treated authoritative; model replacement retains principal ID.
- [ ] Run tests; expect failure.
- [ ] Project enrollment/assignment/issuance safe metadata from trusted domain source. Add provenance fields only from implemented source or label unknown. No JWT/token preview or human renewal button. Preserve gated memory locks and no model-change/delegation controls.
- [ ] Implement responsive read surfaces with explicit eligibility reasons and safe technical ID disclosure.
- [ ] Run tests/typecheck/build and commit. Covers A10–15; closes G01/G04 presentation; G14/G19 full features remain deferred.

## B05 — Exact human governance adapter and decision ledger

**Files:** Create commands.ts, ApprovalReview/AuthorityDetail, reviewed human POST handlers for approvals/grants/assignments/revoke plus command lookup; tests authority-commands.test.ts and approval-review.test.tsx. Trusted ledger schema/service requires a separate backend contract review before enabling these handlers; it must not be invented as browser state.

**Interfaces:** `HumanCommand` discriminated union contains exact S1 seam inputs plus idempotency_key/expected versions at BFF; `submitHumanCommand(session: HumanConsoleSession, command: HumanCommand): Promise<CommandReceipt>` and `lookupHumanCommand(session: HumanConsoleSession, commandIdOrKey: string): Promise<CommandReceipt>`. `previewOperation(operation: OperationPayload): ExactPreview` uses canonical digest-bound typed values; OperationPayload/ExactPreview are defined in contracts.ts. Machine renew is absent from union.

- [ ] Write tests lost_reply_command_lookup, same_key_changed_body_conflict, fresh_owner_MFA_boundaries (300000 ms, future tolerance 5000 ms), grant_48h/approval_24h_and_deadline, exact_digest_fence_version, assign_wrong_kind and revoke_inflight_truth. Assert no controller send from a human handler.
- [ ] Write preview tests complete_long_unicode_params, inert_markup, expiry_during_review, two_tab_stale_approval; immutable preview cannot be edited.
- [ ] Run targeted tests against an authorized disposable local domain fixture; expect failure for absent ledger/read contract.
- [ ] Implement reviewed ledger/history adapter preserving immutable operation semantics and current owner enrollment/MFA. Same-body duplicate returns durable existing result; no blind retry of approval upsert/revoke version increment. Re-read authoritative current eligibility inside backend transaction; UI eligibility is advisory.
- [ ] Wire human approve/grant/assign/revoke only when backend review and feature availability permit. No reject/cancel/edit/re-propose button. Display authorization applied separately from effect result.
- [ ] Run domain+console tests/typecheck/build; inspect network surface and redacted error output; commit. Covers A12/16–21/39; closes G02/G03 human command gaps, live P1 still PARTIAL.

## B06 — Effect, evidence and owned UNKNOWN

**Files:** Create EvidenceDetail/RecoveryDetail and .artifacts/core/recovery routes; tests evidence-recovery.test.tsx; human export/ack remain absent until reviewed domains exist.

**Interfaces:** Typed operation/evidence/incident envelopes; `deriveResultLabel(operation: OperationPayload): ResultLabel` in contracts.ts, where ResultLabel includes unconfirmed and adapter-scoped verified_read; neither derived label writes state. Provider observation carries contract/version/selector/time/match separately from evidence integrity.

- [ ] Write UNKNOWN_no_resend, chain_valid_observation_missing, timeout_then_verified_read_not_original_arrival, revoked_observer_unavailable, incomplete_evidence_archive and ack_not_resolution assertions.
- [ ] Run tests; expect failure.
- [ ] Implement linked six-level evidence hierarchy, authorized pagination, original operation preservation and owned UNKNOWN. No direct dispatch/reconcile calls. Existing internal reconciler progress can be projected; a user observation request needs a separately reviewed non-writing path first.
- [ ] Keep export/ack unavailable until their durable/redacted API extensions pass A25/A32. If post-revocation observation is absent, preserve explicit unresolved reason; never regrant to clear it.
- [ ] Run tests/typecheck/build, inspect no optimistic success from receipts/logs, commit. Covers A22–25/31/32; closes G05 presentation/G13; protected oracle remains a backend qualification gap.

## B07 — Precise Computer/recovery projection

**Files:** Modify `web/lib/computers/dashboard.ts` and `owner.ts` with versioned additive rich payload only; create ComputerDetail and console computer routes; tests computer-states.test.tsx. Read current `src/lib/computers/types.ts` and service transitions before any change.

**Interfaces:** ComputerPayload in contracts.ts has logical_id, raw_state, lifecycle/job/checkpoint axes, placement_alias/generation/fence metadata nullable-with-reason, VERA/identity refs, rebuild requirement and health observation. `toConsoleComputer(source: LegacyComputer, authority: EnvironmentProjection | null): ComputerPayload` never invents generation or exposes providerRef.

- [ ] Write exhaustive 15-state tests, checkpoint_vs_restore_failure, missing_generation_not_workspace_revision, stale_generation_denial and lifecycle_accepted_not_recovered.
- [ ] Run tests; expect collapsed legacy states to fail.
- [ ] Preserve legacy clients with additive raw fields/versioned adapter, update final console display to precise conditions. No concrete provider calls from routes; lifecycle controls require reviewed service action eligibility/current-state checks.
- [ ] Show readonly checkpoint/artifact/fence obligations; do not add restore/destroy/isolate/global-resume controls. A physical fence remains unknown until actual proof.
- [ ] Run relevant root domain and console tests/typecheck/build; review migration/compatibility and commit. Covers A26–28; closes G06/G07 presentation, P3/R6 still NOT RUN.

## B08 — Safe manual session boundary

**Files:** Modify desktop-access.ts, desktop-sessions.ts, desktop route and ComputerScreen.tsx only after authority/isolation review; create ManualSession component and manual-session.test.ts[x]. Trusted exclusive lease/fence persistence extension requires reviewed backend design, not client locking.

**Interfaces:** `ManualLease` in contracts.ts: lease_id, human_id, logical_computer_id, placement_generation, mode, starts_at, expires_at, revoked_at, fence_version. `startManualSession`/`endManualSession` are reviewed human service operations returning CommandReceipt; observed lease read is separate. Manual input results remain manual ActionResult, never effect COMMITTED.

- [ ] Write missing_lease_and_multitab, generation_change_expiry, durable_revoke_across_instances, handback_not_agent_resume, act_http_error_visible, remote_focus_only_keyboard and stale_frame_no_input assertions.
- [ ] Run tests; expect current missing-row authorization/global key capture/action response handling to fail.
- [ ] Implement fail-closed durable lease plus exclusive human/agent execution fence and service result feedback. Keep input disabled if backend boundary or store is absent; do not patch frontend to conceal missing enforcement.
- [ ] Scope keyboard capture to intentionally focused remote surface, document local escape, preserve local Tab/Escape, do not persist screenshots. Audit start/end metadata only. Privileged browser isolation requires actual VM network/credential tests before enabling governed deployment.
- [ ] Run domain/console tests and browser keyboard cases when stage exists; commit. Covers A29/30/40; closes G08/G09 source concerns subject to physical P3/R1/R8 proof.

## B09 — Integrations, incidents, notifications, usage and data profile

**Files:** Create OperationsSettings and settings/readiness routes; tests operations-settings.test.tsx; selectively reuse existing billing portal and metadata code without pricing changes.

**Interfaces:** Typed integration/incident/notification/usage/deployment/readiness envelopes. Channel/preferences/ack/new-task/handoff/export/policy/model/limits mutation extensions are independently reviewed before entering HumanCommand; no generic catch-all action endpoint.

- [ ] Write public_read_not_protected_write, delivery_not_resolution, duplicate_common_cause, stale_meter_not_zero, reservation_not_charge, missing_RPO_unknown and subscription_not_authority assertions.
- [ ] Run tests; expect failure.
- [ ] Implement authorized metadata and dependency-aware readiness with exact maturity; missing domain API gets clear unavailable reason. Show incident owner/delivery attempts separately; no external notification is sent by frontend tests.
- [ ] Reuse reviewed billing workflows independently. Keep optional memory/procedures/federation/team/compensation/policy-write controls unsupported until dedicated contracts and acceptance extension exist.
- [ ] Run tests/typecheck/build and commit. Covers A02/19/32–37; closes G10/G15/G16 presentation, live delivery/spend gates remain unchanged.

## B10 — Integrated accessibility/browser evidence and review

**Files:** web/e2e/continuum.spec.ts, test fixture harness isolated from production, evidence report in repo docs; no new production environment provisioned by test runner.

**Interfaces:** Existing console human APIs and spec A01–A40; test environment explicitly chooses fixture vs approved authenticated stage. No credentials in saved traces/HAR/screenshots. Redact before artifact persistence.

- [ ] Add exact_preview_zoom_expiry and common browser tests at 320/390/768/1024/1440 px, 200% text and 400% zoom, reduced motion, keyboard-only and actual screen-reader review. Assert preview readability, focus-visible/restoration, no sticky obstruction or accidental approval, no global remote key hijack; measure contrast and axe results.
- [ ] Run `npm --prefix web run test:console`, root `npm run typecheck`/`npm run test:domain`, `npm --prefix web run typecheck`, `npm --prefix web run build`; all must pass for the changed slice. Missing script/dependency is resolved in B01, not represented as a passing check.
- [ ] When O09 is available, run `npm --prefix web run test:e2e:console` against the explicitly configured authorized stage. Execute A01–A40 relevant enabled profile cases, direct backend authority tampering, no-secret/no-controller-surface checks, uncertainty/revocation/manual session races and degraded/offline responses. Unavailable profiles are checked for honest availability, not fake success.
- [ ] Capture command, exact commit, timestamp, environment/profile, test accounts by opaque IDs, expected vs actual, pass/fail/not-run, sanitized observation/evidence refs and retained failures. Automated accessibility pass alone does not certify full accessibility.
- [ ] Review complete diff for stale helpers, unsafe fallback, hidden credential surfaces and unmatched controls. Re-pin gate ledger from current evidence; never promote PARTIAL for UI completion. Commit report and prepare reviewable branch/PR only within authorization; merge/release remain separate.

## Independent work and rollback

B01–B04 and read-only B06/B07/B09 can be engineered with explicit fixtures/local domain services without live owner connections after spec/plan review. B05 command enablement waits for reviewed backend ledger/session contracts; B08 manual enablement waits for lease/fence/isolation enforcement. O01–O11 block only live qualifications, not unrelated UI work. No speculative new-task/handoff/policy/export mutation slips into a read-only slice.

Rollback disables the affected feature via trusted availability/ingress and stops new admission. It preserves command/operation/evidence history, logical IDs and fence versions; it never reactivates stale credentials or routes to legacy dispatch. No dual writable authority cutover. Console cache or browser reload cannot restore authority. If source/contract differs from this pin, adapt the plan and record the evidence before proceeding.

## Current completion state

Document reconciliation and internal validation: PASS. B00 workflow approval, B01–B10 runtime implementation and authenticated browser evidence: NOT RUN. No frontend code or deployment was changed. The next review concerns this concrete packet, not plugin permission.
