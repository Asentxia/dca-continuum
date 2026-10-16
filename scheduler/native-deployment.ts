import type { WorkerDeploymentOptions } from '@temporalio/worker';
import type { VersioningOverride } from '@temporalio/common';
export function pinnedWorkerDeployment(
  deploymentName: string,
  buildId: string,
): WorkerDeploymentOptions {
  return {
    version: { deploymentName, buildId },
    useWorkerVersioning: true,
    defaultVersioningBehavior: 'PINNED',
  };
}
export function pinnedWorkflowVersion(
  deploymentName: string,
  buildId: string,
): VersioningOverride {
  return { pinnedTo: { deploymentName, buildId } };
}
// Type-checked staging harness options only. Native deployment/pinning still NOT RUN.
