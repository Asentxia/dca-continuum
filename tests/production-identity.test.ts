import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import {
  IdentityVerifier,
  type VerifiedIdentity,
} from '../src/identity-provider.js';
import {
  CapabilitySigner,
  PublicCapabilityVerifier,
} from '../src/production-capability.js';
import { AuthorityService } from '../src/authority-service.js';
import { identityApi } from '../src/identity-api.js';
import { pool } from '../src/db.js';
import { admin, gov, bootstrap, makeOp, fence } from './helpers.js';
import { serveController } from '../src/controller-server.js';
import { EffectController } from '../src/controller.js';
import { FixtureAdapter } from '../internal/fixtures/provider-adapter.js';
import { callController } from '../src/controller-client.js';
import { config, start, stop, secrets } from './process-helpers.js';
import type http from 'node:http';
import type { ChildProcess } from 'node:child_process';
const authorityDb = pool('ct_authority_api'),
  issuerDb = pool('ct_cap_issuer'),
  ctlDb = pool('ct_controller');
const externalIssuer = 'https://test-issuer.qualification.invalid',
  resource = 'urn:continuum:test-identity';
let external: Awaited<ReturnType<typeof generateKeyPair>>,
  signing: Awaited<ReturnType<typeof generateKeyPair>>,
  service: AuthorityService,
  capVerifier: PublicCapabilityVerifier,
  userVerifier: IdentityVerifier,
  machineVerifier: IdentityVerifier,
  api: http.Server,
  ctl: http.Server,
  provider: ChildProcess;
