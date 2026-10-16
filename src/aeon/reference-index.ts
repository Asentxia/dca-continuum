import type { ContextReference } from '../context-service.js';
import {
  validateRecallScope,
  validateRecallQuery,
  validateContextReference,
  validateIndexReply,
  type DerivedReferenceIndexPort,
  type RecallScope,
  type RecallQuery,
  type ReferenceIndexReply,
} from '../restricted-memory-protocol.js';
import type { AeonRanker } from './offline-ranker.js';

export type AeonCandidate = Readonly<{
  reference: ContextReference;
  distance: number;
  neighborWeight: number;
}>;
/** Trusted injected metadata source, not an alternate fact/permission store.
 * Returns at most 16 candidate references/scores, never payload/eligibility flags.
 * It must partition metadata by supplied R1-derived scope. Scope shape is NOT auth.
 */
export interface AeonCandidateSource {
  candidates(
    scope: RecallScope,
    query: RecallQuery,
  ): Promise<readonly AeonCandidate[]>;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('AEON candidate shape');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(fields).length !== keys.length ||
    keys.some(
      (key) =>
        !fields[key] || !('value' in fields[key]) || !fields[key].enumerable,
    )
  )
    throw Error('AEON candidate shape');
  return Object.fromEntries(keys.map((key) => [key, fields[key].value]));
}

/** Implements E1 only: ranking confers no eligibility, facts or authority.
 * Compose with existing RecallService R1. Every returned ref still resolves via
 * fresh ContextService; no result payloads, fallback, persistence or eligibility cache.
 */
export class AeonReferenceIndex implements DerivedReferenceIndexPort {
  constructor(
    private readonly source: AeonCandidateSource,
    private readonly ranker: AeonRanker,
  ) {}
  async lookup(
    scope: RecallScope,
    query: RecallQuery,
  ): Promise<ReferenceIndexReply> {
    try {
      const requested = validateRecallQuery(query);
      const current = validateRecallScope(scope);
      const raw = await this.source.candidates(current, requested);
      if (
        !Array.isArray(raw) ||
        Object.getPrototypeOf(raw) !== Array.prototype ||
        raw.length > 16
      )
        throw Error('AEON candidate bounds');
      const properties = Object.getOwnPropertyDescriptors(raw);
      if (Reflect.ownKeys(properties).length !== raw.length + 1)
        throw Error('AEON array shape');
      const ids = new Set<string>();
      const candidates: AeonCandidate[] = [];
      for (let index = 0; index < raw.length; index++) {
        const item = properties[String(index)];
        if (!item || !('value' in item) || !item.enumerable)
          throw Error('AEON array shape');
        const r = record(item.value, [
          'reference',
          'distance',
          'neighborWeight',
        ]);
        const reference = validateContextReference(r.reference);
        if (ids.has(reference.id)) throw Error('AEON duplicate candidate');
        ids.add(reference.id);
        if (
          typeof r.distance !== 'number' ||
          !Number.isFinite(r.distance) ||
          r.distance < 0 ||
          r.distance > 2 ||
          typeof r.neighborWeight !== 'number' ||
          !Number.isFinite(r.neighborWeight) ||
          r.neighborWeight < 0 ||
          r.neighborWeight > 5
        )
          throw Error('AEON score bounds');
        candidates.push(
          Object.freeze({
            reference,
            distance: r.distance,
            neighborWeight: r.neighborWeight,
          }),
        );
      }
      // Copy before awaiting the child: source mutations cannot replace refs/scores.
      const scores = await this.ranker.score(
        Object.freeze(
          candidates.map((c) =>
            Object.freeze({
              distance: c.distance,
              neighborWeight: c.neighborWeight,
            }),
          ),
        ),
      );
      if (
        !Array.isArray(scores) ||
        scores.length !== candidates.length ||
        scores.some(
          (s) => typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 2,
        )
      )
        throw Error('AEON score reply');
      const references = candidates
        .map((c, i) => ({ reference: c.reference, score: scores[i], order: i }))
        .sort((a, b) => a.score - b.score || a.order - b.order)
        .slice(0, requested.limit)
        .map((c) => c.reference);
      return validateIndexReply({ status: 'AVAILABLE', references }, requested);
    } catch {
      // No reasons, metadata, source text or partial candidates escape on failure.
      return Object.freeze({ status: 'UNAVAILABLE' });
    }
  }
}
