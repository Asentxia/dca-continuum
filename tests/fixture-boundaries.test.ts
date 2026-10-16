import { ConsoleCommands } from '../src/console/commands.js';
import { ConsoleReads } from '../src/console/reads.js';
import { issueCapability } from '../src/capability.js';
import { assertLocalFixtures } from '../src/runtime-profile.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityVerifier } from '../src/identity-provider.js';
import { FixtureAdapter } from '../internal/fixtures/provider-adapter.js';
import { pool } from '../src/db.js';
import { consoleApi } from '../src/console/api.js';

function production<T>(fn: () => T): T {
  const names = [
    'NODE_ENV',
    'CT_RUNTIME_ENV',
    'CT_ALLOW_LOCAL_FIXTURES',
    'CT_CONSOLE_MODE',
  ];
  const previous = names.map((name) => process.env[name]);
  process.env.NODE_ENV = 'production';
  process.env.CT_RUNTIME_ENV = 'staging';
  process.env.CT_ALLOW_LOCAL_FIXTURES = 'yes'; // Deliberate contradictory misconfiguration.
  process.env.CT_CONSOLE_MODE = 'LOCAL_FIXTURE';
  try {
    return fn();
  } finally {
    names.forEach((name, i) =>
      previous[i] === undefined
        ? delete process.env[name]
        : (process.env[name] = previous[i]),
    );
  }
}
test('production/staging rejects a fixture provider before any network request', () => {
  production(() =>
    assert.throws(
      () =>
        new FixtureAdapter(
          'http://127.0.0.1:5555',
          'noncredential-test-marker',
        ),
      /fixture|local/i,
    ),
  );
});
test('production/staging rejects injected local JWKS before accepting identity', () => {
  production(() =>
    assert.throws(
      () =>
        new IdentityVerifier(
          {
            issuer: 'https://test-identity.invalid',
            jwksUri: 'https://test-identity.invalid/jwks',
            audience: 'urn:test',
            kind: 'user',
            algorithms: ['EdDSA'],
          },
          async () => {
            throw Error('No token is evaluated by this constructor probe');
          },
        ),
      /fixture|local/i,
    ),
  );
});
test('production/staging rejects the trust-authenticated local database pool', () => {
  production(() => assert.throws(() => pool('localtest'), /fixture|local/i));
});
test('production/staging rejects fixture login injection into a domain API', () => {
  production(() =>
    assert.throws(
      () =>
        consoleApi({} as never, {} as never, {} as never, {
          fixtureLogin: async () => 'invalid-test-only',
          fixtureServerKey: 'noncredential-test-marker',
        }),
      /fixture|local/i,
    ),
  );
});

test('local command profile cannot activate production authority mutations', () => {
  production(() =>
    assert.throws(
      () =>
        new ConsoleCommands(
          {} as never,
          {} as never,
          {} as never,
          'test-fence',
          'LOCAL_FIXTURE',
        ),
      /fixture|local/i,
    ),
  );
});
test('local read profile cannot present a production snapshot as qualified fixture truth', () => {
  production(() =>
    assert.throws(
      () =>
        new ConsoleReads(
          {} as never,
          {} as never,
          'LOCAL_FIXTURE',
          'test',
          'test-fence',
        ),
      /fixture|local/i,
    ),
  );
});
test('HMAC fixture issuer refuses production even if a key is supplied', () => {
  production(() =>
    assert.throws(
      () => issueCapability('test-not-a-secret', {} as never),
      /fixture|local/i,
    ),
  );
});
test('default and conflicting local profiles fail closed', () => {
  for (const env of [
    {},
    { CT_RUNTIME_ENV: 'local-test' },
    { CT_RUNTIME_ENV: 'staging', CT_ALLOW_LOCAL_FIXTURES: 'yes' },
    {
      CT_RUNTIME_ENV: 'local-test',
      CT_ALLOW_LOCAL_FIXTURES: 'yes',
      WORKOS_API_KEY: 'test-marker',
    },
    {
      CT_RUNTIME_ENV: 'local-test',
      CT_ALLOW_LOCAL_FIXTURES: 'yes',
      PGHOST: 'stage.invalid',
    },
  ])
    assert.throws(() => assertLocalFixtures('probe', env), /fixture|local/i);
  assert.doesNotThrow(() =>
    assertLocalFixtures('probe', {
      CT_RUNTIME_ENV: 'local-test',
      CT_ALLOW_LOCAL_FIXTURES: 'yes',
      PGHOST: '127.0.0.1',
      PGPORT: '55432',
    }),
  );
});
