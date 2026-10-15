# Offline E2 / NEXUS / AEON implementation

This is an isolated development implementation, not a production release, live
identity deployment or real-model autonomy demonstration. Production BLOCKED;
scheduler HELD; canary NO-GO. Public source/distribution and merge remain held
for the owner's exact publication clearance and final independent audit.

## Actual capabilities and limits

- E2 authenticates the new admission and owner-review interfaces using the existing
  configured verifiers. Private runtime actor-object guards and opaque server-owned
  observation handles reject serialized/structural impersonation. Source eligibility,
  tenant/VERA scope, expiry, corruption and lock-wait freshness are checked in PostgreSQL.
  Exactly one fixed-protocol result/receipt per scoped source is admitted atomically
  with content-free evidence. It is PRIVATE, quarantined and UNVERIFIED. No release,
  sharing, grant, external execution or ordinary-ingest refresh is enabled.
- Source replacement/erasure/expiry and result withdrawal deny stale content and
  terminal replay; current R1 remains cache-free and resolves all references through
  ContextService. A revoked reader is denied, not permission to erase another owner's
  legitimate data. Checks serialize at server validation points, not continuous
  recall of bytes already delivered. E2 results are not normal recall hits while
  quarantined. Exact authorized inert inspection is an internal owner interface,
  not a newly enabled Focus Desk/HTTP route. Generic console projections suppress
  E2 context records and redact receipt metadata.
- NEXUS runs actual pinned donor-derived Wasmtime logic through a minimal native
  bridge. The opt-in local profile accepts a trusted tenant-scoped module registry,
  fresh host credential/enrollment/policy callbacks and exact import-free `() -> i32`
  exports. It meters fuel/memory/tables and enforces native CPU/address-space/output
  bounds and parent kill-and-reap deadline. No WASI, guest host calls, network,
  filesystem mounts, credentials or effect authority are provided. Fork/snapshot/
  rollback are explicitly unsupported. This is not a full Computer or an audited
  hostile-multi-tenant native service; runtime/compiler escape risks remain.
- AEON executes the exact unchanged pinned `augment_scores` function in a std-only
  native numeric bridge. Request-local graph-weight/ordinal shims are explicit;
  no donor PostgreSQL, embedding store, persistent graph or public server is enabled.
  Ranking only orders candidate references; current R1/ContextService makes eligibility
  decisions. E2 candidate admission delegates only to the authenticated E2 seam,
  never ordinary ingest or an approval fallback. This is not a live extraction model,
  complete AEON feature set or extraction-quality result.

The original opaque bounded-computation recording API remains unchanged. The new
operational profile is explicit; it does not silently add operational semantics to
old callers. Output is untrusted LOCAL_RESULT, not an authoritative provider observation.

## Baseline and provenance

The recovered v7.1 snapshot tree is
`dc25bacb7625a4c889eadb36cbdb8e47ea33c3c6`. Original commit label
`d75928ca9a95cdddbbca9ee1a265c7f28395ce86` is attributed by the archive; the original
commit object/parents were not recovered. Local import commits preserve fetched
public development history and record snapshot/executable-mode restoration openly.
All migrations001–021 and frozen safety/qualification bytes remain intact.
Migration022 is additive. ENG-001–052 remain the maintained acceptance map; a local
slice does not close the whole product task.

NEXUS donor: Adaptive-Liquidity/Nexus-temp at
`e1c3d3c75d58f609c617e7a87cb05e84ea437d64`.
AEON donor: Adaptive-Liquidity/AEON-IQ-temp at
`d5866e85edb3a7f7ea7186854655981ca73760f4`.
See the sibling NEXUS-AUDIT/PROVENANCE and AEON-REVIEW/PROVENANCE files for exact
selected source hashes, adaptations, pinned dependency closure and retained MIT
notices. Neither the entire donor tree nor its optional servers is cleared by this
local review. Public redistribution, product licensing and final independent IP/
security acceptance remain separate. No new overall product license is chosen.

## Reproducible prerequisites

Retain the existing [safe local launcher](../LOCAL-TEST-LAUNCHER.md) and
[canonical testing rules](../TESTING.md). Backend Node24.14.1, frontend Node22.23.3,
PostgreSQL17 tools/server (this sprint used17.10), Python3.11+ for native provenance, OpenSSL, Chromium,
Linux namespaces and existing restricted fixture helper are required. Rust1.94.0 is
an additional **local build dependency**, not a runtime installer. Cargo packages
are exact/checksummed in `tools/nexus-native/Cargo.lock`; AEON has no registry closure.

