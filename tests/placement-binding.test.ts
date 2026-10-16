import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPair, exportJWK } from 'jose';
import { setTimeout as delay } from 'node:timers/promises';
import {
  actionBinding,
  bindingDigest,
  canonical,
  contractVersionOf,
  pool,
  sha,
} from '../src/db.js';
import { issueCapability, verifyCapability } from '../src/capability.js';
import {
  CapabilitySigner,
  PublicCapabilityVerifier,
} from '../src/production-capability.js';
import { ComputerService, type Placement } from '../src/computers.js';
import { EffectController } from '../src/controller.js';
import { verifyOperationArchive } from '../src/evidence-export.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence, gov } from './helpers.js';
import { randomBytes } from 'node:crypto';

const v1Canonical =
  '{"action":"write","contractVersion":1,"cost":1,"deadline":"2026-01-01T00:00:00.000Z","epoch":1,"fence":"fixture-fence-v1","generation":1,"grantId":"grant","grantVersion":1,"id":"op-vector","idempotencyKey":"op-vector","params":{"value":"vector"},"planVersion":1,"principal":"vera","provider":"fixture","resource":"fixture-object","taskId":"task","tenant":"a"}';
const v2Canonical =
  '{"action":"write","computerId":"logical-computer","contractVersion":2,"cost":1,"deadline":"2026-01-01T00:00:00.000Z","epoch":1,"fence":"fixture-fence-v1","generation":1,"grantId":"grant","grantVersion":1,"id":"op-vector","idempotencyKey":"op-vector","params":{"value":"vector"},"placementGeneration":1,"planVersion":1,"principal":"vera","provider":"fixture","resource":"fixture-object","taskId":"task","tenant":"a"}';
const vectorRow = {
  tenant: 'a',
  id: 'op-vector',
  principal: 'vera',
  epoch: 1,
  generation: 1,
  fence: 'fixture-fence-v1',
  grant_id: 'grant',
  grant_version: 1,
  task_id: 'task',
  plan_version: 1,
  provider: 'fixture',
  action: 'write',
  resource: 'fixture-object',
  params: { value: 'vector' },
  idempotency_key: 'op-vector',
  cost: 1,
  deadline: '2026-01-01T00:00:00.000Z',
};

after(async () => {
  await admin.end();
  await gov.end();
});

