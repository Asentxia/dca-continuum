import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPair, exportJWK } from 'jose';
import { admin, gov, bootstrap, fence, state } from './helpers.js';
import { pool, tx, bindingDigest, eventOutbox } from '../src/db.js';
import {
  CapabilitySigner,
  PublicCapabilityVerifier,
} from '../src/production-capability.js';
import { EffectController } from '../src/controller.js';
import {
  GitHubReadOnlyAdapter,
  safeRepository,
} from '../src/providers/github-readonly.js';
import type { ProviderAdapter } from '../src/provider-adapter.js';
const db = pool('ct_controller');
let signer: CapabilitySigner, verifier: PublicCapabilityVerifier;
const observations: Array<unknown> = [];
async function readOp(id: string, opts: Record<string, any> = {}) {
  return tx(gov, async (c) => {
    const p = (
      await c.query(
        "SELECT * FROM ct.principals WHERE tenant='a' AND id='agent'",
      )
    ).rows[0];
    const resource = `repo:${safeRepository.owner}/${safeRepository.repo}@${safeRepository.commit}`;
    await c.query(
      "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget,approval_required) VALUES('a',$1,'agent','readCommit',$2,now()+interval '1 hour',0,0,true)",
      ['g-' + id, resource],
    );
    const o = {
      tenant: 'a',
      id,
      principal: 'agent',
      grant_id: 'g-' + id,
      epoch: p.epoch,
      generation: p.generation,
      fence,
      grant_version: 1,
      task_id: 'task-' + id,
      plan_version: 1,
      provider: 'github-public-readonly',
      action: 'readCommit',
      resource,
      params: { ...safeRepository },
      idempotency_key: id,
      cost: 0,
      deadline: new Date(Date.now() + 3600000),
    };
    const digest = bindingDigest(o);
    await c.query(
      'INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        o.tenant,
        o.id,
        o.principal,
        o.grant_id,
        o.epoch,
        o.generation,
        o.fence,
        o.grant_version,
        o.task_id,
        o.plan_version,
        o.provider,
        o.action,
        o.resource,
        o.params,
        digest,
        o.idempotency_key,
        o.cost,
        o.deadline,
      ],
    );
    await c.query(
      "INSERT INTO ct.approvals(tenant,operation,digest,grant_version,approved_by,expires) VALUES('a',$1,$2,1,'test-owner',now()+interval '1 hour')",
      [id, digest],
    );
    await eventOutbox(c, o, 'OPERATION_CREATED', { id, digest });
    return { ...o, digest };
  });
}
async function actor(o: Record<string, any>) {
  return verifier.verify(
    await signer.sign(
      {
        deploymentFence: fence,
        tenant: 'a',
        principal: 'agent',
        epoch: o.epoch,
        generation: o.generation,
        operations: [o.id],
        expires: Date.now() + 60000,
      },
      'provider-machine',
    ),
  );
}
before(async () => {
  await bootstrap();
  await gov.query(
    "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role) VALUES('provider-machine','https://provider-test.invalid','fixture','urn:provider-test','machine','a','agent','worker')",
  );
  const kp = await generateKeyPair('EdDSA');
  signer = new CapabilitySigner(
    kp.privateKey,
    'provider-test',
    'https://cap.qualification.invalid',
  );
  verifier = new PublicCapabilityVerifier(
    {
      keys: [
        {
          ...(await exportJWK(kp.publicKey)),
          alg: 'EdDSA',
          use: 'sig',
          kid: 'provider-test',
        },
      ],
    },
    'https://cap.qualification.invalid',
  );
});
after(async () => {
  fs.writeFileSync(
    '.artifacts/qualification/REAL-PROVIDER-REQUESTS.json',
    JSON.stringify(
      {
        action:
          'Public immutable commit read only; no provider mutation/idempotency window',
        observations,
      },
      null,
      2,
    ),
  );
  await Promise.all([db, admin, gov].map((p) => p.end()));
});
test('Real GitHub safe read completes through domain controller and matching second endpoint', async () => {
  const o = await readOp('pq-real-success');
  const adapter = new GitHubReadOnlyAdapter();
  const c = new EffectController(db, adapter, fence);
  assert.equal((await c.dispatch(await actor(o), o.id)).state, 'COMMITTED');
  assert.equal(adapter.evidence.length, 2);
  assert.ok(
    adapter.evidence.every((e) => e.status === 200 && e.method === 'GET'),
  );
  observations.push({ case: 'success', requests: adapter.evidence });
});
test('Real GitHub acknowledgement discarded after response => UNKNOWN, no resend, authoritative reconciliation', async () => {
  const o = await readOp('pq-real-lost-ack');
  const real = new GitHubReadOnlyAdapter();
  let sends = 0;
  const wrapped: ProviderAdapter = {
    provider: real.provider,
    supports: (x) => real.supports(x),
    send: async (x) => {
      sends++;
      await real.send(x);
      throw Error('test-only discard after real provider response');
    },
    lookup: (x) => real.lookup(x),
  };
  const c = new EffectController(db, wrapped, fence);
  const a = await actor(o);
  assert.equal((await c.dispatch(a, o.id)).state, 'UNKNOWN');
  await c.dispatch(a, o.id);
  await c.dispatch(a, o.id);
  assert.equal(sends, 1);
  assert.equal((await c.reconcile(a, o.id)).state, 'COMMITTED');
  observations.push({
    case: 'client-discarded-ack',
    sends,
    requests: real.evidence,
  });
});
test('Real GitHub request with deliberately tiny timeout => UNKNOWN; independent read-back resolves', async () => {
  const o = await readOp('pq-real-timeout');
  const timeout = new GitHubReadOnlyAdapter(1),
    readback = new GitHubReadOnlyAdapter();
  let sends = 0;
  const wrapped: ProviderAdapter = {
    provider: timeout.provider,
    supports: (x) => timeout.supports(x),
    send: async (x) => {
      sends++;
      await timeout.send(x);
    },
    lookup: (x) => readback.lookup(x),
  };
  const c = new EffectController(db, wrapped, fence);
  const a = await actor(o);
  assert.equal((await c.dispatch(a, o.id)).state, 'UNKNOWN');
  assert.equal((await c.dispatch(a, o.id)).state, 'UNKNOWN');
  assert.equal(sends, 1);
  assert.equal((await c.reconcile(a, o.id)).state, 'COMMITTED');
  observations.push({
    case: 'client-timeout',
    sends,
    requests: timeout.evidence,
    readback: readback.evidence,
    limit:
      'No claim the timed-out first request reached GitHub; immutable read contract allows fresh verification.',
  });
});
test('UNKNOWN readback outage/mismatch remains UNKNOWN and dispatch never sends again', async () => {
  const o = await readOp('pq-real-unverified');
  const real = new GitHubReadOnlyAdapter();
  let sends = 0;
  let allowed = false;
  const wrapped: ProviderAdapter = {
    provider: real.provider,
    supports: (x) => real.supports(x),
    send: async (x) => {
      sends++;
      await real.send(x);
    },
    lookup: async (x) => {
      if (!allowed) throw Error('test-only unavailable verifier');
      return real.lookup(x);
    },
  };
  const c = new EffectController(db, wrapped, fence),
    a = await actor(o);
  assert.equal((await c.dispatch(a, o.id)).state, 'UNKNOWN');
  assert.equal((await c.reconcile(a, o.id)).state, 'UNKNOWN');
  await c.dispatch(a, o.id);
  assert.equal(sends, 1);
  allowed = true;
  assert.equal((await c.reconcile(a, o.id)).state, 'COMMITTED');
  observations.push({
    case: 'real-read-then-injected-readback-outage',
    sends,
    requests: real.evidence,
  });
});
test('Safe adapter refuses URL/resource/repository mutation and stale capability before provider send', async () => {
  const adapter = new GitHubReadOnlyAdapter();
  const o = await readOp('pq-real-stale-cap');
  assert.equal(
    adapter.supports({
      ...o,
      params: { ...o.params, url: 'http://169.254.169.254' },
    }),
    false,
  );
  assert.equal(adapter.supports({ ...o, action: 'delete' }), false);
  await assert.rejects(
    new EffectController(db, adapter, fence).dispatch(
      { ...(await actor(o)), expires: 0 },
      o.id,
    ),
  );
  assert.equal(adapter.evidence.length, 0);
  observations.push({
    case: 'stale-capability-and-input-refusal',
    requests: 0,
  });
});
test('Stale idempotency-key payload reuse denied by immutable domain; provider key expiration is not applicable to GET', async () => {
  const o = await readOp('pq-real-key-binding');
  await assert.rejects(
    admin.query(
      'UPDATE ct.operations SET params=$2,version=version+1 WHERE id=$1',
      [o.id, { ...safeRepository, commit: '0'.repeat(40) }],
    ),
    /immutable/,
  );
  observations.push({
    case: 'idempotency-binding',
    bindingRejected: true,
    providerWindow:
      'NOT APPLICABLE: read-only GET never uses a provider mutation key; write-provider stale-key gate NOT RUN',
  });
});
