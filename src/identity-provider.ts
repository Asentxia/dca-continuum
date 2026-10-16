import { assertLocalFixtures } from './runtime-profile.js';
import {
  createRemoteJWKSet,
  jwtVerify,
  customFetch,
  type JWTVerifyGetKey,
} from 'jose';
export interface IdentityConfig {
  issuer: string;
  jwksUri: string;
  audience: string;
  kind: 'user' | 'machine';
  algorithms: string[];
  requiredClaims?: Record<string, string>;
}
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  audience: string;
  kind: 'user' | 'machine';
  expires: number;
  authTime?: number;
  methods: string[];
  // Issuer-signed workload fence. A caller body cannot supply these.
  credentialGeneration?: number;
  credentialEpoch?: number;
  credentialPlacement?: number;
}
export class IdentityVerifier {
  private keys: JWTVerifyGetKey;
  constructor(
    private config: IdentityConfig,
    testKeys?: JWTVerifyGetKey,
  ) {
    if (testKeys) assertLocalFixtures('injected test JWKS');
    const issuer = new URL(config.issuer),
      jwks = new URL(config.jwksUri);
    if (
      issuer.protocol !== 'https:' ||
      jwks.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      jwks.username ||
      jwks.password ||
      issuer.search ||
      issuer.hash ||
      jwks.hash ||
      jwks.origin !== issuer.origin
    )
      throw Error('pinned HTTPS issuer/JWKS required');
    if (
      !config.audience ||
      !config.algorithms.length ||
      config.algorithms.some((x) => !['RS256', 'ES256', 'EdDSA'].includes(x))
    )
      throw Error('invalid audience/algorithm policy');
    this.keys =
      testKeys ??
      createRemoteJWKSet(jwks, {
        timeoutDuration: 5000,
        cacheMaxAge: 300000,
        [customFetch]: async (url, options) => {
          if (String(url) !== jwks.toString()) throw Error('JWKS URL mismatch');
          return fetch(url, { ...options, redirect: 'error' });
        },
      });
  }
  async verify(token: string): Promise<VerifiedIdentity> {
    if (token.length > 16384) throw Error('oversized identity token');
    const { payload, protectedHeader } = await jwtVerify(token, this.keys, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithms: this.config.algorithms,
      requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat'],
      maxTokenAge: '15 minutes',
      clockTolerance: 0,
    });
    if (
      protectedHeader.jku ||
      protectedHeader.jwk ||
      protectedHeader.x5u ||
      protectedHeader.crit
    )
      throw Error('untrusted JWT key/control header');
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      payload.sub.length > 255 ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat)
    )
      throw Error('invalid identity claims');
    if (
      payload.auth_time !== undefined &&
      (!Number.isSafeInteger(payload.auth_time) ||
        Number(payload.auth_time) < 0 ||
        Number(payload.auth_time) > Math.floor(Date.now() / 1000))
    )
      throw Error('invalid authentication time');
    for (const claim of ['ct_gen', 'ct_epoch'] as const)
      if (payload[claim] !== undefined && !Number.isSafeInteger(payload[claim]))
        throw Error('invalid workload binding');
    const placementClaim = payload.ct_placement;
    if (
      placementClaim !== undefined &&
      (typeof placementClaim !== 'number' ||
        !Number.isSafeInteger(placementClaim) ||
        placementClaim < 1)
    )
      throw Error('invalid workload binding');
    for (const [k, v] of Object.entries(this.config.requiredClaims ?? {}))
      if (payload[k] !== v) throw Error('workload claim binding');
    // Token kind is selected by the registered issuer/audience verifier, never caller body or token role fields.
    return Object.freeze({
      issuer: this.config.issuer,
      subject: payload.sub,
      audience: this.config.audience,
      kind: this.config.kind,
      expires: payload.exp! * 1000,
      authTime:
        typeof payload.auth_time === 'number'
          ? payload.auth_time * 1000
          : undefined,
      methods: Array.isArray(payload.amr)
        ? payload.amr.filter((x) => typeof x === 'string')
        : [],
      credentialGeneration:
        typeof payload.ct_gen === 'number' ? payload.ct_gen : undefined,
      credentialEpoch:
        typeof payload.ct_epoch === 'number' ? payload.ct_epoch : undefined,
      credentialPlacement:
        typeof payload.ct_placement === 'number'
          ? payload.ct_placement
          : undefined,
    });
  }
}
