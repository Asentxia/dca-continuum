import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { setTimeout as delay } from 'node:timers/promises';
import {
  actionBinding,
  bindingDigest,
  canonical,
  manifestAdmission,
  pool,
  sha,
  tx,
} from '../src/db.js';
import { ContextService } from '../src/context-service.js';
import { CognitionService } from '../src/cognition-service.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import { IdentityVerifier } from '../src/identity-provider.js';
import { EffectController } from '../src/controller.js';
import {
  rowFromBinding,
  verifyOperationArchive,
} from '../src/evidence-export.js';
import { LocalIndependentFenceStore } from '../src/fence-store.js';
import { RecoveryService } from '../src/recovery.js';
import { productApi } from '../src/product-api.js';
import { OrganizationService } from '../src/regency/organization-service.js';
import { fixture } from './implementation-helpers.js';
import { admin, bootstrap, fence, gov } from './helpers.js';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

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
    ['-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function waitFor(like: string, blockingPid?: number) {
  if (blockingPid !== undefined)
    assert.ok(Number.isInteger(blockingPid) && blockingPid > 0);
  for (let n = 0; n < 80; n++) {
    const found = (
      await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='transactionid' AND state='active' AND query LIKE $1 AND ($2::integer IS NULL OR $2=ANY(pg_blocking_pids(pid)))",
        [like, blockingPid ?? null],
      )
    ).rows[0].n;
    if (found > 0) return;
    await delay(50);
  }
  assert.fail('expected lock wait ' + like);
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

async function waitForContextExpiry(id: string, version: number) {
  const until = performance.now() + 20000;
  for (;;) {
    const witness = (
      await admin.query(
        `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS wall)
         SELECT current_database() AS database, v.expires, t.wall,
                v.expires <= t.wall AS expired
         FROM ct.context_versions v CROSS JOIN t
         WHERE v.tenant=$1 AND v.id=$2 AND v.version=$3`,
        ['a', id, version],
      )
    ).rows[0];
    assert.ok(witness, 'bound context version must exist');
    assert.ok(Number.isFinite(+new Date(witness.expires)));
    assert.ok(Number.isFinite(+new Date(witness.wall)));
    if (witness.expired === true) return witness;
    if (performance.now() >= until)
      assert.fail(
        'database did not confirm context expiry: ' + JSON.stringify(witness),
      );
    await delay(25);
  }
}

