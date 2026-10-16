import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pool, tx } from '../src/db.js';
import { productApi } from '../src/product-api.js';
import { ProductService } from '../src/product-service.js';
import { ConsoleCommands } from '../src/console/commands.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import { MandateService } from '../src/regency/mandate-service.js';
import { OrganizationService } from '../src/regency/organization-service.js';
import type { VerifiedIdentity } from '../src/identity-provider.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence, gov } from './helpers.js';

const mandates = new MandateService();
const organizations = new OrganizationService();
let f: Awaited<ReturnType<typeof fixture>>;
let auth: ReturnType<typeof pool>;
let commands: ConsoleCommands;
let api: ReturnType<typeof productApi>;
let endpoint: string;

function deadline() {
  return new Date(Date.now() + 3600000).toISOString();
}
function command(
  key: string,
  target: string,
  input: Record<string, unknown>,
  version = 0,
) {
  return {
    schema_version: 1 as const,
    idempotency_key: key,
    kind: 'create_task' as const,
    target,
    expected_version: version,
    input,
  };
}
async function count(sql: string) {
  return Number((await admin.query(sql)).rows[0].n);
}
async function effects() {
  return {
    grants: await count('SELECT count(*) n FROM ct.grants'),
    approvals: await count('SELECT count(*) n FROM ct.approvals'),
    operations: await count('SELECT count(*) n FROM ct.operations'),
    outbox: await count('SELECT count(*) n FROM ct.outbox'),
    notices: await count('SELECT count(*) n FROM ct.notice_projection'),
    tenantNotices: await count(
      "SELECT count(*) n FROM ct.evidence_events WHERE kind='TENANT_NOTICE'",
    ),
    sends: f.provider.sends,
  };
}
async function tasks(id: string) {
  return Number(
    (
      await admin.query(
        'SELECT count(*) n FROM ct.tasks WHERE tenant=$1 AND id=$2',
        ['a', id],
      )
    ).rows[0].n,
  );
}
async function taskRow(id: string) {
  return (
    await admin.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
      'a',
      id,
    ])
  ).rows[0];
}
async function waitForLock(fragment: string) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const waiting = await count(
      `SELECT count(*) n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%${fragment}%' AND pid<>pg_backend_pid()`,
    );
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('lock wait not observed');
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
function rawPool(user: string, database: string) {
  return new pg.Pool({
    host: '127.0.0.1',
    port: Number(process.env.PGPORT ?? 55432),
    user,
    database,
    max: 4,
    connectionTimeoutMillis: 2500,
  });
}

