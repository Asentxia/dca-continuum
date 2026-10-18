-- Repair databases that recorded 023 before these columns were edited into that file.
-- The filename ledger does not re-run 023. Fresh installs already create the columns.
BEGIN;
SET ROLE ct_owner;

ALTER TABLE ct.model_text_attempts ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE ct.model_text_attempts SET updated_at = clock_timestamp() WHERE updated_at IS NULL;
ALTER TABLE ct.model_text_attempts ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE ct.model_text_attempts ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE ct.model_text_attempts ADD COLUMN IF NOT EXISTS dispatch text;
UPDATE ct.model_text_attempts SET dispatch = 'text' WHERE dispatch IS NULL;
ALTER TABLE ct.model_text_attempts ALTER COLUMN dispatch SET NOT NULL;

ALTER TABLE ct.model_connection_limits ADD COLUMN IF NOT EXISTS max_output_tokens bigint;
ALTER TABLE ct.model_connection_limits ADD COLUMN IF NOT EXISTS max_response_bytes bigint;
UPDATE ct.model_connection_limits SET max_output_tokens = 128 WHERE max_output_tokens IS NULL;
UPDATE ct.model_connection_limits SET max_response_bytes = 8192 WHERE max_response_bytes IS NULL;
ALTER TABLE ct.model_connection_limits ALTER COLUMN max_output_tokens SET NOT NULL;
ALTER TABLE ct.model_connection_limits ALTER COLUMN max_response_bytes SET NOT NULL;

RESET ROLE;
COMMIT;
