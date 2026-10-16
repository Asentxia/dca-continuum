import pg from 'pg';
export interface StagingDatabaseConfig {
  enabled: boolean;
  approvalReference: string;
  host: string;
  database: string;
  role: string;
  ca: string;
}
export function stagingDatabase(
  x: StagingDatabaseConfig,
  password: () => Promise<string>,
) {
  if (
    !x.enabled ||
    !x.approvalReference ||
    !x.host ||
    !x.database ||
    !x.ca ||
    !/^ct_(product_api|authority_api|cap_issuer|controller|computer_broker|context_service|recovery|evidence_export|resource_service|scheduler|console_reader)$/.test(
      x.role,
    )
  )
    throw Error('approved restricted staging database configuration required');
  return new pg.Pool({
    host: x.host,
    port: 5432,
    user: x.role,
    database: x.database,
    password,
    ssl: { ca: x.ca, rejectUnauthorized: true },
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 10000,
    application_name: 'continuum-staging-' + x.role,
  });
}
