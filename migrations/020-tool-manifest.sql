-- Version 4 binds a tool id and the server-selected tool revision.
-- Historical operation rows stay version 1, 2, or 3. This file does not edit earlier migrations.
BEGIN;
SET ROLE ct_owner;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS tool_id text;
ALTER TABLE ct.operations ADD COLUMN IF NOT EXISTS tool_revision bigint;
DO $$BEGIN
 IF to_regclass('ct.tool_manifests') IS NULL THEN
  CREATE TABLE ct.tool_manifests(
   tenant text NOT NULL REFERENCES ct.tenants(id),
   tool_id text NOT NULL CHECK(tool_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
   revision bigint NOT NULL CHECK(revision>0),
   definition_digest text NOT NULL CHECK(length(definition_digest)=64),
   PRIMARY KEY(tenant,tool_id,revision));
  ALTER TABLE ct.tool_manifests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ct.tool_manifests FORCE ROW LEVEL SECURITY;
 END IF;
 IF to_regclass('ct.tool_manifest_index') IS NULL THEN
  CREATE TABLE ct.tool_manifest_index(
   tenant text NOT NULL,
   tool_id text NOT NULL CHECK(tool_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
   revision bigint NOT NULL CHECK(revision>0),
   definition_digest text NOT NULL CHECK(length(definition_digest)=64),
   lock_tag bigint NOT NULL DEFAULT 0,
   PRIMARY KEY(tenant,tool_id));
  ALTER TABLE ct.tool_manifest_index ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ct.tool_manifest_index FORCE ROW LEVEL SECURITY;
 END IF;
END$$;
ALTER TABLE ct.operations DROP CONSTRAINT IF EXISTS operations_tool_id_check;
ALTER TABLE ct.operations ADD CONSTRAINT operations_tool_id_check CHECK(tool_id IS NULL OR tool_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
ALTER TABLE ct.operations DROP CONSTRAINT IF EXISTS operations_binding_version;
ALTER TABLE ct.operations ADD CONSTRAINT operations_binding_version CHECK(
 (contract_version=1 AND computer_id IS NULL AND placement_generation IS NULL AND context_id IS NULL AND context_version IS NULL AND cognition_revision IS NULL AND tool_id IS NULL AND tool_revision IS NULL) OR
 (contract_version=2 AND computer_id IS NOT NULL AND length(computer_id)>0 AND placement_generation IS NOT NULL AND placement_generation>0 AND context_id IS NULL AND context_version IS NULL AND cognition_revision IS NULL AND tool_id IS NULL AND tool_revision IS NULL) OR
 (contract_version=3
  AND ((computer_id IS NULL AND placement_generation IS NULL) OR (computer_id IS NOT NULL AND length(computer_id)>0 AND placement_generation IS NOT NULL AND placement_generation>0))
  AND ((context_id IS NULL AND context_version IS NULL) OR (context_id IS NOT NULL AND length(context_id)>0 AND context_version IS NOT NULL AND context_version>0))
  AND (cognition_revision IS NULL OR cognition_revision>0)
  AND (context_id IS NOT NULL OR cognition_revision IS NOT NULL)
  AND tool_id IS NULL AND tool_revision IS NULL) OR
 (contract_version=4
  AND ((computer_id IS NULL AND placement_generation IS NULL) OR (computer_id IS NOT NULL AND length(computer_id)>0 AND placement_generation IS NOT NULL AND placement_generation>0))
  AND ((context_id IS NULL AND context_version IS NULL) OR (context_id IS NOT NULL AND length(context_id)>0 AND context_version IS NOT NULL AND context_version>0))
  AND (cognition_revision IS NULL OR cognition_revision>0)
  AND tool_id IS NOT NULL AND tool_revision IS NOT NULL AND tool_revision>0));
ALTER TABLE ct.operations DROP CONSTRAINT IF EXISTS operations_contract_version;
ALTER TABLE ct.operations ADD CONSTRAINT operations_contract_version CHECK(contract_version IN(1,2,3,4));
DO $$BEGIN
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='operations_tool_fk') THEN
  ALTER TABLE ct.operations ADD CONSTRAINT operations_tool_fk FOREIGN KEY(tenant,tool_id,tool_revision) REFERENCES ct.tool_manifests(tenant,tool_id,revision);
 END IF;
END$$;
CREATE OR REPLACE FUNCTION ct.guard_operation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.grant_id,NEW.epoch,NEW.generation,NEW.fence,NEW.grant_version,NEW.task_id,NEW.plan_version,NEW.provider,NEW.action,NEW.resource,NEW.params,NEW.digest,NEW.idempotency_key,NEW.cost,NEW.deadline,NEW.computer_id,NEW.placement_generation,NEW.contract_version,NEW.context_id,NEW.context_version,NEW.cognition_revision,NEW.tool_id,NEW.tool_revision)
 IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.grant_id,OLD.epoch,OLD.generation,OLD.fence,OLD.grant_version,OLD.task_id,OLD.plan_version,OLD.provider,OLD.action,OLD.resource,OLD.params,OLD.digest,OLD.idempotency_key,OLD.cost,OLD.deadline,OLD.computer_id,OLD.placement_generation,OLD.contract_version,OLD.context_id,OLD.context_version,OLD.cognition_revision,OLD.tool_id,OLD.tool_revision) THEN RAISE EXCEPTION 'immutable operation binding';END IF;
 IF NEW.state<>OLD.state THEN
  IF (OLD.state='REQUESTED' AND NEW.state IN('RESERVED','DENIED')) OR (OLD.state='RESERVED' AND NEW.state IN('SENDING','DENIED','UNKNOWN')) OR (OLD.state='SENDING' AND NEW.state IN('COMMITTED','UNKNOWN','FAILED_KNOWN_NO_EFFECT')) OR (OLD.state='UNKNOWN' AND NEW.state='COMMITTED') THEN NULL;
  ELSIF OLD.state='REQUESTED' AND NEW.state='UNKNOWN' AND current_user='ct_recovery' THEN
   IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'closed recovery run required';END IF;
  ELSE RAISE EXCEPTION 'illegal operation transition % -> %',OLD.state,NEW.state;END IF;
 END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'operation CAS version must advance by one';END IF;RETURN NEW;END$$;
