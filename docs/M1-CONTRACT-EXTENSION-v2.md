# M1 contract extension — operation binding version 2

Status: versioned extension approved with ENG-009 REV3. `docs/M1-SAFETY-CONTRACTS.md` stays frozen. This note does not change its bytes and does not claim the historical version 1 implementation already hashed a Computer id.

## Reason

M1 §1 requires the digest to cover the complete action binding, including Computer id and generation. M1 §2 names Computer generation in authority binding. The implemented version 1 digest hashes principal generation and does not hash a Computer id. Rewriting those stored digests or approvals would discard historical records.

## Binding

Contract version 1 remains the historical binding. Its canonical bytes stay the version 1 object: principal epoch and principal generation, and no Computer id or placement generation.

Contract version 2 is required for an operation created while that principal has a logical Continuum Computer. It is the version 1 binding plus `computerId` and `placementGeneration`. Principal epoch and principal generation stay separate fields. The approval binds to the version 2 digest.

The VERA id and the logical Computer id stay fixed. Replacement changes the placement generation of that Computer. It does not create a second Computer.

A repeated proposal with the same operation id is idempotent only when the complete version-specific binding matches, including Computer id and placement generation. A different Computer or placement generation is a conflict and never sends.

A version 1 operation is not upgraded, backfilled, or downgraded. After a Computer exists, renewal and both pre-send checks deny it. Observation of an existing UNKNOWN operation still uses the stored digest and does not send. A new operation or approval is not a substitute for resolving that uncertainty.

## Legacy send restriction

Version 1 records, digests, and approvals remain intact as historical records. They are not sendable once a Computer exists for that principal. This restriction is deliberate. It is not a rewrite of the frozen version 1 bytes.
