import {
  RenewingCapabilityClient,
  type IdentityTokenSource,
} from './capability-renewal.js';
import { callController } from './controller-client.js';
export interface ScopedJobReference {
  id: string;
  operations: string[];
}
// Production worker integration seam: only references in workflow/job history, no capability/provider key.
export function createRenewingEffectActivity(
  authorityEndpoint: string,
  controllerSocket: string,
  identity: IdentityTokenSource,
) {
  const renewal = new RenewingCapabilityClient(authorityEndpoint, identity);
  return async (job: ScopedJobReference, index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= job.operations.length)
      throw Error('invalid operation index');
    const operation = job.operations[index];
    let cap = await renewal.forOperation(operation);
    let o = await callController(controllerSocket, cap, operation);
    for (
      let n = 0;
      n < 12 && ['RESERVED', 'SENDING', 'UNKNOWN'].includes(o.state);
      n++
    ) {
      await new Promise((r) => setTimeout(r, 100));
      cap = await renewal.forOperation(operation);
      o = await callController(controllerSocket, cap, operation, '/reconcile');
      if (o.state === 'UNKNOWN') break;
    }
    return o.state;
  };
}
