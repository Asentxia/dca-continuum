import { describe, it, expect } from 'vitest';
import { consoleProfile } from '../lib/deployment-profile';
const local = {
  CT_RUNTIME_ENV: 'local-test',
  CT_ALLOW_LOCAL_FIXTURES: 'yes',
  CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
  CT_CONSOLE_ORIGIN: 'http://127.0.0.1:5661',
  CT_DOMAIN_API_ORIGIN: 'http://127.0.0.1:5660',
};
describe('immutable product/local-test profile boundary', () => {
  it('ordinary product build rejects a runtime-only fixture mode flip', () =>
    expect(() =>
      consoleProfile({ CT_CONSOLE_MODE: 'LOCAL_FIXTURE' }, 'PRODUCT'),
    ).toThrow());
  it('product build rejects injected fixture keys and test profiles', () => {
    for (const env of [
      { CT_FIXTURE_SERVER_KEY: 'test-marker' },
      { CT_ALLOW_LOCAL_FIXTURES: 'yes' },
      { CT_RUNTIME_ENV: 'local-test' },
      { CT_LOCAL_TEST_BUILD: 'yes' },
    ])
      expect(() => consoleProfile(env, 'PRODUCT')).toThrow();
  });
  it('local-test build requires all explicit local profile controls', () => {
    for (const name of [
      'CT_RUNTIME_ENV',
      'CT_ALLOW_LOCAL_FIXTURES',
      'CT_CONSOLE_MODE',
    ]) {
      const env = { ...local, [name]: undefined };
      expect(() => consoleProfile(env, 'LOCAL_TEST')).toThrow();
    }
  });
  it('local-test build rejects staging/production or real identity configuration', () => {
    for (const extra of [
      { CT_DEPLOYMENT_ENV: 'staging' },
      { CT_DEPLOYMENT_ENV: 'production' },
      { WORKOS_API_KEY: 'test-marker' },
    ])
      expect(() =>
        consoleProfile({ ...local, ...extra }, 'LOCAL_TEST'),
      ).toThrow();
  });
  it('local-test build rejects public, credentialled, path and redirect-like origins', () => {
    for (const origin of [
      'https://stage.invalid',
      'http://0.0.0.0:5661',
      'http://localhost:5661',
      'http://127.0.0.1:5661/path',
      'http://127.0.0.1:5661/?target=x',
    ])
      expect(() =>
        consoleProfile({ ...local, CT_CONSOLE_ORIGIN: origin }, 'LOCAL_TEST'),
      ).toThrow();
  });
  it('explicit local build works only on loopback; normal product works without test trust', () => {
    expect(consoleProfile(local, 'LOCAL_TEST')).toBe('LOCAL_TEST');
    expect(
      consoleProfile(
        { CT_CONSOLE_MODE: 'STAGING', CT_RUNTIME_ENV: 'staging' },
        'PRODUCT',
      ),
    ).toBe('PRODUCT');
  });
});
