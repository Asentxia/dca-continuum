import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { append, pool, tx } from '../src/db.js';
import {
  applyTenantNotice,
  rebuildTenantNotices,
  recordTenantNotice,
  type TenantNotice,
} from '../src/event-envelope.js';
import { admin, gov } from './helpers.js';

const tenantA = pool('ct_tenant_a');
const tenantB = pool('ct_tenant_b');
const controller = pool('ct_controller');
const provider = pool('ct_provider');
const reader = pool('ct_console_reader');
const suffix = randomUUID().slice(0, 8);
const name = (label: string) => `n12-${label}-${suffix}`;

before(async () => {
  await tx(gov, async (c) => {
    await c.query(
      "INSERT INTO ct.tenants VALUES('a'),('b') ON CONFLICT DO NOTHING",
    );
    await c.query(
      "INSERT INTO ct.evidence_heads(tenant) VALUES('a'),('b') ON CONFLICT DO NOTHING",
    );
  });
});

after(async () => {
  await Promise.all(
    [tenantA, tenantB, controller, provider, reader, admin, gov].map((p) =>
      p.end(),
    ),
  );
});

async function ensureTenant(tenant: string) {
  await tx(gov, async (c) => {
    await c.query('INSERT INTO ct.tenants VALUES($1) ON CONFLICT DO NOTHING', [
      tenant,
    ]);
    await c.query(
      'INSERT INTO ct.evidence_heads(tenant) VALUES($1) ON CONFLICT DO NOTHING',
      [tenant],
    );
  });
}

async function head(tenant: string) {
  const row = (
    await admin.query(
      'SELECT seq, hash FROM ct.evidence_heads WHERE tenant=$1',
      [tenant],
    )
  ).rows[0];
  return { seq: Number(row.seq), hash: String(row.hash) };
}

async function notices(tenant: string) {
  return (
    await admin.query(
      'SELECT seq, subject_id, body, source FROM ct.notice_projection WHERE tenant=$1 ORDER BY seq',
      [tenant],
    )
  ).rows.map((row) => ({
    seq: Number(row.seq),
    subjectId: String(row.subject_id),
    body: String(row.body),
    source: String(row.source),
  }));
}

async function deliveryCount(tenant: string) {
  return Number(
    (
      await admin.query(
        'SELECT count(*) n FROM ct.notice_deliveries WHERE tenant=$1',
        [tenant],
      )
    ).rows[0].n,
  );
}

async function authority() {
  const count = async (sql: string) =>
    Number((await admin.query(sql)).rows[0].n);
  return {
    grants: await count('SELECT count(*) n FROM ct.grants'),
    approvals: await count('SELECT count(*) n FROM ct.approvals'),
    operations: await count('SELECT count(*) n FROM ct.operations'),
    effects: await count('SELECT count(*) n FROM provider.effects'),
    outbox: await count('SELECT count(*) n FROM ct.outbox'),
    inbox: await count('SELECT count(*) n FROM ct.inbox'),
    unknown: (
      await admin.query(
        "SELECT tenant, id, state, observation::text AS observation FROM ct.operations WHERE state='UNKNOWN' ORDER BY tenant, id",
      )
    ).rows,
  };
}