function psql(database: string, args: string[]) {
  const result = spawnSync(
    'psql',
    ['-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function driver() {
  const placements = new Map<string, Placement>();
  return {
    async start(s: {
      generation: number;
      tenant: string;
      computer: string;
      principal: string;
      requestId: string;
    }) {
      const placed: Placement = {
        id: `placement-${s.computer}-${s.generation}`,
        tenant: s.tenant,
        computer: s.computer,
        generation: s.generation,
        status: 'RUNNING',
      };
      placements.set(placed.id, placed);
      return placed;
    },
    async inspect(id: string) {
      const found = placements.get(id);
      if (!found) throw Error('missing placement');
      return found;
    },
    async stop(id: string) {
      placements.delete(id);
    },
  };
}

test('version selection keeps version 1 digest bytes and rejects invalid combinations', async () => {
  const v1 = actionBinding(vectorRow);
  const v2 = actionBinding({
    ...vectorRow,
    contract_version: 2,
    computer_id: 'logical-computer',
    placement_generation: 1,
  });
  assert.equal(canonical(v1), v1Canonical);
  assert.equal(sha(v1Canonical), bindingDigest(vectorRow));
  assert.equal(
    bindingDigest(vectorRow),
    'f9f96afb8d33b5202ec459e4b5d0e16b63b8e9a0744e3567fbe30f7797546897',
  );
  assert.equal(canonical(v2), v2Canonical);
  assert.equal(
    bindingDigest({
      ...vectorRow,
      contract_version: 2,
      computer_id: 'logical-computer',
      placement_generation: 1,
    }),
    'f67bec337487cada2254607ee5acab75a88f0de2e068cca2e9defaf3f8140518',
  );
  assert.equal(contractVersionOf(vectorRow), 1);
  assert.throws(
    () => actionBinding({ ...vectorRow, contract_version: 3 }),
    /invalid contract binding/,
  );
  assert.throws(
    () => actionBinding({ ...vectorRow, contract_version: 4 }),
    /invalid contract binding/,
  );
  assert.throws(
    () => actionBinding({ ...vectorRow, contract_version: 5 }),
    /invalid contract version/,
  );
  assert.throws(
    () =>
      actionBinding({
        ...vectorRow,
        contract_version: 1,
        computer_id: 'logical-computer',
      }),
    /invalid contract binding/,
  );
  assert.throws(
    () => actionBinding({ ...vectorRow, contract_version: 2 }),
    /invalid contract binding/,
  );
  const archived = verifyOperationArchive({
    binding: v1,
    digest: sha(canonical(v1)),
    state: 'REQUESTED',
  });
  assert.equal(bindingDigest(archived), sha(canonical(v1)));
  assert.equal('computerId' in actionBinding(archived), false);
  const archivedV2 = verifyOperationArchive({
    binding: v2,
    digest: sha(canonical(v2)),
    state: 'REQUESTED',
  });
  assert.equal(canonical(actionBinding(archivedV2)), v2Canonical);

  const f = await fixture('placement-vector');
  try {
    const first = await f.intent('placement-vector-replay');
    const again = await f.product.propose(await f.actor('machine'), first.x);
    assert.equal(again.reused, true);
    assert.equal(again.digest, first.op.digest);
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [first.x.id],
      )
    ).rows[0];
    assert.equal(Number(stored.contract_version), 1);
    assert.equal(stored.computer_id, null);
    assert.equal(bindingDigest(stored), stored.digest);
    assert.equal(
      canonical(actionBinding(stored)).includes('"contractVersion":1'),
      true,
    );
    assert.equal(
      canonical(actionBinding(stored)).includes('computerId'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('database binding is immutable and placement loss does not move the VERA', async () => {
  const f = await fixture('placement-fence');
  const broker = pool('ct_computer_broker');
  const product = pool('ct_product_api');
  const controller = pool('ct_controller');
  const tenant = pool('ct_tenant_a');
  const computers = new ComputerService(broker, driver(), fence);
  try {
    const owner = await f.actor('user');
    await gov.query(
      'UPDATE ct.principals SET generation=4 WHERE tenant=$1 AND id=$2',
      ['a', f.principal],
    );
    const legacy = await f.intent('placement-fence-legacy');
    const before = (
      await admin.query(
        "SELECT digest FROM ct.operations WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      )
    ).rows[0].digest;
    const registered = await computers.register(
      owner,
      'fence-computer',
      f.principal,
    );
    assert.equal(registered.generation, 1);
    const principal = (
      await admin.query(
        'SELECT id,generation,epoch FROM ct.principals WHERE tenant=$1 AND id=$2',
        ['a', f.principal],
      )
    ).rows[0];
    assert.equal(principal.id, f.principal);
    assert.equal(Number(principal.generation), 4);
    await computers.start(owner, 'fence-computer');
    const lost = await computers.lose(owner, 'fence-computer');
    assert.equal(lost.id, 'fence-computer');
    assert.equal(Number(lost.generation), 2);
    assert.equal(lost.state, 'LOST');
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT generation FROM ct.principals WHERE tenant=$1 AND id=$2',
            ['a', f.principal],
          )
        ).rows[0].generation,
      ),
      4,
    );
    await assert.rejects(
      admin.query(
        "UPDATE ct.computers SET generation=generation-1,revision=revision+1 WHERE tenant='a' AND id='fence-computer'",
      ),
      /immutable computer\/CAS fence/,
    );
    await assert.rejects(
      admin.query(
        "UPDATE ct.computers SET revision=revision WHERE tenant='a' AND id='fence-computer'",
      ),
      /immutable computer\/CAS fence/,
    );
    await assert.rejects(
      admin.query(
        "UPDATE ct.computers SET tenant='b',revision=revision+1 WHERE tenant='a' AND id='fence-computer'",
      ),
      /immutable computer\/CAS fence/,
    );
    await assert.rejects(
      broker.query(
        'UPDATE ct.principals SET generation=generation+1 WHERE tenant=$1 AND id=$2',
        ['a', f.principal],
      ),
    );
    await assert.rejects(
      admin.query(
        "UPDATE ct.operations SET computer_id='fence-computer',placement_generation=2,contract_version=2,version=version+1 WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      ),
      /immutable operation binding/,
    );
    await assert.rejects(
      product.query(
        "UPDATE ct.operations SET computer_id='fence-computer' WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      ),
    );
    await assert.rejects(
      controller.query(
        "UPDATE ct.operations SET placement_generation=2 WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      ),
    );
    await assert.rejects(
      tenant.query(
        "INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) VALUES('a','worker-insert',$1,'g-placement-fence-legacy',1,4,'fixture-fence-v1',1,'t-placement-fence-legacy',1,'fixture','write','fixture-object','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','worker-insert',1,now())",
        [f.principal],
      ),
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,computer_id,contract_version) SELECT tenant,'half-binding',principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,'half-binding',cost,deadline,'fence-computer',2 FROM ct.operations WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      ),
    );
    assert.equal(
      (
        await admin.query(
          "SELECT digest FROM ct.operations WHERE tenant='a' AND id=$1",
          [legacy.x.id],
        )
      ).rows[0].digest,
      before,
    );
    await computers.register(
      await f.actor('user', 'b'),
      'foreign-computer',
      f.principal,
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,computer_id,placement_generation,contract_version) SELECT 'a','cross-tenant',principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,'cross-tenant',cost,deadline,'foreign-computer',1,2 FROM ct.operations WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      ),
    );
    const writers = (
      await admin.query(
        "SELECT grantee FROM information_schema.column_privileges WHERE table_schema='ct' AND table_name='operations' AND column_name='computer_id' AND privilege_type IN('INSERT','UPDATE')",
      )
    ).rows.map((row) => row.grantee);
    for (const role of [
      'ct_controller',
      'ct_tenant_a',
      'ct_tenant_b',
      'ct_computer_broker',
    ])
      assert.equal(writers.includes(role), false, role);
  } finally {
    await broker.end();
    await product.end();
    await controller.end();
    await tenant.end();
    await f.close();
  }
});

test('upgrade preserves historical rows and a repeated migration does not rewrite them', async () => {
  psql('postgres', [
    '-c',
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ct_placement_upgrade' AND pid<>pg_backend_pid()",
  ]);
  spawnSync('dropdb', ['--if-exists', 'ct_placement_upgrade'], {
    encoding: 'utf8',
  });
  const created = spawnSync('createdb', ['ct_placement_upgrade'], {
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  try {
    for (const file of [
      '001-foundation.sql',
      '002-lock-privileges.sql',
      '004-monotonic-fences.sql',
      '005-identity-authority.sql',
      '006-product-computers.sql',
      '007-context-artifacts.sql',
      '008-recovery-controls.sql',
      '009-runtime-trigger-permissions.sql',
      '010-resource-controls.sql',
      '011-console-domain.sql',
      '012-tenant-identity-fks.sql',
      '013-recovery-import-guard.sql',
      '014-recovery-observation-guard.sql',
      '015-regency-foundation.sql',
    ])
      psql('ct_placement_upgrade', ['-f', `migrations/${file}`]);
    const historical = {
      ...vectorRow,
      id: 'historical-op',
      principal: 'historical-vera',
      grant_id: 'historical-grant',
      task_id: 'historical-task',
      idempotency_key: 'historical-op',
    };
    const digest = bindingDigest(historical);
    psql('ct_placement_upgrade', [
      '-c',
      "INSERT INTO ct.tenants VALUES('a')",
      '-c',
      "INSERT INTO ct.principals VALUES('a','historical-vera',1,4,true)",
      '-c',
      "INSERT INTO ct.computers VALUES('a','historical-computer','historical-vera',4,'STOPPED')",
      '-c',
      "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget) VALUES('a','historical-grant','historical-vera','write','fixture-object',now()+interval '1 day',5,20)",
      '-c',
      `INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) VALUES('a','historical-op','historical-vera','historical-grant',1,1,'fixture-fence-v1',1,'historical-task',1,'fixture','write','fixture-object','{"value":"vector"}','${digest}','historical-op',1,'2026-01-01T00:00:00Z')`,
    ]);
    psql('ct_placement_upgrade', [
      '-f',
      'migrations/016-placement-generation.sql',
    ]);
    psql('ct_placement_upgrade', [
      '-f',
      'migrations/016-placement-generation.sql',
    ]);
    const snapshot = psql('ct_placement_upgrade', [
      '-At',
      '-F',
      '|',
      '-c',
      "SELECT o.digest,o.contract_version,COALESCE(o.computer_id,'<null>'),COALESCE(o.placement_generation::text,'<null>'),c.id,c.generation,p.id,p.generation,(SELECT count(*) FROM ct.operations) FROM ct.operations o, ct.computers c, ct.principals p",
    ]).trim();
    assert.equal(
      snapshot,
      `${digest}|1|<null>|<null>|historical-computer|4|historical-vera|4|1`,
    );
  } finally {
    psql('postgres', [
      '-c',
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ct_placement_upgrade' AND pid<>pg_backend_pid()",
    ]);
    spawnSync('dropdb', ['--if-exists', 'ct_placement_upgrade'], {
      encoding: 'utf8',
    });
  }
});

test('same operation id conflicts across placement and a stale claim cannot propose', async () => {
  const f = await fixture('placement-conflict');
  const broker = pool('ct_computer_broker');
  const computers = new ComputerService(broker, driver(), fence);
  try {
    const owner = await f.actor('user');
    const raced = await Promise.allSettled([
      computers.register(owner, 'conflict-computer', f.principal),
      computers.register(owner, 'other-computer', f.principal),
    ]);
    const won = raced.find((item) => item.status === 'fulfilled');
    assert.equal(won?.status, 'fulfilled');
    if (won?.status !== 'fulfilled') return;
    assert.equal(won.value.generation, 1);
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT generation FROM ct.principals WHERE tenant=$1 AND id=$2',
            ['a', f.principal],
          )
        ).rows[0].generation,
      ),
      1,
    );
    const computerId = won.value.id;
    await computers.start(owner, computerId);
    const first = await f.intent('placement-same', true);
    const replay = await f.product.propose(await f.actor('machine'), first.x);
    assert.equal(replay.reused, true);
    assert.equal(replay.digest, first.op.digest);
    const hold = await broker.connect();
    await hold.query('BEGIN');
    await hold.query(
      'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', f.principal],
    );
    const pending = computers.lose(owner, computerId);
    let waiting = 0;
    for (let n = 0; n < 50 && waiting === 0; n++) {
      await delay(100);
      waiting = Number(
        (
          await admin.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname='ct_test' AND wait_event_type='Lock' AND wait_event='transactionid' AND state='active' AND query LIKE 'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE%'",
          )
        ).rows[0].n,
      );
    }
    assert.equal(waiting > 0, true);
    await hold.query('COMMIT');
    const lost = await pending;
    hold.release();
    assert.equal(Number(lost.generation), 2);
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT generation FROM ct.principals WHERE tenant=$1 AND id=$2',
            ['a', f.principal],
          )
        ).rows[0].generation,
      ),
      1,
    );
    const stale = await f.machine.verify(
      await f.token('machine', 'a', { ct_placement: 1 }),
    );
    await assert.rejects(
      f.product.propose(stale, { ...first.x, id: 'placement-stale' }),
      /stale placement claim/,
    );
    await assert.rejects(
      f.product.propose(await f.actor('machine'), first.x),
      /operation identity conflict/,
    );
    const row = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [first.x.id],
      )
    ).rows[0];
    assert.equal(row.digest, first.op.digest);
    assert.equal(Number(row.placement_generation), 1);
    assert.equal(row.state, 'REQUESTED');
    assert.equal(f.provider.sends, 0);
  } finally {
    await broker.end();
    await f.close();
  }
});

