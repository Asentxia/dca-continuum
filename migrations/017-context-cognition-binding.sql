-- Version 3 binds a context item and/or a cognition revision.
-- Historical operation rows stay version 1 or 2. This file does not edit earlier migrations.
BEGIN;
SET ROLE ct_owner;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS context_id text;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS context_version integer;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS cognition_revision bigint;
ALTER TABLE ct.context_heads ADD COLUMN IF NOT EXISTS lock_tag bigint NOT NULL DEFAULT 0;
DO $$BEGIN
 IF to_regclass('ct.cognition_bindings') IS NULL THEN
  CREATE TABLE ct.cognition_bindings(tenant text NOT NULL,principal text NOT NULL,revision bigint NOT NULL,provider text NOT NULL,model text NOT NULL,configuration_reference text NOT NULL,compatibility text NOT NULL CHECK(compatibility IN('UNKNOWN','TESTED','NEEDS_TESTING')),PRIMARY KEY(tenant,principal,revision),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
  ALTER TABLE ct.cognition_bindings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ct.cognition_bindings FORCE ROW LEVEL SECURITY;
  CREATE POLICY canonical_trusted ON ct.cognition_bindings TO ct_owner,ct_governor,ct_authority_api USING(true) WITH CHECK(true);
  CREATE POLICY tenant_read ON ct.cognition_bindings FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant());
  GRANT SELECT,INSERT ON ct.cognition_bindings TO ct_governor;
  GRANT SELECT ON ct.cognition_bindings TO ct_authority_api;
 END IF;
END$$;
DO $$BEGIN
 IF to_regclass('ct.cognition_bindings') IS NOT NULL THEN
  ALTER TABLE ct.cognition_bindings ALTER COLUMN revision DROP DEFAULT;
 END IF;
END$$;
ALTER TABLE ct.operations DROP CONSTRAINT IF EXISTS operations_binding_version;
ALTER TABLE ct.operations ADD CONSTRAINT operations_binding_version CHECK(
 (contract_version=1 AND computer_id IS NULL AND placement_generation IS NULL AND context_id IS NULL AND context_version IS NULL AND cognition_revision IS NULL) OR
 (contract_version=2 AND computer_id IS NOT NULL AND length(computer_id)>0 AND placement_generation IS NOT NULL AND placement_generation>0 AND context_id IS NULL AND context_version IS NULL AND cognition_revision IS NULL) OR
 (contract_version=3
  AND ((computer_id IS NULL AND placement_generation IS NULL) OR (computer_id IS NOT NULL AND length(computer_id)>0 AND placement_generation IS NOT NULL AND placement_generation>0))
  AND ((context_id IS NULL AND context_version IS NULL) OR (context_id IS NOT NULL AND length(context_id)>0 AND context_version IS NOT NULL AND context_version>0))
  AND (cognition_revision IS NULL OR (cognition_revision IS NOT NULL AND cognition_revision>0))
  AND (context_id IS NOT NULL OR cognition_revision IS NOT NULL)));
ALTER TABLE ct.operations DROP CONSTRAINT IF EXISTS operations_contract_version;
ALTER TABLE ct.operations ADD CONSTRAINT operations_contract_version CHECK(contract_version IN(1,2,3));
DO $$BEGIN
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='operations_context_fk') THEN
  ALTER TABLE ct.operations ADD CONSTRAINT operations_context_fk FOREIGN KEY(tenant,context_id,context_version) REFERENCES ct.context_versions(tenant,id,version);
 END IF;
 IF to_regclass('ct.cognition_bindings') IS NOT NULL AND NOT EXISTS(SELECT FROM pg_constraint WHERE conname='operations_cognition_fk') THEN
  ALTER TABLE ct.operations ADD CONSTRAINT operations_cognition_fk FOREIGN KEY(tenant,principal,cognition_revision) REFERENCES ct.cognition_bindings(tenant,principal,revision);
 END IF;
 IF to_regclass('ct.cognition_bindings') IS NOT NULL AND NOT EXISTS(SELECT FROM pg_constraint WHERE conname='cognition_revision_positive') THEN
  ALTER TABLE ct.cognition_bindings ADD CONSTRAINT cognition_revision_positive CHECK(revision>0);
 END IF;
END$$;
CREATE OR REPLACE FUNCTION ct.guard_operation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.grant_id,NEW.epoch,NEW.generation,NEW.fence,NEW.grant_version,NEW.task_id,NEW.plan_version,NEW.provider,NEW.action,NEW.resource,NEW.params,NEW.digest,NEW.idempotency_key,NEW.cost,NEW.deadline,NEW.computer_id,NEW.placement_generation,NEW.contract_version,NEW.context_id,NEW.context_version,NEW.cognition_revision)
 IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.grant_id,OLD.epoch,OLD.generation,OLD.fence,OLD.grant_version,OLD.task_id,OLD.plan_version,OLD.provider,OLD.action,OLD.resource,OLD.params,OLD.digest,OLD.idempotency_key,OLD.cost,OLD.deadline,OLD.computer_id,OLD.placement_generation,OLD.contract_version,OLD.context_id,OLD.context_version,OLD.cognition_revision) THEN RAISE EXCEPTION 'immutable operation binding';END IF;
 IF NEW.state<>OLD.state THEN
  IF (OLD.state='REQUESTED' AND NEW.state IN('RESERVED','DENIED')) OR (OLD.state='RESERVED' AND NEW.state IN('SENDING','DENIED','UNKNOWN')) OR (OLD.state='SENDING' AND NEW.state IN('COMMITTED','UNKNOWN','FAILED_KNOWN_NO_EFFECT')) OR (OLD.state='UNKNOWN' AND NEW.state='COMMITTED') THEN NULL;
  ELSIF OLD.state='REQUESTED' AND NEW.state='UNKNOWN' AND current_user='ct_recovery' THEN
   IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'closed recovery run required';END IF;
  ELSE RAISE EXCEPTION 'illegal operation transition % -> %',OLD.state,NEW.state;END IF;
 END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'operation CAS version must advance by one';END IF;RETURN NEW;END$$;
