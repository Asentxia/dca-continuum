// Controlled CLI probe for tools/local-ha-pitr-lab.py. No real provider or identity credential.
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonical,
  sha,
  bindingDigest,
  actionBinding,
  tx,
  eventOutbox,
} from '../src/db.js';
import { EffectController } from '../src/controller.js';
import {
  LocalIndependentFenceStore,
  assertExternalFence,
} from '../src/fence-store.js';
import { RecoveryService } from '../src/recovery.js';
import type {
  ProviderAdapter,
  ProviderObservation,
} from '../src/provider-adapter.js';
import type { VerifiedIdentity } from '../src/identity-provider.js';
if (process.env.CT_LOCAL_DR_LAB !== 'yes')
  throw Error('local DR lab flag required');
const phase = process.argv[2],
  port = Number(process.argv[3]);
if (![55440, 55441, 55442].includes(port))
  throw Error('owned DR port required');
const root = path.resolve('.local/dr-lab/independent');
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const pools = new Map<string, pg.Pool>();
function db(user: string) {
  let p = pools.get(user);
  if (!p) {
    p = new pg.Pool({
      host: '127.0.0.1',
      port,
      user,
      database: 'ct_dr',
      connectionTimeoutMillis: 2500,
    });
    p.on('error', () => {});
    pools.set(user, p);
  }
  return p;
}
const fence = 'dr-before-restore',
  store = new LocalIndependentFenceStore(path.join(root, 'fence'));
const owner: VerifiedIdentity = {
  issuer: 'https://dr-fixture.invalid',
  subject: 'dr-owner',
  audience: 'urn:continuum:dr-fixture',
  kind: 'user',
  expires: Date.now() + 3600000,
  authTime: Date.now(),
  methods: ['mfa'],
};
const ledgerFile = path.join(root, 'provider-ledger.json'),
  journalFile = path.join(root, 'authority-journal.json');