CREATE OR REPLACE FUNCTION ct.guard_tool_manifest_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,ct AS $fn$
DECLARE next_revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tool-manifest|'||NEW.tenant||'|'||NEW.tool_id,0));
 SELECT COALESCE(MAX(revision),0)+1 INTO next_revision FROM ct.tool_manifests WHERE tenant=NEW.tenant AND tool_id=NEW.tool_id;
 IF NEW.revision IS NULL THEN NEW.revision:=next_revision;
 ELSIF NEW.revision<1 THEN RAISE EXCEPTION 'tool revision';
 ELSIF NEW.revision<>next_revision THEN RAISE EXCEPTION 'tool revision sequence'; END IF;
 RETURN NEW;END$fn$;
CREATE OR REPLACE FUNCTION ct.guard_tool_manifest_index() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,ct AS $fn$
BEGIN
 INSERT INTO ct.tool_manifest_index(tenant,tool_id,revision,definition_digest)
 VALUES(NEW.tenant,NEW.tool_id,NEW.revision,NEW.definition_digest)
 ON CONFLICT(tenant,tool_id) DO UPDATE SET revision=EXCLUDED.revision,definition_digest=EXCLUDED.definition_digest;
 RETURN NEW;END$fn$;
CREATE OR REPLACE FUNCTION ct.guard_tool_manifest_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$BEGIN
 RAISE EXCEPTION 'tool manifest append only';END$fn$;
