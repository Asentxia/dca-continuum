import assert from 'node:assert/strict';
import { EffectController } from '../src/controller.js';
import { FixtureAdapter } from '../internal/fixtures/provider-adapter.js';
import { pool } from '../src/db.js';
import { verifyCapability } from '../src/capability.js';
import { gov, admin, makeOp, count, fence } from './helpers.js';
import { secrets, capability, config, start, stop } from './process-helpers.js';
const db = pool('ct_controller');
config('.local/expiry-provider.json', {});
const p = await start(
  'dist/tests/provider-emulator.js',
  '.local/expiry-provider.json',
  'expiry-provider',
);
const id = process.env.PROBE_ID ?? 'expiry-lock-before-fix';
try {
  await makeOp(id, { expires: new Date(Date.now() + 180) });
  const ctl = new EffectController(
    db,
    new FixtureAdapter('http://127.0.0.1:56670', secrets.providerSecret),
    fence,
    30000,
    {
      afterReservation: async () => {
        const c = await gov.connect();
        await c.query('BEGIN');
        await c.query(
          "SELECT * FROM ct.principals WHERE tenant='a' AND id='agent' FOR UPDATE",
        );
        setTimeout(async () => {
          await c.query('COMMIT');
          c.release();
        }, 240);
      },
    },
  );
  const promise = ctl.dispatch(
    verifyCapability(secrets.capabilitySecret, capability([id])),
    id,
  );
  const outcome = await promise;
  const n = await count(id);
  console.log(
    JSON.stringify({
      id,
      state: outcome.state,
      effects: n,
      expected: 'DENIED after expiration during lock wait',
    }),
  );
  assert.equal(outcome.state, 'DENIED');
  assert.equal(n, 0);
} finally {
  await stop(p);
  await Promise.all([db.end(), admin.end(), gov.end()]);
}
