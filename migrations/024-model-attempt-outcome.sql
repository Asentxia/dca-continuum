-- Repair databases that recorded 023 before these columns were edited into that file.
-- The filename ledger does not re-run 023. Fresh installs already create the columns.
-- Defaults backfill existing rows as DDL, so row-level security does not hide them.
BEGIN;
SET ROLE ct_owner;

ALTER TABLE ct.model_text_attempts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE ct.model_text_attempts
  ADD COLUMN IF NOT EXISTS dispatch text NOT NULL DEFAULT 'text'
  CHECK (dispatch IN ('list', 'text'));
ALTER TABLE ct.model_text_attempts ALTER COLUMN dispatch DROP DEFAULT;

ALTER TABLE ct.model_connection_limits
  ADD COLUMN IF NOT EXISTS max_output_tokens bigint NOT NULL DEFAULT 128
  CHECK (max_output_tokens BETWEEN 1 AND 256);
ALTER TABLE ct.model_connection_limits ALTER COLUMN max_output_tokens DROP DEFAULT;

ALTER TABLE ct.model_connection_limits
  ADD COLUMN IF NOT EXISTS max_response_bytes bigint NOT NULL DEFAULT 8192
  CHECK (max_response_bytes BETWEEN 256 AND 16384);
ALTER TABLE ct.model_connection_limits ALTER COLUMN max_response_bytes DROP DEFAULT;

RESET ROLE;
COMMIT;
