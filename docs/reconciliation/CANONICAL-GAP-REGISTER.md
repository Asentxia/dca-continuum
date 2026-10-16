# Updated gap register

This register contains the qualification snapshot described below. For subsequent
merged work, remaining requirements and scoped owner decisions, read
`../plan/CURRENT-PLAN.md` and `../plan/OWNER-DECISIONS.md`. Do not interpret an older
PASS/PARTIAL row as a new whole-product audit or a live gate promotion.

The historical register is retained in `docs/interface-source`. This register revises it once against the newer implemented baseline and current canonical build. PASS applies only to named source/local gaps. Production gates remain unchanged.

| Gap | Status | Current disposition |
|---|---|---|
| G01 | PASS | Identity labels and independent bindings implemented; live claim semantics still P1 PARTIAL. |
| G02 | PASS | Trusted human reads/BFF, CSRF, current enrollment, freshness and command lookup implemented/tested locally. |
| G03 | PASS | Atomic command ledger, immutable decision history and expected approval revision implemented. |
| G04 | PARTIAL | Safe workload metadata and fresh reference-only renewal tested; real platform identity not exercised. |
| G05 | PARTIAL | A already supplies recovery-only observation seams; UI owned UNKNOWN/source truth integrated. Protected remote observation after revoke unqualified. |
| G06 | PASS | New raw-state/domain-state projection replaces legacy collapsing; exhaustive 15-state test. |
| G07 | PARTIAL | Explicit generation/placement alias, no workspaceRevision synthesis; physical old-host fence still NOT RUN. |
| G08 | PARTIAL | Fixture-only durable lease/fail-closed foundation; no managed desktop input/frame service exposed. |
| G09 | PARTIAL | Exclusive mode/epoch fence and PAUSED hand-back tested; managed credential/browser isolation NOT RUN. |
| G10 | PASS | Server feature maturity/eligibility separates local availability from live qualification. |
| G11 | PARTIAL | Project/task registry, dependencies and handoff CAS tested; primary mutating project/handoff/resource-conflict coordination unavailable. |
| G12 | PASS | Deterministic authorized causal grouping, distinct counts, frozen order and accessible arrival notice tested. |
| G13 | PARTIAL | Scoped evidence pagination/search/redacted selected export tested; full graph navigation/archive remains partial. |
| G14 | PARTIAL | Newer A structured context/artifact services integrated/read-only; semantic/vector pipeline and complete retention qualification deferred. |
| G15 | PARTIAL | Durable incidents/in-app dedup, ack/read separation tested; channel preferences and external delivery unavailable. |
| G16 | PARTIAL | Actual reservations/test-unit limits shown; real token/money/billing freshness not qualified. |
| G17 | PARTIAL | Fresh production-build Chromium/axe/keyboard/reflow evidence; native screen-reader/manual zoom independent review NOT RUN. |
| G18 | PASS | Exact attached source packets pinned/verified; no substitution with older routing files. |
| G19 | NOT RUN | General delegation/policy/model-change/procedures/compensation/commercial controls explicitly unavailable, not fabricated. |
| G20 | NOT RUN | No Superdesign canvas/telemetry integration needed or retried; approved source direction implemented directly. |
