# AEON exact-file offline reuse review

Reviewed before copying on 2026-10-15 against base da1d5f4 (tree dc25bacb7625a4c889eadb36cbdb8e47ea33c3c6).
Source: Adaptive-Liquidity/AEON-IQ-temp commit d5866e85edb3a7f7ea7186854655981ca73760f4,
tree 9ecdfd3663c69e0d5304b9e29ab4cf01dc5c460c, read-only audit checkout.

## Narrow local-copy decision

- `src/memory/amp/augmenter.rs`: blob 9d494c6d9d67c7f8a58e9ca7d5dab67e8cae0f8b,
  SHA256 86f974d75502d9f57c0790dbf3b61253b1dd60114d01d67910de008da5faca8c.
  Reviewed whole file (69 lines): arithmetic distance adjustment; receives candidate IDs,
  calls one graph-weight method, returns adjusted pairs. No I/O, secret, route, config,
  logging, unsafe block, macro, process, provider or permission logic in this file.
- `LICENSE`: blob e542a3d38bf2c33a146ae32f151d20f665f83fbb,
  SHA256 046d505b195d400a42747cc576219b551d2989a302ebd2b2aea5c5d5609db3f9.
  MIT, copyright (c) 2026 Adaptive Liquidity, full notice retained. No contrary file
  header in selected source. This limited source review does not certify upstream
  ownership or clear public distribution. Product license/visibility unchanged.

These two exact files only are cleared for scoped local copy by this implementation
review. Public distribution remains HELD pending separate owner/IP/security approval.
No donor Cargo.toml/Cargo.lock, code outside selected file, fixtures, or infrastructure
are copied. All new glue is Continuum adaptation, not donor extraction logic.

## Dependency closure and adaptations

Donor imports `uuid::Uuid`, `super::co_access::CoAccessGraph` and
`super::pressure::PressureManager`. Do NOT include donor co_access.rs (sqlx DB I/O),
pressure.rs (chrono, eviction semantics), or the uuid crate. Standalone reviewed
std-only harness supplies local implementations at these import paths:
- Uuid is a request-local usize ordinal, never domain identity;
- CoAccessGraph reads only bounded request-local numeric weights, not a database;
- PressureManager is an empty reserved type; donor itself marks it unused.
The donor file remains byte-for-byte unchanged. This executes its actual native
augment_scores function, not a TypeScript rewrite. The numeric bridge has no text,
tenant, principal, credential, context contents or facts database. Rust standard
library is the entire runtime dependency closure; no build.rs or registry crates.
Donor's 304-package lockfile/full server security is explicitly NOT cleared.

## Threat review and limits

Known donor tenant/credential route enforcement gaps are NOT inherited or repaired
by this slice. Reviewed credentials/context.rs distinction: authentication is not
agent authority; route mode/grant enforcement is a later step. Public proxy and
management routes, credentials registry, tenancy grants, extraction loop, DB store,
provider embeddings and workers are all excluded from build and product exposure.
No donor server starts. No caller may select executable/command from JSON. Trusted
composition provides fixed local binary; no shell, inherited secret environment,
network client or text-bearing arguments. Numeric input/output caps and child timeout
are defensive resource bounds, not OS sandboxing of a compromised executable.

Scores order references only; they never establish eligibility. R1 must resolve
every returned reference against fresh ContextService. No eligibility cache, fact
promotion, alternate policy or donor permission store. Candidate source is trusted
injected metadata retrieval, not worker-supplied scope. Derived admissions delegate
only to E2 admitDerivedProposal ingress with opaque server observation handles;
ordinary ingest/approve fallback is forbidden. Quarantined E2 result refs are not
normal recall hits. No prompt-injection immunity, extraction quality, real model,
revocation of already delivered bytes, atomic batch snapshot, PG integration or live
qualification is claimed. Production BLOCKED; scheduler HELD; canary NO-GO.
