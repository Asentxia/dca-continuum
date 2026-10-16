import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
async function run(
  extra: Record<string, string>,
  check: (origin: string) => Promise<void>,
) {
  await fs.mkdir('.artifacts/canonical/product-isolation', { recursive: true });
  const port = await freePort();
  const env = { ...process.env };
  for (const key of [
    'CT_ALLOW_LOCAL_FIXTURES',
    'CT_FIXTURE_SERVER_KEY',
    'CT_LOCAL_TEST_BUILD',
    'WORKOS_API_KEY',
    'WORKOS_CLIENT_ID',
    'WORKOS_COOKIE_PASSWORD',
    'WORKOS_REDIRECT_URI',
  ])
    delete env[key];
  Object.assign(
    env,
    {
      NODE_ENV: 'production',
      CT_RUNTIME_ENV: 'staging',
      CT_CONSOLE_MODE: 'STAGING',
      CT_CONSOLE_ORIGIN: 'https://console.staging.example.invalid',
      CT_DOMAIN_API_ORIGIN: 'https://api.staging.example.invalid',
      CT_LOCAL_TEST_BUILD: 'no',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    extra,
  );
  const bin = process.env.CT_NODE22_BIN;
  if (!bin) throw Error('Approved Node 22 directory required');
  const p: ChildProcess = spawn(
    path.join(bin, 'node'),
    [
      path.resolve('node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: path.resolve('web'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const log = createWriteStream(
    '.artifacts/canonical/product-isolation/server-' + port + '.log',
  );
  p.stdout!.pipe(log);
  p.stderr!.pipe(log);
  const origin = 'http://127.0.0.1:' + port;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (p.exitCode !== null) throw Error('Product server refused startup');
      try {
        await fetch(origin + '/sign-in');
        ready = true;
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, 'Product server ready');
    await check(origin);
  } finally {
    if (p.pid && p.exitCode === null) {
      const done = new Promise<void>((r) => p.once('exit', () => r()));
      try {
        process.kill(-p.pid, 'SIGTERM');
      } catch {}
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      if (p.exitCode === null)
        try {
          process.kill(-p.pid, 'SIGKILL');
        } catch {}
    }
    log.end();
  }
}
test('ordinary product backend artifact excludes test issuers, provider fixtures and old operator executables', async () => {
  for (const name of [
    'dist-product/internal',
    'dist-product/tests',
    'dist-product/src/console/fixture-server.js',
    'dist-product/src/desk-server.js',
    'dist-product/src/local-computer-driver.js',
  ])
    await assert.rejects(fs.stat(name), { code: 'ENOENT' });
});
test('actual product frontend has no fixture sign-in or legacy UI when real identity is absent', async () => {
  await run({}, async (origin) => {
    const signin = await fetch(origin + '/sign-in');
    assert.equal(signin.status, 200);
    assert.ok(!(await signin.text()).includes('Enter local test workspace'));
    const auth = await fetch(origin + '/api/auth/fixture', {
      method: 'POST',
      headers: {
        origin: 'https://console.staging.example.invalid',
        'content-type': 'application/json',
      },
      body: '{"tenant":"a"}',
    });
    assert.ok(auth.status >= 400);
    assert.equal((await fetch(origin + '/api/continuum/v1/work')).status, 401);
    for (const route of [
      '/desk.js',
      '/__fixture-session',
      '/api/context-review',
    ])
      assert.equal((await fetch(origin + route)).status, 404);
  });
});
test('runtime fixture mode and injected compile-profile environment cannot activate the ordinary product build', async () => {
  await run(
    {
      CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
      CT_RUNTIME_ENV: 'local-test',
      CT_ALLOW_LOCAL_FIXTURES: 'yes',
      CT_FIXTURE_SERVER_KEY: 'test-marker',
      CT_COMPILED_PROFILE: 'LOCAL_TEST',
    },
    async (origin) => {
      for (const route of ['/sign-in', '/api/continuum/v1/work'])
        assert.equal((await fetch(origin + route)).status, 503);
      assert.equal(
        (
          await fetch(origin + '/api/auth/fixture', {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: '{"tenant":"a"}',
          })
        ).status,
        503,
      );
    },
  );
});
