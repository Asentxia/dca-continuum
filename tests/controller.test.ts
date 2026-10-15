import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  admin,
  gov,
  bootstrap,
  makeOp,
  revoke,
  state,
  count,
  fence,
} from './helpers.js';
import { pool, sha, canonical, tx } from '../src/db.js';
import { EffectController } from '../src/controller.js';
import { FixtureAdapter } from '../internal/fixtures/provider-adapter.js';
import { unshareIsolated } from '../internal/fixtures/fixture-priv.js';
import { callController } from '../src/controller-client.js';
import { verifyCapability } from '../src/capability.js';
import { readLegacyM3Context as readContext } from '../internal/fixtures/legacy-memory-probe.js';
import { secrets, capability, config, start, stop } from './process-helpers.js';
const socket = process.cwd() + '/.local/controller.sock';
const ctlDb = pool('ct_controller');
let provider: ChildProcess, controller: ChildProcess;
const actor = (id: string, opts: Record<string, unknown> = {}) =>
  verifyCapability(secrets.capabilitySecret, capability([id], opts));
const adapter = new FixtureAdapter(
  'http://127.0.0.1:56670',
  secrets.providerSecret,
);
before(async () => {
  await bootstrap();
  fs.chmodSync('.local/pgsocket', 0o700);
  fs.chmodSync('.local/domain-backup.dump', 0o600);
  config('.local/provider.json', { loseAck: ['m3-lost-ack'] });
  provider = await start(
    'dist/tests/provider-emulator.js',
    '.local/provider.json',
    'M3-provider',
  );
  config('.local/controller.json', { socket, leaseMs: 150 });
  controller = await start(
    'dist/tests/controller-process.js',
    '.local/controller.json',
    'M3-controller',
  );
});
after(async () => {
  await stop(controller);
  await stop(provider);
  await ctlDb.end();
  await admin.end();
  await gov.end();
});
test('M3 exact approved action commits once across concurrent duplicates', async () => {
  await makeOp('m3-duplicate');
  const cap = capability(['m3-duplicate']);
  await Promise.all(
    Array.from({ length: 20 }, () =>
      callController(socket, cap, 'm3-duplicate'),
    ),
  );
  assert.equal((await state('m3-duplicate')).state, 'COMMITTED');
  assert.equal(await count('m3-duplicate'), 1);
});
test('M3 missing/mismatched approval is denied with zero effects', async () => {
  for (const [id, opts] of [
    ['m3-no-approval', { approve: false }],
    ['m3-wrong-approval', { approvalDigest: '0'.repeat(64) }],
  ] as const) {
    await makeOp(id, opts);
    assert.equal(
      (await callController(socket, capability([id]), id)).state,
      'DENIED',
    );
    assert.equal(await count(id), 0);
  }
});
test('M3 provider fixture errors do not disclose internal exception details', async () => {
  const response = await fetch('http://127.0.0.1:56670/unsupported', {
    headers: { authorization: 'Bearer ' + secrets.providerSecret },
  });
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Provider fixture request failed');
});
test('M3 stale grant, epoch, generation, deadline, scope and cost deny', async () => {
  for (const [id, opts] of [
    ['m3-epoch', { epoch: 0 }],
    ['m3-generation', { generation: 0 }],
    ['m3-deadline', { deadline: new Date(0) }],
    ['m3-scope', { resource: 'wrong' }],
    ['m3-cost', { cost: 6 }],
  ] as const) {
    await makeOp(id, opts);
    assert.equal(
      (await callController(socket, capability([id]), id)).state,
      'DENIED',
    );
    assert.equal(await count(id), 0);
  }
  const o = await makeOp('m3-revoked');
  await revoke(o);
  assert.equal(
    (await callController(socket, capability([o.id]), o.id)).state,
    'DENIED',
  );
  await makeOp('m3-expired');
  await gov.query(
    "UPDATE ct.grants SET expires=now()-interval '1 second',version=version+1 WHERE id='g-m3-expired'",
  );
  assert.equal(
    (await callController(socket, capability(['m3-expired']), 'm3-expired'))
      .state,
    'DENIED',
  );
});
test('M3 revocation between reservation and final send denies', async () => {
  const o = await makeOp('m3-revoke-race');
  const ctl = new EffectController(ctlDb, adapter, fence, 1000, {
    afterReservation: async () => revoke(o),
  });
  assert.equal((await ctl.dispatch(actor(o.id), o.id)).state, 'DENIED');
  assert.equal(await count(o.id), 0);
});
test('M3 expiry during final-send lock wait denies (regression)', async () => {
  const id = 'm3-expiry-lock';
  await makeOp(id, { expires: new Date(Date.now() + 180) });
  const ctl = new EffectController(ctlDb, adapter, fence, 30000, {
    afterReservation: async () => {
      const c = await gov.connect();
      await c.query('BEGIN');
      await c.query(
        "SELECT * FROM ct.principals WHERE tenant='a' AND id='agent' FOR UPDATE",
      );
      setTimeout(async () => {
        await c.query('COMMIT');
        c.release();
      }, 240);
    },
  });
  assert.equal((await ctl.dispatch(actor(id), id)).state, 'DENIED');
  assert.equal(await count(id), 0);
});
test('M3 budget reservations serialize concurrent independent operations', async () => {
  await makeOp('m3-budget-one', { grant: 'shared-budget', cost: 1, budget: 1 });
  await makeOp('m3-budget-two', { grant: 'shared-budget', cost: 1, budget: 1 });
  const cap = capability(['m3-budget-one', 'm3-budget-two']);
  const r = await Promise.all(
    ['m3-budget-one', 'm3-budget-two'].map((id) =>
      callController(socket, cap, id),
    ),
  );
  assert.deepEqual(r.map((x) => x.state).sort(), ['COMMITTED', 'DENIED']);
  assert.equal(
    (await count('m3-budget-one')) + (await count('m3-budget-two')),
    1,
  );
});
test('M3 lost acknowledgement becomes UNKNOWN, never auto-resends, readback recovers', async () => {
  const id = 'm3-lost-ack';
  await makeOp(id);
  const cap = capability([id]);
  assert.equal((await callController(socket, cap, id)).state, 'UNKNOWN');
  for (let n = 0; n < 5; n++)
    assert.equal((await callController(socket, cap, id)).state, 'UNKNOWN');
  assert.equal(await count(id), 1);
  assert.equal(
    (await callController(socket, cap, id, '/reconcile')).state,
    'COMMITTED',
  );
  assert.equal(await count(id), 1);
});
test('M3 kill whole controller at three boundaries; durable state prevents second sends', async () => {
  for (const fault of ['afterReservation', 'beforeSend', 'afterSend']) {
    const id = 'm3-kill-' + fault;
    await makeOp(id);
    const sock = process.cwd() + '/.local/fault.sock';
    config('.local/fault.json', { socket: sock, leaseMs: 150, fault });
    const p = await start(
      'dist/tests/controller-process.js',
      '.local/fault.json',
      'M3-fault-' + fault,
    );
    await assert.rejects(callController(sock, capability([id]), id));
    await stop(p);
    await new Promise((r) => setTimeout(r, 180));
    const retry = await callController(socket, capability([id]), id);
    assert.equal(retry.state, 'UNKNOWN');
    const result = await callController(
      socket,
      capability([id]),
      id,
      '/reconcile',
    );
    assert.equal(result.state, fault === 'afterSend' ? 'COMMITTED' : 'UNKNOWN');
    assert.equal(await count(id), fault === 'afterSend' ? 1 : 0);
  }
});
test('M3 duplicate idempotency key/immutable payload conflict never sends', async () => {
  await makeOp('m3-key-one', { key: 'same-key' });
  await assert.rejects(
    makeOp('m3-key-two', { key: 'same-key', params: { value: 'changed' } }),
    { code: '23505' },
  );
  assert.equal(await count('m3-key-two'), 0);
});
test('M3 unknown with missing or mismatched provider evidence stays unknown', async () => {
  const id = 'm3-mismatch';
  await makeOp(id);
  await admin.query(
    "UPDATE ct.operations SET state='RESERVED',version=version+1,lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await admin.query(
    "UPDATE ct.operations SET state='UNKNOWN',version=version+1 WHERE id=$1",
    [id],
  );
  await admin.query(
    "INSERT INTO provider.effects(tenant,operation,digest,idempotency_key,payload) VALUES('a',$1,'forged',$1,'{}')",
    [id],
  );
  assert.equal(
    (await callController(socket, capability([id]), id, '/reconcile')).state,
    'UNKNOWN',
  );
});
test('M3 expired uncertain operation resolves UNKNOWN before deployment fence', async () => {
  const id = 'm3-expired-fenced';
  await makeOp(id);
  await admin.query(
    "UPDATE ct.operations SET state='RESERVED',version=version+1,lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  let guardCalls = 0;
  const ctl = new EffectController(
    ctlDb,
    adapter,
    fence,
    30000,
    {},
    async () => {
      guardCalls++;
      throw Error('stale deployment');
    },
  );
  assert.equal((await ctl.dispatch(actor(id), id)).state, 'UNKNOWN');
  assert.equal(guardCalls, 0);

  const requestedId = 'm3-requested-fenced';
  await makeOp(requestedId);
  await assert.rejects(ctl.dispatch(actor(requestedId), requestedId), {
    message: 'stale deployment',
  });
  assert.equal(guardCalls, 1);
  assert.equal((await state(requestedId)).state, 'REQUESTED');
  assert.equal(await count(requestedId), 0);
});
test('M3 restored/no-fence and wrong deployment fence fail closed', async () => {
  const id = 'm3-fence';
  await makeOp(id);
  const wrong = new EffectController(ctlDb, adapter, 'different-fence');
  assert.equal((await wrong.dispatch(actor(id), id)).state, 'DENIED');
  assert.equal(await count(id), 0);
  const restored = pool('ct_controller', 'ct_restore');
  try {
    const ctl = new EffectController(restored, adapter, fence);
    assert.equal(
      (await ctl.dispatch(actor('m2-b', { tenant: 'b' }), 'm2-b')).state,
      'DENIED',
    );
  } finally {
    await restored.end();
  }
});
test('M3 isolated compromised agent cannot reach provider/DB/secrets or forge completion', async () => {
  const id = 'm3-isolated';
  await makeOp(id);
  const cfg = {
    socket,
    operation: id,
    capability: capability([id]),
    secretPath: process.cwd() + '/.local/controller.json',
    pgSocket: process.cwd() + '/.local/pgsocket/.s.PGSQL.55432',
  };
  const r = spawnSync(
    'sudo',
    unshareIsolated(65534, [
      '/usr/bin/env',
      'PROBE_CONFIG=' + JSON.stringify(cfg),
      process.execPath,
      process.cwd() + '/tests/isolation-probe.mjs',
    ]),
    {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  fs.writeFileSync('.artifacts/core/M3-isolation-result.json', r.stdout);
  assert.equal(r.status, 0, r.stderr + ' ' + r.stdout);
  assert.equal(JSON.parse(r.stdout).uid, 65534);
  assert.equal(await count(id), 1);
});
test('M3 tenant memory stale/digest corruption never becomes accepted context', async () => {
  await gov.query(
    "INSERT INTO ct.context_items VALUES('a','memory-a',1,'untrusted text',$1,false),('b','memory-b',1,'foreign',$2,false)",
    [sha('untrusted text'), sha('foreign')],
  );
  const p = pool('ct_tenant_a');
  try {
    assert.equal(
      (await readContext(p, 'memory-a', 1)).payload,
      'untrusted text',
    );
    await assert.rejects(readContext(p, 'memory-b', 1));
    await assert.rejects(readContext(p, 'memory-a', 2));
    await gov.query(
      "UPDATE ct.context_items SET payload='corrupt' WHERE tenant='a' AND id='memory-a'",
    );
    await assert.rejects(readContext(p, 'memory-a', 1));
  } finally {
    await p.end();
  }
});
test('M3 evidence detects privileged tampering; valid chain not provider truth', async () => {
  await tx(admin, async (c) => {
    await c.query(
      'ALTER TABLE ct.evidence_events DISABLE TRIGGER evidence_immutable',
    );
    const e = (
      await c.query(
        "SELECT * FROM ct.evidence_events WHERE tenant='a' ORDER BY seq LIMIT 1",
      )
    ).rows[0];
    await c.query(
      "UPDATE ct.evidence_events SET payload='tampered' WHERE tenant='a' AND seq=$1",
      [e.seq],
    );
    const changed = (
      await c.query(
        "SELECT * FROM ct.evidence_events WHERE tenant='a' AND seq=$1",
        [e.seq],
      )
    ).rows[0];
    assert.notEqual(
      changed.hash,
      sha(
        canonical({
          tenant: 'a',
          seq: Number(changed.seq),
          kind: changed.kind,
          payload: changed.payload,
          prev: changed.prev_hash,
        }),
      ),
    );
    await c.query('ROLLBACK');
  });
});
