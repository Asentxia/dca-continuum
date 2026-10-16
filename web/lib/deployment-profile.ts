/** PRODUCT is baked into the ordinary build. Runtime environment cannot turn it into test trust. */
export type ConsoleEnvironment = Readonly<Record<string, string | undefined>>;
export const compiledConsoleProfile =
  process.env.CT_COMPILED_PROFILE === 'LOCAL_TEST' ? 'LOCAL_TEST' : 'PRODUCT';
export function consoleProfile(
  env: ConsoleEnvironment,
  compiled: 'PRODUCT' | 'LOCAL_TEST',
): 'PRODUCT' | 'LOCAL_TEST' {
  if (compiled === 'PRODUCT') {
    if (
      env.CT_CONSOLE_MODE === 'LOCAL_FIXTURE' ||
      env.CT_ALLOW_LOCAL_FIXTURES === 'yes' ||
      env.CT_RUNTIME_ENV === 'local-test' ||
      env.CT_FIXTURE_SERVER_KEY ||
      env.CT_LOCAL_TEST_BUILD === 'yes'
    ) {
      throw Error('Product build refuses fixture trust configuration');
    }
    return 'PRODUCT';
  }
  if (
    env.CT_RUNTIME_ENV !== 'local-test' ||
    env.CT_ALLOW_LOCAL_FIXTURES !== 'yes' ||
    env.CT_CONSOLE_MODE !== 'LOCAL_FIXTURE' ||
    (env.CT_DEPLOYMENT_ENV && env.CT_DEPLOYMENT_ENV !== 'local-test') ||
    [
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_ID',
      'WORKOS_COOKIE_PASSWORD',
      'DATABASE_URL',
      'CT_DATABASE_URL',
    ].some((k) => Boolean(env[k]))
  ) {
    throw Error('Dedicated local-test build requires isolated local profile');
  }
  for (const key of ['CT_CONSOLE_ORIGIN', 'CT_DOMAIN_API_ORIGIN']) {
    const u = new URL(env[key] ?? '');
    if (
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    ) {
      throw Error('Dedicated local-test build is loopback-only');
    }
  }
  return 'LOCAL_TEST';
}
