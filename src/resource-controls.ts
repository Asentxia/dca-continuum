import type pg from 'pg';
import { tx, append, canonical, sha } from './db.js';
import { enrolled, identifier } from './service-auth.js';
import type { VerifiedIdentity } from './identity-provider.js';
export interface ResourceBound {
  units: number;
  jobs: number;
  bytes: number;
}
export async function reserveResources(
  c: pg.PoolClient,
  tenant: string,
  kind: 'task' | 'computer' | 'artifact',
  id: string,
  principal: string,
  bound: ResourceBound,
  binding?: string,
  metadata: unknown = {},
) {
  identifier(id);
  for (const n of Object.values(bound))
    if (!Number.isSafeInteger(n) || n < 0) throw Error('resource bounds');
  const digest =
    binding ?? sha(canonical({ tenant, kind, id, principal, ...bound }));
  const limit = (
    await c.query(
      'SELECT * FROM ct.resource_limits WHERE tenant=$1 FOR UPDATE',
      [tenant],
    )
  ).rows[0];
  if (!limit) throw Error('resource policy not enrolled');
  const old = (
    await c.query(
      'SELECT * FROM ct.resource_reservations WHERE tenant=$1 AND kind=$2 AND id=$3 FOR UPDATE',
      [tenant, kind, id],
    )
  ).rows[0];
  if (old) {
    if (
      old.principal !== principal ||
      old.digest !== digest ||
      Number(old.units) !== bound.units ||
      Number(old.jobs) !== bound.jobs ||
      Number(old.bytes) !== bound.bytes ||
      old.state === 'SETTLED'
    )
      throw Error('resource identity conflict/closed');
    return { reused: true };
  }
  if (
    Number(limit.active_jobs) + bound.jobs > Number(limit.max_jobs) ||
    Number(limit.reserved_storage) + bound.bytes > Number(limit.max_storage) ||
    Number(limit.spent_or_reserved_units) + bound.units >
      Number(limit.max_units)
  )
    throw Error('resource limit');
  await c.query(
    'UPDATE ct.resource_limits SET active_jobs=active_jobs+$2,reserved_storage=reserved_storage+$3,spent_or_reserved_units=spent_or_reserved_units+$4 WHERE tenant=$1',
    [tenant, bound.jobs, bound.bytes, bound.units],
  );
  await c.query(
    'INSERT INTO ct.resource_reservations(tenant,kind,id,principal,digest,units,jobs,bytes,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      tenant,
      kind,
      id,
      principal,
      digest,
      bound.units,
      bound.jobs,
      bound.bytes,
      metadata,
    ],
  );
  return { reused: false };
}
export async function settleResources(
  c: pg.PoolClient,
  tenant: string,
  kind: string,
  id: string,
  usedUnits: number,
  knownStopped: boolean,
) {
  await c.query('SELECT * FROM ct.resource_limits WHERE tenant=$1 FOR UPDATE', [
    tenant,
  ]);
  const r = (
    await c.query(
      'SELECT * FROM ct.resource_reservations WHERE tenant=$1 AND kind=$2 AND id=$3 FOR UPDATE',
      [tenant, kind, id],
    )
  ).rows[0];
  if (!r) throw Error('resource reservation missing');
  if (r.state === 'SETTLED') return;
  if (!knownStopped) {
    await c.query(
      "UPDATE ct.resource_reservations SET state='UNCERTAIN' WHERE tenant=$1 AND kind=$2 AND id=$3",
      [tenant, kind, id],
    );
    return;
  }
  if (
    !Number.isSafeInteger(usedUnits) ||
    usedUnits < 0 ||
    usedUnits > Number(r.units)
  )
    throw Error('unbounded/unverified actual usage');
  await c.query(
    'UPDATE ct.resource_limits SET active_jobs=active_jobs-$2,reserved_storage=reserved_storage-$3,spent_or_reserved_units=spent_or_reserved_units-$4 WHERE tenant=$1',
    [tenant, r.jobs, r.bytes, Number(r.units) - usedUnits],
  );
  await c.query(
    "UPDATE ct.resource_reservations SET state='SETTLED',used_units=$4 WHERE tenant=$1 AND kind=$2 AND id=$3",
    [tenant, kind, id, usedUnits],
  );
}
export interface PlatformReceipt {
  tenant: string;
  kind: 'task' | 'computer' | 'artifact';
  id: string;
  usedUnits: number;
  knownStopped: boolean;
  proofReference: string;
}
export class ResourceService {
  constructor(
    private db: pg.Pool,
    private verifyReceipt: (r: PlatformReceipt) => Promise<void>,
  ) {}
  async reserve(
    a: VerifiedIdentity,
    input: {
      kind: 'task' | 'computer' | 'artifact';
      id: string;
      units: number;
      jobs: number;
      bytes: number;
    },
  ) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, a);
      if (i.kind !== 'machine') throw Error('bound machine required');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR SHARE',
        [i.tenant, i.principal],
      );
      const r = await reserveResources(
        c,
        i.tenant,
        input.kind,
        input.id,
        i.principal,
        { units: input.units, jobs: input.jobs, bytes: input.bytes },
      );
      await append(c, i.tenant, 'RESOURCE_RESERVED', {
        kind: input.kind,
        id: input.id,
        ...r,
      });
      return r;
    });
  }
  async settle(receipt: PlatformReceipt) {
    await this.verifyReceipt(receipt);
    return tx(this.db, async (c) => {
      await settleResources(
        c,
        receipt.tenant,
        receipt.kind,
        receipt.id,
        receipt.usedUnits,
        receipt.knownStopped,
      );
      await append(c, receipt.tenant, 'RESOURCE_RECONCILED', {
        kind: receipt.kind,
        id: receipt.id,
        knownStopped: receipt.knownStopped,
        proofReference: receipt.proofReference,
        unitModel: 'bounded test/compute units; not verified external billing',
      });
    });
  }
}
