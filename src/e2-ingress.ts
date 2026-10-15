import type { ContextReference, ContextService } from './context-service.js';
import type {
  IdentityVerifier,
  VerifiedIdentity,
} from './identity-provider.js';
import { canonical } from './db.js';
import {
  classifyModel,
  MODEL_PROTOCOL_CAPS,
  modelWireView,
  validateModelBinding,
  type ModelRequestBinding,
  type ModelObservation,
} from './model-protocol.js';
import { validateContextReference } from './restricted-memory-protocol.js';

export const E2_EXTRACTION_PROTOCOL =
  'continuum-derived-unverified-text/v1' as const;
export const E2_RECORD_CLASS = 'E2_DERIVED_UNVERIFIED_V1' as const;
declare const opaqueObservation: unique symbol;
export type ServerE1ObservationHandle = Readonly<{ [opaqueObservation]: true }>;
export type E2AdmissionInput = Readonly<{
  source: ContextReference;
  extractionProtocol: typeof E2_EXTRACTION_PROTOCOL;
  ttlSeconds: number;
  observationBinding: ServerE1ObservationHandle;
}>;
export type E2AdmissionReceipt = Readonly<{
  receiptId: string;
  source: ContextReference;
  result: ContextReference;
  recordedAt: string;
  resultExpires: string;
  status: 'PRIVATE_QUARANTINED_UNVERIFIED';
  authority: false;
  execution: 'NONE';
}>;
function actorKey(a: VerifiedIdentity) {
  return canonical({
    issuer: a.issuer,
    subject: a.subject,
    audience: a.audience,
    kind: a.kind,
  });
}
/** Trusted composition ONLY. Do not export recordObservation to workers/routes.
 * Minting requires a verified credential AND server-owned E1 binding/observation.
 * This is not authentication of a provider or containment of a compromised server.
 * Worker-facing composition receives only `admit`; handles cannot be JSON-imported.
 */
const authenticatedAdmissions = new WeakSet<object>();
const authenticatedReviews = new WeakSet<object>();
export function authenticatedE2Review(actor: VerifiedIdentity) {
  return authenticatedReviews.has(actor);
}
const observations = new WeakMap<
  object,
  { actor: string; source: ContextReference; text: string }
>();
export function resolveE2Admission(
  actor: VerifiedIdentity,
  input: E2AdmissionInput,
) {
  if (
    !authenticatedAdmissions.has(actor) ||
    !input ||
    Object.keys(input).sort().join(',') !==
      'extractionProtocol,observationBinding,source,ttlSeconds' ||
    input.extractionProtocol !== E2_EXTRACTION_PROTOCOL ||
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > 604800
  )
    throw Error('E2 unavailable');
  const source = validateContextReference(input.source);
  const record = observations.get(input.observationBinding);
  if (
    !record ||
    record.actor !== actorKey(actor) ||
    canonical(source) !== canonical(record.source)
  )
    throw Error('E2 unavailable');
  return Object.freeze({
    source,
    extractionProtocol: E2_EXTRACTION_PROTOCOL,
    ttlSeconds: input.ttlSeconds,
    proposal: Object.freeze({
      kind: 'UNVERIFIED_TEXT' as const,
      text: record.text,
    }),
  });
}
export function createE2Ingress(
  context: ContextService,
  verifier: IdentityVerifier,
) {
  return Object.freeze({
    async recordObservation(
      token: string,
      expected: ModelRequestBinding,
      observation: ModelObservation,
    ): Promise<ServerE1ObservationHandle> {
      try {
        const actor = await verifier.verify(token);
        if (actor.kind !== 'machine') throw Error();
        const binding = validateModelBinding(expected);
        if (classifyModel(binding, observation).status !== 'COMPLETE')
          throw Error();
        // Snapshot before classifier. Never persist wire or permit later mutation.
        const view =
          observation.kind === 'RESPONSE'
            ? modelWireView(observation.wire)
            : undefined;
        if (view && view.byteLength > MODEL_PROTOCOL_CAPS.wireBytes)
          throw Error();
        const copied: ModelObservation =
          observation.kind === 'OUTAGE'
            ? { kind: 'OUTAGE' }
            : {
                kind: 'RESPONSE',
                terminal: observation.terminal,
                wire: view ? Uint8Array.from(view) : new Uint8Array(),
              };
        const result = classifyModel(binding, copied);
        if (
          result.status !== 'COMPLETE' ||
          result.semantic !== 'UNVERIFIED_PROPOSAL' ||
          result.authority !== false ||
          result.execution !== 'NONE'
        )
          throw Error();
        const handle = Object.freeze({}) as ServerE1ObservationHandle;
        observations.set(handle, {
          actor: actorKey(actor),
          source: binding.source,
          text: result.proposal.text,
        });
        return handle;
      } catch {
        throw Error('E2 unavailable');
      }
    },
    async admit(
      token: string,
      input: E2AdmissionInput,
    ): Promise<E2AdmissionReceipt> {
      try {
        const actor = await verifier.verify(token);
        authenticatedAdmissions.add(actor);
        try {
          return await context.admitDerivedProposal(actor, input);
        } finally {
          authenticatedAdmissions.delete(actor);
        }
      } catch {
        throw Error('E2 unavailable');
      }
    },
  });
}

/** Human review credential ingress; only this capability is exposed to review UI.
 * Does not approve, release, share, or convert unverified prose into authority. */
export function createE2ReviewIngress(
  context: ContextService,
  verifier: IdentityVerifier,
) {
  return Object.freeze({
    async inspect(token: string, reference: ContextReference) {
      try {
        const actor = await verifier.verify(token);
        if (actor.kind !== 'user') throw Error();
        authenticatedReviews.add(actor);
        try {
          return await context.inspectDerivedProposal(actor, reference);
        } finally {
          authenticatedReviews.delete(actor);
        }
      } catch {
        throw Error('E2 unavailable');
      }
    },
  });
}
