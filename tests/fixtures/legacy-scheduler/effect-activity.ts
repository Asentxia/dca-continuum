import { callController } from '../../../src/controller-client.js';
import type { Job } from './contracts.js';
export async function effect(job: Job, index: number) {
  const id = job.operations[index];
  let o = await callController(job.socket, job.capability, id);
  for (
    let n = 0;
    n < 12 && ['RESERVED', 'SENDING', 'UNKNOWN'].includes(o.state);
    n++
  ) {
    await new Promise((r) => setTimeout(r, 100));
    o = await callController(job.socket, job.capability, id, '/reconcile');
    if (o.state === 'UNKNOWN') break;
  }
  return o.state;
}
