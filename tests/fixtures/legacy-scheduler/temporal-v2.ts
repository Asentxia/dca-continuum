// Retain the v1 implementation for running histories; v2 is a distinct workflow type.
export { continuumJobV1 } from './temporal-v1.js';
import { proxyActivities } from '@temporalio/workflow';
import type { Job } from './contracts.js';
import type * as activity from './effect-activity.js';
const { effect } = proxyActivities<typeof activity>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 6 },
});
export async function continuumJobV2(job: Job) {
  if (job.schemaVersion !== 2) throw Error('unsupported schema');
  const r = await Promise.all(job.operations.map((_, i) => effect(job, i)));
  return {
    phase: r.every((x) => x === 'COMMITTED') ? 'DONE' : 'BLOCKED',
    schemaVersion: 2,
    done: r.flatMap((s, i) => (s === 'COMMITTED' ? [i] : [])),
  };
}
