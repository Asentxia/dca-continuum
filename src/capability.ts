import { assertLocalFixtures } from './runtime-profile.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
export interface Capability {
  identityId?: string;
  identityVersion?: number;
  deploymentFence: string;
  tenant: string;
  principal: string;
  epoch: number;
  generation: number;
  placementGeneration?: number;
  operations: string[];
  expires: number;
}
export function issueCapability(secret: string, c: Capability) {
  assertLocalFixtures('HMAC fixture issuer');
  const s = Buffer.from(JSON.stringify(c)).toString('base64url');
  return s + '.' + createHmac('sha256', secret).update(s).digest('base64url');
}
export function verifyCapability(secret: string, token: string): Capability {
  assertLocalFixtures('HMAC fixture verifier');
  if (token.length > 16384) throw Error('capability length bound');
  const [s, h, ...rest] = token.split('.');
  if (!s || !h || rest.length) throw Error('bad capability');
  const expected = createHmac('sha256', secret).update(s).digest();
  const actual = Buffer.from(h, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw Error('bad capability');
  const c = JSON.parse(Buffer.from(s, 'base64url').toString());
  if (
    typeof c.deploymentFence !== 'string' ||
    typeof c.tenant !== 'string' ||
    typeof c.principal !== 'string' ||
    !Number.isSafeInteger(c.epoch) ||
    !Number.isSafeInteger(c.generation) ||
    (c.placementGeneration !== undefined &&
      (!Number.isSafeInteger(c.placementGeneration) ||
        c.placementGeneration < 1)) ||
    !Array.isArray(c.operations) ||
    c.operations.some((x: unknown) => typeof x !== 'string') ||
    !Number.isSafeInteger(c.expires) ||
    c.expires <= Date.now()
  )
    throw Error('invalid/expired capability');
  return c;
}
