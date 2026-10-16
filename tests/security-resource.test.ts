import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';
import { pool } from '../src/db.js';
import { ResourceService } from '../src/resource-controls.js';
import {
  RequestBudget,
  safeError,
  validateStagingConfig,
} from '../src/operational-controls.js';
import { stagingDatabase } from '../src/staging-database.js';
import { ArtifactService } from '../src/artifact-store.js';
let f: Awaited<ReturnType<typeof fixture>>, resources: ResourceService;
const db = pool('ct_resource_service'),
  ctxDb = pool('ct_context_service');
before(async () => {
  f = await fixture('resource');
  resources = new ResourceService(db, async (r) => {
    if (r.proofReference !== 'fixture-verified-platform:' + r.id)
      throw Error('untrusted usage report');
  });
  await admin.query(
    "INSERT INTO ct.computers(tenant,id,principal,generation,state) VALUES('a','resource-computer',$1,1,'STOPPED')",
    [f.principal],
  );
});
after(async () => {
  if (f) await f.close();
  await Promise.all([db.end(), ctxDb.end(), admin.end(), gov.end()]);
});
const reservation = (id: string) => ({
  kind: 'task' as const,
  id,
  units: 1,
  jobs: 1,
  bytes: 0,
});
const report = (id: string, extra: any = {}) => ({
  tenant: 'a',
  kind: 'task' as const,
  id,
  usedUnits: 1,
  knownStopped: true,
  proofReference: 'fixture-verified-platform:' + id,
  ...extra,
});
test('Resources concurrent reservations serialize against configured limit', async () => {
  const n = Number(
    (
      await admin.query(
        "SELECT active_jobs FROM ct.resource_limits WHERE tenant='a'",
      )
    ).rows[0].active_jobs,
  );
  await gov.query(
    "UPDATE ct.resource_limits SET max_jobs=$1 WHERE tenant='a'",
    [n + 2],
  );
  const r = await Promise.allSettled(
    [1, 2, 3].map((i) =>
      f
        .actor('machine')
        .then((a) => resources.reserve(a, reservation('resource-cap-' + i))),
    ),
  );
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
  await gov.query(
    "UPDATE ct.resource_limits SET max_jobs=1000 WHERE tenant='a'",
  );
});
test('Resources stable identity reserves once and refuses changed budget', async () => {
  const a = await f.actor('machine');
  assert.equal(
    (await resources.reserve(a, reservation('resource-stable'))).reused,
    false,
  );
  assert.equal(
    (await resources.reserve(a, reservation('resource-stable'))).reused,
    true,
  );
  await assert.rejects(
    resources.reserve(a, { ...reservation('resource-stable'), units: 2 }),
  );
});
test('Resources forged completion cannot release quota; uncertainty remains reserved', async () => {
  await resources.reserve(
    await f.actor('machine'),
    reservation('resource-uncertain'),
  );
  await assert.rejects(
    resources.settle(
      report('resource-uncertain', { proofReference: 'worker-assertion' }),
    ),
  );
  await resources.settle(report('resource-uncertain', { knownStopped: false }));
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM ct.resource_reservations WHERE tenant='a' AND id='resource-uncertain'",
      )
    ).rows[0].state,
    'UNCERTAIN',
  );
  await resources.settle(report('resource-uncertain'));
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM ct.resource_reservations WHERE tenant='a' AND id='resource-uncertain'",
      )
    ).rows[0].state,
    'SETTLED',
  );
});
test('Resources unbounded actual usage and closed identity reuse refused', async () => {
  await resources.reserve(
    await f.actor('machine'),
    reservation('resource-bound'),
  );
  await assert.rejects(
    resources.settle(report('resource-bound', { usedUnits: 2 })),
  );
  await resources.settle(report('resource-bound'));
  await assert.rejects(
    resources.reserve(await f.actor('machine'), reservation('resource-bound')),
  );
});
test('Resources product/worker cannot widen configured limits', async () => {
  await assert.rejects(
    f.productDb.query('UPDATE ct.resource_limits SET max_units=999999999'),
  );
  await assert.rejects(
    db.query('UPDATE ct.resource_limits SET max_storage=999999999'),
  );
  await assert.rejects(
    resources.reserve(await f.actor('user'), reservation('owner-not-worker')),
  );
});
test('Resources artifact lost acknowledgement retains storage budget across rollback/retry', async () => {
  const map = new Map<string, Uint8Array>();
  let fail = true;
  const objects = {
    putIfAbsent: async (k: string, b: Uint8Array) => {
      map.set(k, b);
      if (fail) throw Error('fixture upload acknowledgement lost');
    },
    get: async (k: string) => {
      const b = map.get(k);
      if (!b) throw Error('missing');
      return b;
    },
    erase: async (k: string) => {
      map.delete(k);
    },
  };
  const service = new ArtifactService(ctxDb, objects),
    files = [{ path: 'file.txt', bytes: Buffer.from('storage quota fixture') }];
  await assert.rejects(
    service.capture(
      await f.actor('machine'),
      'resource-upload',
      'resource-computer',
      files,
    ),
  );
  const lease = (
    await admin.query(
      "SELECT * FROM ct.resource_reservations WHERE tenant='a' AND kind='artifact' AND id='resource-upload'",
    )
  ).rows[0];
  assert.equal(lease.state, 'UNCERTAIN');
  assert.equal(Number(lease.bytes), files[0].bytes.length);
  fail = false;
  await service.capture(
    await f.actor('machine'),
    'resource-upload',
    'resource-computer',
    files,
  );
  await service.erase(await f.actor('user'), 'resource-upload');
  await service.collect(await f.actor('user'));
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM ct.resource_reservations WHERE tenant='a' AND kind='artifact' AND id='resource-upload'",
      )
    ).rows[0].state,
    'SETTLED',
  );
});
test('Security product INSERT cannot fabricate terminal effect state', async () => {
  const { x } = await f.intent('resource-insert');
  const row = (
    await admin.query(
      "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
      [x.id],
    )
  ).rows[0];
  await assert.rejects(
    f.productDb.query(
      "INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,state) VALUES('a','fabricated',$1,$2,$3,$4,$5,$6,$7,1,'fixture','write','fixture-object',$8,$9,'fabricated',1,$10,'COMMITTED')",
      [
        row.principal,
        row.grant_id,
        row.epoch,
        row.generation,
        row.fence,
        row.grant_version,
        row.task_id,
        row.params,
        row.digest,
        row.deadline,
      ],
    ),
  );
});
test('Security logs exclude secret-bearing error messages', () => {
  const s = JSON.stringify(
    safeError(Error('Bearer fixture-secret-value token=do-not-save')),
  );
  assert.ok(!s.includes('fixture-secret-value'));
  assert.ok(s.includes('detailRedacted'));
});
test('Security bounded request budget prevents retry storms and unlimited identity entries', () => {
  const b = new RequestBudget(2, 100, 2);
  b.take('a', 0);
  b.take('a', 1);
  assert.throws(() => b.take('a', 2));
  b.take('b', 2);
  assert.throws(() => b.take('c', 2));
  b.take('a', 101);
});
test('Security staging assembly disabled; restricted roles/TLS required', () => {
  assert.throws(() =>
    validateStagingConfig({
      enabled: false,
      mode: 'approved-staging',
      approvalReference: null,
      humanIssuer: null,
      workloadIdentityRef: null,
      secretManagerRef: null,
      externalFenceRef: null,
      networkPolicyRef: null,
    }),
  );
  assert.throws(() =>
    stagingDatabase(
      {
        enabled: true,
        approvalReference: 'fixture',
        host: 'stage.invalid',
        database: 'stage',
        role: 'postgres',
        ca: 'fixture',
      },
      async () => {
        throw Error('must not ask for credentials');
      },
    ),
  );
});
test('Security expired provider read-back retention does not permit UNKNOWN resend', async () => {
  await admin.query(
    "UPDATE ct.computers SET state='RUNNING',revision=revision+1 WHERE tenant='a' AND id='resource-computer'",
  );
  const { x } = await f.intent('resource-stale-provider-key', true);
  f.provider.loseAck = true;
  const cap = await f.capability(x.id);
  assert.equal((await f.controller.dispatch(cap, x.id)).state, 'UNKNOWN');
  f.provider.loseAck = false;
  f.provider.unavailable = true;
  const sends = f.provider.sends;
  assert.equal((await f.controller.dispatch(cap, x.id)).state, 'UNKNOWN');
  assert.equal(f.provider.sends, sends);
  assert.equal((await f.controller.reconcile(cap, x.id)).state, 'UNKNOWN');
  f.provider.unavailable = false;
});
