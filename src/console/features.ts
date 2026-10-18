import type { VerifiedIdentity } from '../identity-provider.js';
import type { ReadEnvelope } from './contracts.js';
export type ConsoleMode = 'LOCAL_FIXTURE' | 'STAGING';
export function freshHumanMfa(actor: VerifiedIdentity, now: number) {
  return (
    Number.isFinite(now) &&
    actor.kind === 'user' &&
    actor.expires > now &&
    actor.methods.includes('mfa') &&
    actor.authTime !== undefined &&
    Number.isFinite(actor.authTime) &&
    actor.authTime <= now + 5000 &&
    now - actor.authTime <= 300000
  );
}
export function featureCatalogue(
  mode: ConsoleMode,
  actor: VerifiedIdentity,
  blocked: boolean,
  now: number,
): ReadEnvelope['features'] {
  const fresh = freshHumanMfa(actor, now);
  // The caller has already enrolled the human. The database's identity
  // constraint permits human/owner and machine/worker, not a self-granted role.
  const enabled = mode === 'LOCAL_FIXTURE' && fresh && !blocked;
  const f = (state: any, reason: string, scope: any = 'NONE') => ({
    state,
    reason,
    scope,
  });
  return {
    reads: f(
      'available',
      'Authorized domain snapshot; external-source freshness is separate.',
      mode,
    ),
    commands: f(
      enabled
        ? 'available'
        : blocked
          ? 'temporarily_unavailable'
          : fresh
            ? 'qualification_pending'
            : 'requires_setup',
      enabled
        ? 'Fresh enrolled owner; LOCAL TEST commands only. Approval does not execute an effect.'
        : blocked
          ? 'Recovery fence blocks new commands.'
          : !fresh
            ? 'Fresh independently authenticated MFA is required.'
            : 'Live identity/command qualification and owner stage authorization remain pending.',
      enabled ? 'LOCAL_FIXTURE' : 'NONE',
    ),
    manualControl: f(
      'qualification_pending',
      'Managed viewing/input and privileged-browser isolation have NOT RUN. No remote input is enabled.',
    ),
    computerLifecycle: f(
      'qualification_pending',
      'Managed lifecycle actions are not qualified; inspect authoritative state only.',
    ),
    contextWrites: f(
      'unsupported',
      'Context is read-only here. Quarantine review/erasure remain internal operator services.',
    ),
    cognition: f(
      'not_configured',
      'Mock-tested / live test pending. A model connection grants no new permissions.',
    ),
    billing: f(
      'not_configured',
      'No approved billing connection. Reservations are not charges.',
    ),
    channels: f(
      'not_configured',
      'In-app records are available; external delivery/preferences are not connected.',
    ),
    scheduler: f(
      'qualification_pending',
      'Selection HELD; no scheduler selector. Real 24-hour stage remains NOT RUN.',
    ),
    protectedProvider: f(
      'qualification_pending',
      'P2 PARTIAL. A public immutable read does not enable protected writes.',
    ),
    handoff: f(
      'unsupported',
      'Bounded domain handoff seam is tested separately; no automatic transfer of grants or old approvals.',
    ),
  };
}
