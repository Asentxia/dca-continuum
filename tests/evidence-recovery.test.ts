import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fixture } from './implementation-helpers.js';
import { admin, gov, fence } from './helpers.js';
import { pool, bindingDigest, canonical, sha } from '../src/db.js';
import { LocalObjectStore } from '../src/object-store.js';
import {
  EvidenceExporter,
  verifyEvidenceBundle,
} from '../src/evidence-export.js';
import { LocalIndependentFenceStore } from '../src/fence-store.js';
import { RecoveryService } from '../src/recovery.js';
let f: Awaited<ReturnType<typeof fixture>>,
  exporter: EvidenceExporter,
  recovery: RecoveryService,
  store: LocalIndependentFenceStore,
  archive: any,
  run: any;
const expDb = pool('ct_evidence_export'),
  recDb = pool('ct_recovery');
let inventory: any[] = [];
let complete = true;
let journal: any[] = [];
let first: string, second: string;
before(async () => {
  f = await fixture('recovery');
  await admin.query(
    "INSERT INTO ct.computers(tenant,id,principal,generation,state) VALUES('a','recovery-computer',$1,1,'RUNNING')",
    [f.principal],
  );
  exporter = new EvidenceExporter(
    expDb,
    new LocalObjectStore(path.resolve('.local/recovery-anchors')),
  );
  store = new LocalIndependentFenceStore(
    path.resolve('.local/recovery-test-fence'),
  );
  await store.initialize({
    revision: 1,
    fence,
    blocked: false,
    authorityDigest: sha('[]'),
  });
  recovery = new RecoveryService(
    recDb,
    store,
    {
      supports: (o) => f.provider.supports(o),
      lookup: (o) => f.provider.lookup(o),
    },
    {
      authorizeOperator: async (a) => {
        if (a.subject !== 'recovery-owner-a' || a.kind !== 'user')
          throw Error('fixture independent cluster operator required');
      },
      readAuthorityJournal: async () => ({
        records: journal,
        digest: sha(canonical(journal)),
      }),
      readOperationInventory: async () => ({
        reference: 'fixture-sealed-independent-archive',
        operations: inventory,
        digest: sha(canonical(inventory)),
        complete,
      }),
      verifyActivationApproval: async (ref, digest) => {
        if (ref !== 'fixture-approved:' + digest)
          throw Error('independent exact manifest approval required');
      },
    },
  );
});
after(async () => {
  if (f) await f.close();
  await Promise.all([expDb.end(), recDb.end(), admin.end(), gov.end()]);
});
test('Evidence sealed consistent chain; machine cannot export private audit', async () => {
  const one = await f.intent('recovery-existing', true),
    two = await f.intent('recovery-missing', true);
  first = one.x.id;
  second = two.x.id;
  f.provider.loseAck = true;
  assert.equal(
    (await f.controller.dispatch(await f.capability(first), first)).state,
    'UNKNOWN',
  );
  assert.equal(
    (await f.controller.dispatch(await f.capability(second), second)).state,
    'UNKNOWN',
  );
  f.provider.loseAck = false;
  archive = await exporter.seal(await f.actor('user'));
  const bundle = await exporter.readSealed(archive.key, archive.digest);
  inventory = bundle.operations;
  assert.equal(bundle.operations.length, 2);
  assert.equal(
    (
      await exporter.comparePrefix(
        await f.actor('user'),
        archive.key,
        archive.digest,
      )
    ).prefixMatches,
    true,
  );
  await assert.rejects(exporter.seal(await f.actor('machine')));
});
test('Evidence altered chain or action binding cannot become a valid archive', async () => {
  const b = await exporter.readSealed(archive.key, archive.digest),
    bad = structuredClone(b);
  bad.events[0].payload = 'changed';
  assert.throws(() => verifyEvidenceBundle(bad));
  const altered = structuredClone(b);
  altered.operations[0].binding.params = { value: 'changed' };
  assert.throws(() => verifyEvidenceBundle(altered));
});
test('Recovery worker cannot initiate recovery; external CAS fences old deployment', async () => {
  await assert.rejects(recovery.begin(await f.actor('machine')));
  journal = [{ tenant: 'a', grant: 'g-' + first, version: 2 }];
  run = await recovery.begin(await f.actor('user'));
  await assert.rejects(store.assertActive(fence));
  await assert.rejects(store.advance(1, sha('[]')));
  assert.equal((await store.read()).blocked, true);
});
test('Recovery incomplete inventory blocks activation and never fabricates authority', async () => {
  complete = false;
  await assert.rejects(recovery.importInventory(await f.actor('user'), run.id));
  await assert.rejects(recovery.activate(await f.actor('user'), run.id, 'bad'));
  complete = true;
});
test('Recovery imports lost binding as UNKNOWN without write approval or second send', async () => {
  const saved = inventory;
  const forged = structuredClone(
    inventory.find((item) => item.binding.id === second),
  );
  forged.binding = {
    ...forged.binding,
    id: 'recovery-missing-computer',
    computerId: 'missing-computer',
  };
  forged.digest = sha(canonical(forged.binding));
  inventory = [forged];
  await assert.rejects(
    recovery.importInventory(await f.actor('user'), run.id),
    /missing historical computer record/,
  );
  inventory = saved;
  await admin.query(
    'DELETE FROM ct.assignments WHERE tenant=$1 AND operation=$2',
    ['a', second],
  );
  await admin.query(
    'DELETE FROM ct.task_operations WHERE tenant=$1 AND operation=$2',
    ['a', second],
  );
  await admin.query(
    'DELETE FROM ct.approvals WHERE tenant=$1 AND operation=$2',
    ['a', second],
  );
  await admin.query('DELETE FROM ct.outbox WHERE tenant=$1 AND operation=$2', [
    'a',
    second,
  ]);
  await admin.query('DELETE FROM ct.operations WHERE tenant=$1 AND id=$2', [
    'a',
    second,
  ]);
  assert.equal(
    await recovery.importInventory(await f.actor('user'), run.id),
    1,
  );
  const restored = (
    await admin.query(
      "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
      [second],
    )
  ).rows[0];
  assert.equal(restored.state, 'UNKNOWN');
  assert.equal(Number(restored.contract_version), 2);
  assert.equal(restored.computer_id, 'recovery-computer');
  assert.equal(Number(restored.placement_generation), 1);
  assert.equal(bindingDigest(restored), restored.digest);
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM ct.approvals WHERE tenant='a' AND operation=$1",
        [second],
      )
    ).rowCount,
    0,
  );
  assert.equal(f.provider.sends, 2);
});
test('Recovery missing/mismatched/duplicate observations keep UNKNOWN', async () => {
  f.provider.unavailable = true;
  assert.equal(
    (await recovery.observe(await f.actor('user'), run.id, first)).state,
    'UNKNOWN',
  );
  f.provider.unavailable = false;
  f.provider.corrupt = true;
  assert.equal(
    (await recovery.observe(await f.actor('user'), run.id, first)).state,
    'UNKNOWN',
  );
  f.provider.corrupt = false;
  const extra = { ...f.provider.rows[0] };
  f.provider.rows.push(extra);
  assert.equal(
    (await recovery.observe(await f.actor('user'), run.id, first)).state,
    'UNKNOWN',
  );
  f.provider.rows.pop();
});
test('Recovery independent revocation journal reapplied; read-only observation needs no revived grant', async () => {
  await recovery.applyAuthorityJournal(await f.actor('user'), run.id);
  assert.equal(
    (
      await admin.query(
        "SELECT revoked FROM ct.grants WHERE tenant='a' AND id=$1",
        ['g-' + first],
      )
    ).rows[0].revoked,
    true,
  );
  assert.equal(
    (await recovery.observe(await f.actor('user'), run.id, first)).state,
    'COMMITTED',
  );
  assert.equal(
    (await recovery.observe(await f.actor('user'), run.id, second)).state,
    'COMMITTED',
  );
  assert.equal(f.provider.sends, 2);
});
test('Recovery exact approval and complete cluster manifest required for activation', async () => {
  const m = await recovery.manifest(await f.actor('user'), run.id),
    digest = sha(canonical(m));
  await assert.rejects(
    recovery.activate(await f.actor('user'), run.id, 'not-exact'),
  );
  const activated = await recovery.activate(
    await f.actor('user'),
    run.id,
    'fixture-approved:' + digest,
  );
  await store.assertActive(activated.fence);
  assert.equal(f.provider.sends, 2);
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM ct.recovery_runs WHERE id=$1 AND state<>'COMPLETE'",
        [run.id],
      )
    ).rowCount,
    0,
  );
});
test('Recovery controller cannot use privileged backup-gap transition', async () => {
  const db = pool('ct_controller');
  try {
    await assert.rejects(
      db.query(
        "UPDATE ct.operations SET state='REQUESTED',version=version+1 WHERE tenant='a' AND id=$1",
        [first],
      ),
    );
  } finally {
    await db.end();
  }
});
