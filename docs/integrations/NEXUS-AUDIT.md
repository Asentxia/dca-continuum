# NEXUS pre-reuse local audit

Disposition: restricted LOCAL implementation cleared for the inventory below.
Public redistribution remains HELD. No product license or visibility change.
Review performed before implementation source extraction on 2026-10-15.

## Exact provenance and licensing

Donor `Adaptive-Liquidity/Nexus-temp`, commit
`e1c3d3c75d58f609c617e7a87cb05e84ea437d64`, tree
`48a32cb08647abf301a069bc966968215453147e`, both verified in a detached audit
checkout. Matches the earlier NEXUS-PIN-PROVENANCE record supplied for this task.
`LICENSE` is MIT, copyright (c) 2026 Adaptive-Liquidity. Retain verbatim notice.
No per-file alternate license was found in the selected runtime source.
`NEXUS-PROVENANCE.json` records original blob/SHA256 identifiers and exact scope.
Only `LICENSE` and adapted portions of `src/sandbox/wasm_runtime.rs` may enter
`vendor/nexus`. Cargo.toml and Cargo.lock are audit-only donor inputs, not copied
or used to build the broad donor package. No server/proxy/daemon/WASI source copied.

## File-level security disposition

- Runtime config lines 384–404: retain fuel/epoch metering. Reject donor default
  WASI-enabled config; construct an explicitly import-free, smaller bounded engine.
- Pure execution lines 776–817 and 924–949: retain Store/limiter, set_fuel, empty
  Linker, real instantiate/call/get_fuel path. Imports rejected even before
  instantiation. No hooks, credentials, providers, filesystem mounts or host calls.
  No `_start` fallback: exact export, explicit `() -> i32` ABI, numeric output only.
- Store state lines 1026–1043: retain StoreLimits memory ceiling; strengthen table,
  instance, memory-count and failed-growth bounds. Reject shared/memory64/multiple
  memories. Also cap native stack, process address space and CPU.
- Omit snapshots/restoration, globals/tables serialization, diagnostics, adaptive
  budgets, cache, hypervisor, telemetry, async/WASI, public binaries and all recovery
  policies. Donor snapshots do not support full stack/table restore. Fork/rollback
  unsupported, not simulated. Fresh store/process per invocation only.
- Donor compilation precedes its worker timeout and a worker can outlive join grace.
  Adaptation uses a parent kill-and-reap deadline covering compilation and execution,
  an epoch deadline for execution, plus Linux prlimit. No success on timeout or
  ambiguous/native failure. Output and ingress have fixed byte ceilings.

## Dependency review before reuse

Initial donor-matching dependency 45.0.3 was explicitly downgraded after the
seven-advisory scan; see `NEXUS-SECURITY-REMEDIATION.md`. Current minimal independent
manifest: Wasmtime exactly **36.0.18** (supported patched LTS; donor source pin unchanged), default-features=false, only cranelift/runtime/std; serde 1.0.228,
serde_json 1.0.149; WAT test parser 1.245.1. Rust 1.94.0 isolated install,
MSRV for Wasmtime 36.0.18 is 1.86.0. Full registry closure pinned with checksums in the new
Cargo.lock; no git dependencies and no donor optional dependency/server feature.
`NEXUS-PROVENANCE.json` inventories all 104 registry packages, their licenses,
license-file hashes and build-script hashes (105 packages including the bridge).

Declared licenses: MIT/Apache alternatives, Apache with LLVM exception,
Zlib (foldhash), optional BSD/Unlicense alternatives, Unicode-3.0 conjunction
(unicode-ident). None declares copyleft or a noncommercial restriction. Some
Bytecode Alliance crate archives omit root license texts; their manifest SPDX
expression and source headers identify licensing, with matching license texts
retained from the sibling wasmtime/wasmparser package. Unicode license is retained
separately. Notices are not a certification of redistribution completeness.

The 31 build scripts were screened for process/network/filesystem behavior.
Observed: Rust compiler/version/feature probes; Cranelift code/assembler/ISLE
source generation under OUT_DIR; Cranelift git rev-parse HEAD metadata probe;
cc compilation of Wasmtime runtime helpers (fiber Windows C and debug helper
branches not active on this Linux profile); target/platform probes and Windows-only
local link-search directives. No download,
HTTP client, socket or credential-fetch action in reviewed build scripts. Build
is explicit, uses locked/offline Cargo after a separate dependency fetch; runtime
never invokes Cargo, shell, registry, server or provider. Build tools remain
trusted native supply-chain inputs, not sandboxed guest execution.

Limitations: this is a targeted integration/dependency-license/build-surface
review, not a full security audit of all transitive compiler/runtime code. Point-in-time full unfiltered RustSec scan is clean against DB
`edb58f5974b83eb8302332821cb6d389777aa351`; this is not native-engine escape
certification, a guarantee against future advisories, hostile multi-tenant service
qualification or production release approval.
Native engine bugs remain a risk: separate application workspace isolation and
Effect Controller authority are unchanged and independently required. Local
results create no grant, approval, capability, admitted fact or external success.
Production BLOCKED; scheduler HELD; canary NO-GO.
