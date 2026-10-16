import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type https from 'node:https';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';
import { remoteReferenceActivity } from '../scheduler/reference-activity.js';
import { stagingControllerHttps } from '../src/staging-controller.js';
import {
  controllerHttps,
  HttpsControllerClient,
} from '../src/controller-https.js';
let f: Awaited<ReturnType<typeof fixture>>,
  server: https.Server,
  client: HttpsControllerClient,
  endpoint: string,
  cert: Buffer;
before(async () => {
  f = await fixture('tls');
  const key = path.resolve('.local/controller-test.key.pem'),
    pem = path.resolve('.local/controller-test.cert.pem');
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      pem,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  assert.equal(r.status, 0);
  await fs.chmod(key, 0o600);
  cert = await fs.readFile(pem);
  server = controllerHttps(
    { key: await fs.readFile(key), cert },
    f.caps,
    f.controller,
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = 'https://127.0.0.1:' + (server.address() as any).port;
  client = new HttpsControllerClient(endpoint, cert);
  await fs.unlink(key);
});
after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (f) await f.close();
  await Promise.all([admin.end(), gov.end()]);
});
test('Controller HTTPS public capability verification commits exact action once', async () => {
  const { x } = await f.intent('tls-approved', true),
    token = (await f.authority.renew(await f.actor('machine'), x.id)).token;
  assert.equal((await client.call(token, x.id)).state, 'COMMITTED');
  assert.equal((await client.call(token, x.id)).state, 'COMMITTED');
  assert.equal(f.provider.sends, 1);
  const activity = remoteReferenceActivity(
    { forOperation: async () => token },
    client,
  );
  assert.equal(
    await activity(
      {
        id: 'tls-job',
        schemaVersion: 1,
        operations: [
          x.id,
          ...Array.from({ length: 9 }, (_, i) => 'unused-' + i),
        ],
        waitMs: 1,
      },
      0,
    ),
    'COMMITTED',
  );
});
test('Controller HTTPS refuses forged scope and arbitrary transport routes', async () => {
  await assert.rejects(client.call('forged', 'tls-approved'));
  const token = (
    await f.authority.renew(await f.actor('machine'), 'tls-approved')
  ).token;
  await assert.rejects(client.call(token, 'unassigned-operation'));
  assert.throws(() => new HttpsControllerClient('http://127.0.0.1'));
  assert.throws(
    () => new HttpsControllerClient('https://user:password@example.invalid'),
  );
  await assert.rejects(client.call(token, 'tls-approved', '/proxy' as any));
  let read = 0;
  await assert.rejects(
    stagingControllerHttps(
      {
        enabled: false,
        approvalReference: '',
        fence: '',
        issuer: '',
        publicJwks: { keys: [] },
      },
      f.controllerDb,
      f.provider,
      {} as any,
      async () => {
        read++;
        throw Error('must not access credentials');
      },
    ),
  );
  assert.equal(read, 0);
});
test('Controller HTTPS uncertainty never permits retry or alternate-transport resend', async () => {
  const { x } = await f.intent('tls-uncertain', true),
    token = (await f.authority.renew(await f.actor('machine'), x.id)).token;
  f.provider.loseAck = true;
  assert.equal((await client.call(token, x.id)).state, 'UNKNOWN');
  f.provider.loseAck = false;
  assert.equal((await client.call(token, x.id)).state, 'UNKNOWN');
  assert.equal(f.provider.rows.filter((o) => o.operation === x.id).length, 1);
  assert.equal(
    (await client.call(token, x.id, '/reconcile')).state,
    'COMMITTED',
  );
});
test('Controller HTTPS disabled identity denies previously-issued scope before new effect', async () => {
  const { x, owner } = await f.intent('tls-disabled', true),
    token = (await f.authority.renew(await f.actor('machine'), x.id)).token;
  await f.product.disableMachine(owner, 'tls-worker-a');
  assert.equal((await client.call(token, x.id)).state, 'DENIED');
  assert.equal(f.provider.rows.filter((o) => o.operation === x.id).length, 0);
});
