import type pg from 'pg';
import { tx, canonical, sha, actionBinding } from './db.js';
import type { VerifiedIdentity } from './identity-provider.js';
import type { ImmutableObjectStore } from './object-store.js';
export interface OperationArchive {
  binding: Record<string, any>;
  digest: string;
  state: string;
}
export interface EvidenceBundle {
  contract: 'ct-evidence-export/1';
  tenant: string;
  head: { seq: number; hash: string };
  events: {
    seq: number;
    kind: string;
    payload: string;
    prev_hash: string;
    hash: string;
  }[];
  operations: OperationArchive[];
}
export function rowFromBinding(b: Record<string, any>) {
  return {
    tenant: b.tenant,
    id: b.id,
    principal: b.principal,
    epoch: b.epoch,
    generation: b.generation,
    fence: b.fence,
    grant_id: b.grantId,
    grant_version: b.grantVersion,
    task_id: b.taskId,
    plan_version: b.planVersion,
    provider: b.provider,
    action: b.action,
    resource: b.resource,
    params: b.params,
    idempotency_key: b.idempotencyKey,
    cost: b.cost,
    deadline: new Date(b.deadline),
    contract_version: b.contractVersion,
    ...((b.contractVersion === 2 || b.computerId) && b.contractVersion !== 1
      ? {
          computer_id: b.computerId,
          placement_generation: b.placementGeneration,
        }
      : {}),
    ...((b.contractVersion === 3 || b.contractVersion === 4) && b.contextId
      ? { context_id: b.contextId, context_version: b.contextVersion }
      : {}),
    ...((b.contractVersion === 3 || b.contractVersion === 4) &&
    b.cognitionRevision != null
      ? { cognition_revision: b.cognitionRevision }
      : {}),
    ...(b.contractVersion === 4
      ? { tool_id: b.toolId, tool_revision: b.toolRevision }
      : {}),
  };
}
export function verifyOperationArchive(o: OperationArchive) {
  const r = rowFromBinding(o.binding);
  if (
    (o.binding.contractVersion !== 1 &&
      o.binding.contractVersion !== 2 &&
      o.binding.contractVersion !== 3 &&
      o.binding.contractVersion !== 4) ||
    canonical(actionBinding(r)) !== canonical(o.binding) ||
    sha(canonical(o.binding)) !== o.digest
  )
    throw Error('archived immutable operation binding mismatch');
  return r;
}
export function verifyEvidenceBundle(b: EvidenceBundle) {
  if (
    b.contract !== 'ct-evidence-export/1' ||
    !Number.isSafeInteger(b.head.seq) ||
    b.head.seq !== b.events.length
  )
    throw Error('evidence export shape/head');
  let prev = 'GENESIS';
  for (let n = 0; n < b.events.length; n++) {
    const e = b.events[n];
    if (
      e.seq !== n + 1 ||
      e.prev_hash !== prev ||
      sha(
        canonical({
          tenant: b.tenant,
          seq: e.seq,
          kind: e.kind,
          payload: e.payload,
          prev,
        }),
      ) !== e.hash
    )
      throw Error('evidence chain invalid');
    prev = e.hash;
  }
  if (prev !== b.head.hash) throw Error('evidence head mismatch');
  for (const o of b.operations) {
    if (o.binding.tenant !== b.tenant) throw Error('archive tenant mismatch');
    verifyOperationArchive(o);
  }
  return b;
}
export class EvidenceExporter {
  constructor(
    private db: pg.Pool,
    private anchors: ImmutableObjectStore,
  ) {}
  async snapshot(a: VerifiedIdentity) {
    return tx(this.db, async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      const i = (
        await c.query(
          "SELECT * FROM ct.identities WHERE issuer=$1 AND subject=$2 AND audience=$3 AND kind='user' AND active",
          [a.issuer, a.subject, a.audience],
        )
      ).rows[0];
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      if (
        !i ||
        a.kind !== 'user' ||
        i.domain_role !== 'owner' ||
        a.expires <= now ||
        a.authTime === undefined ||
        a.authTime > now + 5000 ||
        now - a.authTime > 300000 ||
        !a.methods.includes('mfa')
      )
        throw Error('fresh enrolled owner required');
      const h = (
        await c.query('SELECT * FROM ct.evidence_heads WHERE tenant=$1', [
          i.tenant,
        ])
      ).rows[0];
      if (!h || Number(h.seq) > 10000)
        throw Error(
          'bounded exporter requires chunked stage archive for larger history',
        );
      const events = (
        await c.query(
          'SELECT seq,kind,payload,prev_hash,hash FROM ct.evidence_events WHERE tenant=$1 ORDER BY seq',
          [i.tenant],
        )
      ).rows.map((e) => ({ ...e, seq: Number(e.seq) }));
      const ops = (
        await c.query(
          'SELECT * FROM ct.operations WHERE tenant=$1 ORDER BY id LIMIT 513',
          [i.tenant],
        )
      ).rows;
      if (ops.length > 512) throw Error('bounded operation export');
      return verifyEvidenceBundle({
        contract: 'ct-evidence-export/1',
        tenant: i.tenant,
        head: { seq: Number(h.seq), hash: h.hash },
        events,
        operations: ops.map((o) => ({
          binding: actionBinding(o),
          digest: o.digest,
          state: o.state,
        })),
      });
    });
  }
  async seal(a: VerifiedIdentity) {
    const bundle = await this.snapshot(a),
      text = canonical(bundle),
      digest = sha(text),
      key = `tenants/${sha(bundle.tenant)}/anchors/${String(bundle.head.seq).padStart(12, '0')}-${digest}.json`;
    if (Buffer.byteLength(text) > 8388608)
      throw Error('bounded evidence export size');
    await this.anchors.putIfAbsent(key, Buffer.from(text));
    return {
      key,
      digest,
      head: bundle.head,
      scope:
        'independent anchor adapter; local fixture is not external production immutability',
    };
  }
  async readSealed(key: string, digest: string) {
    const text = Buffer.from(await this.anchors.get(key)).toString('utf8');
    if (sha(text) !== digest)
      throw Error('independent archive digest mismatch');
    return verifyEvidenceBundle(JSON.parse(text));
  }
  async comparePrefix(a: VerifiedIdentity, key: string, digest: string) {
    const prior = await this.readSealed(key, digest),
      current = await this.snapshot(a);
    if (
      prior.tenant !== current.tenant ||
      current.head.seq < prior.head.seq ||
      (prior.head.seq > 0 &&
        current.events[prior.head.seq - 1]?.hash !== prior.head.hash)
    )
      throw Error('anchored history lost, rewritten or forked');
    return {
      prefixMatches: true,
      priorSeq: prior.head.seq,
      currentSeq: current.head.seq,
    };
  }
}
