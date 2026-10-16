# Continuum production interface specification

Revision 1 • 2026-10-09 UTC • Focus Desk reconciliation • Ready for workflow review, not yet approved for implementation or release.

Later scoped implementations and approved integration direction are recorded in
`../plan/CURRENT-PLAN.md` and `../plan/OWNER-DECISIONS.md`. D01 approves restricted
NEXUS/AEON architecture, not enabling gated production memory or shared writable
Team Computers. Proposed controls below still require implemented contracts and
their qualification; this historical revision header is not a reversal of merged work.

## 1. Decision and scope

Keep Focus Desk: Work is the landing page, a stable navigator opens durable objects, and a contextual inspector explains decisions, blockers and results. This specification supersedes historical UI assumptions only; it does not supersede the frozen safety core or approve production deployment. Asentxia is the institution, Continuum the operating environment, VERA the persistent accountable principal, and The Regency the governance responsibility. The console is a human client, not an authority root or execution dependency.

Retain Next.js/React/TypeScript. The inspected frontend has Next ^15.5.2, React ^19.1.1 and Node >=22.12.0 <23. Do not silently upgrade its runtime to the architecture proposal's Node 24. Resolve cross-deployment runtime compatibility separately; the controller can run independently. Preserve ComputerService/ComputerProvider as the compute boundary. Do not enable gated memory engines or shared writable Team Computers.

All contracts prefixed `C-` or `R-` below are **proposed console contracts**, unless explicitly mapped to an implemented seam. Their presence in this document is not deployment evidence. A feature stays unavailable until the backend contract, authorization and applicable qualification are reviewed. The traceability document is the exhaustive interaction catalogue: no additional mutation control is permitted by implication.

## 2. Evidence and precedence

The exact attached `00_READ_ME_FIRST.md` is v2. An older saved copy differs; v2 wins. Read order in this run was routing, verification, extracted production result/gates, architecture, baseline contracts, then refreshed frontend. Latest bundles take precedence over architecture's older claims that identity and real-read adapters are absent. Broader architecture operation states are targets, not current wire enums.

| Source ID | Exact source | SHA-256 / revision | What it establishes |
|---|---|---|---|
| S1 | latest-source-material/CONTINUUM-PRODUCTION-QUALIFICATION-HANDOFF.zip | 49072a61e2023b90c47eb52ae7b0286df1ad8716cf5aad623a0751986e8dcbef | Current source, migrations, production gates, saved test records |
| S2 | latest-source-material/CONTINUUM-TARGET-VALIDATION-IMPLEMENTATION.zip | c2435fd62bd5999d1169079bb0f5d70e33a2859b269a440bb3b4ff6851268a7f | Accepted local baseline, safety contracts and controller regressions |
| S3 | latest-source-material/CONTINUUM-VALIDATION-EVIDENCE.zip | d2cb25b5b48f2734446acbe28328b0d6463ca9e374da72331b3aa3dbda8ae480 | Historical source inventory and diagnostic evidence |
| S4 | CONTINUUM-FINAL-ARCHITECTURE-SYNTHESIS.md | 10fdc3d472ef22248fc6751e1b21e120e533320557bd2fb7e22b21c8d5b7b049 | Target boundaries and responsibility map; not production certification |
| S5 | floks-pc, cursor/aistudio-authkit-desks-a695 | 87f4da5e678a1260133f0141e8a6a59f00025457, refreshed in this run | Current frontend, raw lifecycle, desktop control and limitations |
| S6 | Focus Desk baseline; principal audit addendum; coverage review | Exact user attachments, read in this run | Approved direction and mandatory interface amendments |

All four hashes were recomputed and matched. Extracted qualification gates and FINAL-SUMMARY agree. Saved TAP records report 14 identity, 6 real-read, 7 foundation and 14 controller groups passed with zero failures/skips. These are inspected source-reported execution records; no backend suite was rerun here. The Notion production qualification page returned NOT_FOUND; Notion-only changes remain unverified. An HTTP connector account is not a workload identity or effect grant.

## 3. Domain objects and authority owners

