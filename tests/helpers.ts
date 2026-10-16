import { pool, tx, bindingDigest, eventOutbox, append } from '../src/db.js';
export const admin = pool('localtest'),
  gov = pool('ct_governor');
export const fence = 'fixture-fence-v1';
export async function bootstrap() {
  await tx(gov, async (c) => {
    await c.query(
      "INSERT INTO ct.tenants VALUES('a'),('b') ON CONFLICT DO NOTHING",
    );
    await c.query(
      "INSERT INTO ct.role_tenants VALUES('ct_tenant_a','a'),('ct_tenant_b','b') ON CONFLICT DO NOTHING",
    );
    await c.query(
      "INSERT INTO ct.evidence_heads(tenant) VALUES('a'),('b') ON CONFLICT DO NOTHING",
    );
    await c.query(
      "INSERT INTO ct.principals VALUES('a','agent',1,1,true),('b','agent',1,1,true) ON CONFLICT DO NOTHING",
    );
    await c.query('UPDATE ct.control SET blocked=false,fence=$1', [fence]);
  });
}
export async function makeOp(id: string, opts: Record<string, any> = {}) {
  return tx(gov, async (c) => {
    const tenant = opts.tenant ?? 'a',
      grant = opts.grant ?? 'g-' + id;
    await c.query('SELECT * FROM ct.control FOR SHARE');
    const principal = (
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, 'agent'],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget,approval_required) VALUES($1,$2,'agent','write','fixture-object',$6,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        tenant,
        grant,
        opts.maxCost ?? 5,
        opts.budget ?? 50,
        opts.approvalRequired ?? true,
        opts.expires ?? new Date(Date.now() + 3600000),
      ],
    );
    const g = (
      await c.query(
        'SELECT * FROM ct.grants WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, grant],
      )
    ).rows[0];
    const o = {
      tenant,
      id,
      principal: 'agent',
      grant_id: grant,
      epoch: opts.epoch ?? principal.epoch,
      generation: opts.generation ?? principal.generation,
      fence: opts.fence ?? fence,
      grant_version: g.version,
      task_id: 'task-' + id,
      plan_version: 1,
      provider: 'fixture',
      action: opts.action ?? 'write',
      resource: opts.resource ?? 'fixture-object',
      params: opts.params ?? { value: id },
      idempotency_key: opts.key ?? id,
      cost: opts.cost ?? 1,
      deadline: opts.deadline ?? new Date(Date.now() + 3600000),
      digest: '',
    };
    o.digest = bindingDigest(o);
    await c.query(
      'INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      Object.values(o)
        .slice(0, 14)
        .concat([o.digest, o.idempotency_key, o.cost, o.deadline]),
    );
    if (opts.approve !== false)
      await c.query(
        "INSERT INTO ct.approvals VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
        [
          tenant,
          id,
          opts.approvalDigest ?? o.digest,
          g.version,
          'independent-test-owner',
        ],
      );
    await eventOutbox(c, o, 'OPERATION_CREATED', { id, digest: o.digest });
    return o;
  });
}
export async function revoke(o: { tenant: string; grant_id: string }) {
  await tx(gov, async (c) => {
    await c.query('SELECT * FROM ct.control FOR SHARE');
    await c.query(
      "SELECT * FROM ct.principals WHERE tenant=$1 AND id='agent' FOR UPDATE",
      [o.tenant],
    );
    await c.query(
      'UPDATE ct.grants SET revoked=true,version=version+1 WHERE tenant=$1 AND id=$2',
      [o.tenant, o.grant_id],
    );
    await append(c, o.tenant, 'GRANT_REVOKED', { grant: o.grant_id });
  });
}
export async function state(id: string) {
  return (
    await admin.query(
      "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
      [id],
    )
  ).rows[0];
}
export async function count(id: string) {
  return Number(
    (
      await admin.query(
        "SELECT count(*) n FROM provider.effects WHERE tenant='a' AND operation=$1",
        [id],
      )
    ).rows[0].n,
  );
}
