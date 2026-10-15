// DB candidate tests: require migrations through 021 and an exclusively owned
// local fixture. This file neither registers nor applies a migration.
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { canonical, pool, sha, tx } from '../src/db.js';
import { VeraService } from '../src/regency/vera-service.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence, gov } from './helpers.js';

const prefix = 'vera-profile-' + randomBytes(6).toString('hex');
const id = (suffix: string) => `${prefix}-${suffix}`;
let f: Awaited<ReturnType<typeof fixture>>;
let auth: pg.Pool;
let tenantA: pg.Pool;
let tenantB: pg.Pool;
let consoleReader: pg.Pool;
let service: VeraService;

function request(suffix: string) {
  return {
    id: id(suffix),
    name: 'VERA ' + suffix,
    description: 'Human-managed profile ' + suffix,
  };
}
async function principal(key: string, tenant = 'a') {
  return (
    await admin.query('SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2', [
      tenant,
      key,
    ])
  ).rows[0];
}
async function profile(key: string, tenant = 'a') {
  return (
    await admin.query(
      'SELECT * FROM ct.vera_profiles WHERE tenant=$1 AND id=$2',
      [tenant, key],
    )
  ).rows[0];
}
async function evidence(key: string, tenant = 'a') {
  return (
    await admin.query(
      "SELECT * FROM ct.evidence_events WHERE tenant=$1 AND kind IN('VERA_CREATED','VERA_PROFILE_UPDATED') AND payload::jsonb->>'id'=$2 ORDER BY seq",
      [tenant, key],
    )
  ).rows;
}
async function head(tenant = 'a') {
  return (
    await admin.query(
      'SELECT seq,hash FROM ct.evidence_heads WHERE tenant=$1',
      [tenant],
    )
  ).rows[0];
}
async function absent(key: string, tenant = 'a') {
  assert.equal(await principal(key, tenant), undefined);
  assert.equal(await profile(key, tenant), undefined);
  assert.deepEqual(await evidence(key, tenant), []);
}
async function unrelatedState() {
  const tables = [
    'identities',
    'assignments',
    'computers',
    'computer_observations',
    'grants',
    'approvals',
    'approval_history',
    'tasks',
    'task_operations',
    'operations',
    'organizations',
    'memberships',
    'mandates',
    'projects',
    'work_coordination',
    'cognition_bindings',
    'resource_limits',
    'resource_reservations',
    'outbox',
    'notice_projection',
    'notice_deliveries',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables)
    counts[table] = Number(
      (await admin.query(`SELECT count(*) AS n FROM ct.${table}`)).rows[0].n,
    );
  counts.providerEffects = Number(
    (await admin.query('SELECT count(*) AS n FROM provider.effects')).rows[0].n,
  );
  counts.tenantNotices = Number(
    (
      await admin.query(
        "SELECT count(*) AS n FROM ct.evidence_events WHERE kind='TENANT_NOTICE'",
      )
    ).rows[0].n,
  );
  counts.sends = f.provider.sends;
  return counts;
}

