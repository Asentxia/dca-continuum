/** Negative-state coverage is external to the restored domain DB. This interface
 * is NOT an implementation or qualification of durable append/replay/restore.
 * There is deliberately no restore-reopen path in this first slice. */
export interface IndependentE2Journal {
  normalOperationLease(): Promise<Readonly<{
    state: 'NORMAL_UNRESTORED';
    domain: string;
    fence: string;
    validUntil: number;
  }> | null>;
}
export class E2RecoveryGate {
  constructor(
    private readonly journal: IndependentE2Journal,
    private readonly domain: string,
  ) {}
  async lease() {
    const lease = await this.journal.normalOperationLease();
    if (
      !lease ||
      lease.state !== 'NORMAL_UNRESTORED' ||
      lease.domain !== this.domain ||
      typeof lease.fence !== 'string' ||
      !lease.fence ||
      !Number.isFinite(lease.validUntil)
    )
      throw Error('E2 unavailable');
    // Copy external response; mutable callback objects cannot change the fence.
    return Object.freeze({ ...lease });
  }
}
export type E2Lease = Awaited<ReturnType<E2RecoveryGate['lease']>>;
// Policy defaults only. No projection, purge, timer, or deletion authority.
export const E2_RETENTION_DEFAULTS = Object.freeze({
  auditDays: 90,
  retryDays: 30,
  purgeEnabled: false,
});
