/** Local TEST compute credentials only. Not canonical enrollment or VERA permission.
 * Real composition injects the existing verifier and current enrolled policy instead.
 */
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import {
  NEXUS_LOCAL_AUDIENCE,
  NEXUS_LOCAL_TOKEN_TYPE,
} from '../../src/nexus-local.js';
export function fixtureVerifier(issuer: string, jwk: JWK) {
  const keys = createLocalJWKSet({ keys: [structuredClone(jwk)] });
  const tenants = new Map([
    ['alice', 'alpha'],
    ['bob', 'beta'],
  ]);
  return async (token: string) => {
    const { payload, protectedHeader: h } = await jwtVerify(token, keys, {
      issuer,
      audience: NEXUS_LOCAL_AUDIENCE,
      algorithms: ['EdDSA'],
      typ: NEXUS_LOCAL_TOKEN_TYPE,
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      maxTokenAge: '2 minutes',
      clockTolerance: 0,
    });
    if (
      h.jku ||
      h.jwk ||
      h.x5u ||
      h.crit ||
      !payload.sub ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      payload.exp! - payload.iat! > 120
    )
      throw Error('invalid fixture credential');
    const tenant = tenants.get(payload.sub);
    if (!tenant) throw Error('unrecognized fixture credential');
    return { subject: payload.sub, tenant };
  };
}
