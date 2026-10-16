# M1 contract extension v3 — context and cognition binding

This extension does not replace `docs/M1-SAFETY-CONTRACTS.md`. Version 1 and version 2 canonical bytes stay unchanged.

A new operation uses contract version 3 only when it binds a context item, a cognition revision, or both. Extra columns on a version 1 or version 2 row are invalid. A version 3 digest is the version 1 field set with `contractVersion: 3`, plus `computerId` and `placementGeneration` when a Computer is bound, plus `contextId` and `contextVersion` when a context item is bound, plus `cognitionRevision` when a cognition revision is bound.

The caller cannot supply a context version or a cognition revision. Proposal records the current head version and the current maximum cognition revision. Quarantine does not block binding and does not admit the payload. Approval views may show that the bound item is quarantined and that the content is not an admitted fact and not effect authority.

Later admission denies deletion, erasure, expiry, a new context version, a greater cognition revision, and visibility narrowed so this principal could no longer bind the item. Quarantine and a wider visibility do not deny admission and do not rewrite the digest. An operation that bound neither context nor cognition stays on version 1, or version 2 when a Computer is bound. A later context item or cognition row does not rewrite or deny it. A stored version 3 reference that the trusted role cannot see fails closed and is not treated as an absent binding.

The admission lock order keeps the existing authority locks, then the bound context head, until that transaction commits. A context writer locks the owning principal, when there is one, before the head. A cognition insert locks that VERA principal before it calculates the next revision. This includes a direct insert. No cognition writer locks a context head, and no context writer locks a cognition row. A change that commits before the admission lock can deny the attempt. A change after the pre-send transaction commits does not recall an in-flight attempt and does not authorize a second send.

UNKNOWN reconciliation uses the stored digest and does not send. Recovery imports a version 3 archive only with its original references. A missing referenced row stays blocked and is not stored as an older contract version.
