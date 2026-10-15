# NEXUS local validation record

Base: `da1d5f45545078a085910c43f87ac5899b29e422`, exact tree
`dc25bacb7625a4c889eadb36cbdb8e47ea33c3c6`. Isolated branch `sprint/nexus-local`.
No remote push/merge, provider call, donor service, DB test/reset, paid resource,
global toolchain change or release-ledger edit. Rust 1.94.0 was installed in an
isolated user-owned location; pinned components and Cargo registry setup were
explicit separate network-capable setup, not runtime/build auto-downloads.

## Executed focused checks

- Explicit `bash tools/nexus-build.sh`: passed, offline and locked, sanitized build
  environment. Prebuilt runtime/source SHA256 binding recorded and verified.
- `bash tools/nexus-test.sh`: **7 native tests + 21 Node tests passed** (11 new
  ingress groups and 10 unchanged opaque recording-contract groups). No skips.
- Actual donor-derived WASM execution computes the sum 1…100 as **5050**, with
  positive measured fuel. Real trap/fuel/memory/import/start/epoch cases exercise
  the compiled native runtime, not stubs or simulated successes.
- Compiled six WAT fixtures with the pinned test parser; all committed WASM bytes
  compare exactly. Native-host limits/environment probe and adversarial protocol
  helpers are explicitly distinct from real WASM-execution tests.
- `python3 tools/nexus-verify-provenance.py <detached donor>`: passed, exact donor
  commit/tree/blob/SHA256 checks, two donor-derived artifacts and 103 pinned registry
  packages in the reviewed native dependency closure. MIT notice retained verbatim.
- Root TypeScript build and `node tools/build-product.mjs`: passed.
- Existing service-free fixture/product-backend boundary selection: **9 passed**.
- Original recording helper/tests, operation-binding implementation, provider port,
  frozen M1/recovery and v2/v3/v4 extensions and gate bytes matched the exact base.
- Release and qualification enforcement each returned **1**, as required while
  production stays BLOCKED, scheduler HELD and canary NO-GO.

Final focused-suite fingerprint under `.artifacts/nexus/source-fingerprint.json`
includes native bridge/lock/example, vendor adaptation/notice, adapter, all fixture
and test bytes, tools and audit docs. Generated native targets are excluded.
Native build provenance separately binds the exact prebuilt executable SHA256 to
its source inputs; tests refuse a stale/mismatched prebuilt binary. A source
fingerprint is evidence identification, not independent security qualification.

## Honest gaps and excluded work

A broader optional product-isolation invocation passed nine checks but its two
frontend service tests did not start: the isolated worktree lacked the required
approved Node22/frontend-build environment. The successful service-free selection
above is not a replacement claim for those tests. Full canonical DB/HA/browser
validation and canonical machine-enrollment end-to-end composition belong to the
coordinator and were **NOT RUN here**. No shared database/service was modified.

Canonical authorization is a **required injected host composition**, not a newly
implemented canonical identity service: verifier derives subject/tenant; current
policy callback binds exact computation/module digest and denies changed enrollment
or policy/outage before each spawn. Local JWT tests demonstrate this ingress,
forgery/cross-tenant rejection and revocation-hook behavior; they do not claim real
VERA enrollment, database revocation qualification or a new permission authority.

No snapshot/fork/rollback support or resumed execution; all requested forks deny.
No WASI, native guest-code execution, filesystem/application workspace, management
server, general arguments/output ABI, controller wiring or product UI. No current
vulnerability-database clearance or native-engine escape certification; separate
application workspace/managed-host/network containment remains unqualified.
Public redistribution is HELD despite local MIT-source reuse clearance. No new
product license was selected; native package is `publish = false` with no license
chosen for newly authored product code. No live gate moves from these local checks.
