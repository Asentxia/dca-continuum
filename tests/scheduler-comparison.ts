import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { pool, tx, sha } from '../src/db.js';
import {
  admin,
  gov,
  bootstrap,
  makeOp,
  revoke,
  count,
  fence,
} from './helpers.js';
import { secrets, config, start, stop, capability } from './process-helpers.js';
import { callController } from '../src/controller-client.js';
import type { Job, Progress } from './fixtures/legacy-scheduler/contracts.js';
const db = pool('ct_scheduler');
const socket = process.cwd() + '/.local/m4-controller.sock';
let provider: ChildProcess | undefined,
  controller: ChildProcess | undefined,
  w: ChildProcess | undefined,
  env: TestWorkflowEnvironment | undefined;
const results: any[] = [];
let seq = 0;
async function job(engine: string, label: string, version: 1 | 2 = 1) {
  const id = 'm4-' + engine + '-' + label + '-' + ++seq,
    operations = [];
  for (let n = 0; n < 10; n++) {
    const op = id + '-step-' + n;
    await makeOp(op);
    operations.push(op);
  }
  return {
    id,
    schemaVersion: version,
    operations,
    socket,
    capability: capability(operations),
    waitMs: 1200,
  } satisfies Job;
}
async function until(fn: () => Promise<boolean>, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('wait timeout');
}
async function verify(j: Job, blocked = false) {
  const total = (await Promise.all(j.operations.map(count))).reduce(
    (a, b) => a + b,
    0,
  );
  assert.equal(total, blocked ? 7 : 10);
  for (const id of j.operations) assert.ok((await count(id)) <= 1);
  return total;
}
function restartDb() {
  let r = spawnSync(
    'pg_ctl',
    ['-D', '.local/pgdata', 'stop', '-m', 'immediate'],
    { encoding: 'utf8' },
  );
  fs.appendFileSync(
    '.artifacts/core/M4-database-restart.log',
    r.stdout + r.stderr,
  );
  assert.equal(r.status, 0);
}
function startDb() {
  const r = spawnSync('bash', ['tools/local-db.sh'], { encoding: 'utf8' });
  fs.appendFileSync(
    '.artifacts/core/M4-database-restart.log',
    r.stdout + r.stderr,
  );
  assert.equal(r.status, 0);
}
try {
  await bootstrap();
  config('.local/m4-provider.json', {});
  provider = await start(
    'dist/tests/provider-emulator.js',
    '.local/m4-provider.json',
    'M4-provider',
  );
  config('.local/m4-controller.json', { socket, leaseMs: 300 });
  controller = await start(
    'dist/tests/controller-process.js',
    '.local/m4-controller.json',
    'M4-controller',
  );
  env = await TestWorkflowEnvironment.createLocal({
    server: {
      dbFilename: process.cwd() + '/.local/temporal-dev.sqlite',
      executable: {
        type: 'cached-download',
        downloadDir: process.cwd() + '/.local/temporal-bin',
      },
      log: { format: 'json', level: 'error' },
    },
  });
  const queue = 'continuum-m4';
  async function tw(version: number, killAfterEffectId?: string) {
    config('.local/temporal-worker.json', {
      address: env!.address,
      queue,
      version,
      killAfterEffectId,
    });
    return start(
      'dist/tests/fixtures/legacy-scheduler/temporal-worker.js',
      '.local/temporal-worker.json',
      'M4-temporal-worker-v' + version,
    );
  }
  w = await tw(1);
  for (const label of [
    'worker-upgrade',
    'partial-revocation',
    'database-outage',
  ]) {
    const j = await job('temporal', label),
      t = performance.now();
    const h = await env.client.workflow.start('continuumJobV1', {
      taskQueue: queue,
      workflowId: j.id,
      args: [j],
    });
    await until(
      async () => (await h.query<Progress>('progress')).phase === 'WAITING',
    );
    if (label === 'worker-upgrade') {
      await stop(w);
      w = await tw(2);
    }
    if (label === 'partial-revocation')
      await revoke({ tenant: 'a', grant_id: 'g-' + j.operations[7] });
    if (label === 'database-outage') {
      restartDb();
      await assert.rejects(
        callController(socket, j.capability, j.operations[7]),
      );
      startDb();
    }
    await h.signal('gateApproved');
    const outcome = (await h.result()) as Progress;
    assert.equal(
      outcome.phase,
      label === 'partial-revocation' ? 'BLOCKED' : 'DONE',
    );
    const effects = await verify(j, label === 'partial-revocation');
    const history = await h.fetchHistory();
    if (label === 'worker-upgrade') {
      await Worker.runReplayHistory(
        {
          workflowsPath:
            process.cwd() +
            '/dist/tests/fixtures/legacy-scheduler/temporal-v2.js',
        },
        history,
      );
      fs.writeFileSync('.local/history-v1.json', JSON.stringify(history), {
        mode: 0o600,
      });
    }
    results.push({
      engine: 'Temporal',
      test: label,
      passed: true,
      effects,
      phase: outcome.phase,
      elapsedMs: Math.round(performance.now() - t),
      historyEvents: history.events?.length ?? 0,
      historyHash: sha(JSON.stringify(history)),
      scope:
        'local dev service; v1 retained in v2 bundle, not native deployment pinning',
    });
  }
  const tk = await job('temporal', 'worker-kill-after-effect');
  await stop(w);
  w = await tw(2, tk.id);
  const kh = await env.client.workflow.start('continuumJobV1', {
    taskQueue: queue,
    workflowId: tk.id,
    args: [tk],
  });
  await until(async () => w!.signalCode === 'SIGKILL');
  w = await tw(2);
  await until(
    async () => (await kh.query<Progress>('progress')).phase === 'WAITING',
  );
  await kh.signal('gateApproved');
  assert.equal((await kh.result()).phase, 'DONE');
  results.push({
    engine: 'Temporal',
    test: 'worker-kill-after-effect-before-ack',
    passed: true,
    effects: await verify(tk),
  });
  const j2 = await job('temporal', 'new-v2', 2);
  const h2 = await env.client.workflow.start('continuumJobV2', {
    taskQueue: queue,
    workflowId: j2.id,
    args: [j2],
  });
  assert.equal((await h2.result()).phase, 'DONE');
  results.push({
    engine: 'Temporal',
    test: 'new-v2',
    passed: true,
    effects: await verify(j2),
  });
  await stop(w);
  w = undefined;
  await env.teardown();
  env = undefined;
  config('.local/pg-worker.json', { version: 1 });
  w = await start(
    'dist/tests/fixtures/legacy-scheduler/pgboss-worker.js',
    '.local/pg-worker.json',
    'M4-pgboss-worker-v1',
  );
  for (const label of [
    'worker-upgrade',
    'partial-revocation',
    'database-outage',
  ]) {
    const j = await job('pgboss', label),
      t = performance.now();
    await tx(db, async (c) => {
      await c.query('INSERT INTO ctq.jobs(id,version,input) VALUES($1,$2,$3)', [
        j.id,
        1,
        j,
      ]);
      await c.query('INSERT INTO ctq.outbox(id,task_id) VALUES($1,$2)', [
        j.id + ':start',
        j.id,
      ]);
    });
    await until(
      async () =>
        (await db.query('SELECT phase FROM ctq.jobs WHERE id=$1', [j.id]))
          .rows[0].phase === 'WAITING',
    );
    if (label === 'worker-upgrade') {
      await stop(w);
      config('.local/pg-worker.json', { version: 2 });
      w = await start(
        'dist/tests/fixtures/legacy-scheduler/pgboss-worker.js',
        '.local/pg-worker.json',
        'M4-pgboss-worker-v2',
      );
    }
    if (label === 'partial-revocation')
      await revoke({ tenant: 'a', grant_id: 'g-' + j.operations[7] });
    if (label === 'database-outage') {
      restartDb();
      await assert.rejects(
        callController(socket, j.capability, j.operations[7]),
      );
      startDb();
    }
    await db.query('UPDATE ctq.jobs SET approved=true WHERE id=$1', [j.id]);
    await until(async () =>
      ['DONE', 'BLOCKED'].includes(
        (await db.query('SELECT phase FROM ctq.jobs WHERE id=$1', [j.id]))
          .rows[0].phase,
      ),
    );
    const row = (
      await db.query('SELECT phase,revision,done FROM ctq.jobs WHERE id=$1', [
        j.id,
      ])
    ).rows[0];
    assert.equal(
      row.phase,
      label === 'partial-revocation' ? 'BLOCKED' : 'DONE',
    );
    results.push({
      engine: 'pg-boss',
      test: label,
      passed: true,
      effects: await verify(j, label === 'partial-revocation'),
      phase: row.phase,
      elapsedMs: Math.round(performance.now() - t),
      revision: row.revision,
      scope: 'explicit two-phase state machine with durable scheduling outbox',
    });
  }
  const pk = await job('pgboss', 'worker-kill-after-effect');
  await stop(w);
  config('.local/pg-worker.json', { version: 2, killAfterEffectId: pk.id });
  w = await start(
    'dist/tests/fixtures/legacy-scheduler/pgboss-worker.js',
    '.local/pg-worker.json',
    'M4-pgboss-fault-worker',
  );
  await tx(db, async (c) => {
    await c.query('INSERT INTO ctq.jobs(id,version,input) VALUES($1,1,$2)', [
      pk.id,
      pk,
    ]);
    await c.query('INSERT INTO ctq.outbox(id,task_id) VALUES($1,$2)', [
      pk.id + ':start',
      pk.id,
    ]);
  });
  await until(async () => w!.signalCode === 'SIGKILL');
  config('.local/pg-worker.json', { version: 2 });
  w = await start(
    'dist/tests/fixtures/legacy-scheduler/pgboss-worker.js',
    '.local/pg-worker.json',
    'M4-pgboss-recovered-worker',
  );
  await db.query('UPDATE ctq.jobs SET approved=true WHERE id=$1', [pk.id]);
  await until(
    async () =>
      (await db.query('SELECT phase FROM ctq.jobs WHERE id=$1', [pk.id]))
        .rows[0].phase === 'DONE',
    70000,
  );
  results.push({
    engine: 'pg-boss',
    test: 'worker-kill-after-effect-before-ack',
    passed: true,
    effects: await verify(pk),
  });
  const p2 = await job('pgboss', 'new-v2', 2);
  await tx(db, async (c) => {
    await c.query('INSERT INTO ctq.jobs(id,version,input) VALUES($1,2,$2)', [
      p2.id,
      p2,
    ]);
    await c.query('INSERT INTO ctq.outbox(id,task_id) VALUES($1,$2)', [
      p2.id + ':start',
      p2.id,
    ]);
  });
  await until(
    async () =>
      (await db.query('SELECT phase FROM ctq.jobs WHERE id=$1', [p2.id]))
        .rows[0].phase === 'DONE',
  );
  results.push({
    engine: 'pg-boss',
    test: 'new-v2',
    passed: true,
    effects: await verify(p2),
  });
  fs.writeFileSync(
    '.artifacts/core/M4-scheduler-results.json',
    JSON.stringify(
      {
        results,
        notTested: [
          'real 24-hour soak',
          'incompatible native Temporal deployment pinning',
          'real provider',
          'full host loss',
          'HA/PITR',
          'production costs/scale',
        ],
        decision:
          'No final production selection from this bounded run. Both viable; unchanged provisional Temporal default pending required workload and operational gates.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  fs.writeFileSync(
    '.artifacts/core/M4-scheduler-failure.json',
    JSON.stringify({ completed: results, error: String(e) }, null, 2),
  );
  throw e;
} finally {
  await stop(w);
  await stop(controller);
  await stop(provider);
  if (env) await env.teardown();
  await Promise.all([admin.end(), gov.end(), db.end()]);
}