DROP TRIGGER IF EXISTS tool_manifest_revision_guard ON ct.tool_manifests;
CREATE TRIGGER tool_manifest_revision_guard BEFORE INSERT ON ct.tool_manifests FOR EACH ROW EXECUTE FUNCTION ct.guard_tool_manifest_insert();
DROP TRIGGER IF EXISTS tool_manifest_index_guard ON ct.tool_manifests;
CREATE TRIGGER tool_manifest_index_guard AFTER INSERT ON ct.tool_manifests FOR EACH ROW EXECUTE FUNCTION ct.guard_tool_manifest_index();
DROP TRIGGER IF EXISTS tool_manifest_append_only ON ct.tool_manifests;
CREATE TRIGGER tool_manifest_append_only BEFORE UPDATE OR DELETE ON ct.tool_manifests FOR EACH ROW EXECUTE FUNCTION ct.guard_tool_manifest_mutation();
CREATE OR REPLACE FUNCTION ct.append_tool_manifest(p_tenant text,p_tool_id text,p_digest text) RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog,ct AS $fn$
DECLARE next_revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tool-manifest|'||p_tenant||'|'||p_tool_id,0));
 INSERT INTO ct.tool_manifests(tenant,tool_id,definition_digest) VALUES(p_tenant,p_tool_id,p_digest) RETURNING revision INTO next_revision;
 RETURN next_revision;END$fn$;
CREATE OR REPLACE FUNCTION ct.rebuild_tool_manifest_index() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,ct AS $fn$
BEGIN
 DELETE FROM ct.tool_manifest_index;
 INSERT INTO ct.tool_manifest_index(tenant,tool_id,revision,definition_digest)
 SELECT m.tenant,m.tool_id,m.revision,m.definition_digest FROM ct.tool_manifests m
 WHERE m.revision=(SELECT MAX(revision) FROM ct.tool_manifests x WHERE x.tenant=m.tenant AND x.tool_id=m.tool_id);
END$fn$;
REVOKE ALL ON FUNCTION ct.append_tool_manifest(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ct.rebuild_tool_manifest_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ct.append_tool_manifest(text,text,text), ct.rebuild_tool_manifest_index() TO ct_governor;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifests' AND policyname='tool_manifest_trusted') THEN
  CREATE POLICY tool_manifest_trusted ON ct.tool_manifests TO ct_owner,ct_governor,ct_authority_api USING(true) WITH CHECK(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifests' AND policyname='tool_manifest_read') THEN
  CREATE POLICY tool_manifest_read ON ct.tool_manifests FOR SELECT TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export USING(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifests' AND policyname='tool_manifest_tenant') THEN
  CREATE POLICY tool_manifest_tenant ON ct.tool_manifests FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant());
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifest_index' AND policyname='tool_index_trusted') THEN
  CREATE POLICY tool_index_trusted ON ct.tool_manifest_index TO ct_owner,ct_governor USING(true) WITH CHECK(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifest_index' AND policyname='tool_index_read') THEN
  CREATE POLICY tool_index_read ON ct.tool_manifest_index FOR SELECT TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export,ct_authority_api USING(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifest_index' AND policyname='tool_index_lock') THEN
  CREATE POLICY tool_index_lock ON ct.tool_manifest_index FOR UPDATE TO ct_product_api,ct_cap_issuer,ct_controller USING(true) WITH CHECK(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ct' AND tablename='tool_manifest_index' AND policyname='tool_index_tenant') THEN
  CREATE POLICY tool_index_tenant ON ct.tool_manifest_index FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant());
 END IF;
END$$;
GRANT SELECT,INSERT ON ct.tool_manifests TO ct_governor;
GRANT SELECT,INSERT,UPDATE,DELETE ON ct.tool_manifest_index TO ct_governor;
GRANT SELECT ON ct.tool_manifests,ct.tool_manifest_index TO ct_product_api,ct_cap_issuer,ct_controller,ct_recovery,ct_evidence_export,ct_authority_api;
GRANT SELECT ON ct.tool_manifests,ct.tool_manifest_index TO ct_tenant_a,ct_tenant_b;
GRANT UPDATE(lock_tag) ON ct.tool_manifest_index TO ct_product_api,ct_cap_issuer,ct_controller;
GRANT INSERT(tool_id,tool_revision) ON ct.operations TO ct_product_api;
RESET ROLE;
COMMIT;
