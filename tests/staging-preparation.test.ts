import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3FenceStore } from '../src/s3-fence-store.js';
import { sha } from '../src/db.js';
import { assertExternalFence } from '../src/fence-store.js';
import {
  qualifyScheduler,
  type TrialEngine,
  type TrialBoundary,
} from '../scheduler/qualification-harness.js';
import { eligible, REAL_WAIT_MS } from '../scheduler/qualification-policy.js';
import {
  pinnedWorkerDeployment,
  pinnedWorkflowVersion,
} from '../scheduler/native-deployment.js';
const config = {
  enabled: true,
  approvalReference: 'fixture-only',
  region: 'us-east-1',
  bucket: 'fixture-independent-bucket',
  kmsKeyRef: 'fixture-kms-ref',
};
test('Cloud fence disabled before any credential access', async () => {
  let reads = 0;
  const s = new S3FenceStore({ ...config, enabled: false }, async () => {
    reads++;
    throw Error('not available');
  });
  await assert.rejects(s.read());
  assert.equal(reads, 0);
});
test('Cloud fence conditional ETag update, journal/approval binding, no live request', async () => {
  let state = {
      revision: 1,
      fence: 'before',
      blocked: false,
      authorityDigest: sha('[]'),
    },
    etag = 'one';
  const commands: any[] = [];
  const s = new S3FenceStore(
    config,
    async () => {
      throw Error('mock cannot access credentials');
    },
    async (c) => {
      commands.push(c.input);
      if (c.constructor.name === 'GetObjectCommand')
        return {
          ETag: etag,
          Body: {
            transformToByteArray: async () =>
              Buffer.from(JSON.stringify(state)),
          },
        };
      if (c.input.IfMatch !== etag) throw Error('fixture conditional conflict');
      state = JSON.parse(c.input.Body);
      etag = String(state.revision);
      return { ETag: etag };
    },
  );
  const next = await s.advance(1, sha('journal'));
  assert.equal(next.blocked, true);
  await assert.rejects(assertExternalFence(s, 'before'));
  await s.activate(next.revision, sha('approved manifest'));
  await assertExternalFence(s, next.fence);
  const puts = commands.filter((x) => x.IfMatch);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].ServerSideEncryption, 'aws:kms');
  assert.equal(puts[0].IfMatch, 'one');
});
test('Cloud fence CAS conflict is fail closed, never an unconditional overwrite', async () => {
  const s = new S3FenceStore(
    config,
    async () => {
      throw Error('fixture');
    },
    async (c) => {
      if (c.constructor.name === 'GetObjectCommand')
        return {
          ETag: 'old',
          Body: {
            transformToByteArray: async () =>
              Buffer.from(
                JSON.stringify({
                  revision: 1,
                  fence: 'before',
                  blocked: false,
                  authorityDigest: sha('[]'),
                }),
              ),
          },
        };
      assert.equal(c.input.IfMatch, 'old');
      throw Error('fixture concurrent conditional write');
    },
  );
  await assert.rejects(s.advance(1, sha('journal')));
  await assert.rejects(s.advance(9, sha('journal')));
});
test('Scheduler stage harness refuses deferred identity or accelerated/short trial', async () => {
  let calls = 0;
  const engine: TrialEngine = {
    name: 'temporal',
    start: async () => {
      calls++;
    },
    waitUntilWaiting: async () => {},
    resumeAfterIndependentApprovals: async () => {},
    waitForOutcome: async () => {},
    collect: async () => ({ faults: {}, metrics: {} }),
  };
  const b: TrialBoundary = {
    approvedStagingReference: '',
    P1: false,
    P2: false,
    P3: false,
    P4: false,
    clock: 'real',
    now: () => Date.now(),
    fault: async () => {},
    record: async () => {},
  };
  const job = {
    id: 'trial',
    schemaVersion: 1 as const,
    operations: Array.from({ length: 10 }, (_, i) => 'trial-' + i),
    waitMs: REAL_WAIT_MS,
  };
  await assert.rejects(qualifyScheduler(engine, b, job));
  await assert.rejects(
    qualifyScheduler(
      engine,
      {
        ...b,
        approvedStagingReference: 'fixture',
        P1: true,
        P2: true,
        P3: true,
        P4: true,
        clock: 'accelerated',
      },
      job,
    ),
  );
  assert.equal(calls, 0);
});
test('Scheduler fixture callbacks cannot fake 24-hour eligibility with short wall time', async () => {
  const trace: string[] = [],
    engine: TrialEngine = {
      name: 'pg-boss',
      start: async () => {
        trace.push('start');
      },
      waitUntilWaiting: async () => {
        trace.push('waiting');
      },
      resumeAfterIndependentApprovals: async () => {
        trace.push('independent-approvals');
      },
      waitForOutcome: async () => {},
      collect: async () => ({ faults: {}, metrics: {} }),
    },
    b: TrialBoundary = {
      approvedStagingReference: 'fixture-interface-test-not-live',
      P1: true,
      P2: true,
      P3: true,
      P4: true,
      clock: 'real',
      now: () => 1000,
      fault: async (n) => {
        trace.push(n);
      },
      record: async () => {},
    };
  const r = await qualifyScheduler(engine, b, {
    id: 'trial-interface',
    schemaVersion: 1,
    operations: Array.from({ length: 10 }, (_, i) => 'interface-' + i),
    waitMs: REAL_WAIT_MS,
  });
  assert.equal(r.elapsedMs, 0);
  assert.equal(eligible(r), false);
  assert.ok(trace.includes('host-loss'));
  assert.ok(trace.includes('independent-approvals'));
});
test('Native version helpers use current pinned SDK types, not deprecated build-id routing', () => {
  const o = pinnedWorkerDeployment('continuum-qualification', 'v1');
  assert.equal(o.defaultVersioningBehavior, 'PINNED');
  assert.equal(o.useWorkerVersioning, true);
  assert.deepEqual(pinnedWorkflowVersion('continuum-qualification', 'v1'), {
    pinnedTo: { deploymentName: 'continuum-qualification', buildId: 'v1' },
  });
});
