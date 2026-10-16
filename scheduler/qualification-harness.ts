import {
  REAL_WAIT_MS,
  requiredFaults,
  eligible,
  type SchedulerTrial,
} from './qualification-policy.js';
import {
  validateReferenceJob,
  type ReferenceJob,
} from './reference-contracts.js';
export interface TrialEngine {
  name: 'temporal' | 'pg-boss';
  start(job: ReferenceJob): Promise<void>;
  waitUntilWaiting(id: string): Promise<void>;
  resumeAfterIndependentApprovals(id: string): Promise<void>;
  waitForOutcome(id: string): Promise<void>;
  collect(id: string): Promise<Pick<SchedulerTrial, 'faults' | 'metrics'>>;
}
export interface TrialBoundary {
  approvedStagingReference: string;
  P1: boolean;
  P2: boolean;
  P3: boolean;
  P4: boolean;
  clock: 'real' | 'accelerated';
  now: () => number;
  fault: (name: (typeof requiredFaults)[number], job: string) => Promise<void>;
  record: (event: Record<string, unknown>) => Promise<void>;
}
// Persistent engine state owns the wait. No timer/token is serialized by this coordinator.
// Restart the coordinator using the same job ID; real deployments must bind callbacks to approved stage targets.
export async function qualifyScheduler(
  engine: TrialEngine,
  boundary: TrialBoundary,
  job: ReferenceJob,
) {
  validateReferenceJob(job);
  if (
    !boundary.approvedStagingReference ||
    ![boundary.P1, boundary.P2, boundary.P3, boundary.P4].every(Boolean) ||
    boundary.clock !== 'real' ||
    job.waitMs !== REAL_WAIT_MS
  )
    throw Error('live trial deferred until actual stage prerequisites pass');
  const started = boundary.now();
  await boundary.record({
    event: 'TRIAL_STARTED',
    engine: engine.name,
    job: job.id,
    waitMs: REAL_WAIT_MS,
    scope: 'approved-staging',
  });
  await engine.start(job);
  await engine.waitUntilWaiting(job.id);
  for (const name of requiredFaults) {
    await boundary.fault(name, job.id);
    await boundary.record({
      event: 'FAULT_EXERCISED',
      engine: engine.name,
      job: job.id,
      name,
    });
  }
  await engine.resumeAfterIndependentApprovals(job.id);
  await engine.waitForOutcome(job.id);
  const data = await engine.collect(job.id),
    elapsedMs = boundary.now() - started;
  const trial: SchedulerTrial = {
    engine: engine.name,
    environment: 'approved-staging',
    clock: 'real',
    waitMs: job.waitMs,
    elapsedMs,
    identityLive: boundary.P1,
    providerLive: boundary.P2,
    isolationPassed: boundary.P3,
    drPassed: boundary.P4,
    faults: data.faults,
    metrics: data.metrics,
  };
  await boundary.record({
    event: 'TRIAL_FINISHED',
    engine: engine.name,
    job: job.id,
    elapsedMs,
    eligible: eligible(trial),
  });
  return trial;
}