test('legacy version 1 cannot be renewed or sent after registration', async () => {
  const f = await fixture('placement-legacy');
  const broker = pool('ct_computer_broker');
  const computers = new ComputerService(broker, driver(), fence);
  try {
    const legacy = await f.intent('legacy-requested', true);
    const cap = await f.capability(legacy.x.id);
    assert.equal(cap.placementGeneration, undefined);
    const approval = (
      await admin.query(
        "SELECT digest FROM ct.approvals WHERE tenant='a' AND operation=$1",
        [legacy.x.id],
      )
    ).rows[0].digest;
    const owner = await f.actor('user');
    await computers.register(owner, 'legacy-computer', f.principal);
    await computers.start(owner, 'legacy-computer');
    await assert.rejects(
      f.authority.renew(await f.actor('machine'), legacy.x.id),
      /current authority\/assignment denied/,
    );
    await assert.rejects(
      f.authority.renew(
        await f.machine.verify(await f.token('machine', 'a', { ct_gen: 99 })),
        legacy.x.id,
      ),
      /current authority\/assignment denied/,
    );
    await assert.rejects(
      f.authority.renew(
        await f.machine.verify(await f.token('machine', 'a', { ct_epoch: 9 })),
        legacy.x.id,
      ),
      /current authority\/assignment denied/,
    );
    assert.equal(
      (await f.controller.dispatch(cap, legacy.x.id)).state,
      'DENIED',
    );
    const fresh = await f.intent('legacy-enrollment', true);
    const issued = await f.capability(fresh.x.id);
    assert.equal(
      (
        await f.controller.dispatch(
          { ...issued, identityVersion: 99 },
          fresh.x.id,
        )
      ).state,
      'DENIED',
    );
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [legacy.x.id],
      )
    ).rows[0];
    assert.equal(stored.digest, legacy.op.digest);
    assert.equal(Number(stored.contract_version), 1);
    assert.equal(stored.computer_id, null);
    assert.equal(
      (
        await admin.query(
          "SELECT digest FROM ct.approvals WHERE tenant='a' AND operation=$1",
          [legacy.x.id],
        )
      ).rows[0].digest,
      approval,
    );
    assert.equal(f.provider.sends, 0);
  } finally {
    await broker.end();
    await f.close();
  }
});

