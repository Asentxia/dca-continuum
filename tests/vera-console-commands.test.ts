// Parent-owned PG17 fixture only. No cluster reset, real identity configuration,
// provider action, model connection or Computer allocation occurs in this suite.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { canonical, pool, sha } from '../src/db.js';
import { fixture } from './implementation-helpers.js';
import { admin, gov, fence } from './helpers.js';
import { ConsoleCommands } from '../src/console/commands.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import { featureCatalogue, freshHumanMfa } from '../src/console/features.js';
import { losslessRowFingerprint } from './lossless-row-fingerprint.js';
import {
  CommandSchema,
  CommandInputs,
  CommandReceiptSchema,
  EnvelopeSchema,
  type HumanCommand,
} from '../src/console/contracts.js';

const prefix = 'vera-console-' + randomBytes(6).toString('hex');
const id = (suffix: string) => prefix + '-' + suffix;
let f: Awaited<ReturnType<typeof fixture>>;
let writeDb: pg.Pool;
let readDb: pg.Pool;
let commands: ConsoleCommands;
let reads: ConsoleReads;
before(async () => {
  f = await fixture(prefix);
  writeDb = pool('ct_authority_api');
  readDb = pool('ct_console_reader');
  commands = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    fence,
    'LOCAL_FIXTURE',
  );
  reads = new ConsoleReads(
    readDb,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    'vera-console-scoped-test',
    fence,
  );
});
after(async () => {
  if (f) await f.close();
  for (const db of [writeDb, readDb, admin, gov]) if (db) await db.end();
});
function command(
  kind: HumanCommand['kind'],
  target: string,
  input: Record<string, unknown>,
  version = 0,
  key = id(kind + '-' + randomBytes(4).toString('hex')),
): HumanCommand {
  return {
    schema_version: 1,
    idempotency_key: key,
    kind,
    target,
    expected_version: version,
    input,
  };
}
function create(suffix: string) {
  return command('create_vera', id(suffix), {
    name: 'VERA ' + suffix,
    description: 'Recorded profile, not execution or authority.',
  });
}
async function principal(target: string, tenant = 'a') {
  return (
    await admin.query('SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2', [
      tenant,
      target,
    ])
  ).rows[0];
}
async function profile(target: string, tenant = 'a') {
  return (
    await admin.query(
      'SELECT * FROM ct.vera_profiles WHERE tenant=$1 AND id=$2',
      [tenant, target],
    )
  ).rows[0];
}
async function unrelated() {
  // Hash exact rows, not only counts. Failure output contains digests rather
  // than potentially sensitive fixture bindings.
  const tables = [
    'identities',
    'computers',
    'computer_observations',
    'memberships',
    'mandates',
    'tasks',
    'task_operations',
    'operations',
    'grants',
    'approvals',
    'approval_history',
    'assignments',
    'cognition_bindings',
    'resource_limits',
    'resource_reservations',
  ] as const;
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = (
      await admin.query(
        `SELECT to_jsonb(x)::text AS row FROM ct.${table} x ORDER BY to_jsonb(x)::text`,
      )
    ).rows;
    result[table] = losslessRowFingerprint(rows).sha256;
  }
  return result;
}
function applied(receipt: Awaited<ReturnType<ConsoleCommands['execute']>>) {
  CommandReceiptSchema.parse(receipt);
  assert.equal(receipt.status, 'APPLIED');
  assert.equal(receipt.external_effect, false);
  const result = receipt.result as Record<string, any>;
  assert.equal(result.externalEffect, false);
  assert.equal(result.effectAuthority, false);
  assert.equal(result.workflowAdmitted, false);
  return result;
}

test('row fingerprints preserve distinct PostgreSQL numbers beyond JavaScript precision', async () => {
  const witnesses = (
    await admin.query(
      "SELECT jsonb_build_object('counter',value) AS decoded,jsonb_build_object('counter',value)::text AS raw FROM (VALUES(9007199254740992::numeric),(9007199254740993::numeric)) AS input(value) ORDER BY value",
    )
  ).rows;
  assert.equal(witnesses.length, 2);
  assert.deepEqual(witnesses[0].decoded, witnesses[1].decoded);
  assert.throws(
    () =>
      losslessRowFingerprint(witnesses.map((row) => ({ row: row.decoded }))),
    /lossless PostgreSQL text/,
  );
  assert.notEqual(
    losslessRowFingerprint([{ row: witnesses[0].raw }]).sha256,
    losslessRowFingerprint([{ row: witnesses[1].raw }]).sha256,
  );
  assert.equal(f.provider.sends, 0);
});

