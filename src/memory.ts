import type {
  ContextService,
  ContextReference,
  ContextResolution,
} from './context-service.js';
import type { VerifiedIdentity } from './identity-provider.js';

// No pool overload, alternate eligibility policy, or tenant/header fallback.
// The actor is supplied by the existing trusted verifier ingress, never caller JSON.
export async function readContext(
  service: ContextService,
  actor: VerifiedIdentity,
  reference: ContextReference,
): Promise<ContextResolution> {
  return service.resolve(actor, reference);
}
