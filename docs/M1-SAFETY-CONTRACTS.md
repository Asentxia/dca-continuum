# Continuum M1 — Safety Contracts v0.1 (implementation freeze)

Status: FROZEN FOR THIS VALIDATION REVISION. Owner-approved provisional target; not production approval or canon. Freeze before implementing M2. Amend only through a versioned, reasoned contract change and rerun affected gates. The seven contracts below supersede unsafe prototype behaviors, not historical artifacts.

## 1. Operation identity
The trusted API derives tenant/principal from a verified caller, never from arbitrary worker fields. An operation is immutable `(tenant, operationId, principalId, principalEpoch, computerId, generation, taskId, planVersion, provider, action, resource, canonicalParameters, payloadDigest, idempotencyKey, deadline, costUnits, contractVersion)`. Canonical parameters are JSON with recursively sorted keys; reject unsupported numbers/types, unknown fields and oversized requests. Digest SHA-256 of the complete action binding, not just payload. Reusing operationId or tenant/provider/key with a different binding is CONFLICT and never sends. Retries/reset/Continue-as-New preserve operation IDs. Compensation is a new operation. Provider semantics are not inferred from IDs.

## 2. Grants and approvals
Only trusted governance writes grants. Binding includes tenant, principal, action, exact resource, expiration, version, principal epoch, computer generation, per-operation and total cost caps. This slice deliberately does not support delegation or wildcard resource matching; fail closed rather than approximate. Approvals are explicit decisions by independent governance bound to operation digest, grant version and expiry. AWAITING_APPROVAL is not approval. A changed action/payload/grant invalidates approval. Agents/workers cannot write grants, approvals, provider observations or evidence.

## 3. Revocation and fencing
Dispatch admission locks recovery fence, principal, grant and operation in this order. Governance revocation takes the same grant lock and increments version. Any admission serializing after committed revoke is denied. The last send reservation rechecks authority/expiry/approval/epoch/generation. An admitted/in-flight send may finish after revocation. No promise of global recall or physically cancelling an already-sent request. Recovery activation and computer/principal epoch rotation invalidate older capabilities. Final transport ordering stronger than admission is out of scope and must not be advertised.

## 4. UNKNOWN outcomes
Persistent transitions: REQUESTED -> RESERVED -> SENDING -> COMMITTED | UNKNOWN | FAILED_KNOWN_NO_EFFECT; denial before reservation -> DENIED. Reservation is committed before provider I/O. Only the reserving attempt may enter SENDING. A concurrent delivery returns current state and cannot send. Crash after reservation never grants another sender: after the bounded lease it becomes UNKNOWN. Timeout, malformed acknowledgement, lost acknowledgement and uncertain transport failure become UNKNOWN. UNKNOWN can only be reconciled by authoritative provider read-back; it cannot return to send in this slice. No adapter fallback after a possible effect. A new operator-requested operation is not a legitimate substitute for resolving the old UNKNOWN.

## 5. Verification
The provider owns external truth. Completion requires read-back under a tested adapter contract matching tenant, operation key and digest, not a worker/model assertion. Accepted != completed. Missing/404 read-back is not authoritative proof of no effect; keep UNKNOWN. A mismatched/partial observation is UNKNOWN and must be escalated. The local provider emulator is only a test oracle; no live-provider guarantee follows from it. Store the observation and evidence atomically with the domain outcome.

## 6. Tenant and trust boundaries
All domain references use composite tenant foreign keys. RLS is forced; runtime roles are not owners/superusers/BYPASSRLS. Demonstration per-tenant API DB roles are mapped from session_user, not a mutable tenant GUC. A production pooled API may use a trusted identity-derived context, but must not expose SQL to agents. Untrusted workers get no DB login/credential, no provider secret and no trusted browser cookies/CDP. The controller is a separate process, credential domain and network path. Local network namespace + separate UID is tested containment for this fixture, not a certificate for managed VMs/cloud. Controller validates a narrowly scoped worker capability before loading an operation. Workflow cancellation is not an authority check.

## 7. Evidence
Per-tenant sequence allocation locks an evidence-head row, not MAX(seq)+1. Each immutable event contains sequence, previous hash, canonical payload, payload digest and event hash; append is atomic with the relevant state mutation and outbox. Runtime roles cannot update/delete events. Hash continuity detects some tampering and needs external anchors for administrator tampering. An intact chain is not proof of an external effect. Outbox consumption is at-least-once, deduplicated in the destination; no claim of exactly-once delivery.

## Restore and resource safety
A restore/import starts with effect admission BLOCKED and old capabilities invalid. An independently maintained deployment fence must change before enabling recovered data; no default automatic enable. Reconcile all possible provider effects lost from the backup window first. This slice tests manual gated logical restore; continuous WAL/PITR, HA and regional RPO/RTO remain separate release gates. Reserve cost transactionally once per logical effect; uncertain outcomes retain reservations conservatively. Refuse over-budget/expired work. Memory is tenant-scoped, versioned/digest-checked data and never authority.

## Hard invariants
- Zero unapproved or stale-authority admissions.
- Zero second send from retry of the same logical operation after a possible effect.
- Zero tenant FK/role bypass in tested runtime paths.
- No COMMITTED without authoritative matching observation.
- No restore resume without fence rotation and reconciliation.
- No claimed gate pass beyond its actually exercised failure/threat boundary.

## Explicit exclusions and next gates
Delegation, OIDC login/real human console, provider-specific irreversible actions, live VM firewall/IAM, real SaaS read-back, object-store anchors, real 24-hour soak, production workflow history upgrades, full host loss, PITR/HA and multi-region DR must be implemented/tested before claims. Broad architecture ideation is closed unless tests falsify the provisional target. Safety fixes precede feature expansion.