test('VERA command atomically records a PAUSED profile and truthful tenant-scoped read', async () => {
  const owner = await f.actor('user');
  const request = create('initial');
  const beforeRows = await unrelated();
  const result = applied(await commands.execute(owner, request));
  assert.equal(result.version, 1);
  assert.equal(result.profileRevision, 1);
  assert.deepEqual(result.creation, {
    profileRevision: 1,
    epoch: 1,
    generation: 1,
    active: true,
    executionMode: 'PAUSED',
    availability: 'requires_setup',
  });
  const p = await principal(request.target);
  const v = await profile(request.target);
  assert.equal(Number(p.epoch), 1);
  assert.equal(Number(p.generation), 1);
  assert.equal(p.active, true);
  assert.equal(p.execution_mode, 'PAUSED');
  assert.equal(v.created_by, prefix + '-owner-a');
  const view = await reads.read(owner, 'agents', { id: request.target });
  EnvelopeSchema.parse(view);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].title, request.input.name);
  assert.equal(view.items[0].status, 'Paused VERA');
  assert.equal(view.items[0].fields.profileRevision, 1);
  assert.equal(view.items[0].fields.executionMode, 'PAUSED');
  assert.deepEqual(await unrelated(), beforeRows);
  assert.equal(f.provider.sends, 0);
});

test('display-name search and renamed-profile search stay within the enrolled tenant', async () => {
  const target = id('search-stable-id');
  const ownerA = await f.actor('user', 'a');
  const ownerB = await f.actor('user', 'b');
  const firstName = 'Orchid ' + prefix;
  const renamedName = 'Juniper ' + prefix;
  const otherName = 'Cypress ' + prefix;
  applied(
    await commands.execute(
      ownerA,
      command('create_vera', target, { name: firstName, description: '' }),
    ),
  );
  applied(
    await commands.execute(
      ownerB,
      command('create_vera', target, { name: otherName, description: '' }),
    ),
  );
  const first = await reads.read(ownerA, 'agents', { q: firstName });
  EnvelopeSchema.parse(first);
  assert.deepEqual(
    first.items.map((item) => item.id),
    [target],
  );
  assert.equal(first.items[0].title, firstName);
  assert.equal(first.total, 1);
  assert.equal((await reads.read(ownerB, 'agents', { q: firstName })).total, 0);
  applied(
    await commands.execute(
      ownerA,
      command(
        'update_vera_profile',
        target,
        { name: renamedName, description: 'Renamed, not a new principal.' },
        1,
      ),
    ),
  );
  assert.equal((await reads.read(ownerA, 'agents', { q: firstName })).total, 0);
  const renamed = await reads.read(ownerA, 'agents', { q: renamedName });
  assert.deepEqual(
    renamed.items.map((item) => item.id),
    [target],
  );
  assert.equal(renamed.items[0].title, renamedName);
  assert.equal(renamed.total, 1);
  assert.equal(
    (await reads.read(ownerB, 'agents', { q: renamedName })).total,
    0,
  );
  const other = await reads.read(ownerB, 'agents', { q: otherName });
  assert.deepEqual(
    other.items.map((item) => item.id),
    [target],
  );
  assert.equal(other.items[0].title, otherName);
  assert.equal((await reads.read(ownerA, 'agents', { q: otherName })).total, 0);
  assert.equal(f.provider.sends, 0);
});

test('lost-reply and creation replay preserve original facts after profile and lifecycle changes', async () => {
  const owner = await f.actor('user');
  const original = create('replay');
  const first = await commands.execute(owner, original);
  const firstResult = applied(first);
  const renamed = applied(
    await commands.execute(
      owner,
      command(
        'update_vera_profile',
        original.target,
        { name: 'Renamed profile', description: 'Edited metadata only.' },
        1,
      ),
    ),
  );
  assert.equal(renamed.profileRevision, 2);
  await gov.query(
    "UPDATE ct.principals SET epoch=epoch+1,generation=generation+1,active=false WHERE tenant='a' AND id=$1",
    [original.target],
  );
  const changed = await principal(original.target);
  const replay = applied(
    await commands.execute(owner, {
      ...original,
      idempotency_key: id('new-key-original-creation'),
    }),
  );
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.creation, firstResult.creation);
  assert.deepEqual(await principal(original.target), changed);
  const historical = await commands.lookup(owner, original.idempotency_key);
  assert.equal(historical.command_id, first.command_id);
  assert.deepEqual(historical.result, first.result);
  const view = await reads.read(owner, 'agents', { id: original.target });
  assert.equal(view.items[0].status, 'Inactive VERA');
  assert.equal(view.items[0].title, 'Renamed profile');
  assert.equal(view.items[0].fields.profileRevision, 2);
  assert.equal(view.items[0].fields.principalEpoch, 2);
  assert.equal(f.provider.sends, 0);
});

