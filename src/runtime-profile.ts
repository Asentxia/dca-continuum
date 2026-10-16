/** Test trust is explicit, incompatible with staging/production, and never a fallback. */
export type Environment = Readonly<Record<string, string | undefined>>;
export const fixtureDatabases = new Set([
  'ct_test',
  'ct_restore',
  'ct_recovery_test',
  'ct_console_dev',
  'ct_console_test',
  'ct_console_browser',
  'ct_provider_read_test',
]);
export function assertLocalFixtures(
  surface: string,
  env: Environment = process.env,
): void {
  const forbiddenConfiguration = [
    'WORKOS_API_KEY',
    'WORKOS_COOKIE_PASSWORD',
    'WORKOS_CLIENT_ID',
    'DATABASE_URL',
    'CT_DATABASE_URL',
    'CT_PRODUCTION_CONFIG',
    'CT_STAGING_CONFIG',
  ];
  if (
    env.NODE_ENV === 'production' ||
    env.CT_RUNTIME_ENV !== 'local-test' ||
    env.CT_ALLOW_LOCAL_FIXTURES !== 'yes' ||
    (env.CT_DEPLOYMENT_ENV && env.CT_DEPLOYMENT_ENV !== 'local-test') ||
    (env.CT_CONSOLE_MODE && env.CT_CONSOLE_MODE !== 'LOCAL_FIXTURE') ||
    forbiddenConfiguration.some((key) => Boolean(env[key])) ||
    (env.PGHOST && env.PGHOST !== '127.0.0.1') ||
    (env.PGPORT && env.PGPORT !== '55432') ||
    (env.CT_DATABASE && !fixtureDatabases.has(env.CT_DATABASE))
  ) {
    throw Error(
      `${surface}: explicit isolated local fixture profile required; staging/production denied`,
    );
  }
}
export function assertFixtureDatabase(database: string): void {
  assertLocalFixtures('database');
  if (!fixtureDatabases.has(database))
    throw Error('database: named disposable local fixture required');
}
