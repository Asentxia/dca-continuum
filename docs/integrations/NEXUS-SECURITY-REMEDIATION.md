# NEXUS runtime security remediation — 2026-10-15

Decision: explicitly **downgrade** inherited runtime dependency Wasmtime 45.0.3 to
exact **36.0.18**, the supported patched LTS line. This is not a version upgrade,
not a donor source repin, and not permission to run the public donor package.
Original donor commit/tree/source hashes and MIT notice remain unchanged.

## Seven findings, no suppression

Complete original findings, affected package records, patched/unaffected ranges
and original scan/database settings are retained in `NEXUS-RUSTSEC-BEFORE.json`.
Database commit `edb58f5974b83eb8302332821cb6d389777aa351` (1329 advisories), updated
2026-10-14, supplied by coordinator. Original scan reported seven vulnerabilities.

| RustSec | Finding | Restricted profile exposure assessment | 36.0.18 resolution |
|---|---|---|---|
| RUSTSEC-2026-0222 | Stores can mix up type indices between engines | One fresh engine/store per process; no cross-engine object exchange or cached compiled module API. Known cross-engine path is not exposed, but this was not grounds to ignore the finding. | Patched >=36.0.13,<37 |
| RUSTSEC-2026-0269 | Filesystem sandbox escape with trailing slash paths/symlinks | WASI and filesystem host imports absent; every import denied before instantiation; no preopens, guest paths or host path resolution. Known filesystem path is excluded. | Patched >=36.0.14,<37 |
| RUSTSEC-2026-0316 | Dynamic record lifting exceeds hostcall fuel allocation limit | Component-model dynamic lifting/hostcalls not enabled or exposed. The pure core-WASM numeric ABI has no such hostcall surface. | Patched >=36.0.16,<37 |
| RUSTSEC-2026-0327 | Component async-lifted callback result count causes native stack overflow | Component-model/async callbacks disabled. Not treated as an advisory waiver. | RustSec declares <39 unaffected |
| RUSTSEC-2026-0359 | Stack overflow dropping recursive type chain | No component-model/GC features or host type-construction API exposed. Type/compiler/drop resource risk was still conservatively considered; no exploit non-reachability certification is claimed. | RustSec declares <42 unaffected |
| RUSTSEC-2026-0362 | Async-entrypoint requirement not enforced | Async/component-model entrypoints absent; exact synchronous core export ()->i32 only. | RustSec declares <42 unaffected |
| RUSTSEC-2026-0363 | Component handle tables capped per instance but uncharged | Component resources/handle-table API absent. | Patched >=36.0.18,<37 |

Exposure assessments describe the existing profile, **not** filters, ignores or
exceptions in the scan. The entire lockfile is scanned without target, severity,
feature or advisory suppression. Upstream GHSA API descriptions returned 404 during
this review; no extra exploit/PoC claims are inferred from unavailable descriptions.
Full local RustSec records and their authoritative version ranges were inspected.

## Why this release and toolchain

The minimum patched release on the supported 36 LTS line satisfying all seven
records is 36.0.18: four fixes and three explicit unaffected ranges. 24.0.13 does
not satisfy the newer records and is not the chosen supported LTS. 48.0.6 and 49.0.3
also satisfy the ranges but require Rust 1.95.0 and 1.96.0 respectively; no toolchain
change is necessary for 36.0.18 (declared MSRV 1.86.0, built with pinned 1.94.0).

Wasmtime release policy supports multiples-of-12 LTS branches for 24 months and
ordinary releases for two months, with security backports to supported branches:
https://github.com/bytecodealliance/wasmtime/blob/main/docs/stability-release.md .
Crates.io records 36.0.0 released **2025-08-20**, so the 24-month policy supports
this branch through **2027-08-20**; it is supported on the review date. Registry package
metadata marks 36.0.18 non-yanked, Apache-2.0 WITH LLVM-exception, checksum
`70095b9fe63cc2a87ed206729e11544610decc184c62898c5d201ff1d666d82e`.

## Dependency/file review before applying the new lock

Resolved an isolated audit manifest first, before changing the executable package.
Cargo-audit reports **105 total lockfile packages = 104 registry dependencies +
the one local bridge**, not 105 third-party packages.
Reviewed new closure: 104 registry packages, 46 changed/new name-version pairs
relative to the initial inventory, 154 root license/notice files, 31 build scripts
including eight Windows target-link-search scripts inactive on this Linux target.
All packages are checksum-pinned registry sources; no git dependency, broad donor
manifest, WASI/server/HTTP dependency, component model or async feature added.

Licenses remain the reviewed permissive MIT/Apache/LLVM-exception/Zlib alternatives,
with the unicode-ident Unicode-3.0 conjunction retained. No copyleft or commercial
restriction declared. Updated per-package registry checksums, source/license and
build-script hashes are in `NEXUS-PROVENANCE.json`; notices regenerated from exactly
this closure. All 154 complete root license/notice bodies were compared with
source archives; normalization changes only line endings/edge whitespace. Their
normalized text hashes and package associations are checked by the provenance
verifier, not replaced with SPDX links or package names. The aggregate remains
a full multi-thousand-line notice bundle. Missing root license texts in some Bytecode Alliance archives remain
identified by SPDX/source headers, with corresponding sibling license texts retained.
Public redistribution remains HELD; no product licensing decision changed.

Build behavior remains Rust/target/feature probing, Cranelift source generation,
metadata git rev-parse and trusted local C helpers; Windows-only packages emit local
link-search paths. No network downloader/socket/credential action found in reviewed
build scripts. Config APIs for fuel/epoch, memory reservation/guard/growth, stack,
memory64 and multi-memory exist unchanged; runtime implementation/bounds/tests
are not relaxed or replaced. Build/test commands remain explicitly offline+locked,
with sanitized build env and prebuilt executable/source hash binding. Donor server,
WASI, snapshots, network/filesystem guest capabilities and effect authority stay absent.
