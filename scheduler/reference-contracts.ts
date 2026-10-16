export interface ReferenceJob {
  id: string;
  schemaVersion: 1 | 2;
  operations: string[];
  waitMs: number;
}
export interface ReferenceProgress {
  phase: 'BEFORE_WAIT' | 'WAITING' | 'DONE' | 'BLOCKED';
  schemaVersion: 1 | 2;
  done: number[];
}
// Pure validator also runs in the Temporal sandbox. No transport, credentials or authority in job data.
export function validateReferenceJob(x: ReferenceJob) {
  if (
    !x ||
    typeof x !== 'object' ||
    Object.keys(x).sort().join(',') !== 'id,operations,schemaVersion,waitMs' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x.id) ||
    ![1, 2].includes(x.schemaVersion) ||
    !Array.isArray(x.operations) ||
    x.operations.length !== 10 ||
    new Set(x.operations).size !== 10 ||
    x.operations.some(
      (v) =>
        typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
    ) ||
    !Number.isSafeInteger(x.waitMs) ||
    x.waitMs < 1 ||
    x.waitMs > 172800000
  )
    throw Error('reference-only bounded workload required');
  return x;
}
