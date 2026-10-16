import { SignJWT, jwtVerify, createLocalJWKSet, type JWK } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Capability } from './capability.js';
export const capabilityAudience = 'urn:continuum:effect-controller';
export class CapabilitySigner {
  constructor(
    private key: CryptoKey | Uint8Array,
    private kid: string,
    private issuer: string,
  ) {}
  async sign(c: Capability, identityId: string, identityVersion = 1) {
    return new SignJWT({ ...c, identityId, identityVersion })
      .setProtectedHeader({
        alg: 'EdDSA',
        typ: 'continuum-cap+jwt',
        kid: this.kid,
      })
      .setIssuer(this.issuer)
      .setAudience(capabilityAudience)
      .setSubject(identityId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(c.expires / 1000))
      .sign(this.key);
  }
}
export class PublicCapabilityVerifier {
  private keys: ReturnType<typeof createLocalJWKSet>;
  constructor(
    jwks: { keys: JWK[] },
    private issuer: string,
  ) {
    if (
      !jwks.keys.length ||
      jwks.keys.some(
        (k) => k.d || k.k || k.alg !== 'EdDSA' || k.use !== 'sig' || !k.kid,
      )
    )
      throw Error('public EdDSA keys only');
    this.keys = createLocalJWKSet(jwks);
  }
  async verify(token: string): Promise<Capability> {
    if (token.length > 16384) throw Error('oversized capability');
    const { payload: p } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      audience: capabilityAudience,
      algorithms: ['EdDSA'],
      typ: 'continuum-cap+jwt',
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      maxTokenAge: '2 minutes',
      clockTolerance: 0,
    });
    if (
      typeof p.identityId !== 'string' ||
      p.identityId !== p.sub ||
      !Number.isSafeInteger(p.identityVersion) ||
      Number(p.identityVersion) < 1 ||
      typeof p.deploymentFence !== 'string' ||
      typeof p.tenant !== 'string' ||
      typeof p.principal !== 'string' ||
      !Number.isSafeInteger(p.epoch) ||
      !Number.isSafeInteger(p.generation) ||
      (p.placementGeneration !== undefined &&
        (!Number.isSafeInteger(p.placementGeneration) ||
          Number(p.placementGeneration) < 1)) ||
      !Array.isArray(p.operations) ||
      p.operations.length !== 1 ||
      p.operations.some((x) => typeof x !== 'string') ||
      !Number.isSafeInteger(p.expires) ||
      Number(p.expires) > p.exp! * 1000 + 999 ||
      Number(p.expires) <= Date.now() ||
      Number(p.expires) - Number(p.iat) * 1000 > 91000
    )
      throw Error('invalid scoped capability');
    return {
      identityId: p.identityId as string,
      identityVersion: Number(p.identityVersion),
      deploymentFence: p.deploymentFence,
      tenant: p.tenant,
      principal: p.principal,
      epoch: Number(p.epoch),
      generation: Number(p.generation),
      ...(p.placementGeneration === undefined
        ? {}
        : { placementGeneration: Number(p.placementGeneration) }),
      operations: p.operations as string[],
      expires: Math.min(Number(p.expires), p.exp! * 1000),
    };
  }
}
