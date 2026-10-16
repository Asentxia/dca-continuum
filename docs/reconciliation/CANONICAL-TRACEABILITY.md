# Updated 40-contract traceability

Later scoped implementations and remaining work are tracked in
`../plan/CURRENT-PLAN.md`. The rows below preserve their original evidence scope;
they are not a fresh audit of every latest-main interaction or a production approval.

Source catalogue is preserved without silently changing acceptance. PASS below means the **named local subset**, not live qualification or every future extension. PARTIAL is not PASS. Disabled controls never stand in for an implemented full feature.

| Contract | Product classification | Local acceptance | Delivered scope / limitation |
|---|---|---|---|
| T-01 — Account sign-in/out; workspace selection | CONFIGURATION REQUIRED | PARTIAL | AuthKit server bridge and signed local/test sessions; live sign-in/MFA/workspace enrollment not exercised. |
| T-02 — Readiness prerequisite detail | READ-ONLY | PASS | Dependency-aware readiness and exact qualification limitations. |
| T-03 — Work Focus select/filter/search/expand | IMPLEMENTED + TESTED | PASS | Backend causal grouping, deterministic order, scoped search and incomplete-snapshot disclosure. |
| T-04 — Focus refresh order/new critical notice | IMPLEMENTED + TESTED | PASS | Frozen selection/order and accessible new-attention announcement; explicit reorder. |
| T-05 — Task list/detail/activity/output links | READ-ONLY | PASS | Durable work/task detail and operation links; effects never prove a business goal. Full artifact-download UI is deferred. |
| T-06 — New task form | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | Fixture task creation, atomic command idempotency and one lookup after lost response; never starts a workflow/effect. |
| T-07 — Projects list/detail/resources | READ-ONLY | PASS | Tenant-scoped projects reference the same durable task IDs. Project create/edit/archive UI deliberately absent. |
| T-08 — Coordination/dependency inspector | READ-ONLY | PARTIAL | Responsible VERA and dependency edges; internal cycle/CAS tests pass. Resource-conflict orchestration and dependency mutation UI are not implemented. |
| T-09 — Handoff management | DEFERRED / UNAVAILABLE | PARTIAL | Bounded internal handoff offer/accept CAS is tested; no primary handoff command/control. Old operation/grant authority is not transferred. |
| T-10 — VERA overview/continuity/history | READ-ONLY | PASS | Durable VERA distinct from human, machine, model and Computer; versioned cognition metadata does not change principal identity. |
| T-11 — Workload identity enrollment detail | READ-ONLY | PARTIAL | Independent enrolled identity metadata and no browser credentials. Real issuer/workload enrollment remains P1 PARTIAL. |
| T-12 — Identity assignment form/detail | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | Exact same-principal machine assignment through durable human ledger; assignment is not approval or issuance. |
| T-13 — Renewal freshness status | READ-ONLY | PARTIAL | <=90-second capability contract and fresh fixture renewal tested; unobserved issuance remains unknown. Real renewable workload/24-hour tests NOT RUN. |
| T-14 — Cognition/model binding detail | READ-ONLY | PARTIAL | Versioned model-binding registry and stable VERA tested. Live model replacement/configuration command and semantic compatibility are unavailable. |
| T-15 — Context/state provenance detail | READ-ONLY | PARTIAL | Structured context/provenance/version/quarantine and artifact services tested. Full semantic/vector memory and primary context mutations unavailable. |
| T-16 — Approval queue/exact preview/technical disclosure | READ-ONLY | PASS | Complete immutable preview, long Unicode parameters, inert markup and technical binding disclosure. |
| T-17 — Approve exact action | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | Fresh owner/MFA, exact digest/version, append-only history and atomic receipt; independent fixture worker later dispatches/verifies. |
| T-18 — Approval invalidation/expiry status | READ-ONLY | PASS | Expired/stale decisions retained; monotonic elapsed freshness, server CAS and no automatic reapproval. |
| T-19 — Grant detail/policy/limits/reservations | READ-ONLY | PASS | Exact scoped grants/reservations; missing policy version and measured spend labelled unknown. |
| T-20 — Create bounded grant | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | Bounded grant form and strict exact-selector/server cost/expiry constraints; no assignment/approval/effect implied. |
| T-21 — Revoke grant | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | CAS revocation, durable lookup and honest in-flight semantics; local races/final-send checks retained. |
| T-22 — Operation lifecycle detail | READ-ONLY | PASS | Seven wire states, strict runtime validation and supported matching provider observation; no UNKNOWN retry. |
| T-23 — Pinned GitHub read observation | READ-ONLY | PASS | Six fresh fixed, unauthenticated GitHub public-read cases. Verified intended read does not prove original request arrival or a protected mutation. |
| T-24 — Evidence filters/pagination/detail | READ-ONLY | PARTIAL | Authorized cursor/search/event detail and operation links; chain != external truth. Complete six-level navigable evidence graph remains partial. |
| T-25 — Evidence export | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | Audited/redacted selected-page export <=60 events with completeness/source/integrity limitations; not a full archive. |
| T-26 — Computer list/detail/raw lifecycle | READ-ONLY | PASS | All 15 provider raw states distinct; domain lifecycle, placement generation and freshness separate; future raw state not synthesized as stopped. |
| T-27 — Computer pause/resume/restart/wake | DEFERRED / UNAVAILABLE | NOT RUN | Primary lifecycle controls absent pending managed environment/qualification; existing local lifecycle services remain implemented/tested separately. |
| T-28 — Checkpoint/recovery/fence inspector | READ-ONLY | PARTIAL | Artifact manifests/checkpoint/fence metadata and local reconstruction/DR tested. Managed host loss/physical fence remains NOT RUN. |
| T-29 — Manual session view/frame/viewport | DEFERRED / UNAVAILABLE | NOT RUN | No managed screen/frame/viewport service exposed; no screenshot/input credential path in the production console. |
| T-30 — Manual take control/hand back/input | DEFERRED / UNAVAILABLE | PARTIAL | Fixture-only durable exclusive lease/fencing/hand-back foundation tested; actual managed input, privilege isolation and control UI unavailable. |
| T-31 — Recovery UNKNOWN detail/observation status | READ-ONLY | PASS | Owned original UNKNOWN, observation and unavailable reason remain visible after revocation; no browser reconcile/regrant/resend. |
| T-32 — Incident acknowledgement/ownership | IMPLEMENTED + LIVE QUALIFICATION PENDING | PASS | Versioned durable acknowledgement; never incident resolution or effect success. |
| T-33 — Integrations detail/setup status | READ-ONLY | PARTIAL | Exact adapter/resource and readiness metadata. Live connection/OAuth/credential health integration requires approved configuration. |
| T-34 — Notifications inbox/delivery detail/preferences | IMPLEMENTED + TESTED | PARTIAL | Durable deduplicated in-app records and mark-read separate from incident resolution. External delivery and preferences unavailable. |
| T-35 — Usage/budget/limit detail | READ-ONLY | PASS | Enforced reservation counters/test units, unknown money/estimate and external meter freshness; no fabricated telemetry. |
| T-36 — Billing portal/account terms | CONFIGURATION REQUIRED | NOT RUN | No billing provider/portal or purchase commands copied. Billing terms/catalogue require separate approved integration; no pricing changes. |
| T-37 — Deployment/data/support/maturity | READ-ONLY | PASS | Exact deployment/gate/maturity limitations; no scheduler/HA/security-certification toggle. |
| T-38 — Shared navigation/back/disclosure/copy/pagination | IMPLEMENTED + TESTED | PARTIAL | Shared URL selection/search, mobile list/detail, safe-ID copy and scoped pagination. Full back/scroll restoration across all routes not independently audited. |
| T-39 — Shared stale/offline/error/unknown-schema states | IMPLEMENTED + TESTED | PASS | Late/out-of-order reads, offline/reconnect, schema/receipt failures and identity switch fail closed; commands never automatically replay. |
| T-40 — Shared mobile/zoom/keyboard/reduced-motion states | IMPLEMENTED + TESTED | PARTIAL | Axe/keyboard/focus/reflow/text enlargement/reduced-motion evidence. Native screen-reader and browser-chrome zoom review NOT RUN; no WCAG certification claim. |

Exact source/code/evidence mappings: `CANONICAL-TRACEABILITY.json`. All live interaction profiles are NOT RUN; actual public immutable read is separately identified. Native assistive-technology testing, protected provider mutation, commercial billing and managed manual control are not inferred from this profile.
