import type { ContextReference } from '../context-service.js';
import { validateContextReference } from '../restricted-memory-protocol.js';

export const AEON_E2_PROTOCOL = 'continuum-derived-unverified-text/v1' as const;
export type AeonAdmissionInput<Handle extends object> = Readonly<{
  source: ContextReference;
  extractionProtocol: typeof AEON_E2_PROTOCOL;
  ttlSeconds: number;
  observationBinding: Handle;
}>;
/** Structural delegation contract only. Actual handle identity/authentication,
 * E1 classification, canonical atomic admission and receipts belong to E2.
 * Trusted composition injects createE2Ingress(...).admit; never ordinary ingest.
 */
export interface GovernedAdmissionPort<Handle extends object, Receipt> {
  admit(
    credential: string,
    input: AeonAdmissionInput<Handle>,
  ): Promise<Receipt>;
}
export class AeonGovernedAdmission<Handle extends object, Receipt> {
  constructor(private readonly e2: GovernedAdmissionPort<Handle, Receipt>) {}
  async admit(
    credential: string,
    input: AeonAdmissionInput<Handle>,
  ): Promise<Receipt> {
    if (
      input.extractionProtocol !== AEON_E2_PROTOCOL ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > 604800 ||
      !input.observationBinding ||
      typeof input.observationBinding !== 'object'
    )
      throw Error('AEON admission refused');
    // Do not inspect, clone, serialize or mint the opaque server-owned handle.
    // E2 freshly verifies credentials and rejects forged/mismatched handles.
    return this.e2.admit(
      credential,
      Object.freeze({
        source: validateContextReference(input.source),
        extractionProtocol: AEON_E2_PROTOCOL,
        ttlSeconds: input.ttlSeconds,
        observationBinding: input.observationBinding,
      }),
    );
  }
}
