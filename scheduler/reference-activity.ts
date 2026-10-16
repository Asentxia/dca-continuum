import { callController } from '../src/controller-client.js';
import {
  validateReferenceJob,
  type ReferenceJob,
} from './reference-contracts.js';
export interface OperationCapabilitySource {
  forOperation(operation: string): Promise<string>;
}
export function referenceActivity(
  source: OperationCapabilitySource,
  trustedControllerSocket: string,
) {
  return async (job: ReferenceJob, index: number) => {
    validateReferenceJob(job);
    if (!Number.isInteger(index) || index < 0 || index >= job.operations.length)
      throw Error('operation index');
    const operation = job.operations[index];
    let token: string;
    try {
      token = await source.forOperation(operation);
    } catch {
      return 'NO_CURRENT_AUTHORITY';
    }
    let o = await callController(trustedControllerSocket, token, operation);
    if (['RESERVED', 'SENDING', 'UNKNOWN'].includes(o.state)) {
      // Observation-only retry at the SAME identity. Never route around an UNKNOWN outcome.
      try {
        token = await source.forOperation(operation);
      } catch {
        return o.state;
      }
      o = await callController(
        trustedControllerSocket,
        token,
        operation,
        '/reconcile',
      );
    }
    return o.state;
  };
}

import type { HttpsControllerClient } from '../src/controller-https.js';
export function remoteReferenceActivity(
  source: OperationCapabilitySource,
  controller: HttpsControllerClient,
) {
  return async (job: ReferenceJob, index: number) => {
    validateReferenceJob(job);
    if (!Number.isInteger(index) || index < 0 || index >= job.operations.length)
      throw Error('operation index');
    const op = job.operations[index];
    let token: string;
    try {
      token = await source.forOperation(op);
    } catch {
      return 'NO_CURRENT_AUTHORITY';
    }
    let outcome = await controller.call(token, op);
    if (['RESERVED', 'SENDING', 'UNKNOWN'].includes(outcome.state)) {
      try {
        token = await source.forOperation(op);
      } catch {
        return outcome.state;
      }
      outcome = await controller.call(token, op, '/reconcile');
    }
    return outcome.state;
  };
}
