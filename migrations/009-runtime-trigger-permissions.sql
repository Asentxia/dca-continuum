BEGIN;
SET ROLE ct_owner;
CREATE OR REPLACE FUNCTION ct.guard_operation_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.state='REQUESTED' AND NEW.version=1 AND NEW.attempt IS NULL AND NEW.observation IS NULL THEN RETURN NEW;END IF;
 IF current_user<>'ct_recovery' OR NEW.state<>'UNKNOWN' THEN RAISE EXCEPTION 'initial outcome cannot be asserted by caller';END IF;
 IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'recovery insert requires closed run';END IF;RETURN NEW;END$$;
CREATE OR REPLACE FUNCTION ct.guard_operation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.grant_id,NEW.epoch,NEW.generation,NEW.fence,NEW.grant_version,NEW.task_id,NEW.plan_version,NEW.provider,NEW.action,NEW.resource,NEW.params,NEW.digest,NEW.idempotency_key,NEW.cost,NEW.deadline)
 IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.grant_id,OLD.epoch,OLD.generation,OLD.fence,OLD.grant_version,OLD.task_id,OLD.plan_version,OLD.provider,OLD.action,OLD.resource,OLD.params,OLD.digest,OLD.idempotency_key,OLD.cost,OLD.deadline) THEN RAISE EXCEPTION 'immutable operation binding';END IF;
 IF NEW.state<>OLD.state THEN
  IF (OLD.state='REQUESTED' AND NEW.state IN('RESERVED','DENIED')) OR (OLD.state='RESERVED' AND NEW.state IN('SENDING','DENIED','UNKNOWN')) OR (OLD.state='SENDING' AND NEW.state IN('COMMITTED','UNKNOWN','FAILED_KNOWN_NO_EFFECT')) OR (OLD.state='UNKNOWN' AND NEW.state='COMMITTED') THEN NULL;
  ELSIF OLD.state='REQUESTED' AND NEW.state='UNKNOWN' AND current_user='ct_recovery' THEN
   IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'closed recovery run required';END IF;
  ELSE RAISE EXCEPTION 'illegal operation transition % -> %',OLD.state,NEW.state;END IF;
 END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'operation CAS version must advance by one';END IF;RETURN NEW;END$$;
RESET ROLE;
COMMIT;
