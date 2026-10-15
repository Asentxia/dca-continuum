# NEXUS local validation record

Base: `da1d5f45545078a085910c43f87ac5899b29e422`, exact tree
`dc25bacb7625a4c889eadb36cbdb8e47ea33c3c6`. Isolated branch `sprint/nexus-local`.
No remote push/merge, provider call, donor service, DB test/reset, paid resource,
global toolchain change or release-ledger edit. Rust 1.94.0 was installed in an
isolated user-owned location; pinned components and Cargo registry setup were
explicit separate network-capable setup, not runtime/build auto-downloads.

## Historical initial implementation (superseded dependency security state)

The checks below describe initial commit `02d7d9949f33eaf26474ce0d60e8075f028d5adf`.
Its donor-matching 45.0.3 dependency was later found to have seven RustSec records.
It is superseded by the patched LTS remediation, not relabeled as clean evidence.

## Executed initial focused checks

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

## Patched runtime remediation validation

`NEXUS-SECURITY-REMEDIATION.md` and full before/after audit artifacts record the
explicit 45.0.3 -> 36.0.18 supported-patched-LTS downgrade with donor source unchanged.
Updated closure is 104 registry dependencies + bridge = 105 lockfile packages.
Pinned Rust 1.94.0, actual runtime/adapter source, bounds, ABI and tests unchanged.

- Explicit offline locked native build passed on patched Wasmtime 36.0.18.
- Patched focused suite passed **7 native + 11 ingress + 10 original recording tests**.
- All six pinned WAT->WASM fixtures matched byte-for-byte; actual computation still
  returns 5050 with measured fuel; real denials/timeouts/resource limits pass.
- Source/prebuilt executable hash binding and donor provenance passed. All 154
  full license/notice text bodies and associations passed checksum verification.
- Cargo-audit 0.22.2, no-fetch, no target/severity/advisory filters, deny warnings:
  **exit 0; zero vulnerabilities; zero warnings** against exact DB commit
  `edb58f5974b83eb8302332821cb6d389777aa351`. Before/after commit, git tree and tracked
  file-content tree hashes match and DB is clean. Null raw no-fetch tool metadata
  is retained honestly and bound by the separate scan provenance record.

This is snapshot reproduction of that reviewed DB, not a future/latest security
policy gate or native-engine escape guarantee. Coordinator must rerun canonical
verification on its final integrated dependency/source; old pre-remediation main
canonical evidence is not reused as final patched evidence here. Public
redistribution HELD; production BLOCKED; scheduler HELD; canary NO-GO.