let endpoint: string;
let ownerApi: http.Server;
let ownerEndpoint: string;
async function jwt(sub: string, overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['mfa'],
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'external-test' })
    .setIssuer(externalIssuer)
    .setAudience(resource)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(external.privateKey);
}
async function actor(
  sub: string,
  kind: 'user' | 'machine' = 'machine',
  overrides: Record<string, unknown> = {},
) {
  const claims = { ...overrides };
  if (kind === 'machine' && claims.ct_gen === undefined) {
    const bound = (
      await gov.query(
        'SELECT p.generation,p.epoch FROM ct.identities i JOIN ct.principals p ON p.tenant=i.tenant AND p.id=i.principal WHERE i.subject=$1 AND i.kind=$2',
        [sub, kind],
      )
    ).rows[0];
    if (bound) {
      claims.ct_gen = Number(bound.generation);
      claims.ct_epoch = Number(bound.epoch);
    }
  }
  return (kind === 'user' ? userVerifier : machineVerifier).verify(
    await jwt(sub, claims),
  );
}
async function request(token: string, path: string, body: unknown) {
  return fetch(endpoint + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
before(async () => {
  await bootstrap();
  external = await generateKeyPair('EdDSA');
  signing = await generateKeyPair('EdDSA');
  const ext = {
    ...(await exportJWK(external.publicKey)),
    alg: 'EdDSA',
    kid: 'external-test',
    use: 'sig',
  };
  const configIdentity = {
    issuer: externalIssuer,
    jwksUri: externalIssuer + '/jwks',
    audience: resource,
    algorithms: ['EdDSA'],
  };
  userVerifier = new IdentityVerifier(
    { ...configIdentity, kind: 'user' },
    createLocalJWKSet({ keys: [ext] }),
  );
  machineVerifier = new IdentityVerifier(
    { ...configIdentity, kind: 'machine' },
    createLocalJWKSet({ keys: [ext] }),
  );
  const pub = {
    ...(await exportJWK(signing.publicKey)),
    kid: 'cap-test',
    alg: 'EdDSA',
    use: 'sig',
  };
  capVerifier = new PublicCapabilityVerifier(
    { keys: [pub] },
    'https://issuer.qualification.invalid',
  );
  service = new AuthorityService(
    authorityDb,
    issuerDb,
    new CapabilitySigner(
      signing.privateKey,
      'cap-test',
      'https://issuer.qualification.invalid',
    ),
    fence,
  );
  await gov.query(
    "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role) VALUES('owner-a',$1,'owner-a',$2,'user','a',NULL,'owner'),('owner-b',$1,'owner-b',$2,'user','b',NULL,'owner'),('worker-a',$1,'worker-a',$2,'machine','a','agent','worker'),('worker-b',$1,'worker-b',$2,'machine','b','agent','worker')",
    [externalIssuer, resource],
  );
  api = identityApi(machineVerifier, service);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  endpoint = 'http://127.0.0.1:' + (api.address() as any).port;
  ownerApi = identityApi(userVerifier, service);
  await new Promise<void>((r) => ownerApi.listen(0, '127.0.0.1', r));
  ownerEndpoint = 'http://127.0.0.1:' + (ownerApi.address() as any).port;

  config('.local/pq-provider.json', {});
  provider = await start(
    'dist/tests/provider-emulator.js',
    '.local/pq-provider.json',
    'PQ-identity-provider',
  );
  ctl = await serveController(
    process.cwd() + '/.local/pq-controller.sock',
    capVerifier,
    new EffectController(
      ctlDb,
      new FixtureAdapter('http://127.0.0.1:56670', secrets.providerSecret),
      fence,
    ),
  );
});
after(async () => {
  if (api) await new Promise<void>((r) => api.close(() => r()));
  if (ctl) await new Promise<void>((r) => ctl.close(() => r()));
  if (ownerApi) await new Promise<void>((r) => ownerApi.close(() => r()));
  await stop(provider);
  await Promise.all(
    [authorityDb, issuerDb, ctlDb, admin, gov].map((x) => x.end()),
  );
});
test('Identity issuer/audience/signature/expiry checks reject token confusion', async () => {
  await assert.rejects(
    machineVerifier.verify(
      await new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: 'external-test' })
        .setIssuer('https://evil.invalid')
        .setAudience(resource)
        .setSubject('worker-a')
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(external.privateKey),
    ),
  );
  await assert.rejects(
    machineVerifier.verify(
      await new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: 'external-test' })
        .setIssuer(externalIssuer)
        .setAudience('other-api')
        .setSubject('worker-a')
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(external.privateKey),
    ),
  );
  await assert.rejects(
    machineVerifier.verify(
      await new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: 'external-test' })
        .setIssuer(externalIssuer)
        .setAudience(resource)
        .setSubject('worker-a')
        .setIssuedAt()
        .setExpirationTime(0)
        .sign(external.privateKey),
    ),
  );
  const other = await generateKeyPair('EdDSA');
  await assert.rejects(
    machineVerifier.verify(
      await new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: 'external-test' })
        .setIssuer(externalIssuer)
        .setAudience(resource)
        .setSubject('worker-a')
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(other.privateKey),
    ),
  );
});
test('Identity unknown header key URL and unsafe JWKS configuration rejected', async () => {
  await assert.rejects(
    machineVerifier.verify(
      await new SignJWT({})
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: 'external-test',
          jku: 'http://169.254.169.254/',
        })
        .setIssuer(externalIssuer)
        .setAudience(resource)
        .setSubject('worker-a')
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(external.privateKey),
    ),
  );
  assert.throws(
    () =>
      new IdentityVerifier({
        issuer: externalIssuer,
        jwksUri: 'http://127.0.0.1/jwks',
        audience: resource,
        kind: 'machine',
        algorithms: ['EdDSA'],
      }),
  );
});
test('Machine cannot create/widen grants even with signed token role=owner', async () => {
  const w = await actor('worker-a', 'machine', { role: 'owner', tenant: 'b' });
  await assert.rejects(
    service.createGrant(w, {
      id: 'pq-escalation',
      principal: 'agent',
      action: 'write',
      resource: 'fixture-object',
      expires: new Date(Date.now() + 60000).toISOString(),
      maxCost: 1,
      budget: 1,
    }),
  );
  await assert.rejects(service.revoke(w, 'anything'));
});
test('Fresh enrolled owner creates bounded grant; tenant derived from enrollment', async () => {
  const a = await actor('owner-a', 'user', { tenant: 'b' });
  assert.deepEqual(
    await service.createGrant(a, {
      id: 'pq-real-governance',
      principal: 'agent',
      action: 'write',
      resource: 'fixture-object',
      expires: new Date(Date.now() + 60000).toISOString(),
      maxCost: 1,
      budget: 2,
    }),
    { id: 'pq-real-governance', tenant: 'a' },
  );
});
test('Missing/stale human MFA and unknown enrollment cannot approve', async () => {
  const o = await makeOp('pq-owner-fresh', { approve: false });
  await assert.rejects(
    service.approve(await actor('owner-a', 'user', { amr: [] }), {
      operation: o.id,
      digest: o.digest,
      expires: new Date(Date.now() + 50000).toISOString(),
    }),
  );
  await assert.rejects(
    service.approve(
      await actor('owner-a', 'user', {
        auth_time: Math.floor(Date.now() / 1000) - 1000,
      }),
      {
        operation: o.id,
        digest: o.digest,
        expires: new Date(Date.now() + 50000).toISOString(),
      },
    ),
  );
  await assert.rejects(service.renew(await actor('unknown'), o.id));
});
test('Exact-action owner approval and assignment bind machine identity/digest', async () => {
  const o = await makeOp('pq-approved', { approve: false });
  const owner = await actor('owner-a', 'user');
  await assert.rejects(
    service.approve(owner, {
      operation: o.id,
      digest: '0'.repeat(64),
      expires: new Date(Date.now() + 50000).toISOString(),
    }),
  );
  await service.approve(owner, {
    operation: o.id,
    digest: o.digest,
    expires: new Date(Date.now() + 50000).toISOString(),
  });
  await service.assign(owner, {
    identity: 'worker-a',
    operation: o.id,
    expires: new Date(Date.now() + 50000).toISOString(),
  });
  const r = await service.renew(await actor('worker-a'), o.id);
  const c = await capVerifier.verify(r.token);
  assert.deepEqual(c.operations, [o.id]);
  assert.equal(c.tenant, 'a');
  assert.ok(c.expires <= Date.now() + 90000);
  assert.equal(
    (
      await callController(
        process.cwd() + '/.local/pq-controller.sock',
        r.token,
        o.id,
      )
    ).state,
    'COMMITTED',
  );
});
test('Unknown assignment, other tenant, machine approval and forged body denied', async () => {
  const o = await makeOp('pq-unassigned');
  await assert.rejects(service.renew(await actor('worker-a'), o.id));
  await assert.rejects(service.renew(await actor('worker-b'), 'pq-approved'));
  await assert.rejects(
    service.approve(await actor('worker-a'), {
      operation: o.id,
      digest: o.digest,
      expires: new Date(Date.now() + 50000).toISOString(),
    }),
  );
  const r = await request(await jwt('worker-a'), '/renew', {
    operation: o.id,
    tenant: 'b',
    principal: 'agent',
    expires: Date.now() + 86400000,
  });
  assert.equal(r.status, 403);
});
test('Renewal after revoke denied; previously issued token cannot dispatch revoked operation', async () => {
  const o = await makeOp('pq-revoked-after-mint');
  const owner = await actor('owner-a', 'user');
  await service.assign(owner, {
    identity: 'worker-a',
    operation: o.id,
    expires: new Date(Date.now() + 50000).toISOString(),
  });
  const r = await service.renew(await actor('worker-a'), o.id);
  await service.revoke(owner, o.grant_id);
  await assert.rejects(service.renew(await actor('worker-a'), o.id));
  assert.equal(
    (
      await callController(
        process.cwd() + '/.local/pq-controller.sock',
        r.token,
        o.id,
      )
    ).state,
    'DENIED',
  );
});
test('Renewal after approval expiry, disabled enrollment or recovery fence denied', async () => {
  const o = await makeOp('pq-expire-approval');
  await service.assign(await actor('owner-a', 'user'), {
    identity: 'worker-a',
    operation: o.id,
    expires: new Date(Date.now() + 50000).toISOString(),
  });
  await gov.query(
    "UPDATE ct.approvals SET expires=now()-interval '1 second' WHERE tenant='a' AND operation=$1",
    [o.id],
  );
  await assert.rejects(service.renew(await actor('worker-a'), o.id));
  await gov.query(
    "UPDATE ct.identities SET active=false,version=version+1 WHERE id='worker-a'",
  );
  await assert.rejects(service.renew(await actor('worker-a'), 'pq-approved'));
  await gov.query(
    "UPDATE ct.identities SET active=true,version=version+1 WHERE id='worker-a'",
  );
  await gov.query('UPDATE ct.control SET blocked=true');
  await assert.rejects(service.renew(await actor('worker-a'), 'pq-approved'));
  await gov.query('UPDATE ct.control SET blocked=false');
});
test('Disabled workload identity invalidates an already minted effect capability', async () => {
  const o = await makeOp('pq-old-identity-cap');
  await service.assign(await actor('owner-a', 'user'), {
    identity: 'worker-a',
    operation: o.id,
    expires: new Date(Date.now() + 50000).toISOString(),
  });
  const r = await service.renew(await actor('worker-a'), o.id);
  await gov.query(
    "UPDATE ct.identities SET active=false,version=version+1 WHERE id='worker-a'",
  );
  assert.equal(
    (
      await callController(
        process.cwd() + '/.local/pq-controller.sock',
        r.token,
        o.id,
      )
    ).state,
    'DENIED',
  );
  await gov.query(
    "UPDATE ct.identities SET active=true,version=version+1 WHERE id='worker-a'",
  );
});
test('Issuer/controller have public-key-only boundary and cannot issue domain grants directly', async () => {
  await assert.rejects(issuerDb.query('UPDATE ct.grants SET revoked=false'), {
    code: '42501',
  });
  await assert.rejects(
    issuerDb.query(
      "INSERT INTO ct.approvals(tenant,operation,digest,grant_version,approved_by,expires) VALUES('a','pq-approved','fake',1,'worker',now())",
    ),
    { code: '42501' },
  );
  assert.throws(
    () =>
      new PublicCapabilityVerifier(
        {
          keys: [
            {
              ...{ kty: 'OKP', crv: 'Ed25519', x: 'bad' },
              d: 'private',
              kid: 'x',
              alg: 'EdDSA',
              use: 'sig',
            },
          ],
        },
        'x',
      ),
  );
});
test('Capabilities cannot be forged/widened with controller verification key', async () => {
  const r = await service.renew(await actor('worker-a'), 'pq-approved');
  const parts = r.token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.operations.push('pq-unassigned');
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  await assert.rejects(capVerifier.verify(parts.join('.')));
});
test('Client can obtain fresh bounded capability without reusing expired token (local clock fixture)', async () => {
  const owner = await actor('owner-a', 'user');
  const o = await makeOp('pq-renew-fresh');
  await service.assign(owner, {
    identity: 'worker-a',
    operation: o.id,
    expires: new Date(Date.now() + 50000).toISOString(),
  });
  const first = await service.renew(await actor('worker-a'), o.id);
  const second = await service.renew(await actor('worker-a'), o.id);
  assert.notEqual(first.token, second.token);
  assert.ok(second.expires <= Date.now() + 90000);
});