test('version 1 UNKNOWN reconciles after replacement without a second send or substitute', async () => {
  const f = await fixture('placement-unknown');
  const broker = pool('ct_computer_broker');
  const computers = new ComputerService(broker, driver(), fence);
  try {
    const uncertain = await f.intent('legacy-unknown', true);
    const issued = await f.capability(uncertain.x.id);
    const digest = uncertain.op.digest;
    f.provider.loseAck = true;
    assert.equal(
      (await f.controller.dispatch(issued, uncertain.x.id)).state,
      'UNKNOWN',
    );
    assert.equal(f.provider.sends, 1);
    const owner = await f.actor('user');
    await computers.register(owner, 'unknown-computer', f.principal);
    await computers.start(owner, 'unknown-computer');
    await computers.lose(owner, 'unknown-computer');
    await computers.start(owner, 'unknown-computer');
    await assert.rejects(
      f.product.propose(await f.actor('machine'), {
        ...uncertain.x,
        id: 'legacy-substitute',
      }),
      /no substitute operation/,
    );
    assert.equal(
      (await f.controller.reconcile(issued, uncertain.x.id)).state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 1);
    assert.equal(
      f.provider.rows.filter((row) => row.operation === uncertain.x.id).length,
      1,
    );
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [uncertain.x.id],
      )
    ).rows[0];
    assert.equal(stored.digest, digest);
    assert.equal(Number(stored.contract_version), 1);
    assert.equal(stored.state, 'COMMITTED');
    await assert.rejects(
      f.controller.reconcile({ ...issued, expires: 1 }, uncertain.x.id),
      /capability scope/,
    );
    assert.equal(f.provider.sends, 1);
  } finally {
    await broker.end();
    await f.close();
  }
});

