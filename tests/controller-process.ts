import fs from 'node:fs';
import { pool } from '../src/db.js';
import { FixtureAdapter } from '../internal/fixtures/provider-adapter.js';
import { EffectController } from '../src/controller.js';
import { serveController } from '../src/controller-server.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const db = pool('ct_controller');
const kill = async () => {
  process.kill(process.pid, 'SIGKILL');
};
const hooks =
  config.fault === 'afterReservation'
    ? { afterReservation: kill }
    : config.fault === 'beforeSend'
      ? { beforeSend: kill }
      : config.fault === 'afterSend'
        ? { afterSend: kill }
        : {};
const ctl = new EffectController(
  db,
  new FixtureAdapter('http://127.0.0.1:56670', config.providerSecret),
  config.fence,
  config.leaseMs ?? 30000,
  hooks,
);
await serveController(config.socket, config.capabilitySecret, ctl);
console.log('READY');