| Object | Authority / durable identity | Required detail and boundary |
|---|---|---|
| Human account | Verified issuer/subject/audience plus independently enrolled human mapping | Organization/tenant membership, session expiry and safe MFA eligibility; email alone is insufficient |
| VERA | ct.principals, tenant + principal ID | Active, epoch, generation; persists across model and placement changes |
| Workload identity | ct.identities, independent machine enrollment ID/version | Kind, approved issuer metadata, active/version, assignment and expiry; not human cookies or model credentials |
| Model binding | Proposed versioned cognition binding | Provider/model/config revision, compatibility and substitution history; does not confer principal authority |
| Computer | Logical ID plus authoritative environment record | Current placement alias/generation, raw lifecycle, checkpoint, fence, health and recovery obligations; generation is not workspaceRevision |
| Project/task | Proposed tenant-scoped domain registry | Goal, accepted inputs, single accountable VERA, bounds, dependency versions, output refs and business phase |
| Workflow | Selected scheduler persistence | Progression/wait/version projected read-only to console; scheduler is HELD, no engine selector |
| Operation | ct.operations, immutable semantic binding | Task/plan version, principal, grant/version, epoch/generation/fence, provider/action/resource/params/digest/key/cost/deadline |
| Grant/approval/assignment | ct.grants / ct.approvals / ct.assignments | Exact scope, versions, expiry, revocation and reservations; no UI-expanded authority |
| Context/memory | ct.context_items for current narrow source; proposed provenance extension | Version/digest/quarantine plus source, owner, permitted readers, ingestion and derivation; indexes are rebuildable |
| Evidence/observation | ct.evidence_events and operation observation, provider verification contract | Governance events differ from provider observations and diagnostic logs |
| Incident/notification | Proposed durable incident + delivery registry | Owner, root cause, impact, acknowledgement, delivery attempts and resolution basis |

Current registered roles are human `owner` and machine `worker`. A tenant reader permission is a proposed human API requirement; no viewer/operator/admin role exists by assertion. Browser requests never impersonate a machine. Every read is authorized server-side and redacted by field permission. Cross-tenant missing/denied objects use a generic response; no existence leak.

## 4. Shared read, availability and command contracts

All proposed human routes live under `/api/continuum/v1`. This is a new namespace, not a claim that historical `/v1/*` APIs apply. R-SESSION, R-READINESS, R-FOCUS, R-WORK, R-PROJECT, R-VERA, R-IDENTITY, R-COMPUTER, R-OPERATION, R-AUTHORITY, R-CONTEXT, R-EVIDENCE, R-INTEGRATION, R-INCIDENT, R-NOTIFICATION, R-USAGE and R-DEPLOYMENT name the corresponding proposed GET projections. Use cursor pagination bound to tenant, filters and snapshot; disclose incomplete results. Search/filters operate only on authorized server results, never pretend recent-100 is a full archive.

Every projection envelope contains `schema_version: 1`, `server_time`, `observed_at`, `fresh_until`, `projection_version`, `source_revision`, `completeness`, cursor and per-object versions. Missing values are `unknown` or omitted with an explicit reason, never zero or healthy. Freshness is per source; a current page response may contain stale provider observations. Push invalidations carry sequence/version, contain no private payload, and trigger a read. Sequence gaps trigger full refresh. Slow old responses cannot replace newer state. Polling uses bounded backoff; hidden-tab suspension must not extend eligibility. No unbounded event or effect retry loop.

Each feature has a server-derived availability record: `available`, `not_configured`, `requires_setup`, `temporarily_unavailable`, `qualification_pending`, `unsupported`. Keep separate entitlement, configuration, dependency health, qualification scope/status and action eligibility. Display one concise reason and a reviewed next action, plus detail. A valid old record cannot enable a mutation after `fresh_until`. Unknown versions/enums fail closed and display an update-needed state. Qualification pending does not hide valid historical records. A configured public read adapter does not make protected writes available.

Each proposed human mutation takes an idempotency key and exact expected object versions; authority is derived from the authenticated server session. A durable command ledger binds actor/tenant/body digest/target versions and returns `{command_id, status, result_ref}`. Same key/same body returns the existing result; same key/changed body returns conflict. Lost reply means **Request outcome unconfirmed**; query the command ID/key before any resubmission. Accepted/pending/applied/denied are proposed *command* states, never effect states. 202 or 200 cannot independently establish external success.