-- Lock the principal before calculating the next revision, including a direct INSERT.
DO $$BEGIN
 IF to_regclass('ct.cognition_bindings') IS NULL THEN RETURN; END IF;
 CREATE OR REPLACE FUNCTION ct.guard_cognition_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
 DECLARE next_revision bigint;
 BEGIN
  PERFORM 1 FROM ct.principals WHERE tenant=NEW.tenant AND id=NEW.principal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cognition principal'; END IF;
  SELECT COALESCE(MAX(revision),0)+1 INTO next_revision FROM ct.cognition_bindings WHERE tenant=NEW.tenant AND principal=NEW.principal;
  IF NEW.revision IS NULL THEN NEW.revision:=next_revision;
  ELSIF NEW.revision<1 THEN RAISE EXCEPTION 'cognition revision';
  ELSIF NEW.revision<>next_revision THEN RAISE EXCEPTION 'cognition revision sequence'; END IF;
  RETURN NEW;END$fn$;
 CREATE OR REPLACE FUNCTION ct.guard_cognition_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$BEGIN
  RAISE EXCEPTION 'cognition append only';END$fn$;
 EXECUTE 'DROP TRIGGER IF EXISTS cognition_revision_guard ON ct.cognition_bindings';
 EXECUTE 'CREATE TRIGGER cognition_revision_guard BEFORE INSERT ON ct.cognition_bindings FOR EACH ROW EXECUTE FUNCTION ct.guard_cognition_insert()';
 EXECUTE 'DROP TRIGGER IF EXISTS cognition_append_only ON ct.cognition_bindings';
 EXECUTE 'CREATE TRIGGER cognition_append_only BEFORE UPDATE OR DELETE ON ct.cognition_bindings FOR EACH ROW EXECUTE FUNCTION ct.guard_cognition_mutation()';
 CREATE OR REPLACE FUNCTION ct.append_cognition(p_tenant text,p_principal text,p_provider text,p_model text,p_configuration text,p_compatibility text) RETURNS bigint
 LANGUAGE plpgsql AS $fn$
 DECLARE next_revision bigint;
 BEGIN
  PERFORM 1 FROM ct.principals WHERE tenant=p_tenant AND id=p_principal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cognition principal'; END IF;
  SELECT COALESCE(MAX(revision),0)+1 INTO next_revision FROM ct.cognition_bindings WHERE tenant=p_tenant AND principal=p_principal;
  INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility)
   VALUES(p_tenant,p_principal,next_revision,p_provider,p_model,p_configuration,p_compatibility);
  RETURN next_revision;END$fn$;
 EXECUTE 'REVOKE ALL ON FUNCTION ct.append_cognition(text,text,text,text,text,text) FROM PUBLIC';
 EXECUTE 'GRANT EXECUTE ON FUNCTION ct.append_cognition(text,text,text,text,text,text) TO ct_governor';
END$$;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='context_heads' AND policyname='manifest_context_read') THEN
  CREATE POLICY manifest_context_read ON ct.context_heads FOR SELECT TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export,ct_authority_api USING(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='context_heads' AND policyname='manifest_context_lock') THEN
  CREATE POLICY manifest_context_lock ON ct.context_heads FOR UPDATE TO ct_product_api,ct_cap_issuer,ct_controller USING(true) WITH CHECK(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='context_versions' AND policyname='manifest_version_read') THEN
  CREATE POLICY manifest_version_read ON ct.context_versions FOR SELECT TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export USING(true);
 END IF;
 IF to_regclass('ct.cognition_bindings') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='cognition_bindings' AND policyname='manifest_cognition_read') THEN
  CREATE POLICY manifest_cognition_read ON ct.cognition_bindings FOR SELECT TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export USING(true);
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='ct_console_reader') AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='context_heads' AND policyname='manifest_console_read') THEN
  CREATE POLICY manifest_console_read ON ct.context_heads FOR SELECT TO ct_console_reader USING(true);
 END IF;
END$$;
GRANT SELECT ON ct.context_heads,ct.context_versions TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export;
DO $$BEGIN
 IF to_regclass('ct.cognition_bindings') IS NOT NULL THEN
  GRANT SELECT ON ct.cognition_bindings TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='ct_console_reader') THEN
  GRANT SELECT ON ct.context_heads TO ct_console_reader;
 END IF;
END$$;
GRANT SELECT ON ct.context_heads TO ct_authority_api;
GRANT UPDATE(lock_tag) ON ct.context_heads TO ct_product_api,ct_cap_issuer,ct_controller;
GRANT INSERT(context_id,context_version,cognition_revision) ON ct.operations TO ct_product_api;
RESET ROLE;
COMMIT;
