-- Additive Gemini connection records. Existing tasks and VERA profiles are not rewritten.
BEGIN;
SET ROLE ct_owner;

CREATE TABLE IF NOT EXISTS ct.model_connections (
  tenant text NOT NULL REFERENCES ct.tenants (id),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  name text NOT NULL CHECK (
    length(name) BETWEEN 1 AND 200
    AND btrim(name) <> ''
  ),
  provider text NOT NULL CHECK (provider = 'gemini'),
  status text NOT NULL CHECK (status IN ('AWAITING_KEY', 'SEALED', 'REVOKED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  model text CHECK (
    model IS NULL OR model ~ '^models/[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$'
  ),
  supported_models text[] NOT NULL DEFAULT '{}',
  verification_label text NOT NULL DEFAULT 'not verified'
    CHECK (verification_label IN ('not verified', 'mock-tested / live test pending')),
  assigned_principal text,
  created_by text NOT NULL,
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, created_by) REFERENCES ct.identities (tenant, id),
  FOREIGN KEY (tenant, assigned_principal) REFERENCES ct.principals (tenant, id)
);

CREATE TABLE IF NOT EXISTS ct.model_connection_secrets (
  tenant text NOT NULL,
  connection_id text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 16),
  key_version integer NOT NULL CHECK (key_version = 1),
  PRIMARY KEY (tenant, connection_id),
  FOREIGN KEY (tenant, connection_id) REFERENCES ct.model_connections (tenant, id)
);

CREATE TABLE IF NOT EXISTS ct.model_connection_limits (
  tenant text NOT NULL,
  connection_id text NOT NULL,
  max_requests bigint NOT NULL CHECK (max_requests BETWEEN 1 AND 20),
  max_input_chars bigint NOT NULL CHECK (max_input_chars BETWEEN 1 AND 4000),
  max_output_chars bigint NOT NULL CHECK (max_output_chars BETWEEN 1 AND 4000),
  max_concurrent bigint NOT NULL CHECK (max_concurrent = 1),
  timeout_ms bigint NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 10000),
  max_output_tokens bigint NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 256),
  max_response_bytes bigint NOT NULL CHECK (max_response_bytes BETWEEN 256 AND 16384),
  requests_reserved bigint NOT NULL DEFAULT 0 CHECK (requests_reserved >= 0),
  requests_settled bigint NOT NULL DEFAULT 0 CHECK (requests_settled >= 0),
  concurrent_requests bigint NOT NULL DEFAULT 0 CHECK (concurrent_requests >= 0),
  PRIMARY KEY (tenant, connection_id),
  FOREIGN KEY (tenant, connection_id) REFERENCES ct.model_connections (tenant, id),
  CHECK (requests_reserved + requests_settled <= max_requests),
  CHECK (concurrent_requests <= max_concurrent)
);

CREATE TABLE IF NOT EXISTS ct.model_text_attempts (
  tenant text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  connection_id text NOT NULL,
  principal text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('RESERVED', 'SENDING', 'SETTLED', 'UNCERTAIN', 'BLOCKED')),
  dispatch text NOT NULL CHECK (dispatch IN ('list', 'text')),
  input_chars bigint NOT NULL CHECK (input_chars >= 0),
  outcome text,
  response_text text,
  reported_usage boolean NOT NULL DEFAULT false,
  may_still_complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant, id),
  UNIQUE (tenant, idempotency_key),
  FOREIGN KEY (tenant, connection_id) REFERENCES ct.model_connections (tenant, id),
  FOREIGN KEY (tenant, principal) REFERENCES ct.principals (tenant, id)
);

ALTER TABLE ct.model_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.model_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE ct.model_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.model_connection_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE ct.model_connection_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.model_connection_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE ct.model_text_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.model_text_attempts FORCE ROW LEVEL SECURITY;

DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'model_connection_trusted') THEN
    CREATE POLICY model_connection_trusted ON ct.model_connections
      TO ct_governor, ct_authority_api USING (true) WITH CHECK (true);
    CREATE POLICY model_connection_read ON ct.model_connections
      FOR SELECT TO ct_console_reader USING (true);
    CREATE POLICY model_secret_trusted ON ct.model_connection_secrets
      TO ct_governor, ct_authority_api USING (true) WITH CHECK (true);
    CREATE POLICY model_limit_trusted ON ct.model_connection_limits
      TO ct_governor, ct_authority_api USING (true) WITH CHECK (true);
    CREATE POLICY model_limit_read ON ct.model_connection_limits
      FOR SELECT TO ct_console_reader USING (true);
    CREATE POLICY model_attempt_trusted ON ct.model_text_attempts
      TO ct_governor, ct_authority_api USING (true) WITH CHECK (true);
    CREATE POLICY model_attempt_read ON ct.model_text_attempts
      FOR SELECT TO ct_console_reader USING (true);
  END IF;
END$$;

REVOKE ALL ON ct.model_connections, ct.model_connection_secrets, ct.model_connection_limits, ct.model_text_attempts FROM PUBLIC;
RESET ROLE;

GRANT SELECT ON ct.model_connections, ct.model_connection_limits, ct.model_text_attempts
  TO ct_authority_api, ct_governor, ct_console_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ct.model_connection_secrets TO ct_authority_api, ct_governor;
GRANT INSERT, UPDATE ON ct.model_connections TO ct_authority_api, ct_governor;
GRANT INSERT, UPDATE ON ct.model_connection_limits TO ct_authority_api, ct_governor;
GRANT INSERT, UPDATE ON ct.model_text_attempts TO ct_authority_api, ct_governor;
GRANT INSERT ON ct.cognition_bindings TO ct_authority_api;

ALTER TABLE ct.model_connections DROP CONSTRAINT IF EXISTS model_connections_verification_label_check;
ALTER TABLE ct.model_connections ADD CONSTRAINT model_connections_verification_label_check
  CHECK (verification_label IN ('not verified', 'mock-tested / live test pending'));
ALTER TABLE ct.model_connections ALTER COLUMN verification_label SET DEFAULT 'not verified';
ALTER TABLE ct.model_connection_limits ADD COLUMN IF NOT EXISTS max_output_tokens bigint;
ALTER TABLE ct.model_connection_limits ADD COLUMN IF NOT EXISTS max_response_bytes bigint;
UPDATE ct.model_connection_limits SET max_output_tokens=128 WHERE max_output_tokens IS NULL;
UPDATE ct.model_connection_limits SET max_response_bytes=8192 WHERE max_response_bytes IS NULL;
ALTER TABLE ct.model_connection_limits ALTER COLUMN max_output_tokens SET NOT NULL;
ALTER TABLE ct.model_connection_limits ALTER COLUMN max_response_bytes SET NOT NULL;
ALTER TABLE ct.model_text_attempts DROP CONSTRAINT IF EXISTS model_text_attempts_state_check;
ALTER TABLE ct.model_text_attempts ADD CONSTRAINT model_text_attempts_state_check
  CHECK (state IN ('RESERVED', 'SENDING', 'SETTLED', 'UNCERTAIN', 'BLOCKED'));
ALTER TABLE ct.model_text_attempts ADD COLUMN IF NOT EXISTS dispatch text;
UPDATE ct.model_text_attempts SET dispatch='text' WHERE dispatch IS NULL;
ALTER TABLE ct.model_text_attempts ALTER COLUMN dispatch SET NOT NULL;
COMMIT;
