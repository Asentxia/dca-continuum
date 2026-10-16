export function safeError(e: unknown) {
  const name = e instanceof Error ? e.name : 'UnknownError';
  return {
    classification: ['AbortError', 'TimeoutError', 'TypeError'].includes(name)
      ? name
      : 'BoundaryError',
    detailRedacted: true,
  };
}
export class RequestBudget {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(
    private maximum = 30,
    private windowMs = 60000,
    private maxIdentities = 10000,
  ) {}
  take(key: string, now = Date.now()) {
    const current = this.entries.get(key);
    if (current && current.until > now) {
      if (++current.count > this.maximum) throw Error('request budget');
      return;
    }
    if (current) this.entries.delete(key);
    if (this.entries.size >= this.maxIdentities)
      for (const [k, v] of this.entries)
        if (v.until <= now) this.entries.delete(k);
    if (this.entries.size >= this.maxIdentities)
      throw Error('request budget capacity');
    this.entries.set(key, { count: 1, until: now + this.windowMs });
  }
}
export function validateStagingConfig(x: {
  enabled: boolean;
  mode: string;
  approvalReference: string | null;
  humanIssuer: string | null;
  workloadIdentityRef: string | null;
  secretManagerRef: string | null;
  externalFenceRef: string | null;
  networkPolicyRef: string | null;
}) {
  if (
    !x.enabled ||
    x.mode !== 'approved-staging' ||
    !x.approvalReference ||
    !x.humanIssuer ||
    !x.workloadIdentityRef ||
    !x.secretManagerRef ||
    !x.externalFenceRef ||
    !x.networkPolicyRef
  )
    throw Error('live staging disabled or prerequisites deferred');
  if (new URL(x.humanIssuer).protocol !== 'https:')
    throw Error('pinned HTTPS issuer required');
  return x;
}
