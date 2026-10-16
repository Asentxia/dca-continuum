import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { fixtureVerifier } from './auth-fixture.js';
import {
  createNexusLocalIngress,
  NEXUS_LOCAL_PROFILE,
  NEXUS_LOCAL_AUDIENCE,
  NEXUS_LOCAL_TOKEN_TYPE,
} from '../../src/nexus-local.js';

const executable = process.env.NEXUS_NATIVE_BINARY;
if (!executable)
  throw Error(
    'NEXUS_NATIVE_BINARY must name prebuilt native runtime; never auto-download/build',
  );
const pair = await generateKeyPair('EdDSA');
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: 'local-test',
  alg: 'EdDSA',
  use: 'sig',
};
const issuer = 'urn:continuum:nexus-test';
const request = {
  tenant: 'alpha',
  computationId: 'c1',
  module: 'sum',
  path: 'run',
  fuel: 100000,
  memory: 65536,
  timeout: 1000,
  fork: false,
};
async function token(
  subject = 'alice',
  overrides: Record<string, unknown> = {},
) {
  return new SignJWT(overrides)
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: NEXUS_LOCAL_TOKEN_TYPE,
      kid: 'local-test',
    })
    .setIssuer(issuer)
    .setAudience(NEXUS_LOCAL_AUDIENCE)
    .setSubject(subject)
    .setJti('test')
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(pair.privateKey);
}
async function fixture(name: string) {
  return readFile(resolve('tests/nexus/fixtures', name + '.wasm'));
}
async function ingress(binary = executable!, name = 'sum') {
  return createNexusLocalIngress({
    profile: NEXUS_LOCAL_PROFILE,
    executable: binary,
    verifyCredential: fixtureVerifier(issuer, jwk),
    authorize: async () => true, // Explicit test compute permission only.
    modules: [{ tenant: 'alpha', id: 'sum', bytes: await fixture(name) }],
  });
}
async function run(name: string, changes = {}) {
  return (await ingress(executable!, name)).execute(
    await token(),
    'bounded-computation',
    1,
    { ...request, ...changes },
  );
}
test('real donor-derived runtime computes bounded sum, not a success simulation', async () => {
  const r = await run('sum');
  assert.equal(r.status, 'LOCAL_RESULT');
  if (r.status !== 'LOCAL_RESULT') return;
  assert.equal(r.value, 5050);
  assert.ok(r.fuelConsumed > 100 && r.fuelConsumed < request.fuel);
  assert.equal(
    r.moduleSha256,
    createHash('sha256')
      .update(await fixture('sum'))
      .digest('hex'),
  );
  assert.equal(r.scope, 'LOCAL_ONLY_NOT_PROVIDER_OBSERVATION');
  assert.ok(!('provider' in r) && !('COMMITTED' in r) && !('observation' in r));
});
test('real ingress rejects forged credentials and cross-tenant caller/body', async () => {
  const i = await ingress();
  for (const forged of [
    '',
    'alpha',
    { tenant: 'alpha' },
    (await token()).slice(0, -8) + 'forgedxx',
  ])
    assert.deepEqual(
      await i.execute(forged, 'bounded-computation', 1, request),
      { status: 'DENIED', reason: 'UNAUTHENTICATED' },
    );
  assert.deepEqual(
    await i.execute(
      await token('bob', { tenant: 'alpha' }),
      'bounded-computation',
      1,
      request,
    ),
    { status: 'DENIED', reason: 'TENANT_MISMATCH' },
  );
  assert.deepEqual(
    await i.execute(await token('unknown'), 'bounded-computation', 1, request),
    { status: 'DENIED', reason: 'UNAUTHENTICATED' },
  );
  assert.deepEqual(
    await i.execute(await token(), 'bounded-computation', 1, {
      ...request,
      tenant: 'beta',
    }),
    { status: 'DENIED', reason: 'TENANT_MISMATCH' },
  );
});
test('JWT wrong issuer/audience/type, expired or excessively long credential denied', async () => {
  const i = await ingress();
  for (const changes of [
    { aud: 'urn:continuum:effect-controller' },
    { iss: 'wrong' },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { exp: Math.floor(Date.now() / 1000) + 1000 },
  ]) {
    const t = await new SignJWT({
      sub: 'alice',
      jti: 'x',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: issuer,
      aud: NEXUS_LOCAL_AUDIENCE,
      ...changes,
    })
      .setProtectedHeader({
        alg: 'EdDSA',
        typ: NEXUS_LOCAL_TOKEN_TYPE,
        kid: 'local-test',
      })
      .sign(pair.privateKey);
    assert.equal(
      (await i.execute(t, 'bounded-computation', 1, request)).status,
      'DENIED',
    );
  }
  assert.equal(
    (await i.execute('x'.repeat(8193), 'bounded-computation', 1, request))
      .status,
    'DENIED',
  );
});
test('unknown contract never inspects opaque body and cannot start native runtime', async () => {
  const i = await ingress('/definitely/not/a/runtime');
  const opaque = new Proxy(
    {},
    {
      ownKeys() {
        throw Error('body accessed');
      },
      getPrototypeOf() {
        throw Error('body accessed');
      },
    },
  );
  assert.deepEqual(await i.execute({}, 'other', 1, opaque), {
    status: 'DENIED',
    reason: 'UNSUPPORTED_INTERFACE',
  });
  assert.deepEqual(await i.execute({}, 'bounded-computation', '1', opaque), {
    status: 'DENIED',
    reason: 'UNSUPPORTED_VERSION',
  });
});
test('strict profile rejects paths, authority fields, unknown registry and unsupported fork', async () => {
  for (const changes of [
    { module: '/etc/passwd' },
    { path: '../../run' },
    { provider: 'x' },
    { credential: 'x' },
    { memory: 0 },
    { memory: 65537 },
    { fuel: 0 },
    { fuel: 100000001 },
    { timeout: 1001 },
    { timeout: 0 },
    { memory: 16777217 },
    { fuel: NaN },
    { timeout: '100' },
  ])
    assert.equal((await run('sum', changes)).status, 'DENIED');
  assert.deepEqual(await run('sum', { fork: true }), {
    status: 'DENIED',
    reason: 'FORK_UNSUPPORTED',
  });
  assert.deepEqual(await run('sum', { module: 'missing' }), {
    status: 'DENIED',
    reason: 'MODULE_DENIED',
  });
  assert.deepEqual(await run('sum', { path: 'missing' }), {
    status: 'FAILED',
    reason: 'ENTRYPOINT_DENIED',
  });
  const i = await ingress();
  const { fuel: _, ...missing } = request;
  assert.equal(
    (await i.execute(await token(), 'bounded-computation', 1, missing)).status,
    'DENIED',
  );
  const getter = { ...request };
  Object.defineProperty(getter, 'fuel', {
    get() {
      throw Error('not read');
    },
  });
  assert.equal(
    (await i.execute(await token(), 'bounded-computation', 1, getter)).status,
    'DENIED',
  );
});
test('imports, fuel exhaustion, initial/growing memory and traps fail closed in real runtime', async () => {
  assert.deepEqual(await run('import'), {
    status: 'FAILED',
    reason: 'IMPORT_DENIED',
  });
  assert.deepEqual(await run('loop', { fuel: 10 }), {
    status: 'FAILED',
    reason: 'FUEL_EXHAUSTED',
  });
  assert.deepEqual(await run('memory'), {
    status: 'FAILED',
    reason: 'RESOURCE_LIMIT',
  });
  assert.equal((await run('grow')).status, 'FAILED');
  assert.deepEqual(await run('trap'), { status: 'FAILED', reason: 'TRAP' });
});
test('native deadline covers startup/compilation and next request runs after reap', async () => {
  const i = await ingress(executable!, 'loop');
  const t = await token();
  const before = Date.now();
  assert.deepEqual(
    await i.execute(t, 'bounded-computation', 1, {
      ...request,
      timeout: 1,
      fuel: 100000000,
    }),
    { status: 'FAILED', reason: 'TIMEOUT' },
  );
  assert.ok(Date.now() - before < 1000);
  const second = await i.execute(t, 'bounded-computation', 1, {
    ...request,
    fuel: 10,
  });
  assert.equal(second.status, 'FAILED');
  assert.equal(second.reason, 'FUEL_EXHAUSTED');
});
test('registry bytes immutable and tenant-scoped, no per-tenant name leakage', async () => {
  const bytes = await fixture('sum');
  const i = createNexusLocalIngress({
    profile: NEXUS_LOCAL_PROFILE,
    executable: executable!,
    verifyCredential: fixtureVerifier(issuer, jwk),
    authorize: async () => true, // Explicit test compute permission only.
    modules: [{ tenant: 'alpha', id: 'sum', bytes }],
  });
  bytes.fill(0);
  assert.equal(
    (await i.execute(await token(), 'bounded-computation', 1, request)).status,
    'LOCAL_RESULT',
  );
  assert.deepEqual(
    await i.execute(await token('bob'), 'bounded-computation', 1, {
      ...request,
      tenant: 'beta',
    }),
    { status: 'DENIED', reason: 'MODULE_DENIED' },
  );
});
test('native protocol adversaries: output cap, malformed response, native exit, environment and concurrency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-test-'));
  const helper = async (name: string, source: string) => {
    const p = join(dir, name);
    await writeFile(p, `#!/usr/bin/python3\n${source}\n`);
    await chmod(p, 0o700);
    return p;
  };
  try {
    for (const [name, src, reason] of [
      ['output', "print('x'*4096)", 'OUTPUT_LIMIT'],
      ['bad', "print('{bad')", 'INVALID_NATIVE_REPLY'],
      ['exit', 'import sys; sys.exit(7)', 'NATIVE_FAILURE'],
      ['claim', `print('{"status":"COMMITTED"}')`, 'INVALID_NATIVE_REPLY'],
    ]) {
      const i = await ingress(await helper(name, src));
      assert.deepEqual(
        await i.execute(await token(), 'bounded-computation', 1, request),
        { status: 'FAILED', reason },
      );
    }
    // Native-host probe, not guest functionality: process has empty env and actual rlimits.
    const probe = await helper(
      'probe',
      `import os,json,resource
ok=set(os.environ).issubset({'LC_CTYPE'}) and resource.getrlimit(resource.RLIMIT_AS)==(1073741824,1073741824) and resource.getrlimit(resource.RLIMIT_CPU)==(2,2) and resource.getrlimit(resource.RLIMIT_CORE)==(0,0)
print(json.dumps(dict(status='LOCAL_RESULT',value=1 if ok else 0,fuelConsumed=0)))`,
    );
    const r = await (
      await ingress(probe)
    ).execute(await token(), 'bounded-computation', 1, request);
    assert.equal(r.status, 'LOCAL_RESULT');
    if (r.status === 'LOCAL_RESULT') assert.equal(r.value, 1);
    const sleepy = await ingress(
      await helper('sleep', `import time; time.sleep(10); print('{}')`),
    );
    const t = await token();
    const one = sleepy.execute(t, 'bounded-computation', 1, {
      ...request,
      timeout: 200,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      await sleepy.execute(t, 'bounded-computation', 1, request),
      { status: 'DENIED', reason: 'BUSY' },
    );
    assert.deepEqual(await one, { status: 'FAILED', reason: 'TIMEOUT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('required current authorization gate binds exact caller/module and denies revoked/outage', async () => {
  let allowed = true;
  let outage = false;
  let checks = 0;
  const bytes = await fixture('sum');
  const i = createNexusLocalIngress({
    profile: NEXUS_LOCAL_PROFILE,
    executable: executable!,
    verifyCredential: fixtureVerifier(issuer, jwk),
    authorize: async (binding) => {
      checks++;
      assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.caller));
      assert.deepEqual(binding.caller, { subject: 'alice', tenant: 'alpha' });
      assert.equal(binding.module, 'sum');
      assert.equal(binding.computationId, 'c1');
      assert.equal(
        binding.moduleSha256,
        createHash('sha256').update(bytes).digest('hex'),
      );
      assert.equal(binding.path, 'run');
      assert.equal(binding.fuel, request.fuel);
      assert.equal(binding.memory, request.memory);
      assert.equal(binding.timeout, request.timeout);
      if (outage) throw Error('canonical enrollment store unavailable');
      return allowed;
    },
    modules: [{ tenant: 'alpha', id: 'sum', bytes }],
  });
  const t = await token();
  assert.equal(
    (await i.execute(t, 'bounded-computation', 1, request)).status,
    'LOCAL_RESULT',
  );
  allowed = false; // Same still-valid token cannot bypass changed canonical enrollment/policy.
  assert.deepEqual(await i.execute(t, 'bounded-computation', 1, request), {
    status: 'DENIED',
    reason: 'NOT_AUTHORIZED',
  });
  outage = true;
  assert.deepEqual(await i.execute(t, 'bounded-computation', 1, request), {
    status: 'DENIED',
    reason: 'AUTHORIZATION_UNAVAILABLE',
  });
  assert.equal(checks, 3);
  assert.equal(
    (await i.execute('forged', 'bounded-computation', 1, request)).status,
    'DENIED',
  );
  assert.equal(checks, 3); // No policy access or native spawn before authenticated identity.
});
test('host composition requires explicit profile, credential verifier and current policy', async () => {
  const base = {
    profile: NEXUS_LOCAL_PROFILE,
    executable: executable!,
    verifyCredential: fixtureVerifier(issuer, jwk),
    authorize: async () => true,
    modules: [],
  };
  for (const change of [
    { verifyCredential: undefined },
    { authorize: undefined },
    { profile: 'other' },
    { executable: 'relative' },
  ])
    assert.throws(() =>
      createNexusLocalIngress({ ...base, ...change } as unknown as Parameters<
        typeof createNexusLocalIngress
      >[0]),
    );
  const i = createNexusLocalIngress({
    ...base,
    verifyCredential: async () => {
      throw Error('identity offline');
    },
  });
  assert.deepEqual(
    await i.execute(await token(), 'bounded-computation', 1, request),
    { status: 'DENIED', reason: 'UNAUTHENTICATED' },
  );
});