test('blocked recovery cannot mint a grant through the identity API', async () => {
  await gov.query('UPDATE ct.control SET blocked=true');
  try {
    const body = {
      id: 'pq-blocked-grant',
      principal: 'agent',
      action: 'write',
      resource: 'fixture-object',
      expires: new Date(Date.now() + 60000).toISOString(),
      maxCost: 1,
      budget: 1,
    };
    await assert.rejects(
      service.createGrant(await actor('owner-a', 'user'), body),
      /recovery fence/,
    );
    const http = await fetch(ownerEndpoint + '/grants', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + (await jwt('owner-a')),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    assert.equal(http.status, 403);
    assert.equal(
      Number(
        (
          await gov.query(
            "SELECT count(*) FROM ct.grants WHERE tenant='a' AND id='pq-blocked-grant'",
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    await gov.query('UPDATE ct.control SET blocked=false');
  }
});
test('blocked recovery cannot record an assignment through the identity API', async () => {
  const o = await makeOp('pq-blocked-assign', { approve: false });
  await gov.query('UPDATE ct.control SET blocked=true');
  try {
    const body = {
      identity: 'worker-a',
      operation: o.id,
      expires: new Date(Date.now() + 50000).toISOString(),
    };
    await assert.rejects(
      service.assign(await actor('owner-a', 'user'), body),
      /recovery fence/,
    );
    const http = await fetch(ownerEndpoint + '/assignments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + (await jwt('owner-a')),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    assert.equal(http.status, 403);
    assert.equal(
      Number(
        (
          await gov.query(
            "SELECT count(*) FROM ct.assignments WHERE tenant='a' AND operation='pq-blocked-assign'",
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    await gov.query('UPDATE ct.control SET blocked=false');
  }
});
test('enrolled owner revoke still narrows a grant while recovery is blocked', async () => {
  const owner = await actor('owner-a', 'user');
  await service.createGrant(owner, {
    id: 'pq-revoke-while-blocked',
    principal: 'agent',
    action: 'write',
    resource: 'fixture-object',
    expires: new Date(Date.now() + 60000).toISOString(),
    maxCost: 1,
    budget: 1,
  });
  await gov.query('UPDATE ct.control SET blocked=true');
  try {
    assert.deepEqual(await service.revoke(owner, 'pq-revoke-while-blocked'), {
      grant: 'pq-revoke-while-blocked',
      revoked: true,
    });
    assert.equal(
      (
        await gov.query(
          "SELECT revoked FROM ct.grants WHERE tenant='a' AND id='pq-revoke-while-blocked'",
        )
      ).rows[0].revoked,
      true,
    );
  } finally {
    await gov.query('UPDATE ct.control SET blocked=false');
  }
});
test('Governance HTTP endpoint verifies human identity; worker cannot use it', async () => {
  const o = await makeOp('pq-http-approve', { approve: false });
  const body = {
    operation: o.id,
    digest: o.digest,
    expires: new Date(Date.now() + 40000).toISOString(),
  };
  const worker = await fetch(ownerEndpoint + '/approvals', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + (await jwt('worker-a')),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(worker.status, 403);
  const owner = await fetch(ownerEndpoint + '/approvals', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + (await jwt('owner-a')),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(owner.status, 200);
});