Install dependencies only in the authorized isolated development environment. Use
`npm ci --ignore-scripts`. Install the pinned Rust toolchain separately with your
existing trusted toolchain manager and verify the version. Do not replace a shared
cluster/helper or modify global runtimes as a shortcut. Never use live credentials.

```sh
# Actual toolchain binaries, not rustup proxy symlinks:
export NEXUS_TOOLCHAIN_BIN="$(dirname "$(rustup which --toolchain 1.94.0 rustc)")"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
# If system python3 is older, set NEXUS_PYTHON to a trusted preinstalled3.11+ interpreter.
export NEXUS_PYTHON="$(command -v python3)"
"$NEXUS_TOOLCHAIN_BIN/rustc" --version
# Explicit dependency-fetch phase; not called by product execution or offline build:
"$NEXUS_TOOLCHAIN_BIN/cargo" fetch --locked --manifest-path tools/nexus-native/Cargo.toml
# Subsequent native build/tests refuse missing cache instead of downloading:
bash tools/offline-native-build.sh
```

Native outputs are ignored `.artifacts/` files, not committed binaries. NEXUS
records source/binary hashes and verifies them before tests. Product execution
never invokes Cargo/rustc, a registry, shell or provider to acquire a runtime.

Prepare the fixture cluster/helper using existing README/CI procedures **only after
verifying ownership and absence of foreign clients**. This sprint used a new
checkout-owned `.local/pgdata` on loopback55432; no system database service started.
The helper/config did not previously exist and were pinned to this one checkout.
A different existing helper/cluster is a refusal/handover issue, not permission to
overwrite it. Keep the four-runtime-path profile and environment guide outside Git,
configure `git config continuum.environmentGuide` to the verified private file,
and re-run ownership preflight before any reset. Machine-specific account/paths and
synthetic signing credentials are intentionally absent from this document.

```sh
python3 tools/local-test.py check --profile /private/location/profile.json
export NEXUS_NATIVE_BINARY="$PWD/.artifacts/nexus-target/debug/continuum-nexus-bridge"
# New tests require the reviewed additive schema in the owned disposable fixture.
python3 tools/local-test.py focused --profile /private/location/profile.json \
  e2-derived-proposals.test.js offline-functional-integration.test.js
CT_RESET_LOCAL_FIXTURE=yes CT_RESET_CONSOLE_FIXTURE=yes \
  python3 tools/local-test.py canonical --profile /private/location/profile.json
```

If CARGO_TARGET_DIR is explicitly changed, set NEXUS_NATIVE_BINARY to that trusted
build's exact native executable and verify its recorded source/binary manifest.
The canonical runner builds native fixtures offline, runs Rust/fixture checks,
then measures new Node suites exactly once alongside existing backend, frontend,
browser, product-isolation and native-DR checks. Inspect `.artifacts/canonical/final/`
for COMPLETE or INCOMPLETE and source fingerprint before accepting any run. Existing
release/qualification enforcers must still exit1. Dependency audits may require
network access to the package advisory service; no model or tenant data is sent.

## Recovery and retention boundaries

E2RecoveryGate requires an independent NORMAL_UNRESTORED lease for the exact domain/
fence and checks fresh validity after DB locks. Missing gate, unknown/restored/
unverifiable coverage, fence mismatch or expiry denies admission and owner review.
There is **no restore-reopen implementation** in this slice. The local journal
fixture is not independently durable negative-state infrastructure; its tests prove
refusal behavior, not completed backup-restoration/non-resurrection qualification.
Existing effect recovery/fence/UNKNOWN/no-blind-resend contracts stay separate.
A real journal's crash-safe append/ack/completeness, restore detection and operator
reconciliation are prerequisites before recovered E2 can ever be enabled.

Policy defaults remain90days for specifically disposable ordinary content-free
audit projection and30days from verified completion for disposable retry metadata.
No projection/purge job is enabled. Canonical receipts, immutable evidence, unresolved
outcomes, replay/tombstone protections and legal holds are excluded. No physical
purge, backup/WAL/export lifetime, legal jurisdiction or numeric RPO/RTO is invented.
Logical payload nulling/access withdrawal is not proof of erasure from backup/media.

## Review and next milestone

Internal independent source review found and prompted runtime identity, integrity-
ordering and console-disclosure fixes. Exact final source and executed evidence
must still be audited by the owner's independent reviewer. Public GitHub push,
merge, new license/visibility/history, real model data/spend, WorkOS, hosted
infrastructure, protected external actions and deployment are not authorized here.
Native AT/manual browser zoom remain NOT RUN. Next real-autonomy work is a bounded
replaceable model gateway plus typed application objective/workspace and independent
checker, followed by a separately authorized real-model task/interruption demonstration.
Offline fixtures do not satisfy that milestone.