// Only adapt this test's client. No shared trigger, grant, clock or helper is
// replaced to inject a failure or a lock-wait authentication boundary.
function clientWith(
  client: pg.PoolClient,
  intercept: (
    text: string,
    values: any[] | undefined,
  ) => Promise<pg.QueryResult> | undefined,
): pg.PoolClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query')
        return (text: string, values?: any[]) =>
          intercept(text, values) ?? target.query(text, values);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function faultClient(client: pg.PoolClient, fragment: string) {
  return clientWith(client, (text) =>
    text.startsWith(fragment)
      ? Promise.reject(Error('owned VERA failure injection'))
      : undefined,
  );
}
function faultPool(fragment: string): pg.Pool {
  return {
    connect: async () => faultClient(await auth.connect(), fragment),
  } as unknown as pg.Pool;
}
async function sqlRejected(
  client: pg.PoolClient,
  sql: string,
  values: any[],
  code: string,
) {
  await client.query('SAVEPOINT vera_profile_negative');
  try {
    await assert.rejects(client.query(sql, values), { code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT vera_profile_negative');
    await client.query('RELEASE SAVEPOINT vera_profile_negative');
  }
}
async function rollback(
  db: pg.Pool,
  body: (client: pg.PoolClient) => Promise<void>,
) {
  await assert.rejects(
    tx(db, async (client) => {
      await body(client);
      throw Error('owned VERA fixture rollback');
    }),
    /owned VERA fixture rollback/,
  );
}

describe(
  'narrow human-managed VERA creation/profile candidate',
  { concurrency: 1 },
  () => {
    before(async () => {
      f = await fixture(prefix);
      auth = pool('ct_authority_api');
      tenantA = pool('ct_tenant_a');
      tenantB = pool('ct_tenant_b');
      consoleReader = pool('ct_console_reader');
      service = new VeraService(auth, fence);
    });
    after(async () => {
      // Leave append-only evidence and unique fixture records to the fixture
      // owner. No broad DELETE, shared cleanup or cluster reset is performed.
      if (f) await f.close();
      for (const db of [auth, tenantA, tenantB, consoleReader])
        if (db) await db.end();
      await admin.end();
      await gov.end();
    });

    test('atomic PAUSED creation records only a principal, profile and audit', async () => {
      const x = request('atomic');
      const owner = await f.actor('user');
      const beforeState = await unrelatedState();
      const beforeHead = await head();
      const result = await service.create(owner, x);
      assert.deepEqual(result, {
        id: x.id,
        createdBy: `${prefix}-owner-a`,
        reused: false,
        creation: {
          profileRevision: 1,
          epoch: 1,
          generation: 1,
          active: true,
          executionMode: 'PAUSED',
          availability: 'requires_setup',
        },
        effectAuthority: false,
        workflowAdmitted: false,
        externalEffect: false,
      });
      const p = await principal(x.id);
      assert.equal(p.tenant, 'a');
      assert.equal(p.epoch, 1);
      assert.equal(p.generation, 1);
      assert.equal(p.active, true);
      assert.equal(p.execution_mode, 'PAUSED');
      const v = await profile(x.id);
      assert.equal(v.name, x.name);
      assert.equal(v.description, x.description);
      assert.equal(Number(v.revision), 1);
      assert.equal(v.created_by, result.createdBy);
      assert.equal(v.creation_digest, sha(canonical({ tenant: 'a', ...x })));
      const events = await evidence(x.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'VERA_CREATED');
      const payload = JSON.parse(events[0].payload);
      assert.equal(payload.executionMode, 'PAUSED');
      assert.equal(payload.effectAuthority, false);
      assert.equal(payload.workflowAdmitted, false);
      assert.equal(payload.externalEffect, false);
      assert.equal(Number((await head()).seq), Number(beforeHead.seq) + 1);
      assert.deepEqual(await unrelatedState(), beforeState);
    });

    test('exact replay returns the original identity without a second append', async () => {
      const x = request('repeat');
      const owner = await f.actor('user');
      const first = await service.create(owner, x);
      const p = await principal(x.id);
      const v = await profile(x.id);
      const h = await head();
      const repeat = await service.create(owner, x);
      assert.deepEqual(repeat, { ...first, reused: true });
      assert.deepEqual(await principal(x.id), p);
      assert.deepEqual(await profile(x.id), v);
      assert.deepEqual(await head(), h);
      assert.equal((await evidence(x.id)).length, 1);
    });

    test('changed creation payload conflicts and never rewrites identity/profile', async () => {
      const x = request('changed');
      const owner = await f.actor('user');
      await service.create(owner, x);
      const p = await principal(x.id);
      const v = await profile(x.id);
      const h = await head();
      for (const changed of [
        { ...x, name: x.name + ' changed' },
        { ...x, description: x.description + ' changed' },
      ])
        await assert.rejects(
          service.create(owner, changed),
          /VERA creation conflict/,
        );
      assert.deepEqual(await principal(x.id), p);
      assert.deepEqual(await profile(x.id), v);
      assert.deepEqual(await head(), h);
    });

    test('original-payload replay survives rename; the renamed payload is not creation', async () => {
      const x = request('renamed');
      const owner = await f.actor('user');
      const original = await service.create(owner, x);
      const renamed = {
        ...x,
        name: 'Renamed VERA',
        description: 'Edited profile',
      };
      const update = await service.updateProfile(owner, {
        ...renamed,
        expectedRevision: 1,
      });
      assert.equal(update.revision, 2);
      const h = await head();
      assert.deepEqual(await service.create(owner, x), {
        ...original,
        reused: true,
      });
      await assert.rejects(
        service.create(owner, renamed),
        /VERA creation conflict/,
      );
      const current = await profile(x.id);
      assert.equal(current.name, renamed.name);
      assert.equal(current.description, renamed.description);
      assert.equal(Number(current.revision), 2);
      assert.equal(
        current.creation_digest,
        sha(canonical({ tenant: 'a', ...x })),
      );
      assert.deepEqual(await head(), h);
    });

    test('an existing unprofiled historical principal is never adopted', async () => {
      const x = request('historical');
      await gov.query(
        "INSERT INTO ct.principals(tenant,id,epoch,generation,active,execution_mode) VALUES('a',$1,7,9,true,'PAUSED')",
        [x.id],
      );
      const p = await principal(x.id);
      const h = await head();
      await assert.rejects(
        service.create(await f.actor('user'), x),
        /VERA creation conflict/,
      );
      assert.deepEqual(await principal(x.id), p);
      assert.equal(await profile(x.id), undefined);
      assert.deepEqual(await evidence(x.id), []);
      assert.deepEqual(await head(), h);
    });

    test('concurrent same-request creation makes exactly one principal/profile/append', async () => {
      const x = request('concurrent');
      const owner = await f.actor('user');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => service.create(owner, x)),
      );
      assert.equal(results.filter((result) => !result.reused).length, 1);
      assert.ok(results.every((result) => result.id === x.id));
      for (const table of ['principals', 'vera_profiles'])
        assert.equal(
          Number(
            (
              await admin.query(
                `SELECT count(*) AS n FROM ct.${table} WHERE tenant='a' AND id=$1`,
                [x.id],
              )
            ).rows[0].n,
          ),
          1,
        );
      assert.equal((await evidence(x.id)).length, 1);
    });

    test('concurrent changed creation has one winner and one conflict', async () => {
      const x = request('concurrent-changed');
      const owner = await f.actor('user');
      const candidates = [
        x,
        { ...x, description: 'Different creation request' },
      ];
      const results = await Promise.allSettled(
        candidates.map((candidate) => service.create(owner, candidate)),
      );
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.match(String(rejected.reason), /VERA creation conflict/);
      const winner = results.findIndex(
        (result) => result.status === 'fulfilled',
      );
      assert.equal(
        (await profile(x.id)).description,
        candidates[winner].description,
      );
      assert.equal((await evidence(x.id)).length, 1);
    });

    for (const [label, fragment] of [
      ['profile insert', 'INSERT INTO ct.vera_profiles'],
      ['audit insert', 'INSERT INTO ct.evidence_events'],
    ]) {
      test(`${label} failure rolls back principal/profile/audit with no orphan`, async () => {
        const x = request('failure-' + label.replaceAll(' ', '-'));
        const h = await head();
        const broken = new VeraService(faultPool(fragment), fence);
        await assert.rejects(
          broken.create(await f.actor('user'), x),
          /owned VERA failure injection/,
        );
        await absent(x.id);
        assert.deepEqual(await head(), h);
      });
    }

    test('optional client never commits caller work; outer rollback removes all three', async () => {
      const x = request('outer-rollback');
      const owner = await f.actor('user');
      const h = await head();
      await rollback(auth, async (client) => {
        await service.create(owner, x, client);
        assert.equal(
          (
            await client.query(
              "SELECT count(*) AS n FROM ct.vera_profiles WHERE tenant='a' AND id=$1",
              [x.id],
            )
          ).rows[0].n,
          '1',
        );
        // A second connection cannot see an uncommitted principal/profile/audit.
        await absent(x.id);
        assert.deepEqual(await head(), h);
      });
      await absent(x.id);
      assert.deepEqual(await head(), h);
    });

    test('optional client outside a transaction refuses before any domain write', async () => {
      const x = request('missing-transaction');
      const client = await auth.connect();
      try {
        await assert.rejects(service.create(await f.actor('user'), x, client), {
          code: '25P01',
        });
      } finally {
        client.release();
      }
      await absent(x.id);
    });

    test('caught optional-client failure rolls back only the service savepoint', async () => {
      const good = request('savepoint-kept');
      const bad = request('savepoint-rolled-back');
      const owner = await f.actor('user');
      await tx(auth, async (client) => {
        await service.create(owner, good, client);
        await assert.rejects(
          service.create(
            owner,
            bad,
            faultClient(client, 'INSERT INTO ct.evidence_events'),
          ),
          /owned VERA failure injection/,
        );
        assert.equal(
          (
            await client.query(
              "SELECT count(*) AS n FROM ct.vera_profiles WHERE tenant='a' AND id=$1",
              [good.id],
            )
          ).rows[0].n,
          '1',
        );
      });
      assert.ok(await profile(good.id));
      assert.equal((await evidence(good.id)).length, 1);
      await absent(bad.id);
    });

    test('machine, expired, stale/no/future MFA and unenrolled callers reject', async () => {
      const owner = await f.actor('user');
      const callers = [
        await f.actor('machine'),
        { ...owner, expires: Date.now() - 1 },
        { ...owner, authTime: Date.now() - 301000 },
        { ...owner, authTime: undefined },
        { ...owner, authTime: Date.now() + 60000 },
        { ...owner, methods: [] },
        { ...owner, subject: id('unenrolled') },
        { ...owner, audience: id('wrong-audience') },
      ];
      const h = await head();
      for (const [index, caller] of callers.entries()) {
        const x = request('denied-' + index);
        await assert.rejects(
          service.create(caller, x),
          /identity denied|fresh owner MFA required/,
        );
        await absent(x.id);
      }
      assert.deepEqual(await head(), h);
    });

    test('authorization also fences profile edits and exact creation replay', async () => {
      const x = request('authorized-repeat');
      const owner = await f.actor('user');
      await service.create(owner, x);
      const stale = { ...owner, authTime: Date.now() - 301000 };
      const wrongFence = new VeraService(auth, fence + '-wrong');
      const h = await head();
      for (const denied of [stale, await f.actor('machine')]) {
        await assert.rejects(
          service.create(denied, x),
          /fresh owner MFA required/,
        );
        await assert.rejects(
          service.updateProfile(denied, { ...x, expectedRevision: 1 }),
          /fresh owner MFA required/,
        );
      }
      await assert.rejects(wrongFence.create(owner, x), /recovery fence/);
      await assert.rejects(
        wrongFence.updateProfile(owner, { ...x, expectedRevision: 1 }),
        /recovery fence/,
      );
      const blocked = request('blocked-control');
      await rollback(gov, async (client) => {
        await client.query(
          'UPDATE ct.control SET blocked=true WHERE singleton',
        );
        await assert.rejects(
          service.create(owner, blocked, client),
          /recovery fence/,
        );
      });
      await absent(blocked.id);
      assert.deepEqual(await head(), h);
    });

    for (const staleClock of [2, 3]) {
      test(`fresh owner MFA is rechecked at enrollment ${staleClock} (fixture clock)`, async () => {
        const x = request('freshness-' + staleClock);
        const owner = await f.actor('user');
        const h = await head();
        await tx(auth, async (client) => {
          let checks = 0;
          const clocked = clientWith(client, (text) => {
            if (text !== 'SELECT clock_timestamp() t') return undefined;
            checks++;
            return Promise.resolve({
              rows: [
                {
                  t: new Date(
                    checks >= staleClock
                      ? owner.authTime! + 300001
                      : owner.authTime!,
                  ),
                },
              ],
              command: 'SELECT',
              rowCount: 1,
              oid: 0,
              fields: [],
            });
          });
          await assert.rejects(
            service.create(owner, x, clocked),
            /fresh owner MFA required/,
          );
        });
        await absent(x.id);
        assert.deepEqual(await head(), h);
      });
    }

    test('strict bounded input rejects tenant/counter/mode/authority overrides', async () => {
      const owner = await f.actor('user');
      const valid = request('bad-input');
      const invalid = [
        { ...valid, id: '-invalid' },
        { ...valid, id: 'invalid\n' },
        { ...valid, id: 'x'.repeat(129) },
        { ...valid, name: '' },
        { ...valid, name: ' \t\n\u00a0\ufeff' },
        { ...valid, name: 'x'.repeat(201) },
        { ...valid, description: 'x'.repeat(8001) },
        { ...valid, description: null },
        { ...valid, tenant: 'b' },
        { ...valid, createdBy: `${prefix}-owner-b` },
        { ...valid, epoch: 9 },
        { ...valid, generation: 9 },
        { ...valid, active: true },
        { ...valid, execution_mode: 'AGENT' },
        { ...valid, grant: id('forged-grant') },
      ];
      const h = await head();
      for (const input of invalid)
        await assert.rejects(service.create(owner, input));
      await absent(valid.id);
      assert.deepEqual(await head(), h);
      const bounded = {
        ...request('max-bounds'),
        name: 'n'.repeat(200),
        description: 'd'.repeat(8000),
      };
      await service.create(owner, bounded);
      assert.equal((await profile(bounded.id)).description.length, 8000);
      await service.create(owner, {
        ...request('empty-description'),
        description: '',
      });
    });

    test('same id in two tenants is isolated; tenancy never comes from the body', async () => {
      const a = request('two-tenants');
      const b = {
        ...a,
        name: 'Tenant B VERA',
        description: 'Tenant B profile',
      };
      const ownerA = await f.actor('user', 'a');
      const ownerB = await f.actor('user', 'b');
      const createdA = await service.create(ownerA, a);
      const createdB = await service.create(ownerB, b);
      assert.equal(createdA.id, createdB.id);
      assert.equal(createdA.createdBy, `${prefix}-owner-a`);
      assert.equal(createdB.createdBy, `${prefix}-owner-b`);
      const aBefore = await profile(a.id, 'a');
      await service.updateProfile(ownerB, {
        ...b,
        name: 'B edited',
        expectedRevision: 1,
      });
      assert.deepEqual(await profile(a.id, 'a'), aBefore);
      assert.equal((await profile(a.id, 'b')).name, 'B edited');
      await assert.rejects(
        service.updateProfile(ownerA, {
          ...a,
          tenant: 'b',
          expectedRevision: 1,
        }),
      );
      const bOnly = request('b-only');
      await service.create(ownerB, bOnly);
      await assert.rejects(
        service.updateProfile(ownerA, { ...bOnly, expectedRevision: 1 }),
        /VERA profile version conflict/,
      );
      assert.equal(await profile(bOnly.id, 'a'), undefined);
    });

    test('tenant-role RLS resists tenant guessing and mutable GUCs; readers cannot write', async () => {
      const x = request('rls');
      for (const tenant of ['a', 'b'])
        await service.create(await f.actor('user', tenant), x);
      for (const [db, tenant] of [
        [tenantA, 'a'],
        [tenantB, 'b'],
      ] as const) {
        const rows = (
          await db.query('SELECT tenant,id FROM ct.vera_profiles WHERE id=$1', [
            x.id,
          ])
        ).rows;
        assert.deepEqual(rows, [{ tenant, id: x.id }]);
        await tx(db, async (client) => {
          await client.query("SET LOCAL ct.tenant='forged-other-tenant'");
          assert.deepEqual(
            (
              await client.query(
                'SELECT tenant,id FROM ct.vera_profiles WHERE id=$1',
                [x.id],
              )
            ).rows,
            [{ tenant, id: x.id }],
          );
          await sqlRejected(
            client,
            'UPDATE ct.vera_profiles SET name=$2,revision=revision+1 WHERE id=$1',
            [x.id, 'Forbidden'],
            '42501',
          );
        });
      }
      const read = (
        await consoleReader.query(
          'SELECT tenant,id FROM ct.vera_profiles WHERE id=$1 ORDER BY tenant',
          [x.id],
        )
      ).rows;
      assert.deepEqual(read, [
        { tenant: 'a', id: x.id },
        { tenant: 'b', id: x.id },
      ]);
    });

    test('FORCE RLS and narrow column privileges add no worker/reader write access', async () => {
      const table = (
        await admin.query(
          "SELECT c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='ct' AND c.relname='vera_profiles'",
        )
      ).rows[0];
      assert.deepEqual(table, {
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner: 'ct_owner',
      });
      const roles = [
        'ct_governor',
        'ct_authority_api',
        'ct_console_reader',
        'ct_tenant_a',
        'ct_tenant_b',
      ];
      const runtimeRoles = (
        await admin.query(
          'SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])',
          [roles],
        )
      ).rows;
      assert.equal(runtimeRoles.length, roles.length);
      assert.ok(
        runtimeRoles.every((row) => !row.rolsuper && !row.rolbypassrls),
      );
      for (const role of ['ct_authority_api', 'ct_governor']) {
        for (const column of ['name', 'description', 'revision'])
          assert.equal(
            (
              await admin.query(
                "SELECT has_column_privilege($1,'ct.vera_profiles',$2,'UPDATE') AS allowed",
                [role, column],
              )
            ).rows[0].allowed,
            true,
          );
        for (const column of ['tenant', 'id', 'created_by', 'creation_digest'])
          assert.equal(
            (
              await admin.query(
                "SELECT has_column_privilege($1,'ct.vera_profiles',$2,'UPDATE') AS allowed",
                [role, column],
              )
            ).rows[0].allowed,
            false,
          );
        assert.equal(
          (
            await admin.query(
              "SELECT has_table_privilege($1,'ct.vera_profiles','DELETE') AS allowed",
              [role],
            )
          ).rows[0].allowed,
          false,
        );
      }
      for (const role of [
        'ct_tenant_a',
        'ct_tenant_b',
        'ct_console_reader',
        'ct_product_api',
        'ct_controller',
        'ct_cap_issuer',
        'ct_computer_broker',
        'ct_context_service',
        'ct_resource_service',
        'ct_recovery',
      ]) {
        for (const privilege of ['INSERT', 'UPDATE'])
          assert.equal(
            (
              await admin.query(
                'SELECT has_any_column_privilege($1,$2,$3) AS allowed',
                [role, 'ct.vera_profiles', privilege],
              )
            ).rows[0].allowed,
            false,
          );
      }
      assert.equal(
        (
          await admin.query(
            "SELECT has_column_privilege('ct_authority_api','ct.principals','lock_tag','INSERT') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
      await tx(admin, async (client) => {
        await client.query('SET LOCAL ROLE ct_owner');
        assert.equal(
          (await client.query('SELECT count(*) AS n FROM ct.vera_profiles'))
            .rows[0].n,
          '0',
        );
      });
    });

    test('composite FKs deny cross-tenant creator/principal references', async () => {
      const x = request('foreign-key');
      await rollback(auth, async (client) => {
        await client.query(
          "INSERT INTO ct.principals(tenant,id,epoch,generation,active,execution_mode) VALUES('a',$1,1,1,true,'PAUSED'),('b',$2,1,1,true,'PAUSED')",
          [x.id, id('b-foreign-principal')],
        );
        for (const [key, creator] of [
          [x.id, `${prefix}-owner-b`],
          [id('b-foreign-principal'), `${prefix}-owner-a`],
        ])
          await sqlRejected(
            client,
            "INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES('a',$1,'FK test','',1,$2,$3)",
            [key, creator, 'f'.repeat(64)],
            '23503',
          );
      });
      await absent(x.id);
      await absent(id('b-foreign-principal'), 'b');
    });

    test('DB guard preserves creation digest/creator/id and exact revision increments', async () => {
      const x = request('db-guard');
      await service.create(await f.actor('user'), x);
      const v = await profile(x.id);
      await tx(admin, async (client) => {
        for (const [column, value] of [
          ['creation_digest', 'f'.repeat(64)],
          ['created_by', `${prefix}-owner-b`],
          ['id', id('forged-new-id')],
          ['tenant', 'b'],
        ])
          await sqlRejected(
            client,
            `UPDATE ct.vera_profiles SET ${column}=$2,revision=revision+1 WHERE tenant='a' AND id=$1`,
            [x.id, value],
            'P0001',
          );
        await sqlRejected(
          client,
          "UPDATE ct.vera_profiles SET revision=revision+2 WHERE tenant='a' AND id=$1",
          [x.id],
          'P0001',
        );
        await sqlRejected(
          client,
          "UPDATE ct.vera_profiles SET name='No revision' WHERE tenant='a' AND id=$1",
          [x.id],
          'P0001',
        );
      });
      assert.deepEqual(await profile(x.id), v);
      await rollback(auth, async (client) => {
        const key = id('initial-revision');
        await client.query(
          "INSERT INTO ct.principals(tenant,id,epoch,generation,active,execution_mode) VALUES('a',$1,1,1,true,'PAUSED')",
          [key],
        );
        await sqlRejected(
          client,
          "INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES('a',$1,'Revision test','',2,$2,$3)",
          [key, `${prefix}-owner-a`, 'f'.repeat(64)],
          'P0001',
        );
      });
      await absent(id('initial-revision'));
    });

    test('CAS edits change only profile text/revision and preserve principal/creator/digest', async () => {
      const x = request('cas');
      const owner = await f.actor('user');
      await service.create(owner, x);
      const p = await principal(x.id);
      const v = await profile(x.id);
      const beforeState = await unrelatedState();
      const result = await service.updateProfile(owner, {
        ...x,
        name: 'Edited',
        description: '',
        expectedRevision: 1,
      });
      assert.deepEqual(result, {
        id: x.id,
        name: 'Edited',
        description: '',
        revision: 2,
        createdBy: v.created_by,
        effectAuthority: false,
        workflowAdmitted: false,
        externalEffect: false,
      });
      assert.deepEqual(await principal(x.id), p);
      const updated = await profile(x.id);
      assert.equal(updated.created_by, v.created_by);
      assert.equal(updated.creation_digest, v.creation_digest);
      const h = await head();
      await assert.rejects(
        service.updateProfile(owner, { ...x, expectedRevision: 1 }),
        /VERA profile version conflict/,
      );
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN])
        await assert.rejects(
          service.updateProfile(owner, { ...x, expectedRevision: value }),
        );
      for (const column of [
        'newId',
        'tenant',
        'creator',
        'createdBy',
        'created_by',
        'epoch',
        'generation',
        'active',
        'executionMode',
        'execution_mode',
        'creation_digest',
        'revision',
        'authority',
      ])
        await assert.rejects(
          service.updateProfile(owner, {
            ...x,
            expectedRevision: 2,
            [column]: 'forged',
          }),
        );
      assert.deepEqual(await profile(x.id), updated);
      assert.deepEqual(await head(), h);
      assert.deepEqual(await unrelatedState(), beforeState);
    });

    test('concurrent exact-CAS updates have one winner and one version conflict', async () => {
      const x = request('concurrent-cas');
      const owner = await f.actor('user');
      await service.create(owner, x);
      const p = await principal(x.id);
      const results = await Promise.allSettled([
        service.updateProfile(owner, {
          ...x,
          name: 'First',
          expectedRevision: 1,
        }),
        service.updateProfile(owner, {
          ...x,
          name: 'Second',
          expectedRevision: 1,
        }),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.match(String(rejected.reason), /VERA profile version conflict/);
      assert.equal(Number((await profile(x.id)).revision), 2);
      assert.deepEqual(await principal(x.id), p);
      assert.equal(
        (await evidence(x.id)).filter(
          (event) => event.kind === 'VERA_PROFILE_UPDATED',
        ).length,
        1,
      );
    });

    test('failed profile audit and caller rollback preserve prior profile and evidence', async () => {
      const x = request('update-rollback');
      const owner = await f.actor('user');
      await service.create(owner, x);
      const p = await principal(x.id);
      const v = await profile(x.id);
      const h = await head();
      const update = { ...x, name: 'Uncommitted edit', expectedRevision: 1 };
      const broken = new VeraService(
        faultPool('INSERT INTO ct.evidence_events'),
        fence,
      );
      await assert.rejects(
        broken.updateProfile(owner, update),
        /owned VERA failure injection/,
      );
      await rollback(auth, async (client) => {
        await service.updateProfile(owner, update, client);
        assert.deepEqual(await profile(x.id), v);
      });
      assert.deepEqual(await principal(x.id), p);
      assert.deepEqual(await profile(x.id), v);
      assert.deepEqual(await head(), h);
    });
  },
);
