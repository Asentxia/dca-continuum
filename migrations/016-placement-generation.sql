-- Placement generation is independent of the principal generation.
-- Historical operation rows stay contract version 1. This file does not edit earlier migrations.
BEGIN;
SET ROLE ct_owner;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS computer_id text;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS placement_generation integer;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
DO $$BEGIN
 ALTER TABLE ct.operations DROP CONSTRAINT IF EXISTS operations_binding_version;
 ALTER TABLE ct.operations ADD CONSTRAINT operations_binding_version CHECK(
  (contract_version=1 AND computer_id IS NULL AND placement_generation IS NULL) OR
  (contract_version=2 AND computer_id IS NOT NULL AND length(computer_id)>0 AND placement_generation IS NOT NULL AND placement_generation>0));
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='operations_computer_fk') THEN
  ALTER TABLE ct.operations ADD CONSTRAINT operations_computer_fk FOREIGN KEY(tenant,computer_id) REFERENCES ct.computers(tenant,id);
 END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='operations_contract_version') THEN
  ALTER TABLE ct.operations ADD CONSTRAINT operations_contract_version CHECK(contract_version IN(1,2));
 END IF;
END$$;
CREATE OR REPLACE FUNCTION ct.guard_computer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.generation<1 THEN RAISE EXCEPTION 'placement generation'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.tenant,NEW.id,NEW.principal) IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal) OR NEW.generation<OLD.generation OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'immutable computer/CAS fence'; END IF;
 RETURN NEW;END$$;
CREATE OR REPLACE FUNCTION ct.guard_operation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.grant_id,NEW.epoch,NEW.generation,NEW.fence,NEW.grant_version,NEW.task_id,NEW.plan_version,NEW.provider,NEW.action,NEW.resource,NEW.params,NEW.digest,NEW.idempotency_key,NEW.cost,NEW.deadline,NEW.computer_id,NEW.placement_generation,NEW.contract_version)
 IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.grant_id,OLD.epoch,OLD.generation,OLD.fence,OLD.grant_version,OLD.task_id,OLD.plan_version,OLD.provider,OLD.action,OLD.resource,OLD.params,OLD.digest,OLD.idempotency_key,OLD.cost,OLD.deadline,OLD.computer_id,OLD.placement_generation,OLD.contract_version) THEN RAISE EXCEPTION 'immutable operation binding';END IF;
 IF NEW.state<>OLD.state THEN
  IF (OLD.state='REQUESTED' AND NEW.state IN('RESERVED','DENIED')) OR (OLD.state='RESERVED' AND NEW.state IN('SENDING','DENIED','UNKNOWN')) OR (OLD.state='SENDING' AND NEW.state IN('COMMITTED','UNKNOWN','FAILED_KNOWN_NO_EFFECT')) OR (OLD.state='UNKNOWN' AND NEW.state='COMMITTED') THEN NULL;
  ELSIF OLD.state='REQUESTED' AND NEW.state='UNKNOWN' AND current_user='ct_recovery' THEN
   IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'closed recovery run required';END IF;
  ELSE RAISE EXCEPTION 'illegal operation transition % -> %',OLD.state,NEW.state;END IF;
 END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'operation CAS version must advance by one';END IF;RETURN NEW;END$$;
REVOKE UPDATE(generation) ON ct.principals FROM ct_computer_broker;
GRANT INSERT(computer_id,placement_generation,contract_version) ON ct.operations TO ct_product_api;
GRANT UPDATE(lock_tag) ON ct.computers TO ct_product_api,ct_controller,ct_cap_issuer;
RESET ROLE;
COMMIT;