async function ledger() {
  try {
    return JSON.parse(
      await fs.readFile(ledgerFile, 'utf8'),
    ) as ProviderObservation[];
  } catch {
    return [];
  }
}
const adapter: ProviderAdapter = {
  provider: 'fixture',
  supports: (o) =>
    o.provider === 'fixture' &&
    o.action === 'write' &&
    o.resource === 'fixture-object',
  send: async (o) => {
    const rows = await ledger();
    rows.push({
      tenant: o.tenant,
      operation: o.id,
      digest: o.digest,
      idempotency_key: o.idempotency_key,
      payload: o.params,
    });
    await fs.writeFile(ledgerFile, canonical(rows), { mode: 0o600 });
  },
  lookup: async (o) =>
    (await ledger()).filter(
      (x) => x.tenant === o.tenant && x.operation === o.id,
    ),
};
async function op(id: string, currentFence = fence) {
  return tx(db('ct_governor'), async (c) => {
    const p = (
        await c.query(
          "SELECT * FROM ct.principals WHERE tenant='dr' AND id='agent' FOR UPDATE",
        )
      ).rows[0],
      g = (
        await c.query(
          "SELECT * FROM ct.grants WHERE tenant='dr' AND id='dr-grant' FOR UPDATE",
        )
      ).rows[0];
    const x = {
      tenant: 'dr',
      id,
      principal: 'agent',
      grant_id: 'dr-grant',
      epoch: p.epoch,
      generation: p.generation,
      fence: currentFence,
      grant_version: g.version,
      task_id: 'dr-task-' + id,
      plan_version: 1,
      provider: 'fixture',
      action: 'write',
      resource: 'fixture-object',
      params: { value: id },
      idempotency_key: id,
      cost: 1,
      deadline: new Date(Date.now() + 3600000),
    };
    const digest = bindingDigest(x);
    await c.query(
      'INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        x.tenant,
        id,
        x.principal,
        x.grant_id,
        x.epoch,
        x.generation,
        x.fence,
        x.grant_version,
        x.task_id,
        x.plan_version,
        x.provider,
        x.action,
        x.resource,
        x.params,
        digest,
        x.idempotency_key,
        x.cost,
        x.deadline,
      ],
    );
    await c.query(
      "INSERT INTO ct.approvals(tenant,operation,digest,grant_version,approved_by,expires) VALUES('dr',$1,$2,$3,'fixture-independent-owner',now()+interval '1 hour')",
      [id, digest, g.version],
    );
    await eventOutbox(c, x, 'DR_OPERATION_CREATED', { id, digest });
    return { ...x, digest };
  });
}
async function cap(id: string, dep = fence) {
  const p = (
    await db('ct_governor').query(
      "SELECT * FROM ct.principals WHERE tenant='dr' AND id='agent'",
    )
  ).rows[0];
  return {
    tenant: 'dr',
    principal: 'agent',
    epoch: p.epoch,
    generation: p.generation,
    deploymentFence: dep,
    operations: [id],
    expires: Date.now() + 90000,
  };
}
const checks: any = {
  scope:
    'local PostgreSQL physical backup/streaming/PITR, offline identity/provider/fence fixtures',
  phase,
  port,
};
try {
  if (phase === 'seed') {
    const g = db('ct_governor');
    await g.query("INSERT INTO ct.tenants VALUES('dr')");
    await g.query("INSERT INTO ct.evidence_heads(tenant) VALUES('dr')");
    await g.query(
      "INSERT INTO ct.principals(tenant,id,epoch,generation) VALUES('dr','agent',1,1)",
    );
    await g.query(
      "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,domain_role) VALUES('dr-owner','https://dr-fixture.invalid','dr-owner','urn:continuum:dr-fixture','user','dr','owner')",
    );
    await g.query(
      "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget) VALUES('dr','dr-grant','agent','write','fixture-object',now()+interval '2 hours',5,50)",
    );
    await g.query('UPDATE ct.control SET blocked=false,fence=$1', [fence]);
    await op('dr-operation');
    const archived = (
      await g.query("SELECT * FROM ct.operations WHERE tenant='dr'")
    ).rows.map((o) => ({
      binding: actionBinding(o),
      digest: o.digest,
      state: o.state,
    }));
    await fs.writeFile(
      path.join(root, 'operation-inventory.json'),
      canonical(archived),
      { mode: 0o600 },
    );
    await fs.writeFile(ledgerFile, '[]', { mode: 0o600 });
    await fs.writeFile(journalFile, '[]', { mode: 0o600 });
    await store.initialize({
      revision: 1,
      fence,
      blocked: false,
      authorityDigest: sha('[]'),
    });
    checks.seeded = true;
  } else if (phase === 'send-revoke') {
    const ctl = new EffectController(
      db('ct_controller'),
      adapter,
      fence,
      100,
      {},
      (x) => assertExternalFence(store, x),
    );
    const r = await ctl.dispatch(await cap('dr-operation'), 'dr-operation');
    if (r.state !== 'COMMITTED') throw Error('fixture effect did not commit');
    await fs.writeFile(
      journalFile,
      canonical([{ tenant: 'dr', grant: 'dr-grant', version: 2 }]),
      { mode: 0o600 },
    );
    await db('ct_governor').query(
      "UPDATE ct.grants SET revoked=true,version=version+1 WHERE tenant='dr' AND id='dr-grant'",
    );
    checks.committed = true;
    checks.providerCount = (await ledger()).length;
  } else if (phase === 'failover-check') {
    const g = (
      await db('ct_governor').query(
        "SELECT revoked FROM ct.grants WHERE tenant='dr' AND id='dr-grant'",
      )
    ).rows[0];
    if (!g.revoked) throw Error('standby lost observed revocation');
    const x = await op('dr-after-failover');
    const ctl = new EffectController(
      db('ct_controller'),
      adapter,
      fence,
      100,
      {},
      (x) => assertExternalFence(store, x),
    );
    const r = await ctl.dispatch(await cap(x.id), x.id);
    if (r.state !== 'DENIED' || (await ledger()).length !== 1)
      throw Error('failover resurrected grant/effect');
    checks.revocationRetained = true;
    checks.noDuplicate = true;
  } else if (phase === 'block-before-restore') {
    const old = await store.read(),
      records = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    await store.advance(old.revision, sha(canonical(records)));
    checks.independentFenceAdvanced = true;
  } else if (phase === 'restore-check') {
    const g = (
      await db('ct_governor').query(
        "SELECT revoked FROM ct.grants WHERE tenant='dr' AND id='dr-grant'",
      )
    ).rows[0];
    const o = (
      await db('ct_governor').query(
        "SELECT state FROM ct.operations WHERE tenant='dr' AND id='dr-operation'",
      )
    ).rows[0];
    if (g.revoked || o.state !== 'REQUESTED')
      throw Error('PITR did not reach the intended before-effect point');
    checks.deliberatelyRestoredOldAuthority = true;
    const oldCtl = new EffectController(
      db('ct_controller'),
      adapter,
      fence,
      100,
      {},
      (x) => assertExternalFence(store, x),
    );
    let rejected = false;
    try {
      await oldCtl.dispatch(await cap('dr-operation'), 'dr-operation');
    } catch {
      rejected = true;
    }
    if (!rejected || (await ledger()).length !== 1)
      throw Error('external fence failed');
    checks.oldDeploymentRejectedWithoutResend = true;
    const recovery = new RecoveryService(
      db('ct_recovery'),
      store,
      { supports: adapter.supports, lookup: adapter.lookup },
      {
        authorizeOperator: async (a) => {
          if (a.subject !== 'dr-owner')
            throw Error('fixture operator required');
        },
        readAuthorityJournal: async () => {
          const records = JSON.parse(await fs.readFile(journalFile, 'utf8'));
          return { records, digest: sha(canonical(records)) };
        },
        readOperationInventory: async () => {
          const operations = JSON.parse(
            await fs.readFile(
              path.join(root, 'operation-inventory.json'),
              'utf8',
            ),
          );
          return {
            operations,
            digest: sha(canonical(operations)),
            reference: 'fixture-independent-operation-journal',
            complete: true,
          };
        },
        verifyActivationApproval: async (ref, digest) => {
          if (ref !== 'fixture-approval/' + digest)
            throw Error('fixture exact approval required');
        },
      },
    );
    const run = await recovery.begin(owner);
    checks.suspects = await recovery.markBackupGap(owner, run.id);
    await recovery.importInventory(owner, run.id);
    await recovery.applyAuthorityJournal(owner, run.id);
    if (
      (await recovery.observe(owner, run.id, 'dr-operation')).state !==
      'COMMITTED'
    )
      throw Error('read-only provider gap not reconciled');
    const manifest = await recovery.manifest(owner, run.id);
    const active = await recovery.activate(
      owner,
      run.id,
      'fixture-approval/' + sha(canonical(manifest)),
    );
    const revoked = (
      await db('ct_governor').query(
        "SELECT revoked FROM ct.grants WHERE tenant='dr' AND id='dr-grant'",
      )
    ).rows[0].revoked;
    if (!revoked) throw Error('restored revocation not reapplied');
    const fresh = await op('dr-after-restore', active.fence);
    const ctl = new EffectController(
      db('ct_controller'),
      adapter,
      active.fence,
      100,
      {},
      (x) => assertExternalFence(store, x),
    );
    if (
      (await ctl.dispatch(await cap(fresh.id, active.fence), fresh.id))
        .state !== 'DENIED' ||
      (await ledger()).length !== 1
    )
      throw Error('old authority resurrected after activation');
    checks.revocationReapplied = true;
    checks.gapVerifiedWithoutResend = true;
    checks.noDuplicate = true;
  } else throw Error('unknown DR phase');
  console.log(JSON.stringify(checks));
} finally {
  await Promise.all([...pools.values()].map((p) => p.end()));
}
