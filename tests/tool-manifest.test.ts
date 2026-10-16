import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import {
  actionBinding,
  bindingDigest,
  canonical,
  manifestAdmission,
  pool,
  sha,
  tx,
} from '../src/db.js';
import { lockBoundManifest } from '../src/context-lock.js';
import { ContextService } from '../src/context-service.js';
import { CognitionService } from '../src/cognition-service.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import { productApi } from '../src/product-api.js';
import {
  rowFromBinding,
  verifyOperationArchive,
} from '../src/evidence-export.js';
import { LocalIndependentFenceStore } from '../src/fence-store.js';
import { RecoveryService } from '../src/recovery.js';
import { fixture } from './implementation-helpers.js';
import { admin, bootstrap, fence, gov } from './helpers.js';

const v1Canonical =
  '{"action":"write","contractVersion":1,"cost":1,"deadline":"2026-01-01T00:00:00.000Z","epoch":1,"fence":"fixture-fence-v1","generation":1,"grantId":"grant","grantVersion":1,"id":"op-vector","idempotencyKey":"op-vector","params":{"value":"vector"},"planVersion":1,"principal":"vera","provider":"fixture","resource":"fixture-object","taskId":"task","tenant":"a"}';
const v2Canonical =
  '{"action":"write","computerId":"logical-computer","contractVersion":2,"cost":1,"deadline":"2026-01-01T00:00:00.000Z","epoch":1,"fence":"fixture-fence-v1","generation":1,"grantId":"grant","grantVersion":1,"id":"op-vector","idempotencyKey":"op-vector","params":{"value":"vector"},"placementGeneration":1,"planVersion":1,"principal":"vera","provider":"fixture","resource":"fixture-object","taskId":"task","tenant":"a"}';
const v3Canonical =
  '{"action":"write","cognitionRevision":2,"computerId":"logical-computer","contextId":"item","contextVersion":1,"contractVersion":3,"cost":1,"deadline":"2026-01-01T00:00:00.000Z","epoch":1,"fence":"fixture-fence-v1","generation":1,"grantId":"grant","grantVersion":1,"id":"op-vector","idempotencyKey":"op-vector","params":{"value":"vector"},"placementGeneration":1,"planVersion":1,"principal":"vera","provider":"fixture","resource":"fixture-object","taskId":"task","tenant":"a"}';
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
const priorMigrations = [
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
  '016-placement-generation.sql',
  '017-context-cognition-binding.sql',
  '018-tenant-notice-projection.sql',
  '019-task-mandate-admission.sql',
];
const contextDb = pool('ct_context_service');
const contexts = new ContextService(contextDb);
const cognition = new CognitionService(gov);

after(async () => {
  await contextDb.end();
  await admin.end();
  await gov.end();
});

