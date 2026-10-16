import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  sleep,
  condition,
} from '@temporalio/workflow';
import {
  validateReferenceJob,
  type ReferenceJob,
  type ReferenceProgress,
} from './reference-contracts.js';
const { safeEffect } = proxyActivities<{
  safeEffect(job: ReferenceJob, index: number): Promise<string>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '500 milliseconds',
    maximumInterval: '5 seconds',
  },
});
export const referenceProgress =
  defineQuery<ReferenceProgress>('referenceProgress');
export const referenceContinue = defineSignal('referenceContinue');
export async function referenceV1(job: ReferenceJob) {
  validateReferenceJob(job);
  if (job.schemaVersion !== 1) throw Error('v1 schema');
  let proceed = false;
  const p: ReferenceProgress = {
    phase: 'BEFORE_WAIT',
    schemaVersion: 1,
    done: [],
  };
  setHandler(referenceProgress, () => p);
  setHandler(referenceContinue, () => {
    proceed = true;
  });
  for (let i = 0; i < 5; i++) {
    if ((await safeEffect(job, i)) !== 'COMMITTED') {
      p.phase = 'BLOCKED';
      return p;
    }
    p.done.push(i);
  }
  const branch = await Promise.all([5, 6].map((i) => safeEffect(job, i)));
  branch.forEach((s, k) => {
    if (s === 'COMMITTED') p.done.push(k + 5);
  });
  if (branch.some((s) => s !== 'COMMITTED')) {
    p.phase = 'BLOCKED';
    return p;
  }
  p.phase = 'WAITING';
  await sleep(job.waitMs);
  await condition(() => proceed);
  for (let i = 7; i < 10; i++) {
    if ((await safeEffect(job, i)) !== 'COMMITTED') {
      p.phase = 'BLOCKED';
      return p;
    }
    p.done.push(i);
  }
  p.phase = 'DONE';
  return p;
}
// Explicit incompatible NEW workload; v1 code retained unchanged for old histories.
export async function referenceV2(job: ReferenceJob) {
  validateReferenceJob(job);
  if (job.schemaVersion !== 2) throw Error('v2 schema');
  const p: ReferenceProgress = {
    phase: 'BEFORE_WAIT',
    schemaVersion: 2,
    done: [],
  };
  setHandler(referenceProgress, () => p);
  for (const group of [
    [0, 2, 4, 6, 8],
    [1, 3, 5, 7, 9],
  ]) {
    const states = await Promise.all(group.map((i) => safeEffect(job, i)));
    states.forEach((s, k) => {
      if (s === 'COMMITTED') p.done.push(group[k]);
    });
    if (states.some((s) => s !== 'COMMITTED')) {
      p.phase = 'BLOCKED';
      return p;
    }
  }
  p.phase = 'DONE';
  return p;
}
