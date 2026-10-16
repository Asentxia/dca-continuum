import type pg from 'pg';
import { EffectController } from './controller.js';
import { PublicCapabilityVerifier } from './production-capability.js';
import { serveController } from './controller-server.js';
import { assertExternalFence, type FenceStore } from './fence-store.js';
import type { ProviderAdapter } from './provider-adapter.js';
import type { JWK } from 'jose';
export async function stagingController(
  x: {
    enabled: boolean;
    approvalReference: string;
    socket: string;
    fence: string;
    issuer: string;
    publicJwks: { keys: JWK[] };
  },
  db: pg.Pool,
  adapter: ProviderAdapter,
  independentFence: FenceStore,
) {
  if (
    !x.enabled ||
    !x.approvalReference ||
    !x.fence ||
    adapter.provider === 'fixture'
  )
    throw Error('live staging controller disabled or test-only adapter');
  const verifier = new PublicCapabilityVerifier(x.publicJwks, x.issuer);
  await assertExternalFence(independentFence, x.fence);
  return serveController(
    x.socket,
    verifier,
    new EffectController(db, adapter, x.fence, 30000, {}, (expected) =>
      assertExternalFence(independentFence, expected),
    ),
  );
}

import { controllerHttps } from './controller-https.js';
export async function stagingControllerHttps(
  x: {
    enabled: boolean;
    approvalReference: string;
    fence: string;
    issuer: string;
    publicJwks: { keys: JWK[] };
  },
  db: pg.Pool,
  adapter: ProviderAdapter,
  independentFence: FenceStore,
  tlsFromSecureConnection: () => Promise<{
    key: string | Buffer;
    cert: string | Buffer;
  }>,
) {
  if (
    !x.enabled ||
    !x.approvalReference ||
    !x.fence ||
    adapter.provider === 'fixture'
  )
    throw Error('staging HTTPS controller disabled or fixture-only');
  const verifier = new PublicCapabilityVerifier(x.publicJwks, x.issuer);
  await assertExternalFence(independentFence, x.fence);
  const tls = await tlsFromSecureConnection();
  return controllerHttps(
    tls,
    verifier,
    new EffectController(db, adapter, x.fence, 30000, {}, (expected) =>
      assertExternalFence(independentFence, expected),
    ),
  );
}
