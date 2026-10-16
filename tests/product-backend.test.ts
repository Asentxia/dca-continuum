import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';
import { pool } from '../src/db.js';
import { EffectController } from '../src/controller.js';
import { productApi } from '../src/product-api.js';
let f: Awaited<ReturnType<typeof fixture>>, api: http.Server, endpoint: string;
before(async () => {
  f = await fixture('backend');
  api = productApi(f.machine, f.product);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  endpoint = 'http://127.0.0.1:' + (api.address() as any).port;
});
after(async () => {
  if (api) await new Promise<void>((r) => api.close(() => r()));
  if (f) await f.close();
  await admin.end();
  await gov.end();
});
async function req(path: string, body: unknown, token?: string) {
  return fetch(endpoint + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (token ?? (await f.token('machine'))),
    },
    body: JSON.stringify(body),
  });
}
test('Backend intent -> independent approval -> capability -> verified status', async () => {
  const { worker, owner, op, x } = await f.intent('backend-complete');
  assert.equal(
    (await f.product.status(worker, x.task)).phase,
    'AWAITING_APPROVAL',
  );
  await assert.rejects(f.authority.renew(worker, x.id));
  await f.authority.approve(owner, {
    operation: x.id,
    digest: op.digest,
    expires: x.deadline,
  });
  const c = await f.capability(x.id);
  assert.equal((await f.controller.dispatch(c, x.id)).state, 'COMMITTED');
  assert.equal(
    (await f.product.status(worker, x.task)).phase,
    'VERIFIED_COMPLETE',
  );
  assert.equal(f.provider.sends, 1);
});
test('Backend tenant and machine-principal boundaries', async () => {
  const { x } = await f.intent('backend-tenant');
  await assert.rejects(f.product.status(await f.actor('machine', 'b'), x.task));
  await assert.rejects(
    f.product.createTask(await f.actor('machine'), {
      id: 'wrong-principal',
      principal: 'agent',
      objective: 'cannot impersonate',
      deadline: x.deadline,
      ...f.admission.a,
    }),
  );
  assert.deepEqual(await f.product.list(await f.actor('machine', 'b')), []);
});
test('Backend machines cannot grant, approve, assign, cancel or disable', async () => {
  const { worker, x, op } = await f.intent('backend-escalation');
  await assert.rejects(
    f.authority.approve(worker, {
      operation: x.id,
      digest: op.digest,
      expires: x.deadline,
    }),
  );
  await assert.rejects(
    f.authority.createGrant(worker, {
      id: 'self-grant',
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: x.deadline,
      maxCost: 5,
      budget: 10,
    }),
  );
  await assert.rejects(
    f.authority.assign(worker, {
      identity: 'backend-worker-a',
      operation: x.id,
      expires: x.deadline,
    }),
  );
  await assert.rejects(f.product.cancel(worker, x.task, 1));
  await assert.rejects(f.product.disableMachine(worker, 'backend-worker-a'));
});
test('Backend HTTP rejects tenant, approval, credential and arbitrary action flags', async () => {
  const { x } = await f.intent('backend-http');
  for (const extra of [
    { tenant: 'b' },
    { approved: true },
    { credential: 'not-a-real-secret' },
    { url: 'https://example.invalid' },
  ])
    assert.equal((await req('/operations', { ...x, ...extra })).status, 403);
  assert.equal((await req('/task-status', { task: x.task })).status, 200);
  assert.equal(
    (await req('/task-status', { task: x.task }, 'bad-token')).status,
    403,
  );
});
test('Backend stable operation identity tolerates exact replay but rejects altered intent', async () => {
  const { worker, x } = await f.intent('backend-replay');
  assert.equal((await f.product.propose(worker, x)).reused, true);
  await assert.rejects(
    f.product.propose(worker, { ...x, params: { value: 'different' } }),
  );
  const n = await admin.query(
    "SELECT count(*) n FROM ct.operations WHERE tenant='a' AND id=$1",
    [x.id],
  );
  assert.equal(Number(n.rows[0].n), 1);
});
test('Backend checks grant scope, cost, deadline and input bounds', async () => {
  const { worker, x } = await f.intent('backend-bounds');
  for (const change of [
    { cost: 6 },
    { resource: 'another-object' },
    { action: 'admin' },
    { deadline: new Date(Date.now() + 7200000).toISOString() },
    { params: 'x'.repeat(17000) },
    { provider: 'arbitrary' },
  ])
    await assert.rejects(
      f.product.propose(worker, { ...x, id: 'bounds-new', ...change }),
    );
  await assert.rejects(
    f.product.createTask(worker, {
      id: '../bad',
      principal: f.principal,
      objective: 'bad',
      deadline: x.deadline,
      ...f.admission.a,
    }),
  );
});
test('Backend cancellation races final send; no later admission, in-flight promise honest', async () => {
  const { owner, x } = await f.intent('backend-cancel', true);
  const cap = await f.capability(x.id),
    before = f.provider.sends;
  const controller = new EffectController(
    f.controllerDb,
    f.provider,
    'fixture-fence-v1',
    100,
    {
      afterReservation: async () => {
        await f.product.cancel(owner, x.task, 1);
      },
    },
  );
  assert.equal((await controller.dispatch(cap, x.id)).state, 'DENIED');
  assert.equal(f.provider.sends, before);
  assert.equal((await f.product.status(owner, x.task)).phase, 'CANCELLED');
  await assert.rejects(f.capability(x.id));
});
test('Backend cancellation CAS accepts one owner action and never uncancels', async () => {
  const { owner, x } = await f.intent('backend-cancel-cas');
  const r = await Promise.allSettled([
    f.product.cancel(owner, x.task, 1),
    f.product.cancel(owner, x.task, 1),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  await assert.rejects(
    f.product.propose(await f.actor('machine'), {
      ...x,
      id: 'backend-cancel-extra',
    }),
  );
});
test('Backend UNKNOWN and empty tasks are never displayed as completed', async () => {
  const { worker, x } = await f.intent('backend-unknown', true);
  f.provider.loseAck = true;
  assert.equal(
    (await f.controller.dispatch(await f.capability(x.id), x.id)).state,
    'UNKNOWN',
  );
  f.provider.loseAck = false;
  assert.equal((await f.product.status(worker, x.task)).phase, 'BLOCKED');
  const deadline = new Date(Date.now() + 3600000).toISOString();
  await f.product.createTask(worker, {
    id: 'empty-task',
    principal: f.principal,
    objective: 'No actions yet',
    deadline,
    ...f.admission.a,
  });
  assert.equal((await f.product.status(worker, 'empty-task')).phase, 'PLANNED');
});
test('Backend database role cannot grant authority, approve or claim effect success', async () => {
  for (const sql of [
    "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget) VALUES('a','unsafe', 'agent','write','fixture-object',now()+interval '1 hour',1,2)",
    "UPDATE ct.approvals SET expires=now()+interval '2 hours'",
    "UPDATE ct.operations SET state='COMMITTED',version=version+1",
  ])
    await assert.rejects(f.productDb.query(sql));
  const tenantB = pool('ct_tenant_b');
  try {
    assert.equal(
      (await tenantB.query("SELECT * FROM ct.tasks WHERE tenant='a'")).rowCount,
      0,
    );
  } finally {
    await tenantB.end();
  }
});
test('Backend rejected issuer subject and stale identities cannot access tasks', async () => {
  const actor = await f.actor('machine');
  await assert.rejects(f.product.list({ ...actor, subject: 'not-enrolled' }));
  await assert.rejects(f.product.list({ ...actor, expires: Date.now() - 1 }));
  await assert.rejects(
    f.product.list({ ...actor, audience: 'wrong-audience' }),
  );
});
test('Backend owner disable invalidates a previously minted capability', async () => {
  const { owner, x } = await f.intent('backend-disable', true);
  const cap = await f.capability(x.id),
    before = f.provider.sends;
  await f.product.disableMachine(owner, 'backend-worker-a');
  assert.equal((await f.controller.dispatch(cap, x.id)).state, 'DENIED');
  assert.equal(f.provider.sends, before);
  await assert.rejects(f.capability(x.id));
});
