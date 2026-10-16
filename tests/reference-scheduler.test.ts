import '../internal/fixtures/temporal-logging.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { PgBoss } from 'pg-boss';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';
import { pool } from '../src/db.js';
import { serveController } from '../src/controller-server.js';
import { referenceActivity } from '../scheduler/reference-activity.js';
import { ReferencePgBoss } from '../scheduler/reference-pgboss.js';
import {
  validateReferenceJob,
  type ReferenceJob,
  type ReferenceProgress,
} from '../scheduler/reference-contracts.js';
import {
  eligible,
  schedulerDecision,
  requiredFaults,
  type SchedulerTrial,
} from '../scheduler/qualification-policy.js';
let f: Awaited<ReturnType<typeof fixture>>,
  env: TestWorkflowEnvironment,
  worker: Worker,
  run: Promise<void>,
  ctl: http.Server,
  pgScheduler: ReferencePgBoss;
const db = pool('ct_scheduler'),
  socket = process.cwd() + '/.local/reference-controller.sock';
const issued: { operation: string; expires: number }[] = [];
let firstToken: string | undefined;
let activity: (j: ReferenceJob, i: number) => Promise<string>;
const results: any[] = [];
async function until(fn: () => Promise<boolean>, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Error('scheduler fixture timeout');
}
async function makeJob(id: string, version: 1 | 2 = 1) {
  const operations = [];
  for (let i = 0; i < 10; i++) {
    const o = await f.intent(id + '-' + i, true);
    operations.push(o.x.id);
  }
  return {
    id,
    schemaVersion: version,
    operations,
    waitMs: 5500,
  } as ReferenceJob;
}
async function startTemporal() {
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'reference-tests',
    workflowsPath: fileURLToPath(
      new URL('../scheduler/reference-workflows.js', import.meta.url),
    ),
    activities: { safeEffect: activity },
  });
  run = worker.run();
  run.catch(() => {});
}
async function startPG() {
  const boss = new PgBoss({
    host: '127.0.0.1',
    port: 55432,
    user: 'ct_scheduler',
    database: 'ct_test',
    schema: 'pgboss_reference',
    monitorIntervalSeconds: 5,
  });
  boss.on('error', () => {});
  pgScheduler = new ReferencePgBoss(db, boss, activity, 'ct-reference-tests');
  await pgScheduler.start();
}
async function effectCount(j: ReferenceJob) {
  return f.provider.rows.filter((x) => j.operations.includes(x.operation))
    .length;
}
before(async () => {
  f = await fixture('reference');
  ctl = await serveController(socket, f.caps, f.controller);
  activity = referenceActivity(
    {
      forOperation: async (operation) => {
        const token = await f.token('machine', 'a', {
          exp: Math.floor(Date.now() / 1000) + 5,
        });
        const actor = await f.machine.verify(token);
        const cap = await f.authority.renew(actor, operation);
        issued.push({ operation, expires: cap.expires });
        firstToken ??= cap.token;
        return cap.token;
      },
    },
    socket,
  );
  await fs.mkdir('.local/temporal-bin', { recursive: true });
  env = await TestWorkflowEnvironment.createLocal({
    server: {
      dbFilename:
        process.env.CT_REFERENCE_DB_FILE ??
        process.cwd() + '/.local/reference-temporal.sqlite',
      executable: {
        type: 'cached-download',
        downloadDir: process.cwd() + '/.local/temporal-bin',
      },
      log: { format: 'json', level: 'error' },
    },
  });
  await startTemporal();
  await startPG();
});
after(async () => {
  if (worker) {
    worker.shutdown();
    await run.catch(() => {});
  }
  if (pgScheduler) await pgScheduler.stop();
  if (env) await env.teardown();
  if (ctl) await new Promise<void>((r) => ctl.close(() => r()));
  if (f) await f.close();
  await Promise.all([admin.end(), gov.end(), db.end()]);
  await fs.writeFile(
    '.artifacts/implementation/REFERENCE-SCHEDULERS.json',
    JSON.stringify(
      {
        scope:
          'actual local Temporal and pg-boss; local test issuer/provider; 5.5 seconds, NOT 24 hours',
        results,
        issuedCapabilityCount: issued.length,
        historyTokensStored: false,
        liveTrial: 'NOT RUN',
        nativeVersionPinning: 'NOT RUN',
        schedulerDecision: 'HELD',
      },
      null,
      2,
    ),
  );
  firstToken = undefined;
});
test('Reference scheduler refuses credential/transport fields and malformed operation references', async () => {
  const j = {
    id: 'strict-job',
    schemaVersion: 1,
    operations: Array.from({ length: 10 }, (_, i) => 'strict-' + i),
    waitMs: 1,
  } as ReferenceJob;
  validateReferenceJob(j);
  for (const extra of [
    { capability: 'fixture-no-value' },
    { socket: '/tmp/arbitrary' },
    { tenant: 'b' },
    { url: 'https://bad.invalid' },
  ])
    assert.throws(() => validateReferenceJob({ ...j, ...extra }));
  assert.throws(() =>
    validateReferenceJob({
      ...j,
      operations: ['duplicate', ...Array(9).fill('duplicate')],
    }),
  );
});
test('Reference Temporal resumes retained v1 with fresh short-lived authority, no secrets in history', async () => {
  const j = await makeJob('ref-temporal-full'),
    h = await env.client.workflow.start('referenceV1', {
      workflowId: j.id,
      taskQueue: 'reference-tests',
      args: [j],
    });
  await until(
    async () =>
      (await h.query<ReferenceProgress>('referenceProgress')).phase ===
      'WAITING',
  );
  worker.shutdown();
  await run;
  await startTemporal();
  await h.signal('referenceContinue');
  const p = await h.result();
  assert.equal(p.phase, 'DONE');
  assert.equal(await effectCount(j), 10);
  assert.ok(
    issued.find((x) => x.operation === j.operations[0])!.expires < Date.now(),
  );
  await assert.rejects(f.caps.verify(firstToken!));
  const history = await h.fetchHistory();
  const raw = JSON.stringify(history);
  for (const forbidden of [
    'capability',
    'authorization',
    'controller.sock',
    'providerSecret',
  ])
    assert.ok(!raw.includes(forbidden));
  await Worker.runReplayHistory(
    {
      workflowsPath: fileURLToPath(
        new URL('../scheduler/reference-workflows.js', import.meta.url),
      ),
    },
    history,
    j.id,
  );
  await fs.writeFile(
    '.artifacts/implementation/TEMPORAL-REFERENCE-HISTORY.json',
    raw,
  );
  results.push({
    engine: 'temporal',
    case: 'retained-v1 restart/expired prior capability/fresh renewal',
    status: 'PASS',
    effects: 10,
    realWaitMs: j.waitMs,
    nativePinning: 'NOT RUN',
  });
});
test('Reference Temporal revoked post-wait authority blocks partial job after seven effects', async () => {
  const j = await makeJob('ref-temporal-revoked'),
    h = await env.client.workflow.start('referenceV1', {
      workflowId: j.id,
      taskQueue: 'reference-tests',
      args: [j],
    });
  await until(
    async () =>
      (await h.query<ReferenceProgress>('referenceProgress')).phase ===
      'WAITING',
  );
  await f.authority.revoke(await f.actor('user'), 'g-' + j.operations[7]);
  await h.signal('referenceContinue');
  assert.equal((await h.result()).phase, 'BLOCKED');
  assert.equal(await effectCount(j), 7);
  results.push({
    engine: 'temporal',
    case: 'revoked-on-resume',
    status: 'PASS',
    effects: 7,
  });
});
test('Reference pg-boss survives worker restart with durable wait and fresh authority', async () => {
  const j = await makeJob('ref-pgboss-full');
  await pgScheduler.enqueue(j);
  await until(async () => (await pgScheduler.status(j.id)).phase === 'WAITING');
  await pgScheduler.stop();
  await startPG();
  await pgScheduler.signal(j.id);
  await until(async () => (await pgScheduler.status(j.id)).phase === 'DONE');
  assert.equal(await effectCount(j), 10);
  const row = (await db.query('SELECT input FROM ctq.jobs WHERE id=$1', [j.id]))
    .rows[0];
  assert.deepEqual(row.input, j);
  assert.ok(
    issued.find((x) => x.operation === j.operations[0])!.expires < Date.now(),
  );
  results.push({
    engine: 'pg-boss',
    case: 'restart/durable timer/fresh renewal',
    status: 'PASS',
    effects: 10,
    realWaitMs: j.waitMs,
  });
});
test('Reference pg-boss revoked resume blocks after seven effects, no false job completion', async () => {
  const j = await makeJob('ref-pgboss-revoked');
  await pgScheduler.enqueue(j);
  await until(async () => (await pgScheduler.status(j.id)).phase === 'WAITING');
  await f.authority.revoke(await f.actor('user'), 'g-' + j.operations[7]);
  await pgScheduler.signal(j.id);
  await until(async () => (await pgScheduler.status(j.id)).phase === 'BLOCKED');
  assert.equal(await effectCount(j), 7);
  results.push({
    engine: 'pg-boss',
    case: 'revoked-on-resume',
    status: 'PASS',
    effects: 7,
  });
});
test('Reference incompatible NEW v2 executes while retained v1 remains replayable on both engines', async () => {
  const t = await makeJob('ref-temporal-v2', 2),
    h = await env.client.workflow.start('referenceV2', {
      workflowId: t.id,
      taskQueue: 'reference-tests',
      args: [t],
    });
  assert.equal((await h.result()).phase, 'DONE');
  assert.equal(await effectCount(t), 10);
  const q = await makeJob('ref-pgboss-v2', 2);
  await pgScheduler.enqueue(q);
  await until(async () => (await pgScheduler.status(q.id)).phase === 'DONE');
  assert.equal(await effectCount(q), 10);
  await assert.rejects(pgScheduler.enqueue({ ...q, waitMs: 100 }));
  results.push({
    engine: 'both',
    case: 'explicit v2 with v1 retained',
    status: 'PASS',
    nativeDeployment: 'NOT RUN',
  });
});
test('Reference scheduler release evaluator rejects virtual, short, fixture or missing live evidence', () => {
  const trial: SchedulerTrial = {
    engine: 'temporal',
    environment: 'fixture',
    clock: 'real',
    waitMs: 86400000,
    elapsedMs: 86400000,
    identityLive: true,
    providerLive: true,
    isolationPassed: true,
    drPassed: true,
    faults: Object.fromEntries(requiredFaults.map((x) => [x, 'PASS'])) as any,
    metrics: {
      engineeringHours: 1,
      maintenanceHours: 1,
      recoveryToilMinutes: 1,
      infrastructureCost: 1,
      p95Ms: 1,
    },
  };
  assert.equal(eligible(trial), false);
  assert.equal(
    eligible({
      ...trial,
      environment: 'approved-staging',
      clock: 'accelerated',
    }),
    false,
  );
  assert.equal(
    eligible({ ...trial, environment: 'approved-staging', waitMs: 5500 }),
    false,
  );
  assert.equal(
    eligible({ ...trial, environment: 'approved-staging', metrics: {} }),
    false,
  );
  assert.equal(
    schedulerDecision([trial, { ...trial, engine: 'pg-boss' }]).decision,
    'HELD',
  );
  assert.equal(
    schedulerDecision([trial, { ...trial, engine: 'pg-boss' }])
      .eligibleForMeasuredReview,
    false,
  );
});