test('version 2 read-back sends once and loss before the final admission sends nothing', async () => {
  const f = await fixture('placement-send');
  const broker = pool('ct_computer_broker');
  const computers = new ComputerService(broker, driver(), fence);
  try {
    const owner = await f.actor('user');
    await computers.register(owner, 'send-computer', f.principal);
    await computers.start(owner, 'send-computer');
    const interrupted = await f.intent('send-interrupted', true);
    const cap = await f.capability(interrupted.x.id);
    assert.equal(cap.placementGeneration, 1);
    const ctl = new EffectController(f.controllerDb, f.provider, fence, 30000, {
      afterReservation: async () => {
        await computers.lose(owner, 'send-computer');
      },
    });
    assert.equal((await ctl.dispatch(cap, interrupted.x.id)).state, 'DENIED');
    assert.equal(f.provider.sends, 0);
    await computers.start(owner, 'send-computer');
    const fresh = await f.intent('send-fresh', true);
    assert.equal(
      (await f.controller.dispatch(await f.capability(fresh.x.id), fresh.x.id))
        .state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 1);
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [fresh.x.id],
      )
    ).rows[0];
    assert.equal(stored.computer_id, 'send-computer');
    assert.equal(Number(stored.placement_generation), 2);
    assert.equal(Number(stored.contract_version), 2);
    assert.equal(bindingDigest(stored), stored.digest);
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT id,generation FROM ct.principals WHERE tenant=$1 AND id=$2',
            ['a', f.principal],
          )
        ).rows[0].generation,
      ),
      1,
    );
  } finally {
    await broker.end();
    await f.close();
  }
});

