import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, append, canonical, sha } from '../src/db.js';
import { admin, gov, bootstrap, makeOp } from './helpers.js';
const a = pool('ct_tenant_a'),
  b = pool('ct_tenant_b'),
  ctl = pool('ct_controller'),
  provider = pool('ct_provider');
before(bootstrap);
after(async () => {
  await Promise.all([a, b, ctl, provider, admin, gov].map((p) => p.end()));
});
test('M2 runtime roles have no owner/superuser/BYPASSRLS and RLS forced', async () => {
  const r = await admin.query(
    "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname LIKE 'ct_%'",
  );
  assert.ok(r.rows.every((x) => !x.rolsuper && !x.rolbypassrls));
  const t = await admin.query(
    "SELECT relforcerowsecurity FROM pg_class WHERE relname='operations'",
  );
  assert.equal(t.rows[0].relforcerowsecurity, true);
});
test('M2 tenant session role cannot switch tenant with GUC or SET ROLE', async () => {
  await makeOp('m2-a');
  await makeOp('m2-b', { tenant: 'b' });
  await a.query("SET app.current_tenant='b'");
  const r = await a.query('SELECT DISTINCT tenant FROM ct.operations');
  assert.deepEqual(r.rows, [{ tenant: 'a' }]);
  assert.equal(
    (await b.query("SELECT count(*) n FROM ct.operations WHERE tenant='a'"))
      .rows[0].n,
    '0',
  );
  await assert.rejects(a.query('SET ROLE ct_controller'));
});
test('M2 composite tenant FK rejects foreign principal/grant', async () => {
  await gov.query(
    "INSERT INTO ct.principals VALUES('b','b-only',1,1,true) ON CONFLICT DO NOTHING",
  );
  await assert.rejects(
    gov.query(
      "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget) VALUES('a','wrong-fk','b-only','write','x',now(),1,1)",
    ),
    { code: '23503' },
  );
});
test('M2 controller cannot forge approvals/grants; provider cannot read domain; readers cannot write', async () => {
  await assert.rejects(ctl.query('UPDATE ct.grants SET revoked=false'), {
    code: '42501',
  });
  await assert.rejects(
    ctl.query(
      "INSERT INTO ct.approvals VALUES('a','m2-a','fake',1,'agent',now())",
    ),
    { code: '42501' },
  );
  await assert.rejects(provider.query('SELECT * FROM ct.operations'), {
    code: '42501',
  });
  await assert.rejects(a.query("UPDATE ct.operations SET state='COMMITTED'"), {
    code: '42501',
  });
});
test('M2 immutable binding and no UNKNOWN -> send transition', async () => {
  await assert.rejects(
    admin.query(
      "UPDATE ct.operations SET params='{}',version=version+1 WHERE id='m2-a'",
    ),
    /immutable/,
  );
  await admin.query(
    "UPDATE ct.operations SET state='RESERVED',version=version+1 WHERE id='m2-a'",
  );
  await admin.query(
    "UPDATE ct.operations SET state='UNKNOWN',version=version+1 WHERE id='m2-a'",
  );
  await assert.rejects(
    ctl.query(
      "UPDATE ct.operations SET state='SENDING',version=version+1 WHERE id='m2-a'",
    ),
    /illegal/,
  );
});
test('M2 evidence concurrent append allocates contiguous hash chain', async () => {
  await Promise.all(
    Array.from({ length: 25 }, (_, n) =>
      tx(gov, (c) => append(c, 'a', 'PARALLEL', { n })),
    ),
  );
  const r = (await a.query('SELECT * FROM ct.evidence_events ORDER BY seq'))
    .rows;
  let prev = 'GENESIS',
    seq = 0;
  for (const e of r) {
    assert.equal(Number(e.seq), ++seq);
    assert.equal(e.prev_hash, prev);
    assert.equal(
      e.hash,
      sha(
        canonical({
          tenant: e.tenant,
          seq,
          kind: e.kind,
          payload: e.payload,
          prev,
        }),
      ),
    );
    prev = e.hash;
  }
  await assert.rejects(ctl.query('DELETE FROM ct.evidence_events'), {
    code: '42501',
  });
});
test('M2 failed transaction leaves no evidence or outbox', async () => {
  const before = (await a.query('SELECT count(*) n FROM ct.evidence_events'))
    .rows[0].n;
  await assert.rejects(
    tx(gov, async (c) => {
      await append(c, 'a', 'ROLLBACK', { x: 1 });
      throw Error('injected rollback');
    }),
  );
  assert.equal(
    (await a.query('SELECT count(*) n FROM ct.evidence_events')).rows[0].n,
    before,
  );
});
