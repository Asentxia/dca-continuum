import type { ContextReference } from './context-service.js';

/**
 * E1 is a references-only protocol, not a recall consumer or an identity verifier.
 * A future consumer must derive this scope from fresh enrolled workload identity,
 * including empty/unavailable/cache paths, and resolve every candidate exclusively
 * through ContextService. A TypeScript scope/reference is not authenticated.
 */
export const RESTRICTED_MEMORY_CAPS = Object.freeze({
  queryBytes: 1024,
  candidates: 16,
  encodedEnvelopeBytes: 16 * 1024,
  identifierCharacters: 128,
  maximumContextVersion: 2147483647,
});

export type RecallScope = Readonly<{ tenant: string; principal: string }>;
export type RecallQuery = Readonly<{ text: string; limit: number }>;
export type ReferenceIndexReply =
  | Readonly<{
      status: 'AVAILABLE';
      references: readonly ContextReference[];
    }>
  | Readonly<{ status: 'UNAVAILABLE' }>;

export interface DerivedReferenceIndexPort {
  lookup(scope: RecallScope, query: RecallQuery): Promise<ReferenceIndexReply>;
}

export class RestrictedMemoryProtocolError extends Error {
  constructor(
    readonly code:
      | 'SHAPE'
      | 'SCOPE'
      | 'QUERY_BOUNDS'
      | 'REFERENCE_BOUNDS'
      | 'REPLY_BOUNDS'
      | 'ENCODED_BOUNDS'
      | 'CONFLICTING_REFERENCE',
  ) {
    super(`restricted memory protocol: ${code}`);
    this.name = 'RestrictedMemoryProtocolError';
  }
}

function record(value: unknown, keys?: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new RestrictedMemoryProtocolError('SHAPE');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(properties).some((key) => typeof key !== 'string') ||
    (keys !== undefined &&
      Object.keys(properties).sort().join(',') !==
        [...keys].sort().join(',')) ||
    Object.values(properties).some(
      (descriptor) => !('value' in descriptor) || !descriptor.enumerable,
    )
  )
    throw new RestrictedMemoryProtocolError('SHAPE');
  // Own data descriptors only: no getter, toJSON, or inherited fallback is read.
  return Object.fromEntries(
    Object.entries(properties).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  ) as Record<string, unknown>;
}

export function validProtocolUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function hasProtocolControls(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function nonblankUnicode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    validProtocolUnicode(value) &&
    value.trim().length > 0 &&
    !hasProtocolControls(value)
  );
}

export function validateRecallScope(value: unknown): RecallScope {
  const r = record(value, ['tenant', 'principal']);
  if (!nonblankUnicode(r.tenant) || !nonblankUnicode(r.principal))
    throw new RestrictedMemoryProtocolError('SCOPE');
  // Opaque strings are preserved; this checks shape, not enrollment or tenancy.
  return Object.freeze({ tenant: r.tenant, principal: r.principal });
}

export function validateRecallQuery(value: unknown): RecallQuery {
  const r = record(value, ['text', 'limit']);
  if (
    !nonblankUnicode(r.text) ||
    Buffer.byteLength(r.text, 'utf8') > RESTRICTED_MEMORY_CAPS.queryBytes ||
    typeof r.limit !== 'number' ||
    !Number.isInteger(r.limit) ||
    r.limit < 1 ||
    r.limit > RESTRICTED_MEMORY_CAPS.candidates
  )
    throw new RestrictedMemoryProtocolError('QUERY_BOUNDS');
  return Object.freeze({ text: r.text, limit: r.limit });
}

export function validateContextReference(value: unknown): ContextReference {
  const r = record(value, ['id', 'version', 'digest']);
  if (
    typeof r.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.id) ||
    typeof r.version !== 'number' ||
    !Number.isInteger(r.version) ||
    r.version < 1 ||
    r.version > RESTRICTED_MEMORY_CAPS.maximumContextVersion ||
    typeof r.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.digest)
  )
    throw new RestrictedMemoryProtocolError('REFERENCE_BOUNDS');
  // Typed values have no numeric lexeme: raw JSON lexical checks belong to the
  // model wire parser, not this port that never receives network bytes.
  return Object.freeze({ id: r.id, version: r.version, digest: r.digest });
}

export function validateIndexReply(
  value: unknown,
  query: RecallQuery,
): ReferenceIndexReply {
  const requested = validateRecallQuery(query);
  const data = record(value);
  const r = record(
    data,
    data.status === 'UNAVAILABLE' ? ['status'] : ['status', 'references'],
  );
  if (r.status === 'UNAVAILABLE')
    return Object.freeze({ status: 'UNAVAILABLE' });
  if (r.status !== 'AVAILABLE' || !Array.isArray(r.references))
    throw new RestrictedMemoryProtocolError('SHAPE');
  if (
    r.references.length > RESTRICTED_MEMORY_CAPS.candidates ||
    r.references.length > requested.limit
  )
    throw new RestrictedMemoryProtocolError('REPLY_BOUNDS');
  if (Object.getPrototypeOf(r.references) !== Array.prototype)
    throw new RestrictedMemoryProtocolError('SHAPE');
  const descriptors = Object.getOwnPropertyDescriptors(r.references);
  if (
    Reflect.ownKeys(descriptors).length !== r.references.length + 1 ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')
  )
    throw new RestrictedMemoryProtocolError('SHAPE');
  const references: ContextReference[] = [];
  for (let index = 0; index < r.references.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new RestrictedMemoryProtocolError('SHAPE');
    references.push(validateContextReference(descriptor.value));
  }
  const envelope = { status: 'AVAILABLE', references };
  // This is the UTF-8 JSON encoding of a validated, bounded typed envelope,
  // BEFORE deduplication. It is NOT a check of raw network wire/whitespace/
  // escaping which this port never receives. With <=16 fixed ASCII references,
  // the accepted grammar already bounds this encoding below 16 KiB.
  if (
    Buffer.byteLength(JSON.stringify(envelope), 'utf8') >
    RESTRICTED_MEMORY_CAPS.encodedEnvelopeBytes
  )
    throw new RestrictedMemoryProtocolError('ENCODED_BOUNDS');
  const first = new Map<string, ContextReference>();
  for (const reference of references) {
    const old = first.get(reference.id);
    if (
      old &&
      (old.version !== reference.version || old.digest !== reference.digest)
    )
      throw new RestrictedMemoryProtocolError('CONFLICTING_REFERENCE');
    if (!old) first.set(reference.id, reference);
  }
  return Object.freeze({
    status: 'AVAILABLE',
    references: Object.freeze([...first.values()]),
  });
}
