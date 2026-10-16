import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  sleep,
  condition,
} from '@temporalio/workflow';
import type { Job, Progress } from './contracts.js';
import type * as activity from './effect-activity.js';
const { effect } = proxyActivities<typeof activity>({
  startToCloseTimeout: '10 seconds',
  retry: {
    maximumAttempts: 6,
    initialInterval: '500 milliseconds',
    maximumInterval: '2 seconds',
  },
});
export const progressQuery = defineQuery<Progress>('progress');
export const approveSignal = defineSignal('gateApproved');
export async function continuumJobV1(job: Job) {
  if (job.schemaVersion !== 1) throw Error('unsupported schema');
  let approved = false;
  const p: Progress = { phase: 'BEFORE_WAIT', schemaVersion: 1, done: [] };
  setHandler(progressQuery, () => p);
  setHandler(approveSignal, () => {
    approved = true;
  });
  for (let i = 0; i < 5; i++) {
    if ((await effect(job, i)) !== 'COMMITTED') {
      p.phase = 'BLOCKED';
      return p;
    }
    p.done.push(i);
  }
  const branch = await Promise.all([5, 6].map((i) => effect(job, i)));
  for (let n = 0; n < 2; n++) if (branch[n] === 'COMMITTED') p.done.push(n + 5);
  if (branch.some((x) => x !== 'COMMITTED')) {
    p.phase = 'BLOCKED';
    return p;
  }
  p.phase = 'WAITING';
  await sleep(job.waitMs);
  await condition(() => approved);
  for (let i = 7; i < 10; i++) {
    if ((await effect(job, i)) !== 'COMMITTED') {
      p.phase = 'BLOCKED';
      return p;
    }
    p.done.push(i);
  }
  p.phase = 'DONE';
  return p;
}
