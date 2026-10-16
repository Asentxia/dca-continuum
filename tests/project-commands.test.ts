import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { ConsoleCommands } from '../src/console/commands.js';
import { WorkCoordination } from '../src/console/coordination.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import {
  CommandInputs,
  CommandReceiptSchema,
  CommandSchema,
  type HumanCommand,
} from '../src/console/contracts.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence, gov } from './helpers.js';

// Parent-owned disposable DB/test lease only. Never reset a cluster from this
// suite or delete immutable evidence/history. All fixture IDs are suite-owned;
// teardown closes only these pools. The parent owns eventual fixture disposal.
const prefix = 'project-commands-' + randomBytes(8).toString('hex');
const id = (suffix: string) => prefix + '-' + suffix;
let f: Awaited<ReturnType<typeof fixture>>;
let writeDb: ReturnType<typeof pool>;
let commands: ConsoleCommands;
let coordination: WorkCoordination;

function command(
  kind: HumanCommand['kind'],
  target: string,
  input: Record<string, unknown>,
  version = 0,
  key = target + '-' + kind,
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
function projectCommand(suffix: string) {
  return command('create_project', id(suffix), {
    name: 'Project ' + suffix,
    objective: 'Organization only; no execution or effect authority.',
  });
}
async function createProject(suffix: string, tenant = 'a') {
  const request = projectCommand(suffix);
  const result = await commands.execute(await f.actor('user', tenant), request);
  applied(result, 1);
  return request.target;
}
async function createTask(suffix: string, tenant = 'a', console = false) {
  const target = id(suffix);
  const input = {
    principal: f.principal,
    objective: 'Fixture task ' + suffix,
    deadline: new Date(Date.now() + 3600000).toISOString(),
    ...f.admission[tenant],
  };
  if (console) {
    const result = await commands.execute(
      await f.actor('user', tenant),
      command('create_task', target, input),
    );
    assert.equal(result.status, 'APPLIED');
  } else {
    await f.product.createTask(await f.actor('machine', tenant), {
      id: target,
      ...input,
    });
  }
  return target;
}
async function projectRow(target: string, tenant = 'a') {
  return (
    await admin.query('SELECT * FROM ct.projects WHERE tenant=$1 AND id=$2', [
      tenant,
      target,
    ])
  ).rows[0];
}
async function coordinationRow(task: string, tenant = 'a') {
  return (
    await admin.query(
      'SELECT * FROM ct.work_coordination WHERE tenant=$1 AND task=$2',
      [tenant, task],
    )
  ).rows[0];
}
async function commandRows(key: string, tenant = 'a') {
  return (
    await admin.query(
      'SELECT * FROM ct.console_commands WHERE tenant=$1 AND idempotency_key=$2',
      [tenant, key],
    )
  ).rows;
}
async function events(
  kind: string,
  field: string,
  value: string,
  tenant = 'a',
) {
  return (
    await admin.query(
      'SELECT payload FROM ct.evidence_events WHERE tenant=$1 AND kind=$2 AND payload::jsonb->>($3::text)=$4 ORDER BY seq',
      [tenant, kind, field, value],
    )
  ).rows.map((row) => JSON.parse(row.payload));
}
function applied(
  result: Awaited<ReturnType<ConsoleCommands['execute']>>,
  version: number,
) {
  CommandReceiptSchema.parse(result);
  assert.equal(result.status, 'APPLIED');
  assert.equal(result.external_effect, false);
  assert.equal((result.result as any).version, version);
  assert.equal((result.result as any).workflowAdmitted, false);
  assert.equal((result.result as any).effectAuthority, false);
  assert.equal((result.result as any).externalEffect, false);
}
async function effectRows(task: string, operation: string) {
  const bindings: [string, string, string][] = [
    ['tasks', 'principal', f.principal],
    ['task_operations', 'task', task],
    ['operations', 'principal', f.principal],
    ['grants', 'principal', f.principal],
    ['approvals', 'operation', operation],
    ['approval_history', 'operation', operation],
    ['assignments', 'operation', operation],
    ['outbox', 'operation', operation],
    ['resource_reservations', 'principal', f.principal],
    ['resource_limits', 'tenant', 'a'],
    ['principals', 'id', f.principal],
    ['computers', 'principal', f.principal],
    ['notice_projection', 'tenant', 'a'],
  ];
  const rows: Record<string, unknown[]> = {};
  for (const [table, column, value] of bindings) {
    // Identifiers come only from the fixed test list above.
    rows[table] = (
      await admin.query(
        `SELECT to_jsonb(r) AS snapshot_row FROM ct.${table} r WHERE tenant=$1 AND ${column}=$2 ORDER BY to_jsonb(r)::text`,
        ['a', value],
      )
    ).rows.map((row) => row.snapshot_row);
  }
  return rows;
}
async function waitForCommandLock(fragment: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const waiting = (
      await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE $2 AND pid<>pg_backend_pid()",
        ['ct_authority_api', '%' + fragment + '%'],
      )
    ).rowCount;
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('command lock wait not observed: ' + fragment);
}
async function denyAfterDomainWrite(request: HumanCommand) {
  const locker = await admin.connect();
  let outcome:
    | Promise<
        | { value: Awaited<ReturnType<ConsoleCommands['execute']>> }
        | { error: unknown }
      >
    | undefined;
  try {
    await locker.query('BEGIN');
    await locker.query(
      'SELECT * FROM ct.evidence_heads WHERE tenant=$1 FOR UPDATE',
      ['a'],
    );
    const owner = await f.actor('user');
    const authTime = Date.now() - 297000;
    // Domain INSERT/UPDATE occurs before append waits; MFA expires during that
    // wait. A nested pool commit would leave an orphan after the outer denial.
    outcome = commands.execute({ ...owner, authTime }, request).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForCommandLock('ct.evidence_heads');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, authTime + 300000 - Date.now()) + 100),
    );
  } finally {
    try {
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
      if (outcome) await outcome;
    }
  }
  const result = await outcome!;
  if ('error' in result) throw result.error;
  assert.equal(result.value.status, 'DENIED');
  assert.equal(result.value.external_effect, false);
  return result.value;
}

