# AEON-IQ offline reference-ranking integration

Implemented scope: actual pinned donor co-access distance adjustment executed in
native Rust, behind a replaceable numeric port. This is not an extractor, vector
index, embedding provider, model transport, policy engine or complete AEON server.
See AEON-REVIEW.md and AEON-PROVENANCE.json for exact copy clearance/notice.

## Build and deterministic checks

Requires existing Rust (tested 1.94.0), Node 24 and locked root Node dependencies.
No dependency download, network call, DB connection/reset or spend occurs here.

```sh
# Optionally set RUSTC to the trusted preinstalled compiler's absolute path.
bash tools/aeon/build.sh
npm run build
node --test dist/tests/aeon/offline.test.js
```

Build produces ignored `.artifacts/aeon/ranker` and native test executable, not a
checked-in binary. `verify-vendor.py` fails on any changed selected donor bytes.
Runtime does not compile/download or select a fallback. Missing binary, invalid
numeric response, source outage or bad metadata => UNAVAILABLE, then R1 DEGRADED.
No hidden fixture fallback or reimplemented donor scoring is used.

## Trusted composition

```ts
import { NativeAeonRanker } from '../../src/aeon/offline-ranker.js';
import { AeonReferenceIndex } from '../../src/aeon/reference-index.js';
import { AeonGovernedAdmission } from '../../src/aeon/governed-admission.js';
// Existing trusted server composition supplies the SAME canonical db/context,
// configured verifier, fixed built binary path and scope-partitioned metadata source.
const index = new AeonReferenceIndex(metadataSource, new NativeAeonRanker(binaryPath));
const recall = new RecallService(enrollmentDb, context, machineVerifier, index);
// E2 implementation supplies createE2Ingress. Only admit is delegated here.
const e2 = createE2Ingress(context, machineVerifier);
const admissions = new AeonGovernedAdmission({ admit: e2.admit });
```

Do not expose `recordObservation` or executable/metadata-source selection through a
worker HTTP body. The ranking adapter has no credential/API ingress of its own.
Scope is supplied by existing authenticated R1; validating its shape does not
verify enrollment. Metadata source returns <=16 `{reference,distance,neighborWeight}`
records, no payloads/eligibility flags. Distances must be finite [0,2], aggregate
weights finite [0,5]. Static graph bonus is 0.15 (donor default). Candidate IDs are
request-local ordinals inside the child; no tenant, principal, query, references,
text or credentials cross the numeric child boundary. Adjusted distance is lower
is better; clamp to zero is actual donor logic; stable ties preserve input order.
Ranking chooses up to query.limit references after scoring. Repeated/conflicting
IDs, unknown fields and accessors refuse rather than merge. No persistent metadata
source or eligibility cache is supplied by this slice.

Existing R1 performs fresh enrollment checkpoints and ContextService resolution;
it owns all canonical failures. Direct index use never supplies context contents
or authenticates a caller. Ranking cannot turn a stale/private/quarantined ref into
an eligible one. E2 admission takes an existing server-origin opaque observation
handle and fixed `continuum-derived-unverified-text/v1`, delegates to E2, and has no
ordinary ingest, approval, sharing or retry path. It does not synthesize a model
observation. The resulting private quarantined E2 reference is NOT eligible for
normal recall; separate exact owner E2 inspection remains E2-owned.

## Evidence and exclusions

Local checks: 3 native tests execute unchanged donor augment_scores (bonus/clamp,
disabled bonus, numeric bounds); 11 Node tests include actual native child ranking,
limits/stable ties/no-cache/mutation snapshots/refusals/exact upstream hashes and
E2 delegation refusal. The E2 delegation test uses a clearly labelled contract
double; it is NOT canonical admission, identity or PostgreSQL evidence. No actual
E2 facts are admitted during these tests. Full worktree TypeScript compile passes.
R1 + PostgreSQL eligibility/races, E2 migration/recovery integration and canonical
suite are NOT RUN in this worktree (coordinator-owned fixture lease). No existing
R1, ContextService, model grammar, migrations or gate ledgers were changed.

No automated extraction/embedding, semantic candidate discovery, model quality,
learning/eviction, persistent graph, provider egress, donor management/public/proxy
server, donor credential routes, alternate facts store or public distribution.
Build isolation is not OS/process/network containment against arbitrary malicious
binaries. Current local tests prove deterministic integration only, not whole donor
security, production qualification, prompt-injection immunity or autonomy success.
Production BLOCKED; scheduler HELD; canary NO-GO. Public distribution HELD.