test('profile command CAS has one winner and cannot change principal or authority rows', async () => {
  const owner = await f.actor('user');
  const original = create('cas');
  applied(await commands.execute(owner, original));
  const initialPrincipal = await principal(original.target);
  const initialProfile = await profile(original.target);
  const beforeRows = await unrelated();
  const replies = await Promise.all(
    ['Left', 'Right'].map((name) =>
      commands.execute(
        owner,
        command(
          'update_vera_profile',
          original.target,
          { name, description: 'CAS edit' },
          1,
        ),
      ),
    ),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), ['APPLIED', 'DENIED']);
  const current = await profile(original.target);
  assert.equal(Number(current.revision), 2);
  assert.equal(current.created_by, initialProfile.created_by);
  assert.equal(current.creation_digest, initialProfile.creation_digest);
  assert.deepEqual(await principal(original.target), initialPrincipal);
  assert.deepEqual(await unrelated(), beforeRows);
  const view = await reads.read(owner, 'agents', { id: original.target });
  assert.equal(view.items[0].version, Number(initialPrincipal.epoch));
  assert.equal(view.items[0].fields.profileRevision, 2);
  assert.equal(f.provider.sends, 0);
});

test('outer receipt failure rolls back VERA principal/profile/audit together', async () => {
  const actor = await f.actor('user');
  const request = create('receipt-failure');
  const beforeHead = (
    await admin.query("SELECT * FROM ct.evidence_heads WHERE tenant='a'")
  ).rows[0];
  const faultPool = {
    connect: async () => {
      const client = await writeDb.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query')
            return (text: string, values?: any[]) => {
              if (text.startsWith('UPDATE ct.console_commands'))
                throw Error('owned receipt failure');
              return target.query(text, values);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
  const failing = new ConsoleCommands(
    faultPool,
    f.authority,
    f.product,
    fence,
    'LOCAL_FIXTURE',
  );
  await assert.rejects(
    failing.execute(actor, request),
    /owned receipt failure/,
  );
  assert.equal(await principal(request.target), undefined);
  assert.equal(await profile(request.target), undefined);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) AS n FROM ct.console_commands WHERE idempotency_key=$1',
        [request.idempotency_key],
      )
    ).rows[0].n,
    '0',
  );
  assert.deepEqual(
    (await admin.query("SELECT * FROM ct.evidence_heads WHERE tenant='a'"))
      .rows[0],
    beforeHead,
  );
});

test('same stable identifier and guessed profile reads remain tenant isolated', async () => {
  const target = id('same-id');
  for (const tenant of ['a', 'b'])
    applied(
      await commands.execute(
        await f.actor('user', tenant),
        command('create_vera', target, {
          name: 'Tenant ' + tenant,
          description: 'Only ' + tenant,
        }),
      ),
    );
  for (const tenant of ['a', 'b']) {
    const view = await reads.read(await f.actor('user', tenant), 'agents', {
      id: target,
    });
    assert.equal(view.items[0].title, 'Tenant ' + tenant);
    assert.equal(view.items[0].fields.description, 'Only ' + tenant);
    assert.equal(
      view.items[0].fields.profileCreatedBy,
      prefix + '-owner-' + tenant,
    );
  }
  const bOnly = create('b-only');
  applied(await commands.execute(await f.actor('user', 'b'), bOnly));
  const before = await profile(bOnly.target, 'b');
  assert.deepEqual(
    (await reads.read(await f.actor('user'), 'agents', { id: bOnly.target }))
      .items,
    [],
  );
  const denied = await commands.execute(
    await f.actor('user'),
    command(
      'update_vera_profile',
      bOnly.target,
      { name: 'Guess', description: '' },
      1,
    ),
  );
  assert.equal(denied.status, 'DENIED');
  assert.deepEqual(await profile(bOnly.target, 'b'), before);
});

