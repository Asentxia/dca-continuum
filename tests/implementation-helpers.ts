import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { pool, tx } from '../src/db.js';
import { IdentityVerifier } from '../src/identity-provider.js';
import {
  CapabilitySigner,
  PublicCapabilityVerifier,
} from '../src/production-capability.js';
import { AuthorityService } from '../src/authority-service.js';
import { ProductService } from '../src/product-service.js';
import { EffectController } from '../src/controller.js';
import type {
  ProviderAdapter,
  ProviderObservation,
} from '../src/provider-adapter.js';
import { gov, bootstrap, fence } from './helpers.js';
import { OrganizationService } from '../src/regency/organization-service.js';
import { MandateService } from '../src/regency/mandate-service.js';
export class LedgerFixture implements ProviderAdapter {
  readonly provider = 'fixture';
  rows: ProviderObservation[] = [];
  sends = 0;
  loseAck = false;
  unavailable = false;
  corrupt = false;
  supports(o: Record<string, any>) {
    return (
      o.provider === 'fixture' &&
      o.action === 'write' &&
      o.resource === 'fixture-object'
    );
  }
  async send(o: Record<string, any>) {
    this.sends++;
    this.rows.push({
      tenant: o.tenant,
      operation: o.id,
      digest: o.digest,
      idempotency_key: o.idempotency_key,
      payload: o.params,
    });
    if (this.loseAck) throw Error('fixture lost acknowledgement');
  }
  async lookup(o: Record<string, any>) {
    if (this.unavailable) throw Error('fixture readback unavailable');
    return this.rows
      .filter((x) => x.tenant === o.tenant && x.operation === o.id)
      .map((x) => (this.corrupt ? { ...x, digest: 'bad' } : x));
  }
}
export async function fixture(prefix: string) {
  await bootstrap();
  await gov.query(
    "INSERT INTO ct.resource_limits(tenant,max_jobs,max_storage,max_units) VALUES('a',1000,67108864,100000),('b',1000,67108864,100000) ON CONFLICT DO NOTHING",
  );
  const principal = 'p-' + prefix,
    issuer = 'https://' + prefix + '.test-identity.invalid',
    audience = 'urn:continuum:test:' + prefix;
  const ext = await generateKeyPair('EdDSA'),
    sig = await generateKeyPair('EdDSA');
  const keys = createLocalJWKSet({
    keys: [
      { ...(await exportJWK(ext.publicKey)), alg: 'EdDSA', kid: 'external' },
    ],
  });
  const base = {
    issuer,
    jwksUri: issuer + '/jwks',
    audience,
    algorithms: ['EdDSA'],
  };
  const human = new IdentityVerifier({ ...base, kind: 'user' }, keys),
    machine = new IdentityVerifier({ ...base, kind: 'machine' }, keys);
  for (const tenant of ['a', 'b']) {
    await gov.query(
      'INSERT INTO ct.principals(tenant,id,epoch,generation) VALUES($1,$2,1,1)',
      [tenant, principal],
    );
    await gov.query(
      "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role) VALUES($1,$3,$1,$4,'user',$5,NULL,'owner'),($2,$3,$2,$4,'machine',$5,$6,'worker')",
      [
        `${prefix}-owner-${tenant}`,
        `${prefix}-worker-${tenant}`,
        issuer,
        audience,
        tenant,
        principal,
      ],
    );
  }
  const productDb = pool('ct_product_api'),
    authDb = pool('ct_authority_api'),
    issuerDb = pool('ct_cap_issuer'),
    controllerDb = pool('ct_controller');
  const signer = new CapabilitySigner(
    sig.privateKey,
    'cap-key',
    'https://' + prefix + '.test-cap.invalid',
  );
  const caps = new PublicCapabilityVerifier(
    {
      keys: [
        {
          ...(await exportJWK(sig.publicKey)),
          alg: 'EdDSA',
          kid: 'cap-key',
          use: 'sig',
        },
      ],
    },
    'https://' + prefix + '.test-cap.invalid',
  );
  const authority = new AuthorityService(authDb, issuerDb, signer, fence),
    product = new ProductService(productDb, fence),
    provider = new LedgerFixture(),
    controller = new EffectController(controllerDb, provider, fence, 100);
  async function token(
    kind: 'user' | 'machine',
    tenant = 'a',
    overrides: Record<string, unknown> = {},
  ) {
    const claims: Record<string, unknown> = {
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['mfa'],
    };
    if (kind === 'machine') {
      const bound = (
        await gov.query(
          'SELECT generation,epoch FROM ct.principals WHERE tenant=$1 AND id=$2',
          [tenant, principal],
        )
      ).rows[0];
      claims.ct_gen = Number(bound.generation);
      claims.ct_epoch = Number(bound.epoch);
      const computer = (
        await gov.query(
          'SELECT generation FROM ct.computers WHERE tenant=$1 AND principal=$2',
          [tenant, principal],
        )
      ).rows[0];
      if (computer) claims.ct_placement = Number(computer.generation);
    }
    return new SignJWT({
      ...claims,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'external' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(`${prefix}-${kind === 'user' ? 'owner' : 'worker'}-${tenant}`)
      .setIssuedAt()
      .setExpirationTime(
        typeof overrides.exp === 'number' ? overrides.exp : '10m',
      )
      .sign(ext.privateKey);
  }
  async function actor(kind: 'user' | 'machine', tenant = 'a') {
    return (kind === 'user' ? human : machine).verify(
      await token(kind, tenant),
    );
  }
  const organizations = new OrganizationService();
  const mandateService = new MandateService();
  const admission: Record<
    string,
    { organization: string; mandate: string; mandateVersion: number }
  > = {};
  for (const tenant of ['a', 'b']) {
    const organization = `${prefix}-org`;
    const mandate = `${prefix}-mandate`;
    await tx(authDb, async (c) => {
      await organizations.create(
        c,
        tenant,
        `${prefix}-owner-${tenant}`,
        organization,
        prefix + ' organization',
      );
      await organizations.addMembership(
        c,
        tenant,
        organization,
        'vera',
        principal,
        'steward',
        false,
      );
      const recorded = await mandateService.record(
        c,
        tenant,
        `${prefix}-owner-${tenant}`,
        organization,
        mandate,
        'Fixture mandate',
        'Fixture mandate for ' + prefix,
        0,
      );
      admission[tenant] = {
        organization,
        mandate,
        mandateVersion: recorded.version,
      };
    });
  }
  async function intent(
    id: string,
    approved = false,
    objective?: string,
    parameters?: unknown,
  ) {
    const owner = await actor('user'),
      worker = await actor('machine'),
      deadline = new Date(Date.now() + 3600000).toISOString();
    await authority.createGrant(owner, {
      id: 'g-' + id,
      principal,
      action: 'write',
      resource: 'fixture-object',
      expires: deadline,
      maxCost: 5,
      budget: 20,
    });
    await product.createTask(worker, {
      id: 't-' + id,
      principal,
      objective: objective ?? 'Fixture task ' + id,
      deadline,
      ...admission.a,
    });
    const x = {
      id,
      task: 't-' + id,
      grant: 'g-' + id,
      provider: 'fixture',
      action: 'write',
      resource: 'fixture-object',
      params: parameters ?? { value: id },
      cost: 1,
      deadline,
    };
    const op = await product.propose(worker, x);
    await authority.assign(owner, {
      identity: `${prefix}-worker-a`,
      operation: id,
      expires: deadline,
    });
    if (approved)
      await authority.approve(owner, {
        operation: id,
        digest: op.digest,
        expires: deadline,
      });
    return { owner, worker, x, op };
  }
  async function capability(id: string) {
    return caps.verify(
      (await authority.renew(await actor('machine'), id)).token,
    );
  }
  return {
    prefix,
    principal,
    issuer,
    audience,
    human,
    machine,
    token,
    actor,
    authority,
    product,
    provider,
    controller,
    caps,
    intent,
    admission,
    capability,
    productDb,
    controllerDb,
    close: () =>
      Promise.all(
        [productDb, authDb, issuerDb, controllerDb].map((p) => p.end()),
      ),
  };
}
