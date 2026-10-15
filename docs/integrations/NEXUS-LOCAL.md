# Restricted local NEXUS computation integration

Profile: `nexus-local-i32-v1`. Production BLOCKED; scheduler HELD; canary NO-GO.
Public redistribution HELD. Local commits only. No provider, server or model call.

## Boundary and ownership

`src/nexus-local.ts` exports `createNexusLocalIngress` for **trusted host composition**.
A worker can call only the resulting credential-requiring `execute` closure, not
construct/replace its verifier, authorization callback, module registry or executable.
Constructor requires both trusted `verifyCredential(token)` and `authorize(binding)`.
Compose the existing canonical machine identity verification/current enrollment
service there. Verified tenant/subject must come from that service, never worker body.
The adapter has no enrollment store, issuer, grant writer or canonical identity model.
The JWT verifier under `tests/nexus/auth-fixture.ts` is test compute capability only;
it does **not** establish real VERA enrollment, current authority or production auth.

`authorize` MUST check current enrollment/revocation and exact module/hash/entrypoint
policy for each call. It receives immutable verified caller plus computation id,
module id/SHA256, path, fuel, memory and timeout. False, nonboolean and outage deny.
Credential verification failure denies before policy or execution. These hooks run
only in the trusted host, never the native child. Host composition owns their
bounded availability and current epoch/generation/placement policies. No permission
is cached by this adapter. Revocation after local admission is not global recall;
there are no external effects to recall. Separate Effect Controller authority,
capability handling and PostgreSQL domain truth are unchanged.

## Explicit profile contract (not a silent rewrite of old v1)

The original `bounded-computation-contract.ts` and its opaque recording/denial API
are unchanged. They still report NO_RUNTIME. This new, explicitly selected profile
is a distinct local executable port that accepts interface `bounded-computation`,
exact numeric version `1` and a deliberately narrower operational shape. It is not
a new persisted operation contract version or a general definition of opaque v1.
Unknown interface/version fails closed before request inspection or verifier calls.
No product UI, worker dispatch, controller integration or grant path is wired here.

Required own JSON data fields only:

| Field | Local profile semantics |
|---|---|
| tenant | Must equal trusted verified tenant, identifier 1–64 characters |
| computationId | Local correlation id, identifier 1–64 characters; no durable operation/idempotency semantics |
| module | Exact tenant-scoped id from trusted immutable copied registry, never file path/URL |
| path | Exact WASM export identifier, never host path; `() -> i32` only, no fallback |
| fuel | Integer 1–100,000,000, Wasmtime fuel units, not wall-clock instructions |
| memory | Integer bytes, 64KiB page multiple, 64KiB–16MiB |
| timeout | Integer milliseconds, 1–1,000; parent deadline includes process startup/compile/execute |
| fork | Must be false. Snapshot/fork/rollback unsupported and denied, never simulated |

Identifiers accept ASCII letters/digits/underscore/hyphen only. No arbitrary args,
credentials, provider fields, callback, file contents, capability request or metadata.
Module content is host-supplied bytes (8–65,536 bytes), max 32 registry entries,
copied and hashed at construction. Each execution gets a fresh process/store.
No guest state is retained between invocations. This is not snapshot rollback.

Success is `LOCAL_RESULT`, signed i32 `value`, measured `fuelConsumed`, module SHA256,
and `scope: LOCAL_ONLY_NOT_PROVIDER_OBSERVATION`. These untrusted local results
cannot create an approval/grant/capability, admit a fact or establish COMMITTED.
Caller must not convert these into authoritative external observations.

## Actual native runtime

`vendor/nexus/pure-runtime.rs` adapts the audited donor's real Wasmtime
Store/limiter/fuel/empty-Linker/instantiate/call/get_fuel path, not a success shim.
MIT notice and exact source ranges/hashes are in the audit/provenance documents.
No donor binary, management API, public server, WASI, component model, HTTP stack,
capability minting, recovery policy, telemetry, database or snapshot code is built.

The native stdin bridge accepts only bounded JSON WASM bytes/export/bounds and
returns one bounded numeric result or fixed reason; it receives no JWT/tenant,
credentials, network configuration, inherited environment or host paths. All WASM
imports are rejected before instantiation; empty Linker provides no host functions,
filesystem/network/env/clock/random/process imports or effect capability. Imported
start code cannot run. WASM start functions are themselves fuel/epoch metered.
Resource controls: Wasmtime store memory size/count, table count/elements, 256KiB
WASM stack, fuel, epoch interrupt; parent one-at-a-time admission, <=1,024-byte
stdout and kill-and-reap timeout covering compilation as well as execution.
Linux `/usr/bin/prlimit` additionally enforces 1GiB native address space, 2s native
CPU, zero file growth/core and 32 descriptors. Killed/invalid native outcomes fail,
not success. Working directory `/`, empty environment, no shell; stderr discarded
rather than surfaced as possible guest diagnostics.

This is WASM import/capability isolation, **not** an OS firewall or native-engine
sandbox-escape guarantee. The JIT/native runtime remains trusted code; rlimits are
not a container. Separate exec/filesystem/application workspace isolation remains
a distinct independently qualified requirement. No managed-host/production claims.

## Reproduction — setup and execution are separate

Use Node 24 and the existing root lockfile npm dependencies. No package.json change.
Install the explicitly pinned Rust 1.94.0 toolchain in an isolated user-owned location
without changing global tools. Set `NEXUS_TOOLCHAIN_BIN` to its real toolchain `bin`
directory (not rustup proxies) and `CARGO_HOME` to the reviewed registry cache.
Build scripts sanitize their environment and never auto-install toolchains.

A separately authorized dependency setup is explicit:

```bash
# Network-capable setup only; do not invoke from runtime or tests.
"$NEXUS_TOOLCHAIN_BIN/cargo" fetch --locked --manifest-path tools/nexus-native/Cargo.toml
# All subsequent commands are offline and lockfile-bound.
bash tools/nexus-build.sh
bash tools/nexus-test.sh
```

Runtime ingress requires the resulting prebuilt absolute binary path. It never
builds, fetches, invokes Cargo, contacts a registry or starts a server. Tests invoke
explicit offline Cargo test/fixture generation and compile TypeScript. Fixture
regeneration is compared byte-for-byte; no fixture expectation is fabricated from
native status. `sum.wat` computes 1+…+100 = 5050 using an actual WASM loop. Native
and ingress tests cover imports, start-function fuel, memory growth/initial size,
tables, missing entrypoint, trap, fuel, epoch timeout, process deadline, malformed
protocol/output, forged and cross-tenant credentials, current authorization denial,
authorization outage, registry mutation, unknown versions, fork denial and busy cap.
Native-host probe tests rlimits and lack of inherited env (Python may synthesize
LC_CTYPE itself). Python stubs test hostile protocol only, not WASM functionality.

`tools/nexus-fingerprint.py` includes native Cargo source/lock/example, adapted vendor
source/notice, all adapter/test/fixture bytes and audit docs, excluding generated
targets. Final fingerprint is written under `.artifacts/nexus` by the focused suite.
Full existing canonical DB/HA/browser suite is coordinator-owned, NOT RUN here.
No DB reset or main-environment helper/toolchain change is part of this work.