HTTP semantics proposed: 401 sign-in needed; 403 generic unauthorized; 409 stale/conflicting command; 422 invalid bounded input; 429 rate-limited with retry metadata; 503 unavailable with no inferred effect outcome. Typed detailed reasons are returned only after object authorization. Preserve unsent forms on session expiry, but clear private cached data on logout/account switch. A new session must refresh and require a new explicit approval click; never auto-submit preserved intent. Server sessions use HttpOnly secure cookies, same-origin/CSRF protection, no-store private responses and server-only credentials.

Implemented governance seams in S1/src/identity-api.ts are POST `/grants`, `/approvals`, `/assignments`, `/revoke`, `/renew`. They accept exact keys and return generic 403 on errors; no GET projection, typed browser eligibility or general durable human command ledger exists there. A reviewed BFF must call the first four as a verified human only, preserving independent enrollment/MFA semantics. `/renew` is machine-only and stays inaccessible to browsers. `/dispatch` and `/reconcile` remain trusted internal controller seams. Enrollment/disable, task admission, recovery, takeover fencing, notification and cognition management require additional reviewed contracts; do not implement UI buttons ahead of those.

## 5. Screen and interaction system

Navigator: Work, Projects, Agents, Approvals, Evidence, Recovery, Settings. Computer detail is linked from Agents/Work and a Computers utility entry only when an authorized environment read model is configured. No separate swarm dashboard or portfolio app tiles. Account/workspace menu shows authenticated identity and tenant, and never changes tenant via client-only state.

Focus layout: approximately 208 px navigator, flexible work list and 400–480 px inspector at wide widths. Below 1100 px use a full detail route or closable overlay only if focus behavior remains sound; below 768 px use list then full detail, with Back preserving filters/scroll/selection. These are implementation targets, validated at 320/390/768/1024/1440 px. Do not compress an approval into an unreadable sliver. Readable body type defaults to 16 px; Geist sans with JetBrains Mono only for technical IDs. Existing graphite/paper/lime tokens are the foundation; lime indicates interaction, not verified success. No console glow/CRT or decorative motion. Verify actual contrast instead of inferring it from hex values.

| Screen | Content and allowed interactions | State axes / availability |
|---|---|---|
| Entry/account | Existing sign-in/out; current workspace; session renewal | Authentication is separate from enrollment/readiness |
| Readiness | Ordered prerequisite graph; inspect blocked dependency | Sign-in → tenant → VERA → Computer → workload binding → integration → bounded grant → task → approval → effect → verification; profiles explicitly omit unnecessary compute |
| Work/Focus | Severity groups, tasks, root blockers, results needing review; open/filter/search | Exact affected counts; no Approved task bucket; business/workflow/effect are separate |
| Projects/detail | Same task collection in list; coordination/dependencies/resources | Board read-only until drag transition is reviewed; no speculative archive/edit |
| Task/detail | Goal, bounds, accountable VERA, activity, exact requests, outputs | Recorded task ≠ admitted workflow ≠ completed effect ≠ achieved goal |
| Agents/VERA | Overview, Authority, State, Cognition, Continuity | Stable principal, independent machine/model/Computer references |
| Identity/detail | Enrollment, version, assignments, freshness/renewal metadata | Active, disabled, revoked, expired and renewal-blocked are distinct projected reasons; missing metadata unknown |
| Approvals/detail | Exact immutable action preview, eligibility, expiry; reviewed approve | No reject/cancel/re-propose until command exists |
| Authority/detail | Grants, policy reference/version, epochs, reservations; reviewed create/revoke/assign | Policy lifecycle beyond current schema deferred; no delegation inference |
| Computer/detail | Placement alias, generation, raw lifecycle, isolation qualification, health, checkpoints/fence | Legacy lifecycle commands only after adapter review; no generic recovery button |
| Computer/manual session | Viewing/control holder, start/end/expiry and safe command feedback | Manual human session differs from agent execution; unavailable without durable lease/isolation proof |
| State/context detail | Source/version/digest/quarantine/derivation/admission | Context is data; memory write/import/delete/export controls deferred |
| Cognition/detail | Model binding revision and compatibility | Read-only until mutation/version semantics reviewed |
| Evidence/detail | Linked intent, governance, controller, provider observation, integrity and telemetry | Integrity label is not provider truth; export only with authorized redacted contract |
| Recovery/incident | Original operation, cause, affected work, owner, observations, next trusted check | UNKNOWN never receives retry/resend; manual acknowledgement does not resolve effect |
| Integrations/detail | Exact adapter/action/resource, connection health and qualification | Public immutable read scoped separately from unqualified protected mutation |
| Notifications/detail | In-app unread/ack, delivery attempts, channel status | Delivery accepted/sent/delivered/failed/unknown differs from incident resolution |
| Settings/security/usage | Safe sessions/roles, limits/freshness, billing source links, deployment profile/support | Existing billing reusable independently; charges, estimates and reservations never conflated |

