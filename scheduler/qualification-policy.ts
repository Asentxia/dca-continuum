export const REAL_WAIT_MS = 86400000;
export const requiredFaults = [
  'worker-kill',
  'host-loss',
  'scheduler-service-loss',
  'database-failover',
  'incompatible-version',
  'branching-partial',
  'revoked-on-resume',
  'unknown-no-resend',
] as const;
export interface SchedulerTrial {
  engine: 'temporal' | 'pg-boss';
  environment: 'fixture' | 'approved-staging';
  clock: 'real' | 'accelerated';
  waitMs: number;
  elapsedMs: number;
  identityLive: boolean;
  providerLive: boolean;
  isolationPassed: boolean;
  drPassed: boolean;
  faults: Record<string, 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT RUN'>;
  metrics: {
    engineeringHours?: number;
    maintenanceHours?: number;
    recoveryToilMinutes?: number;
    infrastructureCost?: number;
    p95Ms?: number;
  };
}
export function eligible(trial: SchedulerTrial) {
  return (
    trial.environment === 'approved-staging' &&
    trial.clock === 'real' &&
    trial.waitMs >= REAL_WAIT_MS &&
    trial.elapsedMs >= REAL_WAIT_MS &&
    trial.identityLive &&
    trial.providerLive &&
    trial.isolationPassed &&
    trial.drPassed &&
    requiredFaults.every((f) => trial.faults[f] === 'PASS') &&
    [
      'engineeringHours',
      'maintenanceHours',
      'recoveryToilMinutes',
      'infrastructureCost',
      'p95Ms',
    ].every(
      (k) =>
        Number.isFinite((trial.metrics as any)[k]) &&
        (trial.metrics as any)[k] >= 0,
    )
  );
}
export function schedulerDecision(trials: SchedulerTrial[]) {
  return {
    decision: 'HELD' as const,
    eligibleForMeasuredReview:
      trials.length === 2 &&
      new Set(trials.map((x) => x.engine)).size === 2 &&
      trials.every(eligible),
    rule: 'Only measured, predeclared ownership/workload criteria can select the scheduler; local greens and line counts never choose a winner.',
  };
}
