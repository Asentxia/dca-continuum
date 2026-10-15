// Local logical-fixture regression only. Register after VERA-PROFILE: the
// original baseline backup and first controller restore consumer must finish
// first. No database creation/drop, helper/service control or activation here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { canonical, pool, sha, tx } from '../src/db.js';
import { enrolled } from '../src/service-auth.js';
import { assertLocalFixtures } from '../src/runtime-profile.js';
import { VeraService } from '../src/regency/vera-service.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence, gov } from './helpers.js';
import { losslessRowFingerprint } from './lossless-row-fingerprint.js';

const source = 'ct_test';
const target = 'ct_restore';
const prefix = 'vera-profile-backup-' + randomBytes(8).toString('hex');
const sharedId = prefix + '-vera';
const bOnlyId = prefix + '-b-only';
const keys = [sharedId, bOnlyId];
const original = {
  a: {
    id: sharedId,
    name: 'Original VERA A',
    description: 'Original profile A',
  },
  b: {
    id: sharedId,
    name: 'Original VERA B',
    description: 'Original profile B',
  },
};
let root: string;
let expectedDataDirectory: string;
let evidenceDirectory: string;
let baselinePath: string;
let baselineDigest: string;
let baselineRelations: string[];
let dumpPath: string;
let ownedDump: { dev: number; ino: number } | undefined;
let f: Awaited<ReturnType<typeof fixture>> | undefined;
let sourceAuth: pg.Pool | undefined;
let restoredAdmin: pg.Pool | undefined;
let restoredAuth: pg.Pool | undefined;
let restoredA: pg.Pool | undefined;
let restoredB: pg.Pool | undefined;
let sourceSnapshot: Awaited<ReturnType<typeof snapshot>>;
const restoredPools: pg.Pool[] = [];

async function ordinaryFile(filename: string) {
  const stat = await fs.lstat(filename);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    'ordinary owned file required',
  );
  return stat;
}
async function digest(filename: string) {
  await ordinaryFile(filename);
  return createHash('sha256')
    .update(await fs.readFile(filename))
    .digest('hex');
}
async function ordinaryDirectory(dirname: string) {
  const stat = await fs.lstat(dirname);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'linked fixture directory denied',
  );
  assert.equal(await fs.realpath(dirname), dirname);
}
async function missing(filename: string) {
  await assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
}

async function command(program: string, args: string[], label: string) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: {
      ...process.env,
      PGHOST: '127.0.0.1',
      PGPORT: '55432',
      PGUSER: 'localtest',
      CT_DATABASE: source,
    },
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  await fs.writeFile(
    path.join(evidenceDirectory, label + '.log'),
    [
      result.stdout ?? '',
      result.stderr ?? '',
      result.error?.message ?? '',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `${label}: see owned evidence log`);
  return result.stdout;
}

async function physicalConnection(db: pg.Pool, database: string) {
  const row = (
    await db.query(
      "SELECT current_database() AS database,session_user AS actor,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('server_version_num')::int AS version,current_setting('data_directory') AS directory",
    )
  ).rows[0];
  assert.equal(row.database, database);
  assert.equal(row.actor, 'localtest');
  assert.equal(row.address, '127.0.0.1');
  assert.equal(row.port, 55432);
  assert.equal(Math.floor(row.version / 10000), 17);
  assert.equal(
    row.directory,
    expectedDataDirectory,
    'refuse a foreign PostgreSQL cluster',
  );
  assert.equal(await fs.realpath(row.directory), expectedDataDirectory);
}

async function noOtherTargetClients(ownPid: number | null = null) {
  const clients = (
    await admin.query(
      'SELECT pid FROM pg_stat_activity WHERE datname=$1 AND ($2::int IS NULL OR pid<>$2)',
      [target, ownPid],
    )
  ).rows;
  assert.deepEqual(
    clients,
    [],
    'active restore target refused; never terminate another client',
  );
}

// Pool.end() closes the socket, but PostgreSQL may briefly still report the
// exact owned backend. Wait only for that PID; any other client still refuses.
async function waitOwnedTargetClientExit(ownedPid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const clients = (
      await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [
        target,
      ])
    ).rows;
    assert.ok(
      clients.every((row) => Number(row.pid) === ownedPid),
      'active restore target refused; never terminate another client',
    );
    if (clients.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('owned restore probe did not disconnect within the bounded wait');
}