Every page supports loading, empty, partial, stale, offline, unauthorized, session-expired, invalid, degraded, unavailable and unknown-schema states. Empty is justified only by a complete authorized snapshot; partial failure never says “nothing needs attention.” Shared shell navigation, technical disclosure, copy-safe ID, pagination and filters are non-mutating controls covered by the traceability profiles. Hide unauthorized actions; for authorized but unavailable actions show explanation without promotional dead buttons.

## 6. Focus and bounded coordination

R-FOCUS is a deterministic derived attention view, never an authority source. Root grouping uses an authorized causal relation with root object ID + cause code + source version. If causality is only suspected, label related symptoms and do not merge them as one incident. A task blocked by multiple causes remains linked to each cause; totals count distinct tasks. Do not suppress an unrelated urgent condition just because it shares a provider name.

Order by severity, descending affected count, nearest known deadline, oldest cause, stable ID. Missing deadlines sort after known deadlines at the same priority. Freeze order while inspecting/focusing a row. Announce new critical events in a restrained status region and offer Refresh order; never move focus or silently replace the selected approval. Filters, grouping expansion and selection survive route navigation. Incomplete projection displays partial counts.

Work/Projects expose one current accountable VERA, collaborators, dependency edges, waiting-on reason, bounded handoff events, resource locks/reservations and conflicts. Proposed handoff uses expected task version, source owner and explicit target, with durable acceptance before ownership changes. Each operation retains its original accountable principal and grant. A work handoff does not transfer existing approvals or delegate authority. Dependency cycles, cross-tenant references and conflicting owner updates reject. No shared writable filesystem, unchecked recursive delegation or anonymous agent swarm. Handoff management stays unavailable until its domain API is reviewed.

## 7. Exact authority, identity and renewal

Approval content is read-only. Render a typed semantic preview and expandable complete canonical binding: tenant, operation/task/plan version, principal, identity assignment reference, grant/version, epoch/generation/fence, provider/action/resource/params, digest/idempotency reference, cost and deadline. Do not display secret material. Server binds the rendered preview to the digest; raw provider inputs cannot introduce executable HTML. Review long/multiline/Unicode fields without truncating relevant content. A change in bound content requires a new operation, not an edited approved request.

Current owner mutation eligibility requires enrolled human owner, unexpired identity, authenticated MFA and auth_time no older than 300000 ms (future tolerance 5000 ms in source). The UI uses authoritative eligibility/time, not profile email or a client clock. Grant creation is bounded to <=48 h; current approvals <=24 h and additionally bounded by grant expiry and operation deadline. Approve applies only to REQUESTED and current digest/grant/principal/fence. The existing approval row is upserted, so an immutable command ledger/versioned approval history is an integration requirement, not an existing guarantee. Expiry, changed grant version, revocation, principal epoch/generation, assignment/identity or recovery fence can make an approval unusable without erasing its historical decision.

Machine enrollment is separate from human sign-in. Safe identity detail includes enrollment ID/kind/version/active, assigned VERA/operation/digest reference, assignment expiry, observed identity expiry, last successful issuance and effective capability expiry if recorded. Do not infer periodic renewal from last issuance. Per-operation Ed25519 issuance lasts at most 90000 ms, bounded further by verified identity, grant, operation deadline, assignment and required approval expiry; source denies insufficient <=2000 ms remaining lifetime. A machine supplies only the operation ID. Renewal cannot expand scope. Issuance is not admission, and admission is not result verification. Controller checks identity ID/version online at admission and final send. Never send JWTs, refresh tokens, private keys, capability tokens or provider secrets into UI/evidence/telemetry.

Grant revocation commits a version change and denies subsequent admissions under that grant. An in-flight effect can finish afterward. UI says “Grant revoked” only after durable authority observation, and separately lists pending/in-flight/UNKNOWN effects. Policy versions/epochs are shown only when authoritative; there is no policy-version column in current grant schema to invent. Reservation is a budget hold, not spend. Missing usage units remain unspecified; never relabel integer cost as currency without a meter contract.