describe('task mandate admission', { concurrency: 1 }, () => {
  before(async () => {
    f = await fixture('admit');
    auth = pool('ct_authority_api');
    commands = new ConsoleCommands(
      auth,
      f.authority,
      f.product,
      fence,
      'LOCAL_FIXTURE',
    );
    api = productApi(f.machine, f.product);
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    endpoint = 'http://127.0.0.1:' + (api.address() as { port: number }).port;
  });
  after(async () => {
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    if (f) await f.close();
    if (auth) await auth.end();
    await admin.end();
    await gov.end();
  });

  test('a current mandate and active VERA member admit one non-effect task', async () => {
    const beforeEffects = await effects();
    const due = deadline();
    const owner = await f.actor('user');
    const worker = await f.actor('machine');
    const admitted = await commands.execute(
      owner,
      command('admit-command', 'admit-command-task', {
        principal: f.principal,
        objective: 'Admit under the current mandate',
        deadline: due,
        ...f.admission.a,
      }),
    );
    assert.equal(admitted.status, 'APPLIED');
    assert.equal(admitted.external_effect, false);
    assert.equal((admitted.result as any).workflowAdmitted, false);
    assert.equal((admitted.result as any).externalEffect, false);
    assert.equal((admitted.result as any).reused, false);
    const row = await taskRow('admit-command-task');
    assert.equal(row.organization, f.admission.a.organization);
    assert.equal(row.mandate, f.admission.a.mandate);
    assert.equal(Number(row.mandate_version), f.admission.a.mandateVersion);
    const current = Number(
      (
        await admin.query(
          'SELECT current_version FROM ct.mandates WHERE tenant=$1 AND organization=$2 AND id=$3',
          ['a', f.admission.a.organization, f.admission.a.mandate],
        )
      ).rows[0].current_version,
    );
    assert.equal(Number(row.mandate_version), current);
    const payload = JSON.parse(
      (
        await admin.query(
          "SELECT payload FROM ct.evidence_events WHERE tenant='a' AND kind='TASK_CREATED' AND payload LIKE '%admit-command-task%' ORDER BY seq DESC LIMIT 1",
        )
      ).rows[0].payload,
    );
    assert.deepEqual(Object.keys(payload).sort(), [
      'deadline',
      'identity',
      'principal',
      'task',
    ]);
    assert.equal(payload.task, 'admit-command-task');
    assert.equal(payload.principal, f.principal);
    assert.equal(payload.identity, f.prefix + '-owner-a');
    assert.deepEqual(await effects(), beforeEffects);
    await assert.rejects(
      f.product.propose(worker, {
        id: 'admit-no-grant',
        task: 'admit-command-task',
        grant: 'missing-grant',
        provider: 'fixture',
        action: 'write',
        resource: 'fixture-object',
        params: { value: 'no' },
        cost: 1,
        deadline: due,
      }),
    );
    const recorded = await commands.execute(owner, {
      schema_version: 1,
      idempotency_key: 'admit-record-mandate',
      kind: 'record_mandate',
      target: 'admit-extra-mandate',
      expected_version: 0,
      input: {
        organization: f.admission.a.organization,
        title: 'Still not authority',
        body: 'A mandate records purpose only.',
      },
    });
    assert.equal(recorded.status, 'APPLIED');
    assert.equal((recorded.result as any).effectAuthority, false);
    assert.deepEqual(await effects(), beforeEffects);
    const direct = await f.product.createTask(worker, {
      id: 'admit-machine-task',
      principal: f.principal,
      objective: 'Machine path uses the same mandate',
      deadline: due,
      ...f.admission.a,
    });
    assert.equal(direct.reused, false);
    assert.equal(direct.mandateVersion, f.admission.a.mandateVersion);
    const status = await f.product.status(worker, 'admit-machine-task');
    assert.equal(status.organization, f.admission.a.organization);
    assert.equal(status.mandate, f.admission.a.mandate);
    assert.equal(status.mandateVersion, f.admission.a.mandateVersion);
    const listed = (await f.product.list(worker)).find(
      (item) => item.id === 'admit-machine-task',
    );
    assert.equal(listed?.mandateVersion, f.admission.a.mandateVersion);
    assert.equal(f.provider.sends, 0);
  });

  test('missing bindings, ineligible members, and stale versions write nothing', async () => {
    const beforeEffects = await effects();
    const due = deadline();
    const worker = await f.actor('machine');
    const owner = await f.actor('user');
    const ownerId = f.prefix + '-owner-a';
    const base = {
      principal: f.principal,
      objective: 'Refused admission',
      deadline: due,
      ...f.admission.a,
    };
    for (const body of [
      { id: 'miss-org', ...base, organization: undefined },
      { id: 'miss-mandate', ...base, mandate: undefined },
      { id: 'miss-version', ...base, mandateVersion: undefined },
    ]) {
      await assert.rejects(f.product.createTask(worker, body as any));
      assert.equal(await tasks(body.id), 0);
    }
    await assert.rejects(
      commands.execute(
        owner,
        command('miss-command', 'miss-command-task', {
          principal: f.principal,
          objective: 'Missing mandate',
          deadline: due,
        }),
      ),
    );
    assert.equal(await tasks('miss-command-task'), 0);
    const response = await fetch(endpoint + '/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (await f.token('machine')),
      },
      body: JSON.stringify({
        id: 'miss-http',
        principal: f.principal,
        objective: 'Missing HTTP mandate',
        deadline: due,
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(await tasks('miss-http'), 0);
    await gov.query(
      'INSERT INTO ct.principals(tenant,id,epoch,generation,active) VALUES($1,$2,1,1,true)',
      ['a', 'p-outsider'],
    );
    await assert.rejects(
      f.product.createTask(owner, {
        id: 'no-membership',
        principal: 'p-outsider',
        objective: 'No VERA membership',
        deadline: due,
        ...f.admission.a,
      }),
      /vera membership required/,
    );
    assert.equal(await tasks('no-membership'), 0);
    await tx(auth, (c) =>
      organizations.addMembership(
        c,
        'a',
        f.admission.a.organization,
        'vera',
        'p-outsider',
        'steward',
        false,
      ),
    );
    await gov.query(
      'UPDATE ct.principals SET active=false WHERE tenant=$1 AND id=$2',
      ['a', 'p-outsider'],
    );
    await assert.rejects(
      f.product.createTask(owner, {
        id: 'inactive-principal',
        principal: 'p-outsider',
        objective: 'Inactive VERA',
        deadline: due,
        ...f.admission.a,
      }),
      /invalid task/,
    );
    assert.equal(await tasks('inactive-principal'), 0);
    await tx(auth, async (c) => {
      await organizations.create(
        c,
        'a',
        ownerId,
        'human-only-org',
        'Human only',
      );
      await mandates.record(
        c,
        'a',
        ownerId,
        'human-only-org',
        'human-only-mandate',
        'Human',
        'Human membership is not VERA eligibility.',
        0,
      );
      await organizations.create(
        c,
        'b',
        f.prefix + '-owner-b',
        'b-only-org',
        'Tenant b',
      );
      await mandates.record(
        c,
        'b',
        f.prefix + '-owner-b',
        'b-only-org',
        'b-only-mandate',
        'Other tenant',
        'A tenant cannot borrow another mandate.',
        0,
      );
    });
    await assert.rejects(
      f.product.createTask(worker, {
        id: 'human-only-task',
        principal: f.principal,
        objective: 'Human membership only',
        deadline: due,
        organization: 'human-only-org',
        mandate: 'human-only-mandate',
        mandateVersion: 1,
      }),
      /vera membership required/,
    );
    await assert.rejects(
      f.product.createTask(worker, {
        id: 'other-tenant-task',
        principal: f.principal,
        objective: 'Other tenant mandate',
        deadline: due,
        organization: 'b-only-org',
        mandate: 'b-only-mandate',
        mandateVersion: 1,
      }),
      /current mandate required/,
    );
    assert.equal(await tasks('human-only-task'), 0);
    assert.equal(await tasks('other-tenant-task'), 0);
    await assert.rejects(
      f.productDb.query(
        "INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by) VALUES($1,$2,$3,$4,now()+interval '1 hour',$5)",
        ['a', 'sql-unbound', f.principal, 'No mandate columns', ownerId],
      ),
      /task mandate required/,
    );
    await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'sql-mandate',
        'SQL',
        'Version two is current.',
        0,
      ),
    );
    await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'sql-mandate',
        'SQL',
        'Version two is current.',
        1,
      ),
    );
    await assert.rejects(
      f.productDb.query(
        "INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) VALUES($1,$2,$3,$4,now()+interval '1 hour',$5,$6,$7,1)",
        [
          'a',
          'sql-stale',
          f.principal,
          'Stale direct insert',
          ownerId,
          f.admission.a.organization,
          'sql-mandate',
        ],
      ),
      /mandate is not current/,
    );
    assert.equal(await tasks('sql-unbound'), 0);
    assert.equal(await tasks('sql-stale'), 0);
    assert.deepEqual(await effects(), beforeEffects);
  });

  test('a direct insert cannot commit a mandate that advanced', async () => {
    const beforeEffects = await effects();
    const ownerId = f.prefix + '-owner-a';
    await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'direct-lock-mandate',
        'Direct',
        'Version one.',
        0,
      ),
    );
    const holder = await admin.connect();
    const product = await f.productDb.connect();
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await holder.query('BEGIN');
      const locked = (
        await holder.query(
          'SELECT revision FROM ct.mandates WHERE tenant=$1 AND organization=$2 AND id=$3 FOR UPDATE',
          ['a', f.admission.a.organization, 'direct-lock-mandate'],
        )
      ).rows[0];
      await product.query('BEGIN');
      pending = product.query(
        "INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) VALUES('a','direct-lock-task',$1,'Direct insert waits',now()+interval '1 hour',$2,$3,'direct-lock-mandate',1)",
        [f.principal, ownerId, f.admission.a.organization],
      );
      await waitForLock('direct-lock-task');
      await mandates.record(
        holder,
        'a',
        ownerId,
        f.admission.a.organization,
        'direct-lock-mandate',
        'Direct',
        'Version two.',
        Number(locked.revision),
      );
      await holder.query('COMMIT');
      await assert.rejects(pending, /mandate is not current/);
      assert.equal(await tasks('direct-lock-task'), 0);
    } finally {
      await product.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      product.release();
      holder.release();
      await pending.catch(() => undefined);
    }
    const membership = Number(
      (
        await admin.query(
          "SELECT revision FROM ct.memberships WHERE tenant='a' AND organization=$1 AND subject_kind='vera' AND subject_id=$2",
          [f.admission.a.organization, f.principal],
        )
      ).rows[0].revision,
    );
    const gate = await f.productDb.connect();
    const remover = await auth.connect();
    let inserted: Promise<unknown> = Promise.resolve();
    let removing: Promise<unknown> = Promise.resolve();
    try {
      await gate.query('BEGIN');
      inserted = gate.query(
        "INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) VALUES('a','direct-member-task',$1,'Direct insert holds membership',now()+interval '1 hour',$2,$3,$4,$5)",
        [
          f.principal,
          ownerId,
          f.admission.a.organization,
          f.admission.a.mandate,
          f.admission.a.mandateVersion,
        ],
      );
      await inserted;
      removing = (async () => {
        await remover.query('BEGIN');
        const removed = await organizations.removeMembership(
          remover,
          'a',
          f.admission.a.organization,
          'vera',
          f.principal,
          membership,
        );
        await remover.query('COMMIT');
        return removed;
      })();
      await waitForLock('ct.memberships');
      await gate.query('COMMIT');
      assert.equal(((await removing) as { removed: boolean }).removed, true);
      assert.equal(
        Number((await taskRow('direct-member-task')).mandate_version),
        f.admission.a.mandateVersion,
      );
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      await remover.query('ROLLBACK').catch(() => undefined);
      gate.release();
      remover.release();
      await inserted.catch(() => undefined);
      await removing.catch(() => undefined);
    }
    await tx(auth, (c) =>
      organizations.addMembership(
        c,
        'a',
        f.admission.a.organization,
        'vera',
        f.principal,
        'steward',
        false,
      ),
    );
    assert.deepEqual(await effects(), beforeEffects);
  });

  test('an identical stored request is reused after the mandate advances', async () => {
    const due = deadline();
    const worker = await f.actor('machine');
    const owner = await f.actor('user');
    const ownerId = f.prefix + '-owner-a';
    await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'replay-mandate',
        'Replay',
        'Version one.',
        0,
      ),
    );
    const body = {
      id: 'replay-task',
      principal: f.principal,
      objective: 'Stored admission',
      deadline: due,
      organization: f.admission.a.organization,
      mandate: 'replay-mandate',
      mandateVersion: 1,
    };
    assert.equal((await f.product.createTask(worker, body)).reused, false);
    await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'replay-mandate',
        'Replay',
        'Version two.',
        1,
      ),
    );
    const again = await f.product.createTask(worker, body);
    assert.equal(again.reused, true);
    assert.equal(again.mandateVersion, 1);
    assert.equal(await tasks('replay-task'), 1);
    await assert.rejects(
      f.product.createTask(worker, { ...body, id: 'replay-stale' }),
      /current mandate required/,
    );
    assert.equal(await tasks('replay-stale'), 0);
    await assert.rejects(
      f.product.createTask(worker, { ...body, mandateVersion: 2 }),
      /task identity conflict/,
    );
    await assert.rejects(
      f.product.createTask(worker, { ...body, objective: 'Different work' }),
      /task identity conflict/,
    );
    assert.equal(Number((await taskRow('replay-task')).mandate_version), 1);
    const fresh = await f.product.createTask(worker, {
      ...body,
      id: 'replay-current',
      mandateVersion: 2,
    });
    assert.equal(fresh.reused, false);
    assert.equal(fresh.mandateVersion, 2);
    const first = command('replay-command', 'replay-command-task', {
      principal: f.principal,
      objective: 'Command replay',
      deadline: due,
      organization: f.admission.a.organization,
      mandate: 'replay-mandate',
      mandateVersion: 2,
    });
    const applied = await commands.execute(owner, first);
    assert.equal(applied.status, 'APPLIED');
    assert.equal((applied.result as any).workflowAdmitted, false);
    const repeated = await commands.execute(owner, first);
    assert.equal(repeated.command_id, applied.command_id);
    assert.equal(repeated.reused, true);
    await assert.rejects(
      commands.execute(owner, {
        ...first,
        input: { ...first.input, objective: 'Changed command' },
      }),
      /command binding conflict/,
    );
    assert.equal(await tasks('replay-command-task'), 1);
    const deniedBody = command('denied-command', 'denied-command-task', {
      principal: f.principal,
      objective: 'Denied stale command',
      deadline: due,
      organization: f.admission.a.organization,
      mandate: 'replay-mandate',
      mandateVersion: 1,
    });
    const denied = await commands.execute(owner, deniedBody);
    assert.equal(denied.status, 'DENIED');
    assert.equal(denied.error_code, 'STALE_OR_UNAUTHORIZED_COMMAND');
    const deniedAgain = await commands.execute(owner, deniedBody);
    assert.equal(deniedAgain.command_id, denied.command_id);
    assert.equal(deniedAgain.status, 'DENIED');
    assert.equal(deniedAgain.reused, true);
    assert.equal(await tasks('denied-command-task'), 0);
    const moved = await commands.execute(
      owner,
      command('replay-new-key', 'replay-new-key-task', {
        principal: f.principal,
        objective: 'New key under version two',
        deadline: due,
        organization: f.admission.a.organization,
        mandate: 'replay-mandate',
        mandateVersion: 2,
      }),
    );
    assert.equal(moved.status, 'APPLIED');
    assert.notEqual(moved.command_id, applied.command_id);
    assert.equal(await tasks('replay-new-key-task'), 1);
  });

  test('mandate edits and membership removal wait on the admission locks', async () => {
    const beforeEffects = await effects();
    const due = deadline();
    const worker = await f.actor('machine');
    const ownerId = f.prefix + '-owner-a';
    await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'race-mandate',
        'Race',
        'Version one.',
        0,
      ),
    );
    const holder = await admin.connect();
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await holder.query('BEGIN');
      const locked = (
        await holder.query(
          'SELECT revision,current_version FROM ct.mandates WHERE tenant=$1 AND organization=$2 AND id=$3 FOR UPDATE',
          ['a', f.admission.a.organization, 'race-mandate'],
        )
      ).rows[0];
      pending = f.product.createTask(worker, {
        id: 'race-old-version',
        principal: f.principal,
        objective: 'Waits for the mandate edit',
        deadline: due,
        organization: f.admission.a.organization,
        mandate: 'race-mandate',
        mandateVersion: 1,
      });
      await waitForLock('share_mandate');
      await mandates.record(
        holder,
        'a',
        ownerId,
        f.admission.a.organization,
        'race-mandate',
        'Race',
        'Version two.',
        Number(locked.revision),
      );
      await holder.query('COMMIT');
      await assert.rejects(pending, /current mandate required/);
      assert.equal(await tasks('race-old-version'), 0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending.catch(() => undefined);
    }
    const opened = await tx(auth, (c) =>
      mandates.record(
        c,
        'a',
        ownerId,
        f.admission.a.organization,
        'race-create',
        'Race',
        'Version one.',
        0,
      ),
    );
    const limits = await admin.connect();
    const editor = await auth.connect();
    let creating: Promise<unknown> = Promise.resolve();
    let editing: Promise<unknown> = Promise.resolve();
    try {
      await limits.query('BEGIN');
      await limits.query(
        "SELECT tenant FROM ct.resource_limits WHERE tenant='a' FOR UPDATE",
      );
      creating = f.product.createTask(worker, {
        id: 'race-version-one',
        principal: f.principal,
        objective: 'Commits version one first',
        deadline: due,
        organization: f.admission.a.organization,
        mandate: 'race-create',
        mandateVersion: 1,
      });
      await waitForLock('ct.resource_limits');
      editing = (async () => {
        await editor.query('BEGIN');
        const edited = await mandates.record(
          editor,
          'a',
          ownerId,
          f.admission.a.organization,
          'race-create',
          'Race',
          'Version two after admission.',
          opened.revision,
        );
        await editor.query('COMMIT');
        return edited;
      })();
      await waitForLock('ct.mandates');
      await limits.query('COMMIT');
      const created = await creating;
      assert.equal((created as { mandateVersion: number }).mandateVersion, 1);
      const edited = (await editing) as { version: number };
      assert.equal(edited.version, 2);
      assert.equal(
        Number((await taskRow('race-version-one')).mandate_version),
        1,
      );
    } finally {
      await limits.query('ROLLBACK');
      await editor.query('ROLLBACK');
      limits.release();
      editor.release();
      await creating.catch(() => undefined);
      await editing.catch(() => undefined);
    }
    const membership = Number(
      (
        await admin.query(
          "SELECT revision FROM ct.memberships WHERE tenant='a' AND organization=$1 AND subject_kind='vera' AND subject_id=$2",
          [f.admission.a.organization, f.principal],
        )
      ).rows[0].revision,
    );
    const gate = await admin.connect();
    const remover = await auth.connect();
    let creatingMembership: Promise<unknown> = Promise.resolve();
    let removing: Promise<unknown> = Promise.resolve();
    try {
      await gate.query('BEGIN');
      await gate.query(
        "SELECT tenant FROM ct.resource_limits WHERE tenant='a' FOR UPDATE",
      );
      creatingMembership = f.product.createTask(worker, {
        id: 'race-membership',
        principal: f.principal,
        objective: 'Admitted before removal',
        deadline: due,
        ...f.admission.a,
      });
      await waitForLock('ct.resource_limits');
      removing = (async () => {
        await remover.query('BEGIN');
        const removed = await organizations.removeMembership(
          remover,
          'a',
          f.admission.a.organization,
          'vera',
          f.principal,
          membership,
        );
        await remover.query('COMMIT');
        return removed;
      })();
      await waitForLock('ct.memberships');
      await gate.query('COMMIT');
      await creatingMembership;
      assert.equal(((await removing) as { removed: boolean }).removed, true);
      assert.equal(
        Number((await taskRow('race-membership')).mandate_version),
        1,
      );
    } finally {
      await gate.query('ROLLBACK');
      await remover.query('ROLLBACK');
      gate.release();
      remover.release();
      await creatingMembership.catch(() => undefined);
      await removing.catch(() => undefined);
    }
    await assert.rejects(
      f.product.createTask(worker, {
        id: 'race-after-removal',
        principal: f.principal,
        objective: 'Membership already removed',
        deadline: due,
        ...f.admission.a,
      }),
      /vera membership required/,
    );
    assert.equal(await tasks('race-after-removal'), 0);
    await tx(auth, (c) =>
      organizations.addMembership(
        c,
        'a',
        f.admission.a.organization,
        'vera',
        f.principal,
        'steward',
        false,
      ),
    );
    assert.deepEqual(await effects(), beforeEffects);
    assert.equal(f.provider.sends, 0);
  });

  test('historical tasks stay unbound when the admission migration is applied', async () => {
    const database = 'ct_task_mandate_history';
    const script = readFileSync('tools/setup-console-db.sh', 'utf8');
    const listed = script.match(/for m in ([^;]+);do/);
    assert.ok(listed);
    const files = listed[1].trim().split(/\s+/);
    const older = files.slice(
      0,
      files.indexOf('019-task-mandate-admission.sql'),
    );
    assert.equal(older.at(-1), '018-tenant-notice-projection.sql');
    psql('postgres', [
      '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid()`,
    ]);
    spawnSync('dropdb', ['--if-exists', database], { encoding: 'utf8' });
    assert.equal(
      spawnSync('createdb', [database], { encoding: 'utf8' }).status,
      0,
    );
    const product = rawPool('ct_product_api', database);
    const authority = rawPool('ct_authority_api', database);
    const reader = rawPool('ct_console_reader', database);
    const historyAdmin = rawPool('localtest', database);
    try {
      for (const file of older) psql(database, ['-f', `migrations/${file}`]);
      psql(database, [
        '-c',
        `INSERT INTO ct.tenants VALUES('a');
         INSERT INTO ct.evidence_heads(tenant) VALUES('a');
         INSERT INTO ct.principals(tenant,id,epoch,generation) VALUES('a','p-hist',1,1);
         INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role)
           VALUES('hist-owner','https://hist.test-identity.invalid','hist-owner','urn:continuum:test:hist','user','a',NULL,'owner'),
                  ('hist-worker','https://hist.test-identity.invalid','hist-worker','urn:continuum:test:hist','machine','a','p-hist','worker');
         UPDATE ct.control SET blocked=false,fence='fixture-fence-v1';
         INSERT INTO ct.resource_limits(tenant,max_jobs,max_storage,max_units) VALUES('a',1000,67108864,100000);
         INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by)
           VALUES('a','hist-old','p-hist','Historical unbound task',now()+interval '1 hour','hist-owner');`,
      ]);
      psql(database, ['-f', 'migrations/019-task-mandate-admission.sql']);
      const migrated = (
        await historyAdmin.query(
          "SELECT organization,mandate,mandate_version FROM ct.tasks WHERE id='hist-old'",
        )
      ).rows[0];
      assert.equal(migrated.organization, null);
      assert.equal(migrated.mandate, null);
      assert.equal(migrated.mandate_version, null);
      assert.equal(
        Number(
          (await historyAdmin.query('SELECT count(*) n FROM ct.mandates'))
            .rows[0].n,
        ),
        0,
      );
      await assert.rejects(
        historyAdmin.query(
          "UPDATE ct.tasks SET organization='hist-org',mandate='hist-mandate',mandate_version=1 WHERE id='hist-old'",
        ),
        /immutable task intent\/cancellation/,
      );
      await tx(authority, async (c) => {
        await organizations.create(c, 'a', 'hist-owner', 'hist-org', 'History');
        await organizations.addMembership(
          c,
          'a',
          'hist-org',
          'vera',
          'p-hist',
          'steward',
          false,
        );
        await mandates.record(
          c,
          'a',
          'hist-owner',
          'hist-org',
          'hist-mandate',
          'History',
          'A later mandate does not rewrite the old task.',
          0,
        );
      });
      const actor: VerifiedIdentity = {
        issuer: 'https://hist.test-identity.invalid',
        subject: 'hist-worker',
        audience: 'urn:continuum:test:hist',
        kind: 'machine',
        expires: Date.now() + 600000,
        methods: ['mfa'],
        authTime: Date.now(),
      };
      const service = new ProductService(product, fence);
      await service.createTask(actor, {
        id: 'hist-new',
        principal: 'p-hist',
        objective: 'Bound after migration',
        deadline: deadline(),
        organization: 'hist-org',
        mandate: 'hist-mandate',
        mandateVersion: 1,
      });
      const rows = (
        await historyAdmin.query(
          'SELECT id,organization,mandate,mandate_version,objective FROM ct.tasks ORDER BY id',
        )
      ).rows;
      assert.equal(rows[0].id, 'hist-new');
      assert.equal(rows[0].organization, 'hist-org');
      assert.equal(rows[1].id, 'hist-old');
      assert.equal(rows[1].organization, null);
      assert.equal(rows[1].mandate, null);
      assert.equal(rows[1].mandate_version, null);
      assert.equal(rows[1].objective, 'Historical unbound task');
      const reads = new ConsoleReads(
        reader,
        new CursorCodec(randomBytes(32)),
        'LOCAL_FIXTURE',
        'history',
        fence,
      );
      const owner: VerifiedIdentity = {
        ...actor,
        subject: 'hist-owner',
        kind: 'user',
      };
      const work = await reads.read(owner, 'work');
      const old = work.items.find((item) => item.id === 'hist-old');
      const created = work.items.find((item) => item.id === 'hist-new');
      assert.equal(old?.fields.organization, null);
      assert.equal(old?.fields.mandate, null);
      assert.equal(old?.fields.acceptedMandateVersion, null);
      assert.equal(created?.fields.organization, 'hist-org');
      assert.equal(created?.fields.mandate, 'hist-mandate');
      assert.equal(created?.fields.acceptedMandateVersion, 1);
    } finally {
      await Promise.all(
        [product, authority, reader, historyAdmin].map((p) => p.end()),
      );
      psql('postgres', [
        '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid()`,
      ]);
      spawnSync('dropdb', ['--if-exists', database], { encoding: 'utf8' });
    }
  });
});