async function knownIdleTarget() {
  await physicalConnection(admin, source);
  const database = (
    await admin.query(
      'SELECT d.datname,r.rolname AS owner,d.datistemplate,d.datallowconn FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1',
      [target],
    )
  ).rows[0];
  assert.deepEqual(
    database,
    {
      datname: target,
      owner: 'localtest',
      datistemplate: false,
      datallowconn: true,
    },
    'existing owned baseline ct_restore is required; do not create/reset an unknown target',
  );
  await noOtherTargetClients();
  const probe = pool('localtest', target);
  let ownedPid: number | undefined;
  try {
    await physicalConnection(probe, target);
    const pid = Number(
      (await probe.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    );
    ownedPid = pid;
    await noOtherTargetClients(pid);
    const schemas = (
      await probe.query(
        "SELECT n.nspname,r.rolname AS owner FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname NOT IN('pg_catalog','information_schema','public') AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname",
      )
    ).rows;
    assert.deepEqual(schemas, [{ nspname: 'ct', owner: 'ct_owner' }]);
    assert.deepEqual(
      (
        await probe.query(
          "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','S','f')",
        )
      ).rows,
      [],
      'foreign public objects make the target unknown',
    );
    const relations = (
      await probe.query(
        "SELECT c.relname,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='ct' AND c.relkind IN('r','p','v','m','S','f') ORDER BY c.relname",
      )
    ).rows;
    assert.deepEqual(
      relations.map((row) => row.relname),
      baselineRelations,
      'restore target must retain the known baseline archive topology',
    );
    assert.ok(relations.every((row) => row.owner === 'ct_owner'));
    assert.equal(
      Number(
        (await probe.query('SELECT count(*) AS n FROM ct.control')).rows[0].n,
      ),
      0,
      'an activated target is not a disposable baseline restore',
    );
  } finally {
    await probe.end();
  }
  if (ownedPid !== undefined) await waitOwnedTargetClientExit(ownedPid);
  await noOtherTargetClients();
}

async function metadata(db: pg.Pool) {
  return {
    table: (
      await db.query(
        "SELECT c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='ct' AND c.relname='vera_profiles'",
      )
    ).rows,
    columns: (
      await db.query(
        "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='ct' AND table_name='vera_profiles' ORDER BY ordinal_position",
      )
    ).rows,
    constraints: (
      await db.query(
        "SELECT conname,contype,convalidated,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid='ct.vera_profiles'::regclass ORDER BY conname",
      )
    ).rows,
    policies: (
      await db.query(
        "SELECT policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='ct' AND tablename='vera_profiles' ORDER BY policyname",
      )
    ).rows,
    tableAcl: (
      await db.query(
        "SELECT COALESCE(g.rolname,'PUBLIC') AS grantee,r.rolname AS grantor,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles g ON g.oid=x.grantee JOIN pg_roles r ON r.oid=x.grantor WHERE n.nspname='ct' AND c.relname='vera_profiles' ORDER BY grantee,grantor,x.privilege_type",
      )
    ).rows,
    columnAcl: (
      await db.query(
        "SELECT a.attname,COALESCE(g.rolname,'PUBLIC') AS grantee,r.rolname AS grantor,x.privilege_type,x.is_grantable FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x LEFT JOIN pg_roles g ON g.oid=x.grantee JOIN pg_roles r ON r.oid=x.grantor WHERE a.attrelid='ct.vera_profiles'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname,grantee,grantor,x.privilege_type",
      )
    ).rows,
    trigger: (
      await db.query(
        "SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='ct.vera_profiles'::regclass AND NOT tgisinternal ORDER BY tgname",
      )
    ).rows,
    guard: (
      await db.query(
        "SELECT p.prosrc,p.prosecdef,r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='ct.guard_vera_profile()'::regprocedure",
      )
    ).rows,
  };
}

async function consequentialState(db: pg.Pool) {
  const counts: Record<string, { count: number; sha256: string }> = {};
  for (const table of [
    'grants',
    'approvals',
    'operations',
    'computers',
    'tasks',
    'cognition_bindings',
    'resource_reservations',
    'outbox',
  ]) {
    const rows = (
      await db.query(
        `SELECT to_jsonb(x)::text AS row FROM ct.${table} x ORDER BY to_jsonb(x)::text`,
      )
    ).rows;
    counts[table] = losslessRowFingerprint(rows);
  }
  return counts;
}
async function snapshot(db: pg.Pool) {
  return {
    profiles: (
      await db.query(
        'SELECT tenant,id,name,description,revision,created_by,creation_digest FROM ct.vera_profiles WHERE id=ANY($1::text[]) ORDER BY tenant,id',
        [keys],
      )
    ).rows,
    principals: (
      await db.query(
        'SELECT tenant,id,epoch,generation,active,execution_mode FROM ct.principals WHERE id=ANY($1::text[]) ORDER BY tenant,id',
        [keys],
      )
    ).rows,
    creators: (
      await db.query(
        'SELECT id,tenant,issuer,subject,audience,kind,domain_role,active,version FROM ct.identities WHERE id=ANY($1::text[]) ORDER BY tenant,id',
        [[`${prefix}-owner-a`, `${prefix}-owner-b`]],
      )
    ).rows,
    audit: (
      await db.query(
        "SELECT tenant,seq,kind,payload,prev_hash,hash FROM ct.evidence_events WHERE kind IN('VERA_CREATED','VERA_PROFILE_UPDATED') AND payload::jsonb->>'id'=ANY($1::text[]) ORDER BY tenant,seq",
        [keys],
      )
    ).rows,
    heads: (
      await db.query(
        "SELECT tenant,seq,hash FROM ct.evidence_heads WHERE tenant IN('a','b') ORDER BY tenant",
      )
    ).rows,
    metadata: await metadata(db),
    consequential: await consequentialState(db),
  };
}

async function sqlRejected(
  client: pg.PoolClient,
  sql: string,
  values: any[],
  code: string,
) {
  await client.query('SAVEPOINT vera_backup_negative');
  try {
    await assert.rejects(client.query(sql, values), { code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT vera_backup_negative');
    await client.query('RELEASE SAVEPOINT vera_backup_negative');
  }
}
function restoredPool(role: string) {
  const db = pool(role, target);
  restoredPools.push(db);
  return db;
}

describe(
  'populated VERA profile logical backup — local fixture only',
  { concurrency: 1 },
  () => {
    before(async () => {
      assertLocalFixtures('VERA profile logical backup');
      assert.ok(!process.env.CT_DATABASE || process.env.CT_DATABASE === source);
      assert.equal(
        process.env.CT_RESET_LOCAL_FIXTURE,
        'yes',
        'explicit owned-disposable fixture authorization required',
      );
      for (const key of [
        'PGSERVICE',
        'PGSERVICEFILE',
        'PGHOSTADDR',
        'PGOPTIONS',
      ])
        assert.ok(!process.env[key], 'libpq connection override refused');
      root = await fs.realpath(process.cwd());
      await ordinaryDirectory(path.join(root, '.local'));
      expectedDataDirectory = path.join(root, '.local', 'pgdata');
      await ordinaryDirectory(expectedDataDirectory);
      baselinePath = path.join(root, '.local', 'domain-backup.dump');
      baselineDigest = await digest(baselinePath);
      dumpPath = path.join(root, '.local', prefix + '.dump');
      await missing(dumpPath);
      const artifactRoot = path.join(root, '.artifacts');
      await fs.mkdir(artifactRoot, { recursive: true });
      await ordinaryDirectory(artifactRoot);
      const directory = path.join(artifactRoot, 'vera-profile-backup');
      await fs.mkdir(directory, { recursive: true });
      await ordinaryDirectory(directory);
      evidenceDirectory = path.join(directory, prefix);
      await fs.mkdir(evidenceDirectory);
      await physicalConnection(admin, source);
      for (const program of ['pg_dump', 'pg_restore'])
        assert.match(
          await command(program, ['--version'], program + '-version'),
          /\(PostgreSQL\) 17\./,
        );
      const baselineToc = await command(
        'pg_restore',
        ['--list', baselinePath],
        'baseline-toc',
      );
      baselineRelations = [
        ...baselineToc.matchAll(
          /^\d+;\s+\d+\s+\d+\s+(?:TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|FOREIGN TABLE)\s+ct\s+([A-Za-z_][A-Za-z0-9_]*)\s+ct_owner\s*$/gm,
        ),
      ]
        .map((match) => match[1])
        .sort();
      assert.ok(
        baselineRelations.includes('control') &&
          baselineRelations.includes('principals'),
      );
      await knownIdleTarget();
      assert.ok(
        (
          await admin.query(
            "SELECT to_regclass('ct.vera_profiles') AS profiles",
          )
        ).rows[0].profiles,
        'source requires reviewed migration 021 before this regression',
      );
      f = await fixture(prefix);
      sourceAuth = pool('ct_authority_api', source);
      const service = new VeraService(sourceAuth, fence);
      const beforeEffects = await consequentialState(admin);
      for (const tenant of ['a', 'b'] as const)
        await service.create(await f.actor('user', tenant), original[tenant]);
      await service.create(await f.actor('user', 'b'), {
        id: bOnlyId,
        name: 'Tenant B only',
        description: 'Cross-tenant FK witness',
      });
      await service.updateProfile(await f.actor('user'), {
        ...original.a,
        name: 'Renamed VERA α A',
        description: 'Durable edited profile\nLocal fixture only',
        expectedRevision: 1,
      });
      assert.deepEqual(await consequentialState(admin), beforeEffects);
      assert.equal(f.provider.sends, 0);
      sourceSnapshot = await snapshot(admin);
      assert.equal(sourceSnapshot.profiles.length, 3);
      const a = sourceSnapshot.profiles.find((row) => row.tenant === 'a');
      assert.equal(Number(a.revision), 2);
      assert.equal(a.created_by, `${prefix}-owner-a`);
      assert.equal(
        a.creation_digest,
        sha(canonical({ tenant: 'a', ...original.a })),
      );
      for (const row of sourceSnapshot.principals) {
        assert.equal(row.epoch, 1);
        assert.equal(row.generation, 1);
        assert.equal(row.active, true);
        assert.equal(row.execution_mode, 'PAUSED');
      }
      await fs.writeFile(
        path.join(evidenceDirectory, 'source-snapshot.json'),
        JSON.stringify(
          { scope: 'LOCAL_LOGICAL_FIXTURE_ONLY', snapshot: sourceSnapshot },
          null,
          2,
        ) + '\n',
      );
    });

    after(async () => {
      // Close only this file's clients. Do not stop services, kill foreign clients,
      // delete source records/evidence, reset ct_restore or remove the baseline.
      const cleanups: Promise<unknown>[] = restoredPools.map((db) => db.end());
      if (sourceAuth) cleanups.push(sourceAuth.end());
      if (f) cleanups.push(f.close());
      cleanups.push(admin.end(), gov.end());
      const closed = await Promise.allSettled(cleanups);
      if (ownedDump) {
        const stat = await ordinaryFile(dumpPath);
        assert.equal(stat.dev, ownedDump.dev);
        assert.equal(
          stat.ino,
          ownedDump.ino,
          'refuse cleanup of a replaced artifact',
        );
        await fs.unlink(dumpPath);
      }
      if (baselineDigest)
        assert.equal(await digest(baselinePath), baselineDigest);
      assert.ok(
        closed.every((result) => result.status === 'fulfilled'),
        'all owned pools must finish closing',
      );
    });

    test('guarded current dump round-trips populated profiles, identities, audits and schema', async () => {
      // A deliberately owned blocker exercises refusal, not forced cleanup.
      // It is closed before any backup/restore command is allowed to proceed.
      const blocker = pool('localtest', target);
      let blockerPid: number | undefined;
      try {
        blockerPid = Number(
          (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        );
        await assert.rejects(
          knownIdleTarget(),
          /active restore target refused/,
        );
      } finally {
        await blocker.end();
      }
      if (blockerPid !== undefined) await waitOwnedTargetClientExit(blockerPid);
      await physicalConnection(admin, source);
      await missing(dumpPath);
      await command(
        'bash',
        ['tools/backup-domain.sh', path.relative(root, dumpPath)],
        'populated-backup',
      );
      const stat = await ordinaryFile(dumpPath);
      ownedDump = { dev: stat.dev, ino: stat.ino };
      assert.equal(stat.mode & 0o777, 0o600);
      assert.ok(stat.size > 0);
      const toc = await command(
        'pg_restore',
        ['--list', dumpPath],
        'populated-toc',
      );
      assert.match(toc, /\bTABLE DATA ct vera_profiles\b/);
      assert.equal(await digest(baselinePath), baselineDigest);
      await knownIdleTarget();
      // No --create, --force, database drop or external activation. A failed
      // restore rolls back its schema/data/ACL changes in this fixed target.
      await command(
        'pg_restore',
        [
          '--clean',
          '--if-exists',
          '--single-transaction',
          '--exit-on-error',
          '--dbname',
          target,
          dumpPath,
        ],
        'populated-restore',
      );
      restoredAdmin = restoredPool('localtest');
      await physicalConnection(restoredAdmin, target);
      assert.equal(
        Number(
          (await restoredAdmin.query('SELECT count(*) AS n FROM ct.control'))
            .rows[0].n,
        ),
        0,
      );
      assert.deepEqual(await snapshot(restoredAdmin), sourceSnapshot);
      assert.deepEqual(sourceSnapshot.metadata.table, [
        {
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: 'ct_owner',
        },
      ]);
      assert.equal(sourceSnapshot.metadata.guard[0].prosecdef, false);
      await fs.writeFile(
        path.join(evidenceDirectory, 'round-trip.json'),
        JSON.stringify(
          {
            scope: 'LOCAL_LOGICAL_FIXTURE_ONLY',
            database: target,
            dumpDigest: await digest(dumpPath),
            baselineDigest,
            controlRows: 0,
            profileRows: sourceSnapshot.profiles.length,
            nativeHaPitr: 'NOT RUN for new profiles',
            externalTruth: 'NOT CLAIMED',
          },
          null,
          2,
        ) + '\n',
      );
    });

    test('restored composite FKs, FORCE RLS, narrow ACLs and immutable profile binding hold', async () => {
      assert.ok(
        restoredAdmin && f,
        'successful guarded round-trip is required',
      );
      restoredAuth = restoredPool('ct_authority_api');
      restoredA = restoredPool('ct_tenant_a');
      restoredB = restoredPool('ct_tenant_b');
      for (const [db, tenant] of [
        [restoredA, 'a'],
        [restoredB, 'b'],
      ] as const) {
        assert.deepEqual(
          (
            await db.query(
              'SELECT tenant,id FROM ct.vera_profiles WHERE id=$1',
              [sharedId],
            )
          ).rows,
          [{ tenant, id: sharedId }],
        );
        await tx(db, async (client) => {
          await client.query("SET LOCAL ct.tenant='forged-other-tenant'");
          assert.deepEqual(
            (
              await client.query(
                'SELECT tenant,id FROM ct.vera_profiles WHERE id=$1',
                [sharedId],
              )
            ).rows,
            [{ tenant, id: sharedId }],
          );
          await sqlRejected(
            client,
            'UPDATE ct.vera_profiles SET name=$2,revision=revision+1 WHERE id=$1',
            [sharedId, 'Forbidden tenant edit'],
            '42501',
          );
        });
      }
      for (const column of ['name', 'description', 'revision'])
        assert.equal(
          (
            await restoredAdmin.query(
              "SELECT has_column_privilege('ct_authority_api','ct.vera_profiles',$1,'UPDATE') AS allowed",
              [column],
            )
          ).rows[0].allowed,
          true,
        );
      for (const column of ['tenant', 'id', 'created_by', 'creation_digest'])
        assert.equal(
          (
            await restoredAdmin.query(
              "SELECT has_column_privilege('ct_authority_api','ct.vera_profiles',$1,'UPDATE') AS allowed",
              [column],
            )
          ).rows[0].allowed,
          false,
        );
      const runtimeRoles = [
        'ct_governor',
        'ct_authority_api',
        'ct_tenant_a',
        'ct_tenant_b',
        'ct_console_reader',
        'ct_product_api',
        'ct_controller',
        'ct_cap_issuer',
        'ct_computer_broker',
      ];
      const roles = (
        await restoredAdmin.query(
          'SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])',
          [runtimeRoles],
        )
      ).rows;
      assert.equal(roles.length, runtimeRoles.length);
      assert.ok(
        roles.every(
          (role) =>
            role.rolname !== 'ct_owner' && !role.rolsuper && !role.rolbypassrls,
        ),
      );
      for (const role of [
        'ct_tenant_a',
        'ct_tenant_b',
        'ct_console_reader',
        'ct_product_api',
        'ct_controller',
        'ct_cap_issuer',
        'ct_computer_broker',
      ])
        for (const privilege of ['INSERT', 'UPDATE'])
          assert.equal(
            (
              await restoredAdmin.query(
                'SELECT has_any_column_privilege($1,$2,$3) AS allowed',
                [role, 'ct.vera_profiles', privilege],
              )
            ).rows[0].allowed,
            false,
          );
      await tx(restoredAdmin, async (client) => {
        // Prove restored CHECK behavior as well as comparing each full
        // definition. Deparser formatting is not a constraint oracle.
        for (const invalid of [
          { name: '' },
          { name: ' \u2028 ' },
          { name: 'n'.repeat(201) },
          { description: 'd'.repeat(8001) },
          { creation_digest: 'f'.repeat(63) },
          { id: 'invalid profile id' },
          { id: 'v'.repeat(129) },
        ]) {
          const row = {
            id: sharedId,
            name: 'CHECK witness',
            description: '',
            creation_digest: 'f'.repeat(64),
            ...invalid,
          };
          await sqlRejected(
            client,
            "INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES('a',$1,$2,$3,1,$4,$5)",
            [
              row.id,
              row.name,
              row.description,
              `${prefix}-owner-a`,
              row.creation_digest,
            ],
            '23514',
          );
        }
        for (const [column, value] of [
          ['creation_digest', 'f'.repeat(64)],
          ['created_by', `${prefix}-owner-b`],
          ['tenant', 'b'],
          ['id', prefix + '-changed-id'],
        ])
          await sqlRejected(
            client,
            `UPDATE ct.vera_profiles SET ${column}=$2,revision=revision+1 WHERE tenant='a' AND id=$1`,
            [sharedId, value],
            'P0001',
          );
        await sqlRejected(
          client,
          "UPDATE ct.vera_profiles SET revision=revision+2 WHERE tenant='a' AND id=$1",
          [sharedId],
          'P0001',
        );
        for (const [key, creator] of [
          [f!.principal, `${prefix}-owner-b`],
          [bOnlyId, `${prefix}-owner-a`],
        ])
          await sqlRejected(
            client,
            "INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES('a',$1,'Negative FK witness','',1,$2,$3)",
            [key, creator, 'f'.repeat(64)],
            '23503',
          );
      });
      await tx(restoredAdmin, async (client) => {
        await client.query('SET LOCAL ROLE ct_owner');
        assert.equal(
          Number(
            (await client.query('SELECT count(*) AS n FROM ct.vera_profiles'))
              .rows[0].n,
          ),
          0,
        );
      });
      assert.deepEqual(await snapshot(restoredAdmin), sourceSnapshot);
    });

    test('restored fresh-owner create/replay/update and historical adoption remain recovery-fenced', async () => {
      assert.ok(
        restoredAdmin && restoredAuth && f,
        'restored permission checks are required',
      );
      const owner = await f.actor('user');
      await tx(restoredAuth, async (client) => {
        const identity = await enrolled(client, owner, true);
        assert.equal(identity.tenant, 'a');
        assert.equal(identity.id, `${prefix}-owner-a`);
      });
      const service = new VeraService(restoredAuth, fence);
      const newId = prefix + '-must-not-create';
      const historical = (
        await restoredAdmin.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2',
          ['a', f.principal],
        )
      ).rows[0];
      const beforeHead = (
        await restoredAdmin.query(
          'SELECT tenant,seq,hash FROM ct.evidence_heads ORDER BY tenant',
        )
      ).rows;
      await assert.rejects(
        service.create(owner, {
          id: newId,
          name: 'No activation',
          description: '',
        }),
        /recovery fence/,
      );
      await assert.rejects(service.create(owner, original.a), /recovery fence/);
      await assert.rejects(
        service.updateProfile(owner, {
          ...original.a,
          name: 'Must remain unchanged',
          expectedRevision: 2,
        }),
        /recovery fence/,
      );
      await assert.rejects(
        service.create(owner, {
          id: f.principal,
          name: 'Must not adopt historical principal',
          description: '',
        }),
        /recovery fence/,
      );
      assert.equal(
        Number(
          (await restoredAdmin.query('SELECT count(*) AS n FROM ct.control'))
            .rows[0].n,
        ),
        0,
      );
      assert.deepEqual(
        (
          await restoredAdmin.query(
            'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2',
            ['a', f.principal],
          )
        ).rows[0],
        historical,
      );
      assert.deepEqual(
        (
          await restoredAdmin.query(
            'SELECT tenant,seq,hash FROM ct.evidence_heads ORDER BY tenant',
          )
        ).rows,
        beforeHead,
      );
      assert.deepEqual(
        (
          await restoredAdmin.query(
            'SELECT id FROM ct.principals WHERE id=$1',
            [newId],
          )
        ).rows,
        [],
      );
      assert.deepEqual(
        (
          await restoredAdmin.query(
            'SELECT id FROM ct.vera_profiles WHERE id=ANY($1::text[])',
            [[newId, f.principal]],
          )
        ).rows,
        [],
      );
      assert.deepEqual(await snapshot(restoredAdmin), sourceSnapshot);
      assert.equal(f.provider.sends, 0);
      assert.equal(await digest(baselinePath), baselineDigest);
    });
  },
);