## 8. Effect and observation truth

Current exact wire states from S1 migration 001: REQUESTED, RESERVED, SENDING, COMMITTED, UNKNOWN, DENIED, FAILED_KNOWN_NO_EFFECT. Legal transitions are REQUESTED → RESERVED/DENIED; RESERVED → SENDING/DENIED/UNKNOWN; SENDING → COMMITTED/UNKNOWN/FAILED_KNOWN_NO_EFFECT; UNKNOWN → COMMITTED. No other operation transition is exposed. Approval-needed and reconciliation-running are separate read-model axes, not new effect enums.

| Wire state | Human label | Permitted interpretation |
|---|---|---|
| REQUESTED | Requested | Immutable proposal recorded; may still need approval/assignment |
| RESERVED | Budget reserved | Admission progress; no verified provider result |
| SENDING | Sending / awaiting observation | Possible external activity; no success inference |
| COMMITTED | Verified read/result, per adapter | Supported authoritative observation satisfied; not blanket business completion |
| UNKNOWN | Outcome unconfirmed | May have reached provider; no resend action |
| DENIED | Admission denied | No new admitted send under this rejected admission |
| FAILED_KNOWN_NO_EFFECT | Failed — no effect confirmed | Only backed by supported authoritative no-effect contract |

Pinned GitHub read is exactly Adaptive-Liquidity/Continuum commit 9ac4723b5390d22ed2d6aed9cf984cb0a32731ca, tree dcd778fa3a539de0132c2a7ec32c36aaf876f94d. First Git commit read and second repository-commit read-back must match. COMMITTED can mean the fresh verifier completed the intended immutable read after timeout; it does not prove the first read arrived or any write occurred. Arbitrary URLs, redirects and action/resource overrides are unsupported. Protected mutation verification, stale provider mutation idempotency windows and post-revocation recovery observation remain unresolved.

Evidence detail visually separates proposal, governance/admission event, controller operation, provider observation, derived integrity package and logs/traces. Show verifier contract/version, observed selector, observation time, source endpoint category and match result. Hash/receipt validity gets a separate integrity label. Missing/mismatched/unavailable provider observation stays unconfirmed. Logs and narration can explain but never change effect state. Evidence export must preserve tenant permission, redaction, completeness and provenance; pending contract means no export button.

## 9. Computer, recovery and manual control

Preserve all raw ComputerState values: requested, provisioning, ready, running, paused, stopped, waking, checkpointing, recovering, restore_failed, recovery_failed, cleanup_needed, error, deleting, deleted. Friendly summaries must retain the specific condition in list/detail and accessible name. Unknown future states display unavailable controls. Checkpoint status separately preserves pending, ready, failed, restoring, restored. Job status is a third axis. Neither checkpoint readiness nor provider health proves recovery complete.

Computer detail includes stable logical ID, safe placement alias/provider class, actual placement generation, bound VERA/workload identities, lifecycle, last authoritative health, checkpoint/artifact revision/digest/provenance, rebuild confirmation requirement, recovery note, admission fence and old-generation fenced status. Never synthesize generation from legacy workspaceRevision. Raw provider refs/endpoints remain operator-only; normal console gets a redacted alias. Provider capabilities are mechanism descriptions, not isolation qualification. Destroy/recover remain operator seams unless specifically reviewed for humans; no invented isolate/resume/cleanup/restore controls.

Manual takeover requires a durable lease bound to human/tenant/Computer/placement generation, online expiry/revocation, exclusive execution-mode fencing and audited start/end. Current legacy desktop route rotates view/control tokens and records activity but does not establish this complete boundary. Missing session rows currently accept HMAC+owner session; the final console must fail closed on missing lease/state store. Privileged browser cookies/CDP cannot share reachability with untrusted shell. Human manual input is labelled manual and does not become an autonomous verified operation.

Take control presents exact Computer/mode/scope; success requires observed lease and execution fence. Hand back ends manual lease; do not say “Agent resumed” until separate authorized progression is observed. Disconnect/tab close is best effort; server lease expiry is authoritative. Handle multi-tab contention, revoked session, generation change, stale frame and failed action results explicitly. Screenshot viewport has last-observed time and stale overlay; no screenshot persistence by default. Remote keyboard capture occurs only in an explicitly focused control surface, with a documented escape chord to local controls; never hijack global Tab/Escape.

