import type pg from 'pg';
import type { ContextResolution, ContextService } from './context-service.js';
import type {
  IdentityVerifier,
  VerifiedIdentity,
} from './identity-provider.js';
import { tx } from './db.js';
import { enrolled } from './service-auth.js';
import {
  validateIndexReply,
  validateRecallQuery,
  validateRecallScope,
  type DerivedReferenceIndexPort,
  type RecallQuery,
  type RecallScope,
} from './restricted-memory-protocol.js';

export type RecallOutcome = Readonly<{
  status: 'HITS' | 'EMPTY' | 'DEGRADED';
  hits: readonly ContextResolution[];
  authority: false;
  execution: 'NONE';
}>;

type EnrollmentWitness = Readonly<{
  identityId: string;
  identityVersion: string;
  kind: 'machine';
  role: 'worker';
  scope: RecallScope;
}>;

function outcome(
  status: RecallOutcome['status'],
  hits: readonly ContextResolution[] = [],
): RecallOutcome {
  return Object.freeze({
    status,
    hits: Object.freeze([...hits]),
    authority: false,
    execution: 'NONE',
  });
}

function databaseTime(value: unknown): number {
  // A missing/null sample is not the Unix epoch. Do not coerce arbitrary objects,
  // booleans, or a cached application timestamp into an authentication decision.
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number')
    return new Date(value).getTime();
  return NaN;
}

/**
 * Cache-free, workload-only reference consumer. Trusted composition MUST supply
 * the existing verifier and ContextService plus an enrollment pool for the SAME
 * intended canonical database. Function-shape checks are not authentication or
 * proof of that composition; callers cannot supply actor-shaped credentials.
 *
 * Only ContextService owns context eligibility. Its existing committed corruption
 * quarantine is intentional; there is no outer batch transaction to roll it back.
 * Each item has its own validation point, not an atomic snapshot, continuous/ABA
 * revocation guarantee, new principal/effect policy, or recall of delivered bytes.
 */
export class RecallService {
  constructor(
    private readonly enrollmentDb: pg.Pool,
    private readonly context: ContextService,
    private readonly workloadVerifier: IdentityVerifier,
    private readonly index: DerivedReferenceIndexPort,
  ) {
    if (
      typeof enrollmentDb?.connect !== 'function' ||
      typeof context?.resolve !== 'function' ||
      typeof workloadVerifier?.verify !== 'function' ||
      typeof index?.lookup !== 'function'
    )
      throw Error('recall requires explicit trusted dependencies');
  }

  private async checkpoint(
    actor: VerifiedIdentity,
    expected?: EnrollmentWitness,
  ): Promise<EnrollmentWitness> {
    return tx(this.enrollmentDb, async (c) => {
      const i = await enrolled(c, actor);
      if (
        actor.kind !== 'machine' ||
        i.kind !== 'machine' ||
        i.domain_role !== 'worker' ||
        typeof i.principal !== 'string' ||
        typeof i.id !== 'string' ||
        !i.id ||
        typeof i.version !== 'string' ||
        !/^(?:0|-?[1-9][0-9]*)$/.test(i.version)
      )
        throw Error('recall scope unavailable');
      const scope = validateRecallScope({
        tenant: i.tenant,
        principal: i.principal,
      });
      // Enrollment remains share-locked. Sample explicitly after that lock and
      // validate finiteness even on paths that never resolve a context item.
      const now = databaseTime(
        (await c.query('SELECT clock_timestamp() t')).rows[0]?.t,
      );
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(actor.expires) ||
        actor.expires <= now
      )
        throw Error('recall scope unavailable');
      const current: EnrollmentWitness = Object.freeze({
        identityId: i.id,
        identityVersion: i.version,
        kind: 'machine',
        role: 'worker',
        scope,
      });
      if (
        expected &&
        (current.identityId !== expected.identityId ||
          current.identityVersion !== expected.identityVersion ||
          current.kind !== expected.kind ||
          current.role !== expected.role ||
          current.scope.tenant !== expected.scope.tenant ||
          current.scope.principal !== expected.scope.principal)
      )
        throw Error('recall scope unavailable');
      return current;
    });
  }

  async recall(credential: string, query: RecallQuery): Promise<RecallOutcome> {
    try {
      const requested = validateRecallQuery(query);
      if (typeof credential !== 'string' || !credential)
        return outcome('DEGRADED');
      // Authentication comes from this configured existing verifier, never from
      // a structural TypeScript actor, caller flag, scope, or index response.
      const actor = await this.workloadVerifier.verify(credential);
      if (actor.kind !== 'machine') return outcome('DEGRADED');
      const witness = await this.checkpoint(actor);

      let reply: unknown;
      let lookupFailed = false;
      try {
        // The initial checkpoint committed/released before any external wait.
        // Only the immutable tenant/principal and query go to this port.
        reply = await this.index.lookup(witness.scope, requested);
      } catch {
        lookupFailed = true;
      }
      // Mandatory on ALL settled outcomes: empty, unavailable, malformed, thrown.
      // No new timeout, retry, fallback, or cache policy is selected here.
      await this.checkpoint(actor, witness);
      if (lookupFailed) return outcome('DEGRADED');
      const candidates = validateIndexReply(reply, requested);
      if (candidates.status === 'UNAVAILABLE') return outcome('DEGRADED');
      if (!candidates.references.length) return outcome('EMPTY');

      const hits: ContextResolution[] = [];
      let rejected = false;
      for (const reference of candidates.references) {
        // Scope failure aborts the entire batch. Never continue in a new scope.
        await this.checkpoint(actor, witness);
        try {
          const resolved = await this.context.resolve(actor, reference);
          if (!rejected) hits.push(resolved);
        } catch {
          // Canonical rejection is sticky, but every remaining unique candidate
          // still reaches the real resolver while authenticated scope is valid.
          rejected = true;
          hits.length = 0;
        }
      }
      // This checks reader scope/time, NOT a second context snapshot. A context
      // change after an earlier successful item is not retroactively revalidated.
      await this.checkpoint(actor, witness);
      return rejected ? outcome('DEGRADED') : outcome('HITS', hits);
    } catch {
      // No identifiers, tokens, reasons, counts, errors, or partial hits escape.
      return outcome('DEGRADED');
    }
  }
}