test('placement claims, cross-tenant scope, and approval evidence stay exact', async () => {
  assert.throws(
    () =>
      verifyCapability(
        'fixture-secret',
        issueCapability('fixture-secret', {
          deploymentFence: fence,
          tenant: 'a',
          principal: 'vera',
          epoch: 1,
          generation: 1,
          placementGeneration: 0,
          operations: ['op'],
          expires: Date.now() + 60000,
        }),
      ),
    /invalid\/expired capability/,
  );
  for (const placementGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      verifyCapability(
        'fixture-secret',
        issueCapability('fixture-secret', {
          deploymentFence: fence,
          tenant: 'a',
          principal: 'vera',
          epoch: 1,
          generation: 1,
          placementGeneration,
          operations: ['op'],
          expires: Date.now() + 60000,
        }),
      ),
    );
  const omitted = verifyCapability(
    'fixture-secret',
    issueCapability('fixture-secret', {
      deploymentFence: fence,
      tenant: 'a',
      principal: 'vera',
      epoch: 1,
      generation: 1,
      operations: ['op'],
      expires: Date.now() + 60000,
    }),
  );
  assert.equal(omitted.placementGeneration, undefined);
  const keys = await generateKeyPair('EdDSA');
  const signer = new CapabilitySigner(
    keys.privateKey,
    'cap',
    'https://placement.test-cap.invalid',
  );
  const verifier = new PublicCapabilityVerifier(
    {
      keys: [
        {
          ...(await exportJWK(keys.publicKey)),
          alg: 'EdDSA',
          kid: 'cap',
          use: 'sig',
        },
      ],
    },
    'https://placement.test-cap.invalid',
  );
  const base = {
    deploymentFence: fence,
    tenant: 'a',
    principal: 'vera',
    epoch: 1,
    generation: 1,
    operations: ['op'],
    expires: Date.now() + 60000,
  };
  assert.equal(
    (
      await verifier.verify(
        await signer.sign({ ...base, placementGeneration: 2 }, 'worker'),
      )
    ).placementGeneration,
    2,
  );
  await assert.rejects(
    verifier.verify(
      await signer.sign({ ...base, placementGeneration: 0 }, 'worker'),
    ),
    /invalid scoped capability/,
  );
  const f = await fixture('placement-view');
  const broker = pool('ct_computer_broker');
  const computers = new ComputerService(broker, driver(), fence);
  const reader = pool('ct_console_reader');
  const reads = new ConsoleReads(
    reader,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    'placement-test',
    fence,
  );
  try {
    await assert.rejects(
      f.machine.verify(await f.token('machine', 'a', { ct_placement: 0 })),
      /invalid workload binding/,
    );
    const historical = await f.intent('view-historical');
    const owner = await f.actor('user');
    const historicalView = await reads.read(owner, 'operation', {
      id: historical.x.id,
    });
    assert.equal(historicalView.items[0].fields.computerId, undefined);
    assert.equal(historicalView.items[0].fields.placementGeneration, undefined);
    assert.equal(historicalView.items[0].fields.principalGeneration, 1);
    assert.equal(
      JSON.stringify(historicalView.items[0].fields.canonicalBinding).includes(
        'computerId',
      ),
      false,
    );
    await computers.register(owner, 'view-computer', f.principal);
    await computers.start(owner, 'view-computer');
    await assert.rejects(
      computers.authorizePlacement(
        await f.actor('machine', 'b'),
        'view-computer',
        'placement-view-computer-1',
        1,
      ),
      /placement generation denied/,
    );
    const bound = await f.intent('view-bound', true);
    const view = await reads.read(owner, 'approvals', { id: bound.x.id });
    assert.equal(view.items[0].fields.computerId, 'view-computer');
    assert.equal(view.items[0].fields.placementGeneration, 1);
    assert.equal(
      (view.items[0].fields.canonicalBinding as { computerId?: string })
        .computerId,
      'view-computer',
    );
    assert.equal(
      (
        view.items[0].fields.canonicalBinding as {
          placementGeneration?: number;
        }
      ).placementGeneration,
      1,
    );
  } finally {
    await reader.end();
    await broker.end();
    await f.close();
  }
});