test('strict profile commands reject authority overrides, machines, stale MFA and wrong/live profiles', async () => {
  const owner = await f.actor('user');
  const request = create('refused');
  for (const field of [
    'tenant',
    'principal',
    'epoch',
    'generation',
    'active',
    'executionMode',
    'createdBy',
    'role',
    'grants',
  ])
    assert.equal(
      CommandInputs.create_vera.safeParse({
        ...request.input,
        [field]: 'forged',
      }).success,
      false,
    );
  assert.equal(
    CommandSchema.safeParse({ ...request, tenant: 'b' }).success,
    false,
  );
  for (const actor of [
    await f.actor('machine'),
    { ...owner, authTime: Date.now() - 301000 },
  ])
    await assert.rejects(commands.execute(actor, request), /fresh owner MFA/);
  await assert.rejects(
    reads.read(await f.actor('machine'), 'agents'),
    /human read only/,
  );
  const wrongFence = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    'wrong-fence',
    'LOCAL_FIXTURE',
  );
  const staged = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    fence,
    'STAGING',
  );
  await assert.rejects(wrongFence.execute(owner, request), /recovery fence/);
  await assert.rejects(staged.execute(owner, request), /qualification pending/);
  assert.equal(await principal(request.target), undefined);
  assert.equal(f.provider.sends, 0);
});

test('historical unprofiled principals remain readable but cannot be adopted by profile commands', async () => {
  const owner = await f.actor('user');
  const before = await principal(f.principal);
  const view = await reads.read(owner, 'agents', { id: f.principal });
  assert.equal(view.items[0].title, f.principal);
  assert.equal(view.items[0].fields.profileRevision, null);
  const body = { name: 'Historical', description: '' };
  for (const request of [
    command('create_vera', f.principal, body),
    command('update_vera_profile', f.principal, body, 1),
  ])
    assert.equal((await commands.execute(owner, request)).status, 'DENIED');
  assert.equal(await profile(f.principal), undefined);
  assert.deepEqual(await principal(f.principal), before);
  // The CHECK rejects invalid new enrollments. Existing enrollment is also
  // immutable: its BEFORE UPDATE trigger refuses changes before CHECK runs.
  const ownerId = prefix + '-owner-a';
  const enrolledBefore = (
    await gov.query('SELECT * FROM ct.identities WHERE id=$1', [ownerId])
  ).rows[0];
  const invalidId = prefix + '-invalid-human-worker';
  await assert.rejects(
    gov.query(
      "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role) SELECT $1,issuer,$1,audience,kind,tenant,NULL,'worker' FROM ct.identities WHERE id=$2",
      [invalidId, ownerId],
    ),
    { code: '23514' },
  );
  await assert.rejects(
    gov.query("UPDATE ct.identities SET domain_role='worker' WHERE id=$1", [
      ownerId,
    ]),
    {
      code: 'P0001',
      message: 'immutable enrollment/monotonic identity fence',
    },
  );
  assert.deepEqual(
    (await gov.query('SELECT * FROM ct.identities WHERE id=$1', [ownerId]))
      .rows[0],
    enrolledBefore,
  );
  assert.equal(
    (
      await gov.query(
        'SELECT count(*)::integer AS n FROM ct.identities WHERE id=$1',
        [invalidId],
      )
    ).rows[0].n,
    0,
  );
});

test('read eligibility and fresh MFA use PostgreSQL time despite application-clock skew', async () => {
  const owner = await f.actor('user');
  const originalNow = Date.now;
  try {
    for (const delta of [-3600000, 3600000]) {
      Date.now = () => originalNow() + delta;
      const view = await reads.read(owner, 'agents', { id: f.principal });
      assert.equal(view.features.commands.state, 'available');
      assert.equal(view.session?.fresh_mfa, true);
    }
  } finally {
    Date.now = originalNow;
  }
});

test('feature previews retain live/fenced refusals and never treat malformed time as fresh', async () => {
  const owner = await f.actor('user');
  const now = Date.now();
  assert.equal(
    featureCatalogue('LOCAL_FIXTURE', owner, false, now).commands.state,
    'available',
  );
  assert.equal(
    featureCatalogue('STAGING', owner, false, now).commands.state,
    'qualification_pending',
  );
  assert.equal(
    featureCatalogue('LOCAL_FIXTURE', owner, true, now).commands.state,
    'temporarily_unavailable',
  );
  for (const clock of [NaN, Infinity, -Infinity])
    assert.equal(freshHumanMfa(owner, clock), false);
  assert.equal(freshHumanMfa({ ...owner, authTime: NaN }, now), false);
  assert.equal(freshHumanMfa({ ...owner, expires: now }, now), false);
  assert.equal(freshHumanMfa({ ...owner, authTime: now + 5001 }, now), false);
});
