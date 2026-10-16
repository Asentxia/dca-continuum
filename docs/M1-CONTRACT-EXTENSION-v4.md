# M1 contract extension v4 — tool binding

This extension does not replace `docs/M1-SAFETY-CONTRACTS.md`. Version 1, version 2, and version 3 canonical bytes stay unchanged. Context and cognition binding remains contract extension v3. This extension is only the tool binding.

A new operation uses contract version 4 only when it names a tool. The caller supplies the tool id and no revision. The server records the current maximum revision for that tenant and tool. A version 4 digest is the version 1 field set with `contractVersion: 4`, plus `computerId` and `placementGeneration` when a Computer is bound, plus `contextId` and `contextVersion` when a context item is bound, plus `cognitionRevision` when a cognition revision is bound, plus `toolId` and `toolRevision`.

A version 4 row always has both tool fields. A Computer pair, a context pair, and a cognition revision stay optional under the same presence rules as version 3. Version 4 does not require context or cognition. Version 1, 2, and 3 rows have null tool columns. A later tool revision does not rewrite or deny an operation that did not name a tool.

When a cognition row already exists, proposal still records the current maximum cognition revision. If that proposal also names a tool, the operation is version 4 and the digest includes both. If it does not name a tool, the operation stays version 1, 2, or 3.

`ct.tool_manifests` is append-only: tenant, tool id, revision, and definition digest. The revision is a positive bigint. The id uses the existing identifier check. The digest uses the same length-64 check as `ct.context_versions.digest`. The database assigns the next revision, including on a direct insert. Revision 0 and a gap are rejected. Update and delete are rejected. The definition digest identifies the definition. The definition bytes are not stored. A changed definition is a new revision. The operation digest pins `toolId` and `toolRevision`, not a second copy of the definition digest. The revision row is immutable, so the revision pins that digest.

`ct.append_tool_manifest` is granted to the governor only. It takes a transaction advisory lock on the tenant and tool id, inserts the next revision, and inserts or updates the index row in the same transaction. It does not lock a context head, a cognition row, or a principal. A worker cannot append. A tool revision is not a grant, an approval, a mandate, or permission to send.

`ct.tool_manifest_index` holds one derived row per tenant and tool: the current revision and definition digest. `ct.rebuild_tool_manifest_index` is granted to the governor only. It rewrites those rows from `MAX(revision)` in `ct.tool_manifests`. It does not insert a manifest revision, a grant, an approval, or an operation. Admission does not call it and does not repair the index. The index is not authority.

Admission keeps the existing authority locks, then the bound context head when a context item is bound, then the tool advisory lock and the index row when a tool is bound. It reads the append-only maximum. A greater maximum is `MANIFEST_STALE` and does not send. A missing manifest row, a cross-tenant id, or an index row that disagrees with the append-only maximum is `MANIFEST_UNAVAILABLE` and does not send. Quarantine and visibility rules are not copied onto tools.

A repeated proposal with the same operation id is idempotent only when the complete version 4 digest matches. A different tool or revision is a conflict and does not send. UNKNOWN reconciliation uses the stored digest and does not send. Recovery imports a version 4 archive only with its original tool revision. A missing tool revision stays blocked and is not stored as version 1, 2, or 3.

The read-only operation projection that returns a context id and a cognition revision also returns the bound tool id and tool revision. That pass-through is not a Focus Desk screen.