async function closeExpiryFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  ids: readonly string[],
  primaryFailed: boolean,
) {
  let cleanupError: unknown;
  for (const id of ids) {
    try {
      const head = (
        await admin.query(
          "SELECT principal,deleted FROM ct.context_heads WHERE tenant='a' AND id=$1",
          [id],
        )
      ).rows[0];
      if (!head) continue;
      assert.equal(
        head.principal,
        f.principal,
        'cleanup must own this exact context',
      );
      if (!head.deleted) await contexts.erase(await f.actor('user'), id);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    await f.close();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    if (!primaryFailed) throw cleanupError;
    console.error(
      'Exact-owned context cleanup failed; original test failure retained.',
    );
  }
}

async function publish(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  actor: Awaited<ReturnType<typeof f.actor>>,
  principal: string,
  identity: string,
  context?: string,
) {
  const owner = await f.actor('user');
  const deadline = new Date(Date.now() + 3600000).toISOString();
  await f.authority.createGrant(owner, {
    id: 'g-' + id,
    principal,
    action: 'write',
    resource: 'fixture-object',
    expires: deadline,
    maxCost: 5,
    budget: 20,
  });
  await f.product.createTask(actor, {
    id: 't-' + id,
    principal,
    objective: 'Manifest ' + id,
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
    ...(context ? { context } : {}),
  };
  const op = await f.product.propose(actor, x);
  await f.authority.assign(owner, {
    identity,
    operation: id,
    expires: deadline,
  });
  await f.authority.approve(owner, {
    operation: id,
    digest: op.digest,
    expires: deadline,
  });
  const cap = await f.caps.verify((await f.authority.renew(actor, id)).token);
  return { x, op, cap };
}

async function note(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  share = false,
  ttlSeconds = 3600,
) {
  const machine = await f.actor('machine');
  await contexts.ingest(machine, {
    id,
    expectedVersion: 0,
    payload: { text: 'not authority ' + id },
    source: { kind: 'document', reference: 'doc:' + id },
    ttlSeconds,
  });
  const review = await contexts.inspectQuarantine(await f.actor('user'), id);
  if (share || ttlSeconds > 2)
    await contexts.approve(
      await f.actor('user'),
      id,
      review.version,
      review.digest,
      share,
    );
  return review;
}

async function otherMachine(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
) {
  const ext = await generateKeyPair('EdDSA');
  const issuer = 'https://' + name + '.test-identity.invalid';
  const audience = 'urn:continuum:test:' + name;
  const principal = 'p2-' + name;
  await gov.query(
    'INSERT INTO ct.principals(tenant,id,epoch,generation) VALUES($1,$2,1,1)',
    ['a', principal],
  );
  const workerId = name + '-worker';
  await gov.query(
    "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role) VALUES($1,$2,$1,$3,'machine','a',$4,'worker')",
    [workerId, issuer, audience, principal],
  );
  const auth = pool('ct_authority_api');
  try {
    await tx(auth, (c) =>
      new OrganizationService().addMembership(
        c,
        'a',
        f.admission.a.organization,
        'vera',
        principal,
        'steward',
        false,
      ),
    );
  } finally {
    await auth.end();
  }
  const machine = new IdentityVerifier(
    {
      issuer,
      jwksUri: issuer + '/jwks',
      audience,
      algorithms: ['EdDSA'],
      kind: 'machine',
    },
    createLocalJWKSet({
      keys: [
        { ...(await exportJWK(ext.publicKey)), alg: 'EdDSA', kid: 'external' },
      ],
    }),
  );
  const token = await new SignJWT({
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['mfa'],
    ct_gen: 1,
    ct_epoch: 1,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'external' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(workerId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(ext.privateKey);
  return { principal, workerId, worker: await machine.verify(token) };
}

test('version 1 and 2 bytes stay unchanged when version 3 is added', () => {
  assert.equal(canonical(actionBinding(vectorRow)), v1Canonical);
  assert.equal(
    canonical(
      actionBinding({
        ...vectorRow,
        contract_version: 1,
        context_id: null,
        cognition_revision: null,
      }),
    ),
    v1Canonical,
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
  const version3 = actionBinding({
    ...vectorRow,
    contract_version: 3,
    computer_id: 'logical-computer',
    placement_generation: 1,
    context_id: 'item',
    context_version: 1,
    cognition_revision: 2,
  });
  const encoded = canonical(version3);
  assert.equal(version3.contractVersion, 3);
  assert.equal(version3.contextVersion, 1);
  assert.equal(version3.cognitionRevision, 2);
  assert.notEqual(encoded, v1Canonical);
  assert.notEqual(encoded, v2Canonical);
  assert.equal(
    canonical(
      actionBinding({
        ...vectorRow,
        contract_version: 3,
        cognition_revision: 1,
      }),
    ).includes('computerId'),
    false,
  );
  assert.throws(
    () =>
      actionBinding({
        ...vectorRow,
        contract_version: 2,
        computer_id: 'logical-computer',
        placement_generation: 1,
        context_id: 'item',
        context_version: 1,
      }),
    /invalid contract binding/,
  );
  assert.equal(
    manifestAdmission(
      {
        ...vectorRow,
        contract_version: 3,
        context_id: 'item',
        context_version: 1,
        principal: 'vera',
      },
      {
        version: 1,
        deleted: false,
        visibility: 'PRIVATE',
        principal: 'vera',
        quarantined: true,
      },
      { erased_at: null, expires: '2099-01-01T00:00:00.000Z' },
      null,
      Date.parse('2026-01-01T00:00:00.000Z'),
    ),
    null,
  );
});

test('bound context expiry rejects invalid timestamps and non-finite database time', () => {
  const head = {
    version: 1,
    deleted: false,
    visibility: 'PRIVATE',
    principal: 'vera',
  };
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const future = new Date(now + 60000);
  for (const version of [3, 4]) {
    const operation = {
      ...vectorRow,
      contract_version: version,
      context_id: 'clock-vector',
      context_version: 1,
      ...(version === 4 ? { tool_id: 'clock-tool', tool_revision: 1 } : {}),
    };
    const tool =
      version === 4
        ? {
            boundRevision: 1,
            maximum: 1,
            maximumDigest: 'a'.repeat(64),
            indexRevision: 1,
            indexDigest: 'a'.repeat(64),
          }
        : null;
    for (const expires of [
      'invalid',
      undefined,
      Infinity,
      -Infinity,
      new Date(NaN),
    ]) {
      assert.equal(
        manifestAdmission(
          operation,
          head,
          { erased_at: null, expires },
          null,
          now,
          tool,
        ),
        'MANIFEST_UNAVAILABLE',
      );
    }
    for (const clock of [NaN, Infinity, -Infinity]) {
      assert.equal(
        manifestAdmission(
          operation,
          head,
          { erased_at: null, expires: future },
          null,
          clock,
          tool,
        ),
        'MANIFEST_UNAVAILABLE',
      );
    }
    assert.equal(
      manifestAdmission(
        operation,
        head,
        { erased_at: null, expires: future },
        null,
        now,
        tool,
      ),
      null,
    );
    assert.equal(
      manifestAdmission(
        operation,
        head,
        { erased_at: null, expires: new Date(now) },
        null,
        now,
        tool,
      ),
      'MANIFEST_UNAVAILABLE',
    );
  }
});

test('upgrade preserves historical rows and the database rejects a partial manifest', async () => {
  psql('postgres', [
    '-c',
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ct_manifest_upgrade' AND pid<>pg_backend_pid()",
  ]);
  spawnSync('dropdb', ['--if-exists', 'ct_manifest_upgrade'], {
    encoding: 'utf8',
  });
  assert.equal(
    spawnSync('createdb', ['ct_manifest_upgrade'], { encoding: 'utf8' }).status,
    0,
  );
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
      psql('ct_manifest_upgrade', ['-f', `migrations/${file}`]);
    const historical = {
      ...vectorRow,
      id: 'historical-op',
      principal: 'historical-vera',
      grant_id: 'historical-grant',
      task_id: 'historical-task',
      idempotency_key: 'historical-op',
    };
    const digest = bindingDigest(historical);
    psql('ct_manifest_upgrade', [
      '-c',
      "INSERT INTO ct.tenants VALUES('a')",
      '-c',
      "INSERT INTO ct.principals VALUES('a','historical-vera',1,4,true)",
      '-c',
      "INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget) VALUES('a','historical-grant','historical-vera','write','fixture-object',now()+interval '1 day',5,20)",
      '-c',
      `INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) VALUES('a','historical-op','historical-vera','historical-grant',1,1,'fixture-fence-v1',1,'historical-task',1,'fixture','write','fixture-object','{"value":"vector"}','${digest}','historical-op',1,'2026-01-01T00:00:00Z')`,
    ]);
    psql('ct_manifest_upgrade', [
      '-f',
      'migrations/016-placement-generation.sql',
    ]);
    psql('ct_manifest_upgrade', [
      '-f',
      'migrations/017-context-cognition-binding.sql',
    ]);
    psql('ct_manifest_upgrade', [
      '-f',
      'migrations/017-context-cognition-binding.sql',
    ]);
    const snapshot = psql('ct_manifest_upgrade', [
      '-At',
      '-c',
      "SELECT digest||'|'||contract_version||'|'||COALESCE(context_id,'<null>')||'|'||COALESCE(context_version::text,'<null>')||'|'||COALESCE(cognition_revision::text,'<null>') FROM ct.operations",
    ]).trim();
    assert.equal(snapshot, `${digest}|1|<null>|<null>|<null>`);
    const half = spawnSync(
      'psql',
      [
        '-d',
        'ct_manifest_upgrade',
        '-c',
        "INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,contract_version,context_id) VALUES('a','half','historical-vera','historical-grant',1,1,'fixture-fence-v1',1,'historical-task',1,'fixture','write','fixture-object','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','half',1,now()+interval '1 day',3,'item')",
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(half.status, 0);
    const changed = spawnSync(
      'psql',
      [
        '-d',
        'ct_manifest_upgrade',
        '-c',
        "UPDATE ct.operations SET context_id='item',context_version=1,contract_version=3 WHERE id='historical-op'",
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /immutable operation binding/);
    spawnSync('dropdb', ['--if-exists', 'ct_manifest_recovery_schema'], {
      encoding: 'utf8',
    });
    assert.equal(
      spawnSync('createdb', ['ct_manifest_recovery_schema'], {
        encoding: 'utf8',
      }).status,
      0,
    );
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
      '012-tenant-identity-fks.sql',
      '013-recovery-import-guard.sql',
      '014-recovery-observation-guard.sql',
      '016-placement-generation.sql',
      '017-context-cognition-binding.sql',
    ])
      psql('ct_manifest_recovery_schema', ['-f', `migrations/${file}`]);
    psql('ct_manifest_recovery_schema', [
      '-f',
      'migrations/017-context-cognition-binding.sql',
    ]);
    assert.equal(
      psql('ct_manifest_recovery_schema', [
        '-At',
        '-c',
        "SELECT to_regclass('ct.cognition_bindings') IS NOT NULL",
      ]).trim(),
      't',
    );
    for (const database of [
      'ct_manifest_upgrade',
      'ct_manifest_recovery_schema',
    ]) {
      if (database === 'ct_manifest_recovery_schema')
        psql(database, [
          '-c',
          "INSERT INTO ct.tenants VALUES('a')",
          '-c',
          "INSERT INTO ct.principals VALUES('a','cog-zero',1,1,true)",
        ]);
      const principal =
        database === 'ct_manifest_upgrade' ? 'historical-vera' : 'cog-zero';
      const rejected = spawnSync(
        'psql',
        [
          '-d',
          database,
          '-c',
          `INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES('a','${principal}',0,'fixture','model','zero','UNKNOWN')`,
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(rejected.status, 0, rejected.stdout);
      assert.match(rejected.stderr, /cognition revision/);
      psql(database, [
        '-c',
        `INSERT INTO ct.cognition_bindings(tenant,principal,provider,model,configuration_reference,compatibility) VALUES('a','${principal}','fixture','model','omitted','UNKNOWN')`,
      ]);
      psql(database, ['-f', 'migrations/017-context-cognition-binding.sql']);
      assert.equal(
        psql(database, [
          '-At',
          '-c',
          `SELECT revision::text FROM ct.cognition_bindings WHERE tenant='a' AND principal='${principal}'`,
        ]).trim(),
        '1',
      );
      const stillRejected = spawnSync(
        'psql',
        [
          '-d',
          database,
          '-c',
          `INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES('a','${principal}',0,'fixture','model','zero-again','UNKNOWN')`,
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(stillRejected.status, 0);
      assert.match(stillRejected.stderr, /cognition revision/);
    }
  } finally {
    psql('postgres', [
      '-c',
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN('ct_manifest_upgrade','ct_manifest_recovery_schema') AND pid<>pg_backend_pid()",
    ]);
    spawnSync('dropdb', ['--if-exists', 'ct_manifest_upgrade'], {
      encoding: 'utf8',
    });
    spawnSync('dropdb', ['--if-exists', 'ct_manifest_recovery_schema'], {
      encoding: 'utf8',
    });
  }
});

test('privacy and quarantine bind metadata without admitting the payload', async () => {
  const f = await fixture('manifest-privacy');
  const reader = pool('ct_console_reader');
  const reads = new ConsoleReads(
    reader,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    'manifest-privacy',
    fence,
  );
  try {
    const owner = await f.actor('user');
    await contexts.ingest(owner, {
      id: 'ownerless-private',
      expectedVersion: 0,
      payload: { secret: 'hidden' },
      source: { kind: 'document', reference: 'doc:ownerless-private' },
      ttlSeconds: 3600,
    });
    const machine = await f.actor('machine');
    await assert.rejects(
      publish(
        f,
        'bind-ownerless-private',
        machine,
        f.principal,
        f.prefix + '-worker-a',
        'ownerless-private',
      ),
      /context binding unavailable/,
    );
    const owned = await contexts.inspectQuarantine(owner, 'ownerless-private');
    await contexts.approve(
      owner,
      'ownerless-private',
      owned.version,
      owned.digest,
      true,
    );
    const shared = await publish(
      f,
      'bind-ownerless-tenant',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'ownerless-private',
    );
    assert.equal(shared.op.reused, false);
    await contexts.ingest(machine, {
      id: 'private-note',
      expectedVersion: 0,
      payload: { secret: 'payload' },
      source: { kind: 'document', reference: 'doc:private-note' },
      ttlSeconds: 3600,
    });
    const quarantined = await publish(
      f,
      'bind-quarantine',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'private-note',
    );
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        ['bind-quarantine'],
      )
    ).rows[0];
    assert.equal(Number(stored.contract_version), 3);
    assert.equal(Number(stored.context_version), 1);
    assert.equal(stored.digest, quarantined.op.digest);
    await f.authority.createGrant(owner, {
      id: 'g-bind-caller-version',
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: quarantined.x.deadline,
      maxCost: 5,
      budget: 20,
    });
    await f.product.createTask(machine, {
      id: 't-bind-caller-version',
      principal: f.principal,
      objective: 'Caller cannot choose the context version',
      deadline: quarantined.x.deadline,
      ...f.admission.a,
    });
    const forced = await f.product.propose(machine, {
      ...quarantined.x,
      id: 'bind-caller-version',
      task: 't-bind-caller-version',
      grant: 'g-bind-caller-version',
      contextVersion: 99,
    } as never);
    assert.equal(
      (
        await admin.query(
          "SELECT context_version FROM ct.operations WHERE tenant='a' AND id='bind-caller-version'",
        )
      ).rows[0].context_version,
      1,
    );
    assert.notEqual(forced.digest, '');
    await assert.rejects(
      contexts.get(machine, 'private-note', 1),
      /unavailable|quarantined/,
    );
    const view = await reads.read(owner, 'operation', {
      id: 'bind-quarantine',
    });
    assert.equal(view.items[0].fields.contextQuarantined, true);
    assert.match(
      String(view.items[0].fields.contextNote),
      /not an admitted fact/,
    );
    assert.equal(
      JSON.stringify(view.items[0].fields).includes('payload'),
      false,
    );
    assert.equal(
      JSON.stringify(view.items[0].fields.canonicalBinding).includes('secret'),
      false,
    );
    const other = await otherMachine(f, 'manifest-privacy');
    await assert.rejects(
      publish(
        f,
        'bind-foreign-private',
        other.worker,
        other.principal,
        other.workerId,
        'private-note',
      ),
      /context binding unavailable/,
    );
    await contexts.approve(
      owner,
      'private-note',
      1,
      (
        await admin.query(
          "SELECT digest FROM ct.context_versions WHERE tenant='a' AND id='private-note' AND version=1",
        )
      ).rows[0].digest,
      true,
    );
    const foreign = await publish(
      f,
      'bind-foreign-tenant',
      other.worker,
      other.principal,
      other.workerId,
      'private-note',
    );
    assert.equal(
      (
        await admin.query(
          "SELECT context_version FROM ct.operations WHERE tenant='a' AND id=$1",
          [foreign.op.id],
        )
      ).rows[0].context_version,
      1,
    );
    await assert.rejects(
      publish(
        f,
        'bind-other-tenant',
        await f.actor('machine', 'b'),
        f.principal,
        f.prefix + '-worker-b',
        'private-note',
      ),
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM ct.operations WHERE id='bind-other-tenant'",
        )
      ).rows[0].n,
      0,
    );
    const api = productApi(f.machine, f.product);
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    try {
      const deadline = new Date(Date.now() + 3600000).toISOString();
      await f.authority.createGrant(owner, {
        id: 'g-http-context',
        principal: f.principal,
        action: 'write',
        resource: 'fixture-object',
        expires: deadline,
        maxCost: 5,
        budget: 20,
      });
      await f.product.createTask(machine, {
        id: 't-http-context',
        principal: f.principal,
        objective: 'HTTP context binding',
        deadline,
        ...f.admission.a,
      });
      const response = await fetch(
        'http://127.0.0.1:' +
          (api.address() as { port: number }).port +
          '/operations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + (await f.token('machine')),
          },
          body: JSON.stringify({
            id: 'http-context-op',
            task: 't-http-context',
            grant: 'g-http-context',
            provider: 'fixture',
            action: 'write',
            resource: 'fixture-object',
            params: { value: 'http' },
            cost: 1,
            deadline,
            context: 'private-note',
          }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(
        Number(
          (
            await admin.query(
              "SELECT contract_version FROM ct.operations WHERE tenant='a' AND id='http-context-op'",
            )
          ).rows[0].contract_version,
        ),
        3,
      );
    } finally {
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  } finally {
    await reader.end();
    await f.close();
  }
});

test('admission denies a changed manifest and still allows quarantine and wider visibility', async () => {
  const f = await fixture('manifest-life');
  const machine = await f.actor('machine');
  const owner = await f.actor('user');
  let primaryFailed = false;
  try {
    await contexts.ingest(machine, {
      id: 'life-quarantine',
      expectedVersion: 0,
      payload: { text: 'quarantine' },
      source: { kind: 'document', reference: 'doc:life-quarantine' },
      ttlSeconds: 3600,
    });
    const quarantined = await publish(
      f,
      'life-quarantine-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'life-quarantine',
    );
    assert.equal(
      (await f.controller.dispatch(quarantined.cap, quarantined.x.id)).state,
      'COMMITTED',
    );
    await note(f, 'life-stale', false);
    const stale = await publish(
      f,
      'life-stale-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'life-stale',
    );
    await contexts.ingest(machine, {
      id: 'life-stale',
      expectedVersion: 1,
      payload: { text: 'changed' },
      source: { kind: 'document', reference: 'doc:life-stale-2' },
      ttlSeconds: 3600,
    });
    assert.equal(
      (await f.controller.dispatch(stale.cap, stale.x.id)).state,
      'DENIED',
    );
    assert.equal(await denial(stale.x.id), 'MANIFEST_STALE');
    await note(f, 'life-erased', false);
    const erased = await publish(
      f,
      'life-erased-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'life-erased',
    );
    await contexts.erase(owner, 'life-erased');
    assert.equal(
      (await f.controller.dispatch(erased.cap, erased.x.id)).state,
      'DENIED',
    );
    assert.equal(await denial(erased.x.id), 'MANIFEST_UNAVAILABLE');
    await contexts.ingest(machine, {
      id: 'life-expired',
      expectedVersion: 0,
      payload: { text: 'short' },
      source: { kind: 'document', reference: 'doc:life-expired' },
      ttlSeconds: 15,
    });
    const expired = await publish(
      f,
      'life-expired-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'life-expired',
    );
    const initial = (
      await admin.query(
        "SELECT state,contract_version,context_id,context_version FROM ct.operations WHERE tenant='a' AND id=$1",
        [expired.x.id],
      )
    ).rows[0];
    assert.equal(initial.state, 'REQUESTED');
    assert.equal(Number(initial.contract_version), 3);
    assert.equal(initial.context_id, 'life-expired');
    assert.equal(Number(initial.context_version), 1);
    const sendsBeforeExpiry = f.provider.sends;
    // Ingestion and admission use database time; a Node-only sleep is not proof.
    await waitForContextExpiry('life-expired', 1);
    assert.equal(
      (await f.controller.dispatch(expired.cap, expired.x.id)).state,
      'DENIED',
    );
    assert.equal(await denial(expired.x.id), 'MANIFEST_UNAVAILABLE');
    assert.equal(f.provider.sends, sendsBeforeExpiry);
    await contexts.erase(owner, 'life-expired');
    await cognition.record(owner, {
      principal: f.principal,
      provider: 'fixture',
      model: 'life-model',
      configurationReference: 'life-config',
      compatibility: 'UNKNOWN',
    });
    const remembered = await publish(
      f,
      'life-cognition-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT cognition_revision FROM ct.operations WHERE tenant='a' AND id=$1",
            [remembered.x.id],
          )
        ).rows[0].cognition_revision,
      ),
      1,
    );
    await cognition.record(owner, {
      principal: f.principal,
      provider: 'fixture',
      model: 'life-model-2',
      configurationReference: 'life-config-2',
      compatibility: 'TESTED',
    });
    assert.equal(
      (await f.controller.dispatch(remembered.cap, remembered.x.id)).state,
      'DENIED',
    );
    assert.equal(await denial(remembered.x.id), 'MANIFEST_STALE');
    await note(f, 'life-narrow', true);
    const other = await otherMachine(f, 'manifest-life');
    const narrowed = await publish(
      f,
      'life-narrow-op',
      other.worker,
      other.principal,
      other.workerId,
      'life-narrow',
    );
    const reviewed = await contexts.inspectQuarantine(owner, 'life-narrow');
    await contexts.approve(
      owner,
      'life-narrow',
      reviewed.version,
      reviewed.digest,
      false,
    );
    assert.equal(
      (await f.controller.dispatch(narrowed.cap, narrowed.x.id)).state,
      'DENIED',
    );
    assert.equal(await denial(narrowed.x.id), 'MANIFEST_SCOPE');
    await note(f, 'life-wide', false);
    const widened = await publish(
      f,
      'life-wide-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'life-wide',
    );
    const wide = await contexts.inspectQuarantine(owner, 'life-wide');
    await contexts.approve(owner, 'life-wide', wide.version, wide.digest, true);
    assert.equal(
      (await f.controller.dispatch(widened.cap, widened.x.id)).state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 2);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await closeExpiryFixture(f, ['life-expired'], primaryFailed);
  }
});

test('database expiry-witness is independent of the application wall clock', async () => {
  const f = await fixture('manifest-clock');
  const machine = await f.actor('machine');
  const realNow = Date.now;
  let primaryFailed = false;
  try {
    for (const skew of [60000, -60000]) {
      const context = skew > 0 ? 'clock-ahead' : 'clock-behind';
      await note(f, context, false, 5);
      const bound = await publish(
        f,
        context + '-op',
        machine,
        f.principal,
        f.prefix + '-worker-a',
        context,
      );
      const before = (
        await admin.query(
          "SELECT expires > clock_timestamp() AS fresh FROM ct.context_versions WHERE tenant='a' AND id=$1 AND version=1",
          [context],
        )
      ).rows[0];
      assert.equal(before.fresh, true, 'context must be fresh before the wait');
      // Skew only the test's waiting phase, never token creation or dispatch.
      // A forward Node clock would make the old sleep-only oracle finish early.
      Date.now = () => realNow() + skew;
      try {
        const witness = await waitForContextExpiry(context, 1);
        assert.equal(witness.expired, true);
      } finally {
        Date.now = realNow;
      }
      assert.equal(
        (await f.controller.dispatch(bound.cap, bound.x.id)).state,
        'DENIED',
      );
      assert.equal(await denial(bound.x.id), 'MANIFEST_UNAVAILABLE');
      assert.equal(f.provider.sends, 0);
    }
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    Date.now = realNow;
    await closeExpiryFixture(f, ['clock-ahead', 'clock-behind'], primaryFailed);
  }
});

test('context expiry during a final-send context lock wait denies without sending', async () => {
  const f = await fixture('manifest-expiry-lock');
  const machine = await f.actor('machine');
  const hold = await contextDb.connect();
  let pending: Promise<Record<string, any>> | undefined;
  let primaryFailed = false;
  try {
    const holdingPid = Number(
      (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    );
    assert.ok(Number.isInteger(holdingPid) && holdingPid > 0);
    await note(f, 'final-expiry-context', false, 15);
    const bound = await publish(
      f,
      'final-expiry-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'final-expiry-context',
    );
    const controller = new EffectController(
      f.controllerDb,
      f.provider,
      fence,
      30000,
      {
        afterReservation: async () => {
          await hold.query('BEGIN');
          await hold.query(
            'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
            ['a', 'final-expiry-context'],
          );
        },
      },
    );
    pending = controller.dispatch(bound.cap, bound.x.id);
    // Retain cleanup ownership if a preceding witness/assertion fails.
    void pending.catch(() => undefined);
    await waitFor(
      '%SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE%',
      holdingPid,
    );
    const reserved = (
      await admin.query(
        "SELECT state FROM ct.operations WHERE tenant='a' AND id=$1",
        [bound.x.id],
      )
    ).rows[0];
    assert.equal(reserved.state, 'RESERVED');
    assert.equal(f.provider.sends, 0);
    await waitForContextExpiry('final-expiry-context', 1);
    await hold.query('COMMIT');
    assert.equal((await pending).state, 'DENIED');
    assert.equal(await denial(bound.x.id), 'MANIFEST_UNAVAILABLE');
    assert.equal(f.provider.sends, 0);
    const grant = (
      await admin.query(
        "SELECT reserved FROM ct.grants WHERE tenant='a' AND id=$1",
        [bound.x.grant],
      )
    ).rows[0];
    assert.equal(Number(grant.reserved), 0);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await hold.query('ROLLBACK').catch(() => undefined);
    hold.release();
    await pending?.catch(() => undefined);
    await closeExpiryFixture(f, ['final-expiry-context'], primaryFailed);
  }
});

test('operations that bound nothing stay unchanged when context or cognition appears later', async () => {
  const f = await fixture('manifest-absent');
  const machine = await f.actor('machine');
  try {
    const absent = await publish(
      f,
      'absent-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
    );
    await note(f, 'absent-context', false);
    const contextual = await publish(
      f,
      'absent-context-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'absent-context',
    );
    const before = (
      await admin.query(
        "SELECT id,digest,contract_version,context_id,cognition_revision FROM ct.operations WHERE tenant='a' AND id IN('absent-op','absent-context-op') ORDER BY id",
      )
    ).rows;
    assert.equal(Number(before[1].contract_version), 1);
    assert.equal(before[1].context_id, null);
    assert.equal(Number(before[0].contract_version), 3);
    assert.equal(before[0].cognition_revision, null);
    await contexts.ingest(machine, {
      id: 'absent-later',
      expectedVersion: 0,
      payload: { text: 'later' },
      source: { kind: 'document', reference: 'doc:absent-later' },
      ttlSeconds: 3600,
    });
    await cognition.record(await f.actor('user'), {
      principal: f.principal,
      provider: 'fixture',
      model: 'later-model',
      configurationReference: 'later-config',
      compatibility: 'UNKNOWN',
    });
    assert.equal(
      (await f.controller.dispatch(absent.cap, absent.x.id)).state,
      'COMMITTED',
    );
    assert.equal(
      (await f.controller.dispatch(contextual.cap, contextual.x.id)).state,
      'COMMITTED',
    );
    const after = (
      await admin.query(
        "SELECT id,digest,contract_version,cognition_revision FROM ct.operations WHERE tenant='a' AND id IN('absent-op','absent-context-op') ORDER BY id",
      )
    ).rows;
    assert.deepEqual(
      after.map((row) => [row.id, row.digest, Number(row.contract_version)]),
      before.map((row) => [row.id, row.digest, Number(row.contract_version)]),
    );
    assert.equal(after[0].cognition_revision, null);
    assert.equal(f.provider.sends, 2);
    assert.equal(
      (
        await admin.query(
          "SELECT digest FROM ct.approvals WHERE tenant='a' AND operation='absent-op'",
        )
      ).rows[0].digest,
      absent.op.digest,
    );
  } finally {
    await f.close();
  }
});

test('shared and ownerless context races deny admission without a send', async () => {
  const f = await fixture('manifest-race');
  const machine = await f.actor('machine');
  const owner = await f.actor('user');
  const hold = await contextDb.connect();
  try {
    await note(f, 'race-shared', true);
    const other = await otherMachine(f, 'manifest-race');
    const shared = await publish(
      f,
      'race-shared-op',
      other.worker,
      other.principal,
      other.workerId,
      'race-shared',
    );
    await contexts.ingest(owner, {
      id: 'race-ownerless',
      expectedVersion: 0,
      payload: { text: 'ownerless' },
      source: { kind: 'document', reference: 'doc:race-ownerless' },
      ttlSeconds: 3600,
    });
    const ownerlessReview = await contexts.inspectQuarantine(
      owner,
      'race-ownerless',
    );
    await contexts.approve(
      owner,
      'race-ownerless',
      ownerlessReview.version,
      ownerlessReview.digest,
      true,
    );
    const ownerless = await publish(
      f,
      'race-ownerless-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'race-ownerless',
    );
    for (const item of [
      { id: shared.x.id, cap: shared.cap, context: 'race-shared' },
      { id: ownerless.x.id, cap: ownerless.cap, context: 'race-ownerless' },
    ]) {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
        ['a', item.context],
      );
      const pending = f.controller.dispatch(item.cap, item.id);
      await waitFor(
        '%SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE%',
      );
      await hold.query(
        'UPDATE ct.context_heads SET deleted=true,revision=revision+1 WHERE tenant=$1 AND id=$2',
        ['a', item.context],
      );
      await hold.query('COMMIT');
      assert.equal((await pending).state, 'DENIED');
      assert.equal(await denial(item.id), 'MANIFEST_UNAVAILABLE');
    }
    assert.equal(f.provider.sends, 0);
    await note(f, 'cross-a', true);
    await contexts.ingest(other.worker, {
      id: 'cross-b',
      expectedVersion: 0,
      payload: { text: 'owned by the other VERA' },
      source: { kind: 'document', reference: 'doc:cross-b' },
      ttlSeconds: 3600,
    });
    const crossReview = await contexts.inspectQuarantine(owner, 'cross-b');
    await contexts.approve(
      owner,
      'cross-b',
      crossReview.version,
      crossReview.digest,
      true,
    );
    const fromA = await publish(
      f,
      'cross-a-op',
      machine,
      f.principal,
      f.prefix + '-worker-a',
      'cross-b',
    );
    const fromB = await publish(
      f,
      'cross-b-op',
      other.worker,
      other.principal,
      other.workerId,
      'cross-a',
    );
    const crossed = await Promise.all([
      f.controller.dispatch(fromA.cap, fromA.x.id),
      f.controller.dispatch(fromB.cap, fromB.x.id),
    ]);
    assert.deepEqual(crossed.map((row) => row.state).sort(), [
      'COMMITTED',
      'COMMITTED',
    ]);
    assert.equal(f.provider.sends, 2);
  } finally {
    await hold.query('ROLLBACK').catch(() => undefined);
    hold.release();
    await f.close();
  }
});

test('direct cognition inserts lock the principal before the next revision', async () => {
  const f = await fixture('manifest-cog');
  const first = await gov.connect();
  const second = await gov.connect();
  const product = pool('ct_product_api');
  try {
    await first.query('BEGIN');
    await first.query(
      'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', f.principal],
    );
    assert.equal(
      Number(
        (
          await first.query(
            "SELECT ct.append_cognition($1,$2,'fixture','model','cfg','UNKNOWN') AS n",
            ['a', f.principal],
          )
        ).rows[0].n,
      ),
      1,
    );
    const queued = second.query(
      "SELECT ct.append_cognition($1,$2,'fixture','model','cfg-2','TESTED') AS n",
      ['a', f.principal],
    );
    await waitFor('%append_cognition%');
    await first.query('COMMIT');
    assert.equal(Number((await queued).rows[0].n), 2);
    await first.query('BEGIN');
    await first.query(
      'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', f.principal],
    );
    assert.equal(
      Number(
        (
          await first.query(
            "SELECT ct.append_cognition($1,$2,'fixture','model','cfg-3','UNKNOWN') AS n",
            ['a', f.principal],
          )
        ).rows[0].n,
      ),
      3,
    );
    const raw = second.query(
      "INSERT INTO ct.cognition_bindings(tenant,principal,provider,model,configuration_reference,compatibility) VALUES('a',$1,'fixture','model','cfg-4','NEEDS_TESTING') RETURNING revision",
      [f.principal],
    );
    await waitFor('%INSERT INTO ct.cognition_bindings%');
    await first.query('COMMIT');
    assert.equal(Number((await raw).rows[0].revision), 4);
    assert.equal(
      (
        await cognition.record(await f.actor('user'), {
          principal: f.principal,
          provider: 'fixture',
          model: 'service-model',
          configurationReference: 'service-config',
          compatibility: 'UNKNOWN',
        })
      ).revision,
      5,
    );
    await assert.rejects(
      gov.query(
        "INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES('a',$1,99,'fixture','model','bad','UNKNOWN')",
        [f.principal],
      ),
      /cognition revision sequence/,
    );
    const zeroPrincipal = 'zero-' + f.prefix;
    await gov.query(
      'INSERT INTO ct.principals(tenant,id,epoch,generation) VALUES($1,$2,1,1)',
      ['a', zeroPrincipal],
    );
    for (const revision of [0, -1])
      await assert.rejects(
        gov.query(
          'INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            'a',
            zeroPrincipal,
            revision,
            'fixture',
            'model',
            'rejected-' + revision,
            'UNKNOWN',
          ],
        ),
        /cognition revision/,
      );
    await assert.rejects(
      gov.query(
        'INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES($1,$2,2,$3,$4,$5,$6)',
        ['a', zeroPrincipal, 'fixture', 'model', 'gap', 'UNKNOWN'],
      ),
      /cognition revision sequence/,
    );
    assert.equal(
      (
        await gov.query(
          'SELECT count(*)::int AS n FROM ct.cognition_bindings WHERE tenant=$1 AND principal=$2',
          ['a', zeroPrincipal],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      Number(
        (
          await gov.query(
            'INSERT INTO ct.cognition_bindings(tenant,principal,provider,model,configuration_reference,compatibility) VALUES($1,$2,$3,$4,$5,$6) RETURNING revision',
            ['a', zeroPrincipal, 'fixture', 'model', 'omitted', 'UNKNOWN'],
          )
        ).rows[0].revision,
      ),
      1,
    );
    await assert.rejects(
      gov.query(
        'INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES($1,$2,1,$3,$4,$5,$6)',
        ['a', zeroPrincipal, 'fixture', 'model', 'duplicate', 'UNKNOWN'],
      ),
      /cognition revision sequence/,
    );
    assert.equal(
      Number(
        (
          await gov.query(
            'INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES($1,$2,2,$3,$4,$5,$6) RETURNING revision',
            ['a', zeroPrincipal, 'fixture', 'model', 'exact-next', 'TESTED'],
          )
        ).rows[0].revision,
      ),
      2,
    );
    await assert.rejects(
      admin.query(
        "UPDATE ct.cognition_bindings SET model='changed' WHERE tenant='a' AND principal=$1 AND revision=1",
        [f.principal],
      ),
      /cognition append only/,
    );
    await assert.rejects(
      gov.query(
        "DELETE FROM ct.cognition_bindings WHERE tenant='a' AND principal=$1",
        [f.principal],
      ),
      /permission denied|cognition append only/,
    );
    await assert.rejects(
      product.query(
        "SELECT ct.append_cognition('a',$1,'fixture','model','nope','UNKNOWN')",
        [f.principal],
      ),
      /permission denied/,
    );
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    await product.end();
    await f.close();
  }
});

test('runtime roles read the manifest and a hidden cognition row fails closed', async () => {
  const f = await fixture('manifest-roles');
  const controller = pool('ct_controller');
  const issuer = pool('ct_cap_issuer');
  const product = pool('ct_product_api');
  const tenant = pool('ct_tenant_a');
  const session = await admin.connect();
  try {
    await contexts.ingest(await f.actor('machine'), {
      id: 'role-note',
      expectedVersion: 0,
      payload: { text: 'role' },
      source: { kind: 'document', reference: 'doc:role-note' },
      ttlSeconds: 3600,
    });
    await cognition.record(await f.actor('user'), {
      principal: f.principal,
      provider: 'fixture',
      model: 'role-model',
      configurationReference: 'role-config',
      compatibility: 'UNKNOWN',
    });
    for (const role of [controller, issuer, product]) {
      assert.equal(
        (
          await role.query(
            'SELECT revision FROM ct.cognition_bindings WHERE tenant=$1 AND principal=$2',
            ['a', f.principal],
          )
        ).rowCount,
        1,
      );
    }
    const locked = await product.connect();
    await locked.query('BEGIN');
    await locked.query(
      'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', 'role-note'],
    );
    await locked.query('ROLLBACK');
    locked.release();
    await assert.rejects(
      tenant.query('SELECT * FROM ct.cognition_bindings'),
      /permission denied/,
    );
    await session.query('BEGIN');
    await session.query(
      'DROP POLICY manifest_cognition_read ON ct.cognition_bindings',
    );
    await session.query('SET LOCAL ROLE ct_controller');
    const hidden = (
      await session.query(
        'SELECT MAX(revision) AS r FROM ct.cognition_bindings WHERE tenant=$1 AND principal=$2',
        ['a', f.principal],
      )
    ).rows[0].r;
    assert.equal(hidden, null);
    assert.equal(
      manifestAdmission(
        {
          ...vectorRow,
          principal: f.principal,
          contract_version: 3,
          cognition_revision: 1,
        },
        null,
        null,
        hidden,
        Date.now(),
      ),
      'MANIFEST_UNAVAILABLE',
    );
    await session.query('ROLLBACK');
  } finally {
    await session.query('ROLLBACK').catch(() => undefined);
    session.release();
    await Promise.all([
      controller.end(),
      issuer.end(),
      product.end(),
      tenant.end(),
    ]);
    await f.close();
  }
});

test('recovery keeps a version 3 archive and rejects a missing reference', async () => {
  const f = await fixture('manifest-recover2');
  const directory = path.resolve('.local/manifest-recovery-fence');
  await fs.rm(directory, { recursive: true, force: true });
  const store = new LocalIndependentFenceStore(directory);
  let inventory: any[] = [];
  const recoveryDb = pool('ct_recovery');
  const recovery = new RecoveryService(
    recoveryDb,
    store,
    {
      supports: (o) => f.provider.supports(o),
      lookup: (o) => f.provider.lookup(o),
    },
    {
      authorizeOperator: async (actor) => {
        if (actor.subject !== f.prefix + '-owner-a' || actor.kind !== 'user')
          throw Error('fixture independent cluster operator required');
      },
      readAuthorityJournal: async () => ({ records: [], digest: sha('[]') }),
      readOperationInventory: async () => ({
        reference: 'manifest-archive',
        operations: inventory,
        digest: sha(canonical(inventory)),
        complete: true,
      }),
      verifyActivationApproval: async () => undefined,
    },
  );
  try {
    await note(f, 'recovery-note-2', false);
    await cognition.record(await f.actor('user'), {
      principal: f.principal,
      provider: 'fixture',
      model: 'recovery-model',
      configurationReference: 'recovery-config',
      compatibility: 'UNKNOWN',
    });
    const published = await publish(
      f,
      'recovery-op-2',
      await f.actor('machine'),
      f.principal,
      f.prefix + '-worker-a',
      'recovery-note-2',
    );
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
    assert.equal(archive.binding.contractVersion, 3);
    const missing = structuredClone(archive);
    missing.binding = {
      ...missing.binding,
      id: 'recovery-missing-context',
      idempotencyKey: 'recovery-missing-context',
      contextId: 'missing-context',
    };
    missing.digest = sha(canonical(missing.binding));
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
    const roundTrip = structuredClone(archive);
    roundTrip.binding = {
      ...roundTrip.binding,
      id: 'recovery-round-trip',
      idempotencyKey: 'recovery-round-trip',
    };
    roundTrip.digest = sha(canonical(roundTrip.binding));
    inventory = [roundTrip];
    assert.equal(
      await recovery.importInventory(await f.actor('user'), run.id),
      1,
    );
    const restored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id='recovery-round-trip'",
      )
    ).rows[0];
    assert.equal(Number(restored.contract_version), 3);
    assert.equal(restored.context_id, 'recovery-note-2');
    assert.equal(Number(restored.context_version), 1);
    assert.equal(Number(restored.cognition_revision), 1);
    assert.equal(restored.digest, roundTrip.digest);
    assert.equal(restored.state, 'UNKNOWN');
    assert.equal(
      (
        await admin.query(
          "SELECT digest FROM ct.operations WHERE tenant='a' AND id=$1",
          [published.x.id],
        )
      ).rows[0].digest,
      published.op.digest,
    );
    assert.equal(
      canonical(actionBinding(rowFromBinding(archive.binding))),
      canonical(archive.binding),
    );
  } finally {
    await bootstrap();
    await recoveryDb.end();
    await f.close();
  }
});

test('UNKNOWN reconciliation and an in-flight send do not resend or rewrite the binding', async () => {
  const f = await fixture('manifest-unknown');
  try {
    await note(f, 'unknown-note', false);
    const uncertain = await publish(
      f,
      'unknown-op',
      await f.actor('machine'),
      f.principal,
      f.prefix + '-worker-a',
      'unknown-note',
    );
    const digest = uncertain.op.digest;
    f.provider.loseAck = true;
    assert.equal(
      (await f.controller.dispatch(uncertain.cap, uncertain.x.id)).state,
      'UNKNOWN',
    );
    assert.equal(f.provider.sends, 1);
    await contexts.ingest(await f.actor('machine'), {
      id: 'unknown-note',
      expectedVersion: 1,
      payload: { text: 'after unknown' },
      source: { kind: 'document', reference: 'doc:unknown-note-2' },
      ttlSeconds: 3600,
    });
    await assert.rejects(
      f.product.propose(await f.actor('machine'), {
        ...uncertain.x,
        id: 'unknown-substitute',
      }),
      /no substitute operation/,
    );
    f.provider.loseAck = false;
    assert.equal(
      (await f.controller.reconcile(uncertain.cap, uncertain.x.id)).state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 1);
    const stored = (
      await admin.query(
        "SELECT * FROM ct.operations WHERE tenant='a' AND id=$1",
        [uncertain.x.id],
      )
    ).rows[0];
    assert.equal(stored.digest, digest);
    assert.equal(Number(stored.context_version), 1);
    await note(f, 'inflight-note', false);
    const inflight = await publish(
      f,
      'inflight-op',
      await f.actor('machine'),
      f.principal,
      f.prefix + '-worker-a',
      'inflight-note',
    );
    const controller = new EffectController(
      f.controllerDb,
      f.provider,
      fence,
      30000,
      {
        beforeSend: async () => {
          await contexts.ingest(await f.actor('machine'), {
            id: 'inflight-note',
            expectedVersion: 1,
            payload: { text: 'after admission' },
            source: { kind: 'document', reference: 'doc:inflight-2' },
            ttlSeconds: 3600,
          });
        },
      },
    );
    assert.equal(
      (await controller.dispatch(inflight.cap, inflight.x.id)).state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 2);
    assert.equal(
      f.provider.rows.filter((row) => row.operation === inflight.x.id).length,
      1,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT digest,context_version FROM ct.operations WHERE tenant='a' AND id=$1",
          [inflight.x.id],
        )
      ).rows[0].digest,
      inflight.op.digest,
    );
  } finally {
    await f.close();
  }
});