function psql(database: string, args: string[]) {
  const result = spawnSync(
    'psql',
    ['-d', database, '-q', '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function rejected(database: string, sql: string) {
  return spawnSync(
    'psql',
    ['-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );
}

function database(name: string) {
  psql('postgres', [
    '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${name}' AND pid<>pg_backend_pid()`,
  ]);
  spawnSync('dropdb', ['--if-exists', name], { encoding: 'utf8' });
  assert.equal(spawnSync('createdb', [name], { encoding: 'utf8' }).status, 0);
}

async function waitAdvisory(like: string) {
  for (let n = 0; n < 80; n++) {
    const found = (
      await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND state='active' AND query LIKE $1",
        [like],
      )
    ).rows[0].n;
    if (found > 0) return;
    await delay(50);
  }
  assert.fail('expected advisory lock wait ' + like);
}

async function denial(id: string) {
  const row = (
    await admin.query(
      "SELECT payload FROM ct.evidence_events WHERE tenant='a' AND kind='EFFECT_DENIED' AND payload LIKE $1 ORDER BY seq DESC LIMIT 1",
      ['%' + id + '%'],
    )
  ).rows[0];
  return JSON.parse(row.payload).detail.reason as string;
}

async function publish(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  tool?: string,
) {
  const owner = await f.actor('user');
  const actor = await f.actor('machine');
  const deadline = new Date(Date.now() + 3600000).toISOString();
  await f.authority.createGrant(owner, {
    id: 'g-' + id,
    principal: f.principal,
    action: 'write',
    resource: 'fixture-object',
    expires: deadline,
    maxCost: 5,
    budget: 20,
  });
  await f.product.createTask(actor, {
    id: 't-' + id,
    principal: f.principal,
    objective: 'Tool ' + id,
    deadline,
    ...f.admission.a,
  });
  const x = {
    id,
    task: 't-' + id,
    grant: 'g-' + id,
    provider: 'fixture',
    action: 'write',
    resource: 'fixture-object',
    params: { value: id },
    cost: 1,
    deadline,
    ...(tool ? { tool } : {}),
  };
  const op = await f.product.propose(actor, x);
  await f.authority.assign(owner, {
    identity: f.prefix + '-worker-a',
    operation: id,
    expires: deadline,
  });
  await f.authority.approve(owner, {
    operation: id,
    digest: op.digest,
    expires: deadline,
  });
  const cap = await f.caps.verify((await f.authority.renew(actor, id)).token);
  return { x, op, cap, actor, owner };
}

async function authorityCounts() {
  const row = (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM ct.grants) AS grants,(SELECT count(*)::int FROM ct.approvals) AS approvals,(SELECT count(*)::int FROM ct.operations) AS operations,(SELECT coalesce(string_agg(id||':'||digest,',' ORDER BY tenant,id),'') AS digests FROM ct.operations)",
    )
  ).rows[0];
  return {
    grants: row.grants as number,
    approvals: row.approvals as number,
    operations: row.operations as number,
    digests: row.digests as string,
  };
}

test('migration 020 preserves version 1, 2, and 3 rows and rejects tool revision defects', async () => {
  assert.equal(canonical(actionBinding(vectorRow)), v1Canonical);
  assert.equal(
    sha(v1Canonical),
    'f9f96afb8d33b5202ec459e4b5d0e16b63b8e9a0744e3567fbe30f7797546897',
  );
  assert.equal(
    canonical(
      actionBinding({
        ...vectorRow,
        contract_version: 2,
        computer_id: 'logical-computer',
        placement_generation: 1,
      }),
    ),
    v2Canonical,
  );
  assert.equal(
    canonical(
      actionBinding({
        ...vectorRow,
        contract_version: 3,
        computer_id: 'logical-computer',
        placement_generation: 1,
        context_id: 'item',
        context_version: 1,
        cognition_revision: 2,
      }),
    ),
    v3Canonical,
  );
  assert.equal(v1Canonical.includes('toolId'), false);
  assert.equal(v2Canonical.includes('toolId'), false);
  assert.equal(v3Canonical.includes('toolId'), false);
  const name = 'ct_tool_upgrade';
  database(name);
  try {
    for (const file of priorMigrations)
      psql(name, ['-f', `migrations/${file}`]);
    const base = {
      ...vectorRow,
      principal: 'historical-vera',
      grant_id: 'historical-grant',
      task_id: 'historical-task',
    };
    const v1 = { ...base, id: 'hist-v1', idempotency_key: 'hist-v1' };
    const v2 = {
      ...base,
      id: 'hist-v2',
      idempotency_key: 'hist-v2',
      contract_version: 2,
      computer_id: 'hist-computer',
      placement_generation: 1,
    };
    const v3 = {
      ...base,
      id: 'hist-v3',
      idempotency_key: 'hist-v3',
      contract_version: 3,
      computer_id: 'hist-computer',
      placement_generation: 1,
      context_id: 'hist-item',
      context_version: 1,
      cognition_revision: 1,
    };
    const digest = sha('historical-definition');
    psql(name, [
      '-c',
      `BEGIN;
       INSERT INTO ct.tenants VALUES('a');
       INSERT INTO ct.principals VALUES('a','historical-vera',1,1,true);
       INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget) VALUES('a','historical-grant','historical-vera','write','fixture-object',now()+interval '1 day',5,20);
       INSERT INTO ct.computers(tenant,id,principal,generation,state) VALUES('a','hist-computer','historical-vera',1,'RUNNING');
       INSERT INTO ct.context_heads(tenant,id,principal) VALUES('a','hist-item','historical-vera');
       INSERT INTO ct.context_versions(tenant,id,version,principal,payload,digest,source,observed_at,expires) VALUES('a','hist-item',1,'historical-vera','historical','${digest}','{"kind":"document"}',now(),now()+interval '1 day');
       UPDATE ct.context_heads SET version=1 WHERE tenant='a' AND id='hist-item';
       INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES('a','historical-vera',1,'fixture','historical-model','historical-config','UNKNOWN');
       INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,contract_version) VALUES
        ('a','hist-v1','historical-vera','historical-grant',1,1,'fixture-fence-v1',1,'historical-task',1,'fixture','write','fixture-object','{"value":"vector"}','${bindingDigest(v1)}','hist-v1',1,'2026-01-01T00:00:00Z',1);
       INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,contract_version,computer_id,placement_generation) VALUES
        ('a','hist-v2','historical-vera','historical-grant',1,1,'fixture-fence-v1',1,'historical-task',1,'fixture','write','fixture-object','{"value":"vector"}','${bindingDigest(v2)}','hist-v2',1,'2026-01-01T00:00:00Z',2,'hist-computer',1);
       INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,contract_version,computer_id,placement_generation,context_id,context_version,cognition_revision) VALUES
        ('a','hist-v3','historical-vera','historical-grant',1,1,'fixture-fence-v1',1,'historical-task',1,'fixture','write','fixture-object','{"value":"vector"}','${bindingDigest(v3)}','hist-v3',1,'2026-01-01T00:00:00Z',3,'hist-computer',1,'hist-item',1,1);
       COMMIT;`,
    ]);
    const before = psql(name, [
      '-At',
      '-c',
      "SELECT id||'|'||digest||'|'||contract_version||'|'||COALESCE(computer_id,'<null>')||'|'||COALESCE(placement_generation::text,'<null>')||'|'||COALESCE(context_id,'<null>')||'|'||COALESCE(context_version::text,'<null>')||'|'||COALESCE(cognition_revision::text,'<null>') FROM ct.operations ORDER BY id",
    ]).trim();
    psql(name, ['-f', 'migrations/020-tool-manifest.sql']);
    const after = psql(name, [
      '-At',
      '-c',
      "SELECT id||'|'||digest||'|'||contract_version||'|'||COALESCE(computer_id,'<null>')||'|'||COALESCE(placement_generation::text,'<null>')||'|'||COALESCE(context_id,'<null>')||'|'||COALESCE(context_version::text,'<null>')||'|'||COALESCE(cognition_revision::text,'<null>')||'|'||COALESCE(tool_id,'<null>')||'|'||COALESCE(tool_revision::text,'<null>') FROM ct.operations ORDER BY id",
    ]).trim();
    assert.equal(
      after,
      before
        .split('\n')
        .map((row) => row + '|<null>|<null>')
        .join('\n'),
    );
    psql(name, [
      '-c',
      `INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES('a','ledger','${digest}')`,
    ]);
    for (const version of [1, 2, 3]) {
      const row = rejected(
        name,
        `INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,contract_version,computer_id,placement_generation,context_id,context_version,cognition_revision,tool_id,tool_revision)
         SELECT tenant,'tool-on-'||id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,'tool-on-'||id,cost,deadline,contract_version,computer_id,placement_generation,context_id,context_version,cognition_revision,'ledger',1 FROM ct.operations WHERE id='hist-v${version}'`,
      );
      assert.notEqual(row.status, 0, row.stdout);
      assert.match(row.stderr, /operations_binding_version/);
    }
    const changed = rejected(
      name,
      "UPDATE ct.operations SET tool_id='ledger',tool_revision=1 WHERE id='hist-v1'",
    );
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /immutable operation binding/);
    const zero = rejected(
      name,
      `INSERT INTO ct.tool_manifests(tenant,tool_id,revision,definition_digest) VALUES('a','sequence',0,'${digest}')`,
    );
    assert.notEqual(zero.status, 0);
    assert.match(zero.stderr, /tool revision/);
    const gap = rejected(
      name,
      `INSERT INTO ct.tool_manifests(tenant,tool_id,revision,definition_digest) VALUES('a','sequence',2,'${sha('gap')}')`,
    );
    assert.notEqual(gap.status, 0);
    assert.match(gap.stderr, /tool revision sequence/);
    assert.equal(
      psql(name, [
        '-At',
        '-c',
        `INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES('a','sequence','${sha('next')}') RETURNING revision`,
      ]).trim(),
      '1',
    );
    const skipped = rejected(
      name,
      `INSERT INTO ct.tool_manifests(tenant,tool_id,revision,definition_digest) VALUES('a','sequence',3,'${sha('skip')}')`,
    );
    assert.notEqual(skipped.status, 0);
    assert.match(skipped.stderr, /tool revision sequence/);
    assert.equal(
      psql(name, [
        '-At',
        '-c',
        `INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES('a','sequence','${sha('second')}') RETURNING revision`,
      ]).trim(),
      '2',
    );
    for (const sql of [
      "UPDATE ct.tool_manifests SET definition_digest=definition_digest WHERE tool_id='sequence'",
      "DELETE FROM ct.tool_manifests WHERE tool_id='sequence'",
    ]) {
      const blocked = rejected(name, sql);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /tool manifest append only/);
    }
    const worker = rejected(
      name,
      `BEGIN; SET LOCAL ROLE ct_product_api; INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES('a','worker','${digest}'); COMMIT;`,
    );
    assert.notEqual(worker.status, 0);
    assert.match(worker.stderr, /permission denied/);
    const call = rejected(
      name,
      `BEGIN; SET LOCAL ROLE ct_product_api; SELECT ct.append_tool_manifest('a','worker','${digest}'); COMMIT;`,
    );
    assert.notEqual(call.status, 0);
    assert.match(call.stderr, /permission denied/);
  } finally {
    spawnSync('dropdb', ['--if-exists', name], { encoding: 'utf8' });
  }
});

test('a proposal that names a tool stores version 4 and conflicts on another binding', async () => {
  const f = await fixture('tool-propose');
  const reader = pool('ct_console_reader');
  const reads = new ConsoleReads(
    reader,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    'tool-propose',
    fence,
  );
  const definition = sha('definition-not-copied');
  try {
    assert.equal(
      Number(
        (
          await gov.query('SELECT ct.append_tool_manifest($1,$2,$3) AS n', [
            'a',
            'ledger',
            definition,
          ])
        ).rows[0].n,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          await gov.query('SELECT ct.append_tool_manifest($1,$2,$3) AS n', [
            'a',
            'other-ledger',
            sha('other-definition'),
          ])
        ).rows[0].n,
      ),
      1,
    );
    const first = await publish(f, 'tool-op', 'ledger');
    const stored = (
      await admin.query(
        'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2',
        ['a', 'tool-op'],
      )
    ).rows[0];
    assert.equal(Number(stored.contract_version), 4);
    assert.equal(stored.tool_id, 'ledger');
    assert.equal(Number(stored.tool_revision), 1);
    assert.equal(stored.cognition_revision, null);
    const encoded = canonical(actionBinding(stored));
    assert.equal(encoded.includes('"toolId":"ledger"'), true);
    assert.equal(encoded.includes('"toolRevision":1'), true);
    assert.equal(encoded.includes(definition), false);
    assert.equal(stored.digest, first.op.digest);
    assert.equal(stored.digest, sha(encoded));
    const again = await f.product.propose(first.actor, first.x);
    assert.equal(again.reused, true);
    assert.equal(again.id, stored.id);
    assert.equal(again.digest, stored.digest);
    assert.equal(again.state, stored.state);
    const callerRevision = await f.product.propose(first.actor, {
      ...first.x,
      id: 'tool-server-revision',
      task: 't-tool-op',
      grant: 'g-tool-op',
      toolRevision: 99,
    } as typeof first.x);
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT tool_revision FROM ct.operations WHERE id='tool-server-revision'",
          )
        ).rows[0].tool_revision,
      ),
      1,
    );
    assert.notEqual(callerRevision.digest, '');
    await assert.rejects(
      f.product.propose(first.actor, { ...first.x, tool: 'other-ledger' }),
      /operation identity conflict/,
    );
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'ledger',
      sha('later-definition'),
    ]);
    await assert.rejects(
      f.product.propose(first.actor, first.x),
      /operation identity conflict/,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM ct.operations WHERE id='tool-op'",
          )
        ).rows[0].n,
      ),
      1,
    );
    assert.equal(f.provider.sends, 0);
    await cognition.record(first.owner, {
      principal: f.principal,
      provider: 'fixture',
      model: 'tool-model',
      configurationReference: 'tool-config',
      compatibility: 'UNKNOWN',
    });
    const both = await publish(f, 'tool-and-cognition', 'ledger');
    const combined = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id='tool-and-cognition'",
      )
    ).rows[0];
    assert.equal(Number(combined.contract_version), 4);
    assert.equal(Number(combined.cognition_revision), 1);
    assert.equal(Number(combined.tool_revision), 2);
    assert.equal(
      canonical(actionBinding(combined)).includes('"cognitionRevision":1'),
      true,
    );
    assert.equal(combined.digest, both.op.digest);
    const plain = await publish(f, 'tool-absent');
    const version3 = (
      await admin.query(
        "SELECT contract_version,tool_id,cognition_revision,digest FROM ct.operations WHERE id='tool-absent'",
      )
    ).rows[0];
    assert.equal(Number(version3.contract_version), 3);
    assert.equal(version3.tool_id, null);
    assert.equal(version3.digest, plain.op.digest);
    const view = await reads.read(first.owner, 'operation', { id: 'tool-op' });
    assert.equal(view.items[0].fields.toolId, 'ledger');
    assert.equal(view.items[0].fields.toolRevision, 1);
    assert.equal(
      (view.items[0].fields.canonicalBinding as { toolRevision?: number })
        .toolRevision,
      1,
    );
    const api = productApi(f.machine, f.product);
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    try {
      const deadline = new Date(Date.now() + 3600000).toISOString();
      await f.authority.createGrant(first.owner, {
        id: 'g-http-tool',
        principal: f.principal,
        action: 'write',
        resource: 'fixture-object',
        expires: deadline,
        maxCost: 5,
        budget: 20,
      });
      await f.product.createTask(first.actor, {
        id: 't-http-tool',
        principal: f.principal,
        objective: 'HTTP tool binding',
        deadline,
        ...f.admission.a,
      });
      const address = api.address() as { port: number };
      const ok = await fetch(
        'http://127.0.0.1:' + address.port + '/operations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + (await f.token('machine')),
          },
          body: JSON.stringify({
            id: 'http-tool-op',
            task: 't-http-tool',
            grant: 'g-http-tool',
            provider: 'fixture',
            action: 'write',
            resource: 'fixture-object',
            params: { value: 'http' },
            cost: 1,
            deadline,
            tool: 'ledger',
          }),
        },
      );
      assert.equal(ok.status, 200);
      const extra = await fetch(
        'http://127.0.0.1:' + address.port + '/operations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + (await f.token('machine')),
          },
          body: JSON.stringify({
            id: 'http-tool-revision',
            task: 't-http-tool',
            grant: 'g-http-tool',
            provider: 'fixture',
            action: 'write',
            resource: 'fixture-object',
            params: { value: 'http' },
            cost: 1,
            deadline,
            tool: 'ledger',
            toolRevision: 1,
          }),
        },
      );
      assert.equal(extra.status, 403);
    } finally {
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  } finally {
    await reader.end();
    await f.close();
  }
});

test('admission denies a stale or unavailable tool and leaves an unbound operation alone', async () => {
  const f = await fixture('tool-admit');
  const foreign = sha('tenant-b-only-definition');
  const tenant = pool('ct_tenant_a');
  const controller = pool('ct_controller');
  try {
    await cognition.record(await f.actor('user'), {
      principal: f.principal,
      provider: 'fixture',
      model: 'admit-model',
      configurationReference: 'admit-config',
      compatibility: 'UNKNOWN',
    });
    const unbound = await publish(f, 'unbound-op');
    const before = (
      await admin.query(
        "SELECT digest,contract_version,tool_id FROM ct.operations WHERE id='unbound-op'",
      )
    ).rows[0];
    assert.equal(Number(before.contract_version), 3);
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'later-tool',
      sha('later-tool'),
    ]);
    const kept = (
      await admin.query(
        "SELECT digest,contract_version,tool_id FROM ct.operations WHERE id='unbound-op'",
      )
    ).rows[0];
    assert.deepEqual(kept, before);
    const committed = await f.controller.dispatch(unbound.cap, unbound.x.id);
    assert.equal(committed.state, 'COMMITTED');
    assert.equal(f.provider.sends, 1);
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'bound-tool',
      sha('bound-tool'),
    ]);
    const bound = await publish(f, 'bound-op', 'bound-tool');
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'bound-tool',
      sha('bound-tool-2'),
    ]);
    const stale = await f.controller.dispatch(bound.cap, bound.x.id);
    assert.equal(stale.state, 'DENIED');
    assert.equal(await denial('bound-op'), 'MANIFEST_STALE');
    assert.equal(f.provider.sends, 1);
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'index-tool',
      sha('index-tool'),
    ]);
    const disagree = await publish(f, 'disagree-op', 'index-tool');
    await admin.query(
      "UPDATE ct.tool_manifest_index SET definition_digest=$1 WHERE tenant='a' AND tool_id='index-tool'",
      [sha('index-disagrees')],
    );
    const unavailable = await f.controller.dispatch(
      disagree.cap,
      disagree.x.id,
    );
    assert.equal(unavailable.state, 'DENIED');
    assert.equal(await denial('disagree-op'), 'MANIFEST_UNAVAILABLE');
    assert.equal(f.provider.sends, 1);
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'b',
      'foreign-tool',
      foreign,
    ]);
    const machine = await f.actor('machine');
    const deadline = new Date(Date.now() + 3600000).toISOString();
    await f.authority.createGrant(await f.actor('user'), {
      id: 'g-cross-tool',
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: deadline,
      maxCost: 5,
      budget: 20,
    });
    await f.product.createTask(machine, {
      id: 't-cross-tool',
      principal: f.principal,
      objective: 'Cross tenant tool',
      deadline,
      ...f.admission.a,
    });
    await assert.rejects(
      f.product.propose(machine, {
        id: 'cross-tool-op',
        task: 't-cross-tool',
        grant: 'g-cross-tool',
        provider: 'fixture',
        action: 'write',
        resource: 'fixture-object',
        params: { value: 'cross' },
        cost: 1,
        deadline,
        tool: 'foreign-tool',
      }),
      (error: Error) => {
        assert.match(String(error.message), /tool binding unavailable/);
        assert.equal(String(error.message).includes(foreign), false);
        return true;
      },
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM ct.operations WHERE id='cross-tool-op'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await tenant.query(
          'SELECT definition_digest FROM ct.tool_manifests WHERE tool_id=$1',
          ['foreign-tool'],
        )
      ).rowCount,
      0,
    );
    const looked = await tx(controller, (c) =>
      lockBoundManifest(c, {
        tenant: 'a',
        principal: f.principal,
        tool_id: 'foreign-tool',
        tool_revision: 1,
      }),
    );
    assert.equal(looked.tool?.boundRevision ?? null, null);
    assert.equal(JSON.stringify(looked).includes(foreign), false);
    assert.equal(
      manifestAdmission(
        {
          ...vectorRow,
          principal: f.principal,
          contract_version: 4,
          tool_id: 'foreign-tool',
          tool_revision: 1,
        },
        looked.head,
        looked.version,
        looked.cognition,
        Date.now(),
        looked.tool,
      ),
      'MANIFEST_UNAVAILABLE',
    );
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'missing-tool',
      sha('missing-tool'),
    ]);
    const missing = await publish(f, 'missing-op', 'missing-tool');
    await admin.query(
      'ALTER TABLE ct.operations DROP CONSTRAINT operations_tool_fk',
    );
    await admin.query(
      'ALTER TABLE ct.tool_manifests DISABLE TRIGGER tool_manifest_append_only',
    );
    const saved = (
      await admin.query(
        "DELETE FROM ct.tool_manifests WHERE tenant='a' AND tool_id='missing-tool' RETURNING revision,definition_digest",
      )
    ).rows;
    try {
      const hidden = await f.controller.dispatch(missing.cap, missing.x.id);
      assert.equal(hidden.state, 'DENIED');
      assert.equal(await denial('missing-op'), 'MANIFEST_UNAVAILABLE');
      const evidence = (
        await admin.query(
          "SELECT payload FROM ct.evidence_events WHERE tenant='a' AND kind='EFFECT_DENIED' AND payload LIKE '%missing-op%' ORDER BY seq DESC LIMIT 1",
        )
      ).rows[0].payload as string;
      assert.equal(evidence.includes(foreign), false);
      assert.equal(f.provider.sends, 1);
    } finally {
      await admin.query(
        'ALTER TABLE ct.tool_manifests ENABLE TRIGGER tool_manifest_append_only',
      );
      for (const row of saved.sort(
        (a, b) => Number(a.revision) - Number(b.revision),
      ))
        await admin.query(
          'INSERT INTO ct.tool_manifests(tenant,tool_id,revision,definition_digest) VALUES($1,$2,$3,$4)',
          ['a', 'missing-tool', row.revision, row.definition_digest],
        );
      await admin.query(
        'ALTER TABLE ct.operations ADD CONSTRAINT operations_tool_fk FOREIGN KEY(tenant,tool_id,tool_revision) REFERENCES ct.tool_manifests(tenant,tool_id,revision)',
      );
    }
  } finally {
    await tenant.end();
    await controller.end();
    await f.close();
  }
});

test('rebuilding the tool index creates no authority and a dangling index fails closed', async () => {
  const f = await fixture('tool-index');
  try {
    const before = await authorityCounts();
    const manifests = Number(
      (await admin.query('SELECT count(*)::int AS n FROM ct.tool_manifests'))
        .rows[0].n,
    );
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'rebuild-tool',
      sha('rebuild-tool'),
    ]);
    await gov.query('SELECT ct.rebuild_tool_manifest_index()');
    const after = await authorityCounts();
    assert.deepEqual(after, before);
    assert.equal(
      Number(
        (await admin.query('SELECT count(*)::int AS n FROM ct.tool_manifests'))
          .rows[0].n,
      ),
      manifests + 1,
    );
    const index = (
      await admin.query(
        "SELECT revision,definition_digest FROM ct.tool_manifest_index WHERE tenant='a' AND tool_id='rebuild-tool'",
      )
    ).rows[0];
    const maximum = (
      await admin.query(
        "SELECT MAX(revision) AS revision, (SELECT definition_digest FROM ct.tool_manifests WHERE tenant='a' AND tool_id='rebuild-tool' ORDER BY revision DESC LIMIT 1) AS definition_digest FROM ct.tool_manifests WHERE tenant='a' AND tool_id='rebuild-tool'",
      )
    ).rows[0];
    assert.equal(Number(index.revision), Number(maximum.revision));
    assert.equal(index.definition_digest, maximum.definition_digest);
    await gov.query('SELECT ct.rebuild_tool_manifest_index()');
    assert.equal(
      Number(
        (await admin.query('SELECT count(*)::int AS n FROM ct.tool_manifests'))
          .rows[0].n,
      ),
      manifests + 1,
    );
    assert.deepEqual(await authorityCounts(), before);
    await admin.query(
      'INSERT INTO ct.tool_manifest_index(tenant,tool_id,revision,definition_digest) VALUES($1,$2,1,$3)',
      ['a', 'orphan-tool', sha('orphan-index')],
    );
    const owner = await f.actor('user');
    const actor = await f.actor('machine');
    const deadline = new Date(Date.now() + 3600000).toISOString();
    await f.authority.createGrant(owner, {
      id: 'g-orphan-op',
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: deadline,
      maxCost: 5,
      budget: 20,
    });
    await f.product.createTask(actor, {
      id: 't-orphan-op',
      principal: f.principal,
      objective: 'Orphan tool index',
      deadline,
      ...f.admission.a,
    });
    const grants = (await authorityCounts()).grants;
    await assert.rejects(
      f.product.propose(actor, {
        id: 'orphan-op',
        task: 't-orphan-op',
        grant: 'g-orphan-op',
        provider: 'fixture',
        action: 'write',
        resource: 'fixture-object',
        params: { value: 'orphan' },
        cost: 1,
        deadline,
        tool: 'orphan-tool',
      }),
      /tool binding unavailable/,
    );
    assert.equal((await authorityCounts()).grants, grants);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM ct.operations WHERE id='orphan-op'",
        )
      ).rows[0].n,
      0,
    );
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'dangling-tool',
      sha('dangling-tool'),
    ]);
    const dangling = await publish(f, 'dangling-op', 'dangling-tool');
    const grantsBefore = (await authorityCounts()).grants;
    await admin.query(
      'ALTER TABLE ct.operations DROP CONSTRAINT operations_tool_fk',
    );
    await admin.query(
      'ALTER TABLE ct.tool_manifests DISABLE TRIGGER tool_manifest_append_only',
    );
    const saved = (
      await admin.query(
        "DELETE FROM ct.tool_manifests WHERE tenant='a' AND tool_id='dangling-tool' RETURNING revision,definition_digest",
      )
    ).rows;
    try {
      const denied = await f.controller.dispatch(dangling.cap, dangling.x.id);
      assert.equal(denied.state, 'DENIED');
      assert.equal(await denial('dangling-op'), 'MANIFEST_UNAVAILABLE');
      assert.equal((await authorityCounts()).grants, grantsBefore);
      assert.equal(f.provider.sends, 0);
      const manifestsDuring = Number(
        (await admin.query('SELECT count(*)::int AS n FROM ct.tool_manifests'))
          .rows[0].n,
      );
      await gov.query('SELECT ct.rebuild_tool_manifest_index()');
      assert.equal(
        Number(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM ct.tool_manifests',
            )
          ).rows[0].n,
        ),
        manifestsDuring,
      );
      assert.equal((await authorityCounts()).grants, grantsBefore);
    } finally {
      await admin.query(
        'ALTER TABLE ct.tool_manifests ENABLE TRIGGER tool_manifest_append_only',
      );
      for (const row of saved)
        await admin.query(
          'INSERT INTO ct.tool_manifests(tenant,tool_id,revision,definition_digest) VALUES($1,$2,$3,$4)',
          ['a', 'dangling-tool', row.revision, row.definition_digest],
        );
      await admin.query(
        'ALTER TABLE ct.operations ADD CONSTRAINT operations_tool_fk FOREIGN KEY(tenant,tool_id,tool_revision) REFERENCES ct.tool_manifests(tenant,tool_id,revision)',
      );
    }
  } finally {
    await f.close();
  }
});

test('an approval of the version 4 digest does not admit another revision, and UNKNOWN reconciliation does not send', async () => {
  const f = await fixture('tool-unknown');
  try {
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'approved-tool',
      sha('approved-tool'),
    ]);
    const approved = await publish(f, 'approved-op', 'approved-tool');
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id='approved-op'",
      )
    ).rows[0];
    const other = actionBinding({ ...stored, tool_revision: 2 });
    await assert.rejects(
      f.authority.approve(approved.owner, {
        operation: 'approved-op',
        digest: sha(canonical(other)),
        expires: approved.x.deadline,
      }),
      /exact approval\/current authority mismatch/,
    );
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'approved-tool',
      sha('approved-tool-2'),
    ]);
    const denied = await f.controller.dispatch(approved.cap, approved.x.id);
    assert.equal(denied.state, 'DENIED');
    assert.equal(await denial('approved-op'), 'MANIFEST_STALE');
    assert.equal(f.provider.sends, 0);
    assert.equal(
      (
        await admin.query(
          "SELECT digest,tool_revision FROM ct.operations WHERE id='approved-op'",
        )
      ).rows[0].digest,
      approved.op.digest,
    );
    const uncertain = await publish(f, 'tool-unknown-op', 'approved-tool');
    const storedUnknown = (
      await admin.query(
        "SELECT digest,tool_revision FROM ct.operations WHERE id='tool-unknown-op'",
      )
    ).rows[0];
    f.provider.loseAck = true;
    const lost = await f.controller.dispatch(uncertain.cap, uncertain.x.id);
    assert.equal(lost.state, 'UNKNOWN');
    const sends = f.provider.sends;
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'approved-tool',
      sha('approved-tool-3'),
    ]);
    let seen = '';
    f.provider.loseAck = false;
    f.provider.lookup = async (operation) => {
      seen = operation.digest;
      return [];
    };
    const reconciled = await f.controller.reconcile(
      uncertain.cap,
      uncertain.x.id,
    );
    assert.equal(reconciled.state, 'UNKNOWN');
    assert.equal(seen, storedUnknown.digest);
    assert.equal(reconciled.digest, storedUnknown.digest);
    assert.equal(
      Number(reconciled.tool_revision),
      Number(storedUnknown.tool_revision),
    );
    assert.equal(f.provider.sends, sends);
  } finally {
    await f.close();
  }
});

test('recovery keeps a version 4 tool revision and does not rewrite a missing one', async () => {
  const f = await fixture('tool-recover');
  const directory = path.resolve('.local/tool-manifest-recovery-fence');
  await fs.rm(directory, { recursive: true, force: true });
  const store = new LocalIndependentFenceStore(directory);
  let inventory: {
    binding: Record<string, any>;
    digest: string;
    state: string;
  }[] = [];
  const recoveryDb = pool('ct_recovery');
  const recovery = new RecoveryService(
    recoveryDb,
    store,
    {
      supports: (operation) => f.provider.supports(operation),
      lookup: (operation) => f.provider.lookup(operation),
    },
    {
      authorizeOperator: async (actor) => {
        if (actor.subject !== f.prefix + '-owner-a' || actor.kind !== 'user')
          throw Error('fixture independent cluster operator required');
      },
      readAuthorityJournal: async () => ({ records: [], digest: sha('[]') }),
      readOperationInventory: async () => ({
        reference: 'tool-archive',
        operations: inventory,
        digest: sha(canonical(inventory)),
        complete: true,
      }),
      verifyActivationApproval: async () => undefined,
    },
  );
  try {
    await gov.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
      'a',
      'recovery-tool',
      sha('recovery-tool'),
    ]);
    const published = await publish(f, 'recovery-op', 'recovery-tool');
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [published.x.id],
      )
    ).rows[0];
    const archive = {
      binding: actionBinding(stored),
      digest: stored.digest,
      state: 'UNKNOWN',
    };
    verifyOperationArchive(archive);
    assert.equal(archive.binding.contractVersion, 4);
    const missing = structuredClone(archive);
    missing.binding = {
      ...missing.binding,
      id: 'recovery-missing-tool',
      idempotencyKey: 'recovery-missing-tool',
      toolRevision: 99,
    };
    missing.digest = sha(canonical(missing.binding));
    verifyOperationArchive(missing);
    inventory = [missing];
    await store.initialize({
      revision: 1,
      fence,
      blocked: false,
      authorityDigest: sha('[]'),
    });
    const run = await recovery.begin(await f.actor('user'));
    await assert.rejects(
      recovery.importInventory(await f.actor('user'), run.id),
      /missing historical manifest record/,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM ct.operations WHERE id='recovery-missing-tool'",
        )
      ).rows[0].n,
      0,
    );
    const roundTrip = structuredClone(archive);
    roundTrip.binding = {
      ...roundTrip.binding,
      id: 'tool-recovery-round-trip',
      idempotencyKey: 'tool-recovery-round-trip',
    };
    roundTrip.digest = sha(canonical(roundTrip.binding));
    inventory = [roundTrip];
    assert.equal(
      await recovery.importInventory(await f.actor('user'), run.id),
      1,
    );
    const restored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id='tool-recovery-round-trip'",
      )
    ).rows[0];
    assert.equal(Number(restored.contract_version), 4);
    assert.equal(restored.tool_id, 'recovery-tool');
    assert.equal(Number(restored.tool_revision), 1);
    assert.equal(restored.state, 'UNKNOWN');
    assert.equal(restored.digest, roundTrip.digest);
    assert.equal(
      canonical(actionBinding(rowFromBinding(archive.binding))),
      canonical(archive.binding),
    );
    const observed = await recovery.observe(
      await f.actor('user'),
      run.id,
      'tool-recovery-round-trip',
    );
    assert.equal(observed.state, 'UNKNOWN');
    assert.equal(f.provider.sends, 0);
  } finally {
    await bootstrap();
    await recoveryDb.end();
    await f.close();
  }
});

test('concurrent tool appends are gapless and do not lock context or cognition', async () => {
  const f = await fixture('tool-race');
  const first = await gov.connect();
  const second = await gov.connect();
  const holder = await admin.connect();
  try {
    await contexts.ingest(await f.actor('machine'), {
      id: 'tool-lock-note',
      expectedVersion: 0,
      payload: { text: 'not a tool' },
      source: { kind: 'document', reference: 'doc:tool-lock-note' },
      ttlSeconds: 3600,
    });
    await cognition.record(await f.actor('user'), {
      principal: f.principal,
      provider: 'fixture',
      model: 'race-model',
      configurationReference: 'race-config',
      compatibility: 'UNKNOWN',
    });
    const tool = 'race-tool';
    await first.query('BEGIN');
    const firstRevision = Number(
      (
        await first.query('SELECT ct.append_tool_manifest($1,$2,$3) AS n', [
          'a',
          tool,
          sha('race-1'),
        ])
      ).rows[0].n,
    );
    const pending = second.query(
      'SELECT ct.append_tool_manifest($1,$2,$3) AS n',
      ['a', tool, sha('race-2')],
    );
    await waitAdvisory('%append_tool_manifest%');
    await first.query('COMMIT');
    const secondRevision = Number((await pending).rows[0].n);
    assert.deepEqual(
      [firstRevision, secondRevision].sort((a, b) => a - b),
      [1, 2],
    );
    const direct = await gov.connect();
    try {
      await direct.query('BEGIN');
      await direct.query(
        'INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES($1,$2,$3)',
        ['a', tool, sha('race-3')],
      );
      const queued = second.query(
        'INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES($1,$2,$3) RETURNING revision',
        ['a', tool, sha('race-4')],
      );
      await waitAdvisory('%INSERT INTO ct.tool_manifests%');
      await direct.query('COMMIT');
      assert.equal(Number((await queued).rows[0].revision), 4);
    } finally {
      await direct.query('ROLLBACK').catch(() => undefined);
      direct.release();
    }
    const revisions = (
      await admin.query(
        'SELECT revision FROM ct.tool_manifests WHERE tenant=$1 AND tool_id=$2 ORDER BY revision',
        ['a', tool],
      )
    ).rows.map((row) => Number(row.revision));
    assert.deepEqual(revisions, [1, 2, 3, 4]);
    await holder.query('BEGIN');
    await holder.query(
      'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', 'tool-lock-note'],
    );
    await holder.query("SET LOCAL statement_timeout='2s'");
    const writer = await gov.connect();
    try {
      await writer.query("SET statement_timeout='2s'");
      await writer.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
        'a',
        'unlocked-tool',
        sha('unlocked-tool'),
      ]);
      await writer.query('BEGIN');
      await writer.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
        'a',
        'lock-inspect-tool',
        sha('lock-inspect-tool'),
      ]);
      const pid = Number(
        (await writer.query('SELECT pg_backend_pid() AS p')).rows[0].p,
      );
      const locks = (
        await admin.query(
          "SELECT COALESCE(relation::regclass::text,'') AS rel FROM pg_locks WHERE pid=$1 AND locktype='relation'",
          [pid],
        )
      ).rows.map((row) => row.rel as string);
      assert.equal(
        locks.some((rel) => rel.includes('context_heads')),
        false,
      );
      assert.equal(
        locks.some((rel) => rel.includes('cognition_bindings')),
        false,
      );
      assert.equal(
        locks.some((rel) => rel.includes('principals')),
        false,
      );
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.query('RESET statement_timeout').catch(() => undefined);
      writer.release();
    }
    await holder.query('ROLLBACK');
    await holder.query('BEGIN');
    await holder.query(
      'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', f.principal],
    );
    const quick = await gov.connect();
    try {
      await quick.query("SET statement_timeout='2s'");
      await quick.query('SELECT ct.append_tool_manifest($1,$2,$3)', [
        'a',
        'principal-unlocked-tool',
        sha('principal-unlocked-tool'),
      ]);
    } finally {
      await quick.query('RESET statement_timeout').catch(() => undefined);
      quick.release();
    }
    await holder.query('ROLLBACK');
    const source = (
      await admin.query(
        "SELECT pg_get_functiondef('ct.append_tool_manifest(text,text,text)'::regprocedure) AS body",
      )
    ).rows[0].body as string;
    assert.equal(source.includes('context_heads'), false);
    assert.equal(source.includes('cognition_bindings'), false);
    assert.equal(source.includes('ct.principals'), false);
    const unbound = await publish(f, 'race-unbound');
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT contract_version FROM ct.operations WHERE id='race-unbound'",
          )
        ).rows[0].contract_version,
      ),
      3,
    );
    const sent = await f.controller.dispatch(unbound.cap, unbound.x.id);
    assert.equal(sent.state, 'COMMITTED');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await first.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    await f.close();
  }
});

test('an empty tool string does not save an operation', async () => {
  const f = await fixture('empty-tool');
  try {
    const owner = await f.actor('user');
    const actor = await f.actor('machine');
    const deadline = new Date(Date.now() + 3600000).toISOString();
    await f.authority.createGrant(owner, {
      id: 'g-empty-tool',
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: deadline,
      maxCost: 5,
      budget: 20,
    });
    await f.product.createTask(actor, {
      id: 't-empty-tool',
      principal: f.principal,
      objective: 'Empty tool string',
      deadline,
      ...f.admission.a,
    });
    await assert.rejects(
      f.product.propose(actor, {
        id: 'empty-tool-op',
        task: 't-empty-tool',
        grant: 'g-empty-tool',
        provider: 'fixture',
        action: 'write',
        resource: 'fixture-object',
        params: { value: 'empty' },
        cost: 1,
        deadline,
        tool: '',
      }),
      /invalid identifier/,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM ct.operations WHERE id='empty-tool-op'",
          )
        ).rows[0].n,
      ),
      0,
    );
    assert.equal(f.provider.sends, 0);
  } finally {
    await f.close();
  }
});