describe('durable human project commands', { concurrency: 1 }, () => {
  before(async () => {
    f = await fixture(prefix);
    writeDb = pool('ct_authority_api');
    commands = new ConsoleCommands(
      writeDb,
      f.authority,
      f.product,
      fence,
      'LOCAL_FIXTURE',
    );
    coordination = new WorkCoordination(writeDb, fence);
  });
  after(async () => {
    if (f) await f.close();
    if (writeDb) await writeDb.end();
    await admin.end();
    await gov.end();
  });

  test('concurrent identical creation stores exactly one project, receipt and domain event', async () => {
    const owner = await f.actor('user');
    const request = {
      ...projectCommand('concurrent'),
      input: { name: 'Bounded project', objective: '' },
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => commands.execute(owner, request)),
    );
    for (const result of results) {
      applied(result, 1);
      assert.equal(result.command_id, results[0].command_id);
      assert.equal((result.result as any).id, request.target);
      assert.deepEqual(result.result, results[0].result);
    }
    assert.equal(results.filter((result) => !result.reused).length, 1);
    assert.equal((await commandRows(request.idempotency_key)).length, 1);
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT count(*) n FROM ct.projects WHERE tenant=$1 AND id=$2',
            ['a', request.target],
          )
        ).rows[0].n,
      ),
      1,
    );
    assert.equal(Number((await projectRow(request.target)).revision), 1);
    assert.deepEqual(await events('PROJECT_REGISTERED', 'id', request.target), [
      { id: request.target, actor: prefix + '-owner-a' },
    ]);
    const commandEvents = await events(
      'HUMAN_COMMAND_APPLIED',
      'command',
      results[0].command_id,
    );
    assert.equal(commandEvents.length, 1);
    assert.equal(commandEvents[0].externalEffect, false);
    assert.deepEqual(await commands.lookup(owner, request.idempotency_key), {
      ...results[0],
      reused: true,
    });
    assert.equal(f.provider.sends, 0);
  });

  test('creation bounds, initial version, and strict exact bodies fail closed', async () => {
    const owner = await f.actor('user');
    const request = projectCommand('bindings');
    const result = await commands.execute(owner, request);
    applied(result, 1);
    for (const changed of [
      { ...request, target: id('other-target') },
      { ...request, expected_version: 1 },
      { ...request, input: { ...request.input, name: 'Different name' } },
      {
        ...request,
        input: { ...request.input, objective: 'Different objective' },
      },
      command(
        'link_task_project',
        id('other-task'),
        { project: request.target },
        0,
        request.idempotency_key,
      ),
    ])
      await assert.rejects(
        commands.execute(owner, changed),
        /command binding conflict/,
      );
    await assert.rejects(
      commands.execute(owner, {
        ...request,
        input: { ...request.input, start: true },
      }),
    );
    await assert.rejects(
      commands.execute(owner, { ...request, kind: 'unknown_project_command' }),
    );
    assert.equal((await commandRows(request.idempotency_key)).length, 1);

    for (const input of [
      { name: '', objective: '' },
      { name: 'x'.repeat(201), objective: '' },
      { name: 'Valid', objective: 'x'.repeat(8001) },
      { name: 'Valid', objective: '', principal: f.principal },
    ])
      assert.equal(
        CommandInputs.create_project.safeParse(input).success,
        false,
      );
    assert.equal(
      CommandInputs.link_task_project.safeParse({
        project: request.target,
        assign: true,
      }).success,
      false,
    );
    assert.equal(
      CommandInputs.link_task_project.safeParse({
        project: 'invalid project id',
      }).success,
      false,
    );
    assert.equal(
      CommandSchema.safeParse({ ...request, tenant: 'b' }).success,
      false,
    );

    const wrongVersion = {
      ...projectCommand('wrong-version'),
      expected_version: 1,
    };
    assert.equal(
      (await commands.execute(owner, wrongVersion)).status,
      'DENIED',
    );
    assert.equal(await projectRow(wrongVersion.target), undefined);
    const whitespace = {
      ...projectCommand('whitespace'),
      input: { name: '   ', objective: '' },
    };
    assert.equal((await commands.execute(owner, whitespace)).status, 'DENIED');
    assert.equal(await projectRow(whitespace.target), undefined);
    const maximum = {
      ...projectCommand('maximum-bounds'),
      input: { name: 'x'.repeat(200), objective: 'x'.repeat(8000) },
    };
    applied(await commands.execute(owner, maximum), 1);
    const duplicate = { ...request, idempotency_key: id('duplicate-target') };
    assert.equal((await commands.execute(owner, duplicate)).status, 'DENIED');
    assert.deepEqual(
      (await commands.lookup(owner, request.idempotency_key)).result,
      result.result,
    );
    assert.equal(
      (await events('PROJECT_REGISTERED', 'id', request.target)).length,
      1,
    );
    assert.equal(f.provider.sends, 0);
  });

  test('post-domain MFA denial rolls creation and link back with no orphaned writes or events', async () => {
    const create = projectCommand('atomic-create');
    const deniedCreate = await denyAfterDomainWrite(create);
    assert.equal(await projectRow(create.target), undefined);
    assert.deepEqual(
      await events('PROJECT_REGISTERED', 'id', create.target),
      [],
    );
    assert.equal((await commandRows(create.idempotency_key)).length, 1);
    assert.equal(
      (await events('HUMAN_COMMAND_DENIED', 'command', deniedCreate.command_id))
        .length,
      1,
    );

    const first = await createProject('atomic-first');
    const second = await createProject('atomic-second');
    const task = await createTask('atomic-task');
    const owner = await f.actor('user');
    // Existing standalone signature still commits its own domain transaction.
    await coordination.link(owner, task, first, 0);
    const original = await coordinationRow(task);
    const link = command(
      'link_task_project',
      task,
      { project: second },
      1,
      id('atomic-link'),
    );
    const deniedLink = await denyAfterDomainWrite(link);
    assert.deepEqual(await coordinationRow(task), original);
    assert.deepEqual(await events('TASK_PROJECT_LINKED', 'task', task), [
      { task, project: first },
    ]);
    assert.deepEqual(
      await commands.lookup(await f.actor('user'), link.idempotency_key),
      {
        ...deniedLink,
        reused: true,
      },
    );
    assert.deepEqual(await commands.execute(await f.actor('user'), create), {
      ...deniedCreate,
      reused: true,
    });
    assert.equal(await projectRow(create.target), undefined);
    assert.equal(f.provider.sends, 0);
  });

  test('lost-reply lookup and identical replay return the original result after domain changes', async () => {
    const owner = await f.actor('user');
    const create = projectCommand('replay-project');
    const created = await commands.execute(owner, create);
    applied(created, 1);
    await gov.query(
      'UPDATE ct.projects SET name=$3,objective=$4,revision=revision+1 WHERE tenant=$1 AND id=$2',
      ['a', create.target, 'Later name', 'Later objective'],
    );
    const currentProject = await projectRow(create.target);
    assert.equal(Number(currentProject.revision), 2);
    assert.deepEqual(await commands.execute(owner, create), {
      ...created,
      reused: true,
    });
    assert.deepEqual(await commands.lookup(owner, create.idempotency_key), {
      ...created,
      reused: true,
    });
    assert.deepEqual(await projectRow(create.target), currentProject);

    const other = await createProject('replay-other');
    const task = await createTask('replay-task');
    const link = command('link_task_project', task, { project: create.target });
    const linked = await commands.execute(owner, link);
    applied(linked, 1);
    assert.equal((linked.result as any).project, create.target);
    await coordination.link(owner, task, other, 1);
    const currentLink = await coordinationRow(task);
    assert.equal(Number(currentLink.revision), 2);
    assert.equal(currentLink.project, other);
    assert.deepEqual(await commands.execute(owner, link), {
      ...linked,
      reused: true,
    });
    assert.deepEqual(await commands.lookup(owner, link.idempotency_key), {
      ...linked,
      reused: true,
    });
    for (const changed of [
      { ...link, input: { project: other } },
      { ...link, target: id('changed-task') },
      { ...link, expected_version: 2 },
    ])
      await assert.rejects(
        commands.execute(owner, changed),
        /command binding conflict/,
      );
    await assert.rejects(
      commands.execute(owner, {
        ...link,
        input: { ...link.input, approval: true },
      }),
    );
    assert.deepEqual(await coordinationRow(task), currentLink);
    assert.equal((await commandRows(link.idempotency_key)).length, 1);
    assert.equal((await events('TASK_PROJECT_LINKED', 'task', task)).length, 2);
    assert.equal(
      (await events('PROJECT_REGISTERED', 'id', create.target)).length,
      1,
    );

    // An identical stored request must still have fresh owner MFA after waiting
    // for the key lock. No new domain call or command row is permitted.
    const locker = await admin.connect();
    let checked: Promise<void> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['a|' + prefix + '-owner-a|' + create.idempotency_key],
      );
      const authTime = Date.now() - 297000;
      checked = assert.rejects(
        commands.execute({ ...owner, authTime }, create),
        /fresh owner MFA required/,
      );
      await waitForCommandLock('pg_advisory_xact_lock');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, authTime + 300000 - Date.now()) + 100),
      );
    } finally {
      try {
        await locker.query('ROLLBACK');
      } finally {
        locker.release();
        if (checked) await checked;
      }
    }
    assert.deepEqual(await projectRow(create.target), currentProject);
    assert.deepEqual(
      await commands.lookup(await f.actor('user'), create.idempotency_key),
      { ...created, reused: true },
    );
    assert.equal((await commandRows(create.idempotency_key)).length, 1);
    assert.equal(f.provider.sends, 0);
  });

  test('cross-tenant tasks and projects deny atomically in both directions', async () => {
    const local = await createProject('tenant-a-project');
    const foreign = id('tenant-b-project');
    // Exercise the previous project signature as well as tenant-local FK checks.
    await coordination.project(
      await f.actor('user', 'b'),
      foreign,
      'Tenant B only',
      '',
    );
    const taskA = await createTask('tenant-a-task');
    const taskB = await createTask('tenant-b-task', 'b');
    const beforeProjects = [
      await projectRow(local),
      await projectRow(foreign, 'b'),
    ];
    for (const [tenant, task, project, suffix] of [
      ['a', taskB, local, 'foreign-task-a'],
      ['a', taskA, foreign, 'foreign-project-a'],
      ['b', taskA, foreign, 'foreign-task-b'],
      ['b', taskB, local, 'foreign-project-b'],
      ['a', taskA, id('missing-project'), 'missing-project'],
    ]) {
      const request = command(
        'link_task_project',
        task,
        { project },
        0,
        id(suffix),
      );
      const denied = await commands.execute(
        await f.actor('user', tenant),
        request,
      );
      assert.equal(denied.status, 'DENIED');
      assert.equal(denied.external_effect, false);
      assert.equal(
        (await commandRows(request.idempotency_key, tenant)).length,
        1,
      );
    }
    assert.equal(await coordinationRow(taskA), undefined);
    assert.equal(await coordinationRow(taskB, 'b'), undefined);
    assert.deepEqual(await events('TASK_PROJECT_LINKED', 'task', taskA), []);
    assert.deepEqual(
      await events('TASK_PROJECT_LINKED', 'task', taskB, 'b'),
      [],
    );
    assert.deepEqual(
      [await projectRow(local), await projectRow(foreign, 'b')],
      beforeProjects,
    );
    assert.equal(f.provider.sends, 0);
  });

  test('only an independently enrolled fresh-MFA human owner with the active fence can execute', async () => {
    const project = await createProject('authorization-project');
    const task = await createTask('authorization-task');
    const owner = await f.actor('user');
    const requests = [
      projectCommand('unauthorized-create'),
      command('link_task_project', task, { project }),
    ];
    for (const actor of [
      await f.actor('machine'),
      { ...owner, authTime: Date.now() - 300001 },
      { ...owner, authTime: Date.now() + 10000 },
      { ...owner, methods: ['pwd'] },
      { ...owner, expires: Date.now() - 1 },
      { ...owner, subject: id('unenrolled-human') },
    ])
      for (const request of requests)
        await assert.rejects(commands.execute(actor, request));

    // The current schema has no viewer/admin human roles. Removing this
    // fixture's enrollment is the supported human non-owner boundary.
    await gov.query(
      'UPDATE ct.identities SET active=false,version=version+1 WHERE tenant=$1 AND id=$2',
      ['a', prefix + '-owner-a'],
    );
    try {
      for (const request of requests)
        await assert.rejects(
          commands.execute(owner, request),
          /identity denied/,
        );
    } finally {
      await gov.query(
        'UPDATE ct.identities SET active=true,version=version+1 WHERE tenant=$1 AND id=$2',
        ['a', prefix + '-owner-a'],
      );
    }
    const wrongFence = new ConsoleCommands(
      writeDb,
      f.authority,
      f.product,
      'not-the-active-fence',
      'LOCAL_FIXTURE',
    );
    const staged = new ConsoleCommands(
      writeDb,
      f.authority,
      f.product,
      fence,
      'STAGING',
    );
    for (const request of requests) {
      await assert.rejects(
        wrongFence.execute(owner, request),
        /recovery fence/,
      );
      await assert.rejects(
        staged.execute(owner, request),
        /qualification pending/,
      );
      assert.deepEqual(await commandRows(request.idempotency_key), []);
    }
    await assert.rejects(
      commands.lookup(await f.actor('machine'), requests[0].idempotency_key),
      /human only/,
    );
    assert.equal(await projectRow(requests[0].target), undefined);
    assert.equal(await coordinationRow(task), undefined);
    assert.equal(f.provider.sends, 0);
  });

  test('link compares the current coordination revision, not the task version', async () => {
    const first = await createProject('cas-first');
    const second = await createProject('cas-second');
    const task = await createTask('cas-task', 'a', true);
    const owner = await f.actor('user');
    const original = await coordinationRow(task);
    assert.equal(Number(original.revision), 1);
    assert.equal(original.project, null);
    const stale = command(
      'link_task_project',
      task,
      { project: first },
      0,
      id('cas-stale'),
    );
    assert.equal((await commands.execute(owner, stale)).status, 'DENIED');
    assert.deepEqual(await coordinationRow(task), original);
    const current = command(
      'link_task_project',
      task,
      { project: first },
      1,
      id('cas-current'),
    );
    applied(await commands.execute(owner, current), 2);
    const linked = await coordinationRow(task);
    assert.equal(linked.project, first);
    assert.equal(linked.accountable_vera, original.accountable_vera);
    const staleAgain = command(
      'link_task_project',
      task,
      { project: second },
      1,
      id('cas-stale-again'),
    );
    assert.equal((await commands.execute(owner, staleAgain)).status, 'DENIED');
    const unsafe = command(
      'link_task_project',
      task,
      { project: second },
      Number.MAX_SAFE_INTEGER + 1,
      id('cas-unsafe'),
    );
    assert.equal((await commands.execute(owner, unsafe)).status, 'DENIED');
    assert.deepEqual(await coordinationRow(task), linked);
    assert.deepEqual(await events('TASK_PROJECT_LINKED', 'task', task), [
      { task, project: first },
    ]);
    assert.equal(f.provider.sends, 0);
  });

  test('revision exhaustion denies before mutation in commands and the coordination seam', async () => {
    const first = await createProject('revision-first');
    const second = await createProject('revision-second');
    const task = await createTask('revision-task');
    const owner = await f.actor('user');
    await coordination.link(owner, task, first, 0);
    await gov.query(
      'UPDATE ct.work_coordination SET revision=$3 WHERE tenant=$1 AND task=$2',
      ['a', task, Number.MAX_SAFE_INTEGER],
    );
    const original = await coordinationRow(task);
    const history = await events('TASK_PROJECT_LINKED', 'task', task);
    const exhausted = command(
      'link_task_project',
      task,
      { project: second },
      Number.MAX_SAFE_INTEGER,
      id('revision-exhausted'),
    );
    assert.equal((await commands.execute(owner, exhausted)).status, 'DENIED');
    for (const expected of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      NaN,
    ])
      await assert.rejects(
        coordination.link(owner, task, second, expected),
        /coordination version/,
      );
    assert.deepEqual(await coordinationRow(task), original);
    assert.deepEqual(
      await events('TASK_PROJECT_LINKED', 'task', task),
      history,
    );
    await gov.query(
      'UPDATE ct.work_coordination SET revision=$3 WHERE tenant=$1 AND task=$2',
      ['a', task, Number.MAX_SAFE_INTEGER - 1],
    );
    const lastSafe = command(
      'link_task_project',
      task,
      { project: second },
      Number.MAX_SAFE_INTEGER - 1,
      id('revision-last-safe'),
    );
    applied(await commands.execute(owner, lastSafe), Number.MAX_SAFE_INTEGER);
    const final = await coordinationRow(task);
    assert.equal(final.project, second);
    assert.equal(Number(final.revision), Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isSafeInteger(Number(final.revision)));
    assert.equal(f.provider.sends, 0);
  });

  test('project name and objective searches share the enrolled-tenant collection', async () => {
    const target = id('search-stable-id');
    const name = 'Nimbus ' + prefix;
    const objective = 'Synthesis ' + prefix;
    const bName = 'Cypress ' + prefix;
    const ownerA = await f.actor('user', 'a');
    const ownerB = await f.actor('user', 'b');
    applied(
      await commands.execute(
        ownerA,
        command('create_project', target, { name, objective }),
      ),
      1,
    );
    applied(
      await commands.execute(
        ownerB,
        command('create_project', target, {
          name: bName,
          objective: 'Other tenant only',
        }),
      ),
      1,
    );
    const readDb = pool('ct_console_reader');
    try {
      const reads = new ConsoleReads(
        readDb,
        new CursorCodec(randomBytes(32)),
        'LOCAL_FIXTURE',
        'project-search-regression',
        fence,
      );
      for (const query of [name, objective]) {
        const view = await reads.read(ownerA, 'projects', { q: query });
        assert.deepEqual(
          view.items.map((item) => item.id),
          [target],
        );
        assert.equal(view.items[0].title, name);
        assert.equal(view.total, 1);
        assert.equal(
          (await reads.read(ownerB, 'projects', { q: query })).total,
          0,
        );
      }
      const bView = await reads.read(ownerB, 'projects', { q: bName });
      assert.deepEqual(
        bView.items.map((item) => item.id),
        [target],
      );
      assert.equal(bView.total, 1);
      assert.equal(
        (await reads.read(ownerA, 'projects', { q: bName })).total,
        0,
      );
      assert.equal(f.provider.sends, 0);
    } finally {
      await readDb.end();
    }
  });

  test('project commands never change task/effect/approval/grant/assignment truth or send', async () => {
    const { x } = await f.intent(id('immutable-operation'), true);
    const owner = await f.actor('user');
    const beforeRows = await effectRows(x.task, x.id);
    for (const table of ['operations', 'grants', 'approvals', 'assignments'])
      assert.equal(beforeRows[table].length, 1);
    assert.ok(
      beforeRows.tasks.some((row) => (row as { id: string }).id === x.task),
    );
    const project = await createProject('immutable-project');
    assert.deepEqual(await effectRows(x.task, x.id), beforeRows);
    const beforeProject = await projectRow(project);
    const request = command('link_task_project', x.task, { project });
    const result = await commands.execute(owner, request);
    applied(result, 1);
    const row = await coordinationRow(x.task);
    assert.equal(row.project, project);
    assert.equal(row.accountable_vera, f.principal);
    assert.equal(Number(row.revision), 1);
    assert.deepEqual(await effectRows(x.task, x.id), beforeRows);
    assert.deepEqual(await projectRow(project), beforeProject);
    assert.deepEqual(await events('TASK_PROJECT_LINKED', 'task', x.task), [
      { task: x.task, project },
    ]);
    assert.equal(f.provider.sends, 0);
    assert.deepEqual(f.provider.rows, []);
  });
});