Recovery detail retains original operation ID and all attempts/observations, owner, root cause, next trusted observation, blocked dependency and outstanding obligations. Acknowledgement is administrative, not resolution. Computer recovery requires new placement generation, verified artifact restore and old placement fencing before new admission; database restore also requires recovery fence and reconciliation of the backup window. Neither browser reload nor UI “Resume” clears a fence. Revoked authority must never be reinstated just to observe UNKNOWN. Show “Observation unavailable” until the independent authorized observation path exists.

## 10. Notifications, usage, data and accessibility

Incident lifecycle and notification delivery are proposed independent read models. Incident open/acknowledged/resolved status requires recorded owner and resolution basis. Notification queued/accepted/sent/delivered/failed/unknown/read status cannot resolve an incident. Group duplicate causes by durable incident+version, retain affected tasks and channel attempts, use idempotent outbox/inbox delivery, backoff and retry caps. Channel test/retry/preferences need reviewed commands; no email/Slack message is sent as part of this spec. Critical in-app notice remains visible when external delivery fails.

Usage displays meter source, unit, period, observed_at/fresh_until, measured spend, estimate, reservations, quota, concurrency/storage limits and enforcement reason independently. Stale meter is not free balance. Billing uses existing provider-derived invoices/subscription state; entitlements never substitute for grants. Cancellation/plan change remain existing reviewed commercial workflows and do not promise a global stop of in-flight effects. Deployment/data profile exposes actual residency, custody, retention and tested RPO/RTO only; no sovereignty/HA badge without qualification.

Accessibility target is WCAG 2.2 AA, with automated checks plus actual keyboard/screen-reader review. Landmarks, skip link, semantic headings/tables/lists, labelled controls, focus-visible and non-color status are required. Dialog focus is trapped/restored and confirmation cannot be default-triggered by Enter in another field. Exact approval content remains reviewable at 200% text enlargement and 400% zoom/320 CSS px reflow. Long IDs wrap or use a clearly labelled technical scroller; never horizontally scroll the whole approval. Targets aim for 44 px with at least WCAG minimum target spacing. Screen-reader announcements are restrained; new severity does not steal focus. Reduced-motion removes nonessential transitions/auto-scrolling. Pointer/manual-computer actions need usable keyboard equivalents and local escape; inaccessible provider UI is an explicit limitation, not solved by screenshot alt text.

Mobile sticky actions must not obscure focused content or the final approval fields. Do not approve on swipe, drag or single-key shortcut. Offline mutation is unavailable; cached data has a stale timestamp. Reconnect revalidates all eligibility. Locale/timezone formatting includes absolute expiry and server-derived relative time; minute rounding never extends lifetime. Availability labels have text and icons; contrast for text, borders and focus rings is measured in implemented rendering.

## 11. Gate and acceptance rule

The gate table in CONTINUUM-UI-GAP-REGISTER.md copies exact S1 production statuses. Production remains BLOCKED; scheduler HELD; canary NO-GO. All new UI acceptance tests in the traceability document are NOT RUN until implementation. Document validation can PASS independently, never promote production qualification. Runnable staging browser/accessibility/E2E evidence is NOT RUN: no authenticated console staging URL/configuration is available to this run.

Allowed path: authorized read → exact REQUESTED operation → fresh enrolled owner MFA approval → independently assigned machine → bounded per-operation renewal → controller online admission/final-send checks → supported provider observation → adapter-specific verified result.

Denied path: changed digest/stale owner/disabled identity/version/fence → server denial → retained original proposal and reason → no browser dispatch or optimistic success.

Unresolved counterexample: an effect may have been sent before revocation, then verifier access is lost. The current source lacks separately authorized post-revocation observation. UI must retain UNKNOWN with an owner and unavailable observation reason indefinitely; neither a fresh approval, model claim, valid chain nor a new provider executor can resolve it.

Implementation workflow approval is distinct from tool authorization. The user approved tools/resources; the concrete specification and plan still require review under the invoked Superpowers workflow and the requested deliverable sequence before frontend changes. No frontend, external deployment or production gate was changed in this reconciliation run.
