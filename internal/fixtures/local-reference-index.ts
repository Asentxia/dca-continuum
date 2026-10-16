import type { ContextReference } from '../../src/context-service.js';
import {
  RESTRICTED_MEMORY_CAPS,
  validateIndexReply,
  validateRecallQuery,
  validateRecallScope,
  type DerivedReferenceIndexPort,
  type RecallQuery,
  type RecallScope,
  type ReferenceIndexReply,
} from '../../src/restricted-memory-protocol.js';
import { assertLocalFixtures } from '../../src/runtime-profile.js';

function namespace(scope: RecallScope, externalName: string): string {
  // JSON tuple avoids delimiter collisions and preserves opaque identifiers.
  return JSON.stringify([scope.tenant, scope.principal, externalName]);
}

/**
 * Disposable local reference fixtures, never canonical facts or eligibility.
 * No global/default tenant bucket, index manager, gateway, network or DB access.
 */
export class LocalReferenceIndexDouble implements DerivedReferenceIndexPort {
  private readonly entries = new Map<string, readonly ContextReference[]>();
  private available = true;
  constructor() {
    assertLocalFixtures('local reference index double');
  }
  seed(
    scope: RecallScope,
    externalName: string,
    references: readonly ContextReference[],
  ): void {
    assertLocalFixtures('local reference index double');
    const current = validateRecallScope(scope);
    const query = validateRecallQuery({
      text: externalName,
      limit: RESTRICTED_MEMORY_CAPS.candidates,
    });
    const reply = validateIndexReply(
      { status: 'AVAILABLE', references },
      query,
    );
    if (reply.status !== 'AVAILABLE') throw Error('local reference seed');
    this.entries.set(namespace(current, query.text), reply.references);
  }
  async lookup(
    scope: RecallScope,
    query: RecallQuery,
  ): Promise<ReferenceIndexReply> {
    assertLocalFixtures('local reference index double');
    const current = validateRecallScope(scope);
    const requested = validateRecallQuery(query);
    if (!this.available) return Object.freeze({ status: 'UNAVAILABLE' });
    // Return the scripted candidate set, or reject a smaller requested limit;
    // do not silently truncate it, rank it, or resolve a "latest" candidate.
    return validateIndexReply(
      {
        status: 'AVAILABLE',
        references: this.entries.get(namespace(current, requested.text)) ?? [],
      },
      requested,
    );
  }
  setAvailable(available: boolean): void {
    assertLocalFixtures('local reference index double');
    if (typeof available !== 'boolean') throw Error('local index availability');
    this.available = available;
  }
  reset(): void {
    assertLocalFixtures('local reference index double');
    this.entries.clear();
    this.available = false;
  }
}