function psql(database: string, args: string[]) {
  const result = spawnSync(
    'psql',
    ['-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function eventPayload(tenant: string, seq: number) {
  return String(
    (
      await admin.query(
        'SELECT payload FROM ct.evidence_events WHERE tenant=$1 AND seq=$2',
        [tenant, seq],
      )
    ).rows[0].payload,
  );
}

describe('tenant notice envelope', { concurrency: 1 }, () => {
  test('historical events stay in the chain and out of the projection', async () => {
    const tenant = name('history');
    await ensureTenant(tenant);
    const historical = await tx(gov, (c) =>
      append(c, tenant, 'PARALLEL', { n: 7 }),
    );
    const before = await eventPayload(tenant, historical.seq);
    const saved = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'kept', 'notice text'),
    );
    assert.equal(
      await tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq)),
      'applied',
    );
    assert.equal(
      await tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq)),
      'duplicate',
    );
    assert.deepEqual(await notices(tenant), [
      {
        seq: saved.seq,
        subjectId: 'kept',
        body: 'notice text',
        source: 'governor',
      },
    ]);
    assert.equal(await deliveryCount(tenant), 1);
    assert.equal(
      (await tx(gov, (c) => rebuildTenantNotices(c, tenant))).notices,
      1,
    );
    assert.deepEqual(await notices(tenant), [
      {
        seq: saved.seq,
        subjectId: 'kept',
        body: 'notice text',
        source: 'governor',
      },
    ]);
    assert.equal(await eventPayload(tenant, historical.seq), before);
    assert.notEqual((await notices(tenant))[0].body, 'caller-forged-body');
  });

  test('concurrent recording waits for the rebuild evidence-head lock', async () => {
    const tenant = name('lock');
    await ensureTenant(tenant);
    const first = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'earlier', 'before'),
    );
    await tx(gov, (c) => applyTenantNotice(c, tenant, first.seq));
    const before = await head(tenant);
    const holder = await gov.connect();
    let pending: Promise<TenantNotice> | undefined;
    let closed = false;
    try {
      await holder.query('BEGIN');
      await rebuildTenantNotices(holder, tenant);
      pending = tx(gov, (c) =>
        recordTenantNotice(c, tenant, 'during', 'waited'),
      );
      const started = Date.now();
      let waiting = false;
      while (Date.now() - started < 5000) {
        const n = Number(
          (
            await admin.query(
              `SELECT count(*) n FROM pg_stat_activity
               WHERE wait_event_type='Lock' AND query LIKE '%ct.evidence_heads%'
                 AND pid<>pg_backend_pid()`,
            )
          ).rows[0].n,
        );
        if (n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true);
      assert.deepEqual(await head(tenant), before);
      await holder.query('COMMIT');
      closed = true;
      const saved = await pending;
      pending = undefined;
      assert.deepEqual(await head(tenant), {
        seq: before.seq + 1,
        hash: saved.hash,
      });
      await tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq));
      assert.deepEqual(
        (await notices(tenant)).map((row) => row.subjectId),
        ['earlier', 'during'],
      );
      assert.equal(await deliveryCount(tenant), 2);
    } finally {
      if (!closed) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
  });

  test('missing, foreign, and forged events do not become notices', async () => {
    const tenant = name('forge');
    await ensureTenant(tenant);
    const historical = await tx(gov, (c) =>
      append(c, tenant, 'PARALLEL', { n: 1 }),
    );
    const saved = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'real', 'stored text'),
    );
    await tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq));
    const before = await notices(tenant);
    await assert.rejects(
      tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq + 50)),
      /missing evidence event/,
    );
    await assert.rejects(
      tx(gov, (c) => applyTenantNotice(c, tenant, historical.seq)),
      /not a tenant notice/,
    );
    assert.deepEqual(await notices(tenant), before);
    await tx(admin, async (c) => {
      await c.query(
        'ALTER TABLE ct.evidence_events DISABLE TRIGGER evidence_immutable',
      );
      await c.query(
        "UPDATE ct.evidence_events SET hash=repeat('ab',32) WHERE tenant=$1 AND seq=$2",
        [tenant, saved.seq],
      );
      await c.query(
        'ALTER TABLE ct.evidence_events ENABLE TRIGGER evidence_immutable',
      );
    });
    try {
      await assert.rejects(
        tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq)),
        /evidence chain does not match head/,
      );
      await assert.rejects(
        tx(gov, (c) => rebuildTenantNotices(c, tenant)),
        /evidence chain does not match head/,
      );
      assert.deepEqual(await notices(tenant), before);
    } finally {
      await tx(admin, async (c) => {
        await c.query(
          'ALTER TABLE ct.evidence_events DISABLE TRIGGER evidence_immutable',
        );
        await c.query(
          'UPDATE ct.evidence_events SET hash=$3 WHERE tenant=$1 AND seq=$2',
          [tenant, saved.seq, saved.hash],
        );
        await c.query(
          'ALTER TABLE ct.evidence_events ENABLE TRIGGER evidence_immutable',
        );
      });
    }
    await tx(admin, async (c) => {
      await c.query(
        'DELETE FROM ct.notice_projection WHERE tenant=$1 AND seq=$2',
        [tenant, saved.seq],
      );
      await c.query(
        'INSERT INTO ct.notice_projection(tenant, seq, subject_id, body, source) VALUES($1,$2,$3,$4,$5)',
        [tenant, saved.seq, 'forged-id', 'forged-body', 'governor'],
      );
    });
    await tx(gov, (c) => rebuildTenantNotices(c, tenant));
    assert.deepEqual(await notices(tenant), [
      {
        seq: saved.seq,
        subjectId: 'real',
        body: 'stored text',
        source: 'governor',
      },
    ]);
    assert.equal(await deliveryCount(tenant), 1);
  });

  test('malformed notices fail and leave the prior projection', async () => {
    const tenant = name('bad');
    await ensureTenant(tenant);
    const good = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'good', 'kept'),
    );
    await tx(gov, (c) => applyTenantNotice(c, tenant, good.seq));
    const neighbor = await tx(gov, (c) =>
      append(c, tenant, 'PARALLEL', { n: 3 }),
    );
    const neighborPayload = await eventPayload(tenant, neighbor.seq);
    const beforeHead = await head(tenant);
    await assert.rejects(
      tx(gov, (c) => recordTenantNotice(c, tenant, 'bad', '')),
      /malformed tenant notice/,
    );
    await assert.rejects(
      tx(gov, (c) => recordTenantNotice(c, tenant, '', 'text')),
      /malformed tenant notice/,
    );
    assert.deepEqual(await head(tenant), beforeHead);
    const unsupported = await tx(gov, (c) =>
      append(c, tenant, 'TENANT_NOTICE', {
        body: { text: 'later' },
        envelope: 2,
        source: 'governor',
        subject: { id: 'bad', kind: 'notice' },
        tenant,
      }),
    );
    await assert.rejects(
      tx(gov, (c) => applyTenantNotice(c, tenant, unsupported.seq)),
      /unsupported tenant notice/,
    );
    await assert.rejects(
      tx(gov, (c) => rebuildTenantNotices(c, tenant)),
      /unsupported tenant notice/,
    );
    assert.deepEqual(await notices(tenant), [
      { seq: good.seq, subjectId: 'good', body: 'kept', source: 'governor' },
    ]);
    assert.equal(await eventPayload(tenant, neighbor.seq), neighborPayload);
    const mismatchedTenant = name('bad-tenant');
    await ensureTenant(mismatchedTenant);
    const mismatched = await tx(gov, (c) =>
      append(c, mismatchedTenant, 'TENANT_NOTICE', {
        body: { text: 'cross' },
        envelope: 1,
        source: 'governor',
        subject: { id: 'other', kind: 'notice' },
        tenant: 'b',
      }),
    );
    await assert.rejects(
      tx(gov, (c) => applyTenantNotice(c, mismatchedTenant, mismatched.seq)),
      /malformed tenant notice/,
    );
    await assert.rejects(
      tx(gov, (c) => rebuildTenantNotices(c, mismatchedTenant)),
      /malformed tenant notice/,
    );
    const missingTenant = name('bad-body');
    await ensureTenant(missingTenant);
    const missingBody = await tx(gov, (c) =>
      append(c, missingTenant, 'TENANT_NOTICE', {
        envelope: 1,
        source: 'governor',
        subject: { id: 'nobody', kind: 'notice' },
        tenant: missingTenant,
      }),
    );
    await assert.rejects(
      tx(gov, (c) => applyTenantNotice(c, missingTenant, missingBody.seq)),
      /malformed tenant notice/,
    );
    await assert.rejects(
      tx(gov, (c) => rebuildTenantNotices(c, missingTenant)),
      /malformed tenant notice/,
    );
  });

  test('rollback stays inside the failed transaction', async () => {
    const tenant = name('rollback');
    await ensureTenant(tenant);
    const beforeAuthority = await authority();
    const beforeHead = await head(tenant);
    await assert.rejects(
      tx(gov, async (c) => {
        await recordTenantNotice(c, tenant, 'rolled', 'back');
        throw Error('injected record failure');
      }),
      /injected record failure/,
    );
    assert.deepEqual(await head(tenant), beforeHead);
    assert.deepEqual(await notices(tenant), []);
    assert.equal(await deliveryCount(tenant), 0);
    const saved = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'kept', 'committed'),
    );
    const recordedHead = await head(tenant);
    await assert.rejects(
      tx(gov, async (c) => {
        await applyTenantNotice(c, tenant, saved.seq);
        throw Error('injected apply failure');
      }),
      /injected apply failure/,
    );
    assert.deepEqual(await head(tenant), recordedHead);
    assert.deepEqual(await notices(tenant), []);
    assert.equal(await deliveryCount(tenant), 0);
    await tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq));
    const applied = await notices(tenant);
    await assert.rejects(
      tx(gov, async (c) => {
        await rebuildTenantNotices(c, tenant);
        throw Error('injected rebuild failure');
      }),
      /injected rebuild failure/,
    );
    assert.deepEqual(await head(tenant), recordedHead);
    assert.deepEqual(await notices(tenant), applied);
    assert.equal(await deliveryCount(tenant), 1);
    assert.deepEqual(await authority(), beforeAuthority);
  });

  test('a committed notice survives a failed apply and is restored once', async () => {
    const tenant = name('survive');
    await ensureTenant(tenant);
    const beforeAuthority = await authority();
    const first = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'keep', 'committed notice'),
    );
    const recordedHead = await head(tenant);
    const stored = await eventPayload(tenant, first.seq);
    await assert.rejects(
      tx(gov, async (c) => {
        await applyTenantNotice(c, tenant, first.seq);
        throw Error('injected apply failure');
      }),
      /injected apply failure/,
    );
    assert.deepEqual(await head(tenant), recordedHead);
    assert.equal(await eventPayload(tenant, first.seq), stored);
    assert.deepEqual(await notices(tenant), []);
    assert.equal(await deliveryCount(tenant), 0);
    assert.deepEqual(await authority(), beforeAuthority);
    assert.equal(
      await tx(gov, (c) => applyTenantNotice(c, tenant, first.seq)),
      'applied',
    );
    assert.equal(
      await tx(gov, (c) => applyTenantNotice(c, tenant, first.seq)),
      'duplicate',
    );
    assert.deepEqual(await notices(tenant), [
      {
        seq: first.seq,
        subjectId: 'keep',
        body: 'committed notice',
        source: 'governor',
      },
    ]);
    const second = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'again', 'second notice'),
    );
    await assert.rejects(
      tx(gov, async (c) => {
        await applyTenantNotice(c, tenant, second.seq);
        throw Error('injected apply failure');
      }),
      /injected apply failure/,
    );
    assert.equal((await eventPayload(tenant, second.seq)) === '', false);
    assert.equal(
      (await tx(gov, (c) => rebuildTenantNotices(c, tenant))).notices,
      2,
    );
    assert.deepEqual(await notices(tenant), [
      {
        seq: first.seq,
        subjectId: 'keep',
        body: 'committed notice',
        source: 'governor',
      },
      {
        seq: second.seq,
        subjectId: 'again',
        body: 'second notice',
        source: 'governor',
      },
    ]);
    assert.equal(await deliveryCount(tenant), 2);
    assert.deepEqual(await head(tenant), {
      seq: second.seq,
      hash: second.hash,
    });
    assert.deepEqual(await authority(), beforeAuthority);
  });

  test('apply waits and does not read an uncommitted notice', async () => {
    const tenant = name('open');
    await ensureTenant(tenant);
    const holder = await gov.connect();
    let pending: Promise<unknown> | undefined;
    let closed = false;
    try {
      await holder.query('BEGIN');
      const saved = await recordTenantNotice(holder, tenant, 'open', 'not yet');
      pending = tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq));
      const started = Date.now();
      let waiting = false;
      while (Date.now() - started < 5000) {
        const n = Number(
          (
            await admin.query(
              `SELECT count(*) n FROM pg_stat_activity
               WHERE wait_event_type='Lock' AND query LIKE '%ct.evidence_heads%'
                 AND pid<>pg_backend_pid()`,
            )
          ).rows[0].n,
        );
        if (n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true);
      assert.deepEqual(await notices(tenant), []);
      await holder.query('ROLLBACK');
      closed = true;
      await assert.rejects(pending, /missing evidence event/);
      pending = undefined;
      assert.deepEqual(await head(tenant), { seq: 0, hash: 'GENESIS' });
      assert.deepEqual(await notices(tenant), []);
      assert.equal(await deliveryCount(tenant), 0);
    } finally {
      if (!closed) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
  });

  test('an earlier broken link does not publish a later notice', async () => {
    const tenant = name('earlier');
    await ensureTenant(tenant);
    const beforeAuthority = await authority();
    const earlier = await tx(gov, (c) =>
      append(c, tenant, 'PARALLEL', { n: 1 }),
    );
    const kept = await tx(gov, (c) =>
      recordTenantNotice(c, tenant, 'kept', 'already applied'),
    );
    await tx(gov, (c) => applyTenantNotice(c, tenant, kept.seq));
    const tail = await head(tenant);
    await tx(admin, async (c) => {
      await c.query(
        'ALTER TABLE ct.evidence_events DISABLE TRIGGER evidence_immutable',
      );
      await c.query(
        "UPDATE ct.evidence_events SET hash=repeat('cd',32) WHERE tenant=$1 AND seq=$2",
        [tenant, earlier.seq],
      );
      await c.query(
        'ALTER TABLE ct.evidence_events ENABLE TRIGGER evidence_immutable',
      );
    });
    try {
      const saved = await tx(gov, (c) =>
        recordTenantNotice(c, tenant, 'later', 'not published'),
      );
      assert.equal(saved.seq, tail.seq + 1);
      const linked = (
        await admin.query(
          'SELECT prev_hash FROM ct.evidence_events WHERE tenant=$1 AND seq=$2',
          [tenant, saved.seq],
        )
      ).rows[0];
      assert.equal(linked.prev_hash, tail.hash);
      await assert.rejects(
        tx(gov, (c) => applyTenantNotice(c, tenant, saved.seq)),
        /evidence chain does not match head/,
      );
      await assert.rejects(
        tx(gov, (c) => rebuildTenantNotices(c, tenant)),
        /evidence chain does not match head/,
      );
      assert.deepEqual(await notices(tenant), [
        {
          seq: kept.seq,
          subjectId: 'kept',
          body: 'already applied',
          source: 'governor',
        },
      ]);
      assert.notEqual(await eventPayload(tenant, saved.seq), '');
      assert.deepEqual(await authority(), beforeAuthority);
    } finally {
      await tx(admin, async (c) => {
        await c.query(
          'ALTER TABLE ct.evidence_events DISABLE TRIGGER evidence_immutable',
        );
        await c.query(
          'UPDATE ct.evidence_events SET hash=$3 WHERE tenant=$1 AND seq=$2',
          [tenant, earlier.seq, earlier.hash],
        );
        await c.query(
          'ALTER TABLE ct.evidence_events ENABLE TRIGGER evidence_immutable',
        );
      });
    }
  });

  test('a fresh console schema includes the notice tables', () => {
    const script = readFileSync('tools/setup-console-db.sh', 'utf8');
    const listed = script.match(/for m in ([^;]+);do/);
    assert.ok(listed);
    const files = listed[1].trim().split(/\s+/);
    // Additive E2 schema follows the unchanged020/021 migrations.
    assert.equal(files.at(-3), '020-tool-manifest.sql');
    assert.equal(files.at(-2), '021-vera-profiles.sql');
    assert.equal(files.at(-1), '022-e2-derived-proposals.sql');
    assert.equal(
      files.filter((file) => file === '021-vera-profiles.sql').length,
      1,
    );
    assert.ok(files.includes('011-console-domain.sql'));
    const database = 'ct_notice_schema';
    psql('postgres', [
      '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid()`,
    ]);
    spawnSync('dropdb', ['--if-exists', database], { encoding: 'utf8' });
    assert.equal(
      spawnSync('createdb', [database], { encoding: 'utf8' }).status,
      0,
    );
    try {
      for (const file of files) psql(database, ['-f', `migrations/${file}`]);
      assert.equal(
        psql(database, [
          '-At',
          '-c',
          "SELECT to_regclass('ct.notice_projection') IS NOT NULL AND to_regclass('ct.notice_deliveries') IS NOT NULL AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='ct.notice_projection'::regclass)",
        ]).trim(),
        't',
      );
      assert.equal(
        psql(database, [
          '-At',
          '-c',
          "SELECT confrelid::regclass::text FROM pg_constraint WHERE conrelid='ct.notice_projection'::regclass AND contype='f'",
        ]).trim(),
        'ct.evidence_events',
      );
      const inserted = spawnSync(
        'psql',
        [
          '-d',
          database,
          '-c',
          "SET ROLE ct_console_reader; INSERT INTO ct.notice_projection(tenant,seq,subject_id,body,source) VALUES('a',1,'x','y','governor')",
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(inserted.status, 0);
      assert.match(inserted.stderr, /42501|permission denied/);
      assert.match(
        psql(database, [
          '-c',
          'SET ROLE ct_console_reader',
          '-c',
          'SELECT count(*) FROM ct.notice_projection',
        ]),
        /\b0\b/,
      );
      for (const role of ['ct_controller', 'ct_tenant_a', 'ct_provider']) {
        const denied = spawnSync(
          'psql',
          [
            '-d',
            database,
            '-c',
            `SET ROLE ${role}; INSERT INTO ct.notice_deliveries(tenant,seq) VALUES('a',1)`,
          ],
          { encoding: 'utf8' },
        );
        assert.notEqual(denied.status, 0, role);
      }
    } finally {
      psql('postgres', [
        '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid()`,
      ]);
      spawnSync('dropdb', ['--if-exists', database], { encoding: 'utf8' });
    }
  });

  test('tenant isolation and existing write permissions stay in place', async () => {
    const saved = await tx(gov, (c) =>
      recordTenantNotice(c, 'a', 'iso-a', 'tenant a notice'),
    );
    await tx(gov, (c) => applyTenantNotice(c, 'a', saved.seq));
    const other = await tx(gov, (c) =>
      recordTenantNotice(c, 'b', 'iso-b', 'tenant b notice'),
    );
    await tx(gov, (c) => applyTenantNotice(c, 'b', other.seq));
    const beforeB = await notices('b');
    assert.equal(
      (
        await tenantA.query(
          'SELECT body FROM ct.notice_projection WHERE seq=$1',
          [saved.seq],
        )
      ).rows[0].body,
      'tenant a notice',
    );
    assert.equal(
      (
        await tenantB.query(
          "SELECT count(*) n FROM ct.notice_projection WHERE tenant='a'",
        )
      ).rows[0].n,
      '0',
    );
    await tx(gov, (c) => rebuildTenantNotices(c, 'a'));
    assert.deepEqual(await notices('b'), beforeB);
    const forged =
      "INSERT INTO ct.notice_projection(tenant, seq, subject_id, body, source) VALUES('a',1,'x','y','governor')";
    for (const role of [tenantA, tenantB, controller, provider, reader]) {
      await assert.rejects(role.query(forged), { code: '42501' });
    }
    await assert.rejects(provider.query('SELECT 1 FROM ct.evidence_events'), {
      code: '42501',
    });
    await assert.rejects(provider.query('SELECT 1 FROM ct.notice_projection'), {
      code: '42501',
    });
    assert.equal(
      (
        await reader.query(
          'SELECT body FROM ct.notice_projection WHERE tenant=$1 AND seq=$2',
          ['a', saved.seq],
        )
      ).rows[0].body,
      'tenant a notice',
    );
  });
});
