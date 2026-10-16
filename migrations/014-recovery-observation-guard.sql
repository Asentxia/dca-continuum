-- Recovery import remains UNKNOWN-only. Provider observation is recorded later by the verified lookup path.
BEGIN;
SET ROLE ct_owner;
CREATE OR REPLACE FUNCTION ct.guard_operation_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_user='ct_recovery' THEN
  IF NEW.state<>'UNKNOWN' OR NEW.version<>1 OR NEW.attempt IS NOT NULL OR NEW.observation IS NOT NULL THEN RAISE EXCEPTION 'recovery cannot import a sendable outcome';END IF;
  IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'recovery insert requires closed run';END IF;
  RETURN NEW;
 END IF;
 IF NEW.state='REQUESTED' AND NEW.version=1 AND NEW.attempt IS NULL AND NEW.observation IS NULL THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'initial outcome cannot be asserted by caller';END$$;
RESET ROLE;
COMMIT;
