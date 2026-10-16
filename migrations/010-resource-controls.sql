BEGIN;
SET ROLE ct_owner;
ALTER TABLE ct.recovery_runs ADD COLUMN IF NOT EXISTS inventory_digest text NOT NULL DEFAULT '';
CREATE TABLE ct.resource_limits(tenant text PRIMARY KEY REFERENCES ct.tenants(id),max_jobs bigint NOT NULL CHECK(max_jobs>=0),max_storage bigint NOT NULL CHECK(max_storage>=0),max_units bigint NOT NULL CHECK(max_units>=0),active_jobs bigint NOT NULL DEFAULT 0 CHECK(active_jobs>=0 AND active_jobs<=max_jobs),reserved_storage bigint NOT NULL DEFAULT 0 CHECK(reserved_storage>=0 AND reserved_storage<=max_storage),spent_or_reserved_units bigint NOT NULL DEFAULT 0 CHECK(spent_or_reserved_units>=0 AND spent_or_reserved_units<=max_units));
CREATE TABLE ct.resource_reservations(tenant text NOT NULL,kind text NOT NULL CHECK(kind IN('task','computer','artifact')),id text NOT NULL,principal text NOT NULL,digest text NOT NULL,units bigint NOT NULL CHECK(units>=0),jobs bigint NOT NULL CHECK(jobs>=0),bytes bigint NOT NULL CHECK(bytes>=0),state text NOT NULL DEFAULT 'RESERVED' CHECK(state IN('RESERVED','UNCERTAIN','SETTLED')),used_units bigint,metadata jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(tenant,kind,id),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE FUNCTION ct.guard_resource_binding() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.kind,NEW.id,NEW.principal,NEW.digest,NEW.units,NEW.jobs,NEW.bytes,NEW.metadata) IS DISTINCT FROM ROW(OLD.tenant,OLD.kind,OLD.id,OLD.principal,OLD.digest,OLD.units,OLD.jobs,OLD.bytes,OLD.metadata) OR (OLD.state='SETTLED' AND NEW.state<>'SETTLED') THEN RAISE EXCEPTION 'immutable resource reservation';END IF;RETURN NEW;END$$;
CREATE TRIGGER resource_contract BEFORE UPDATE ON ct.resource_reservations FOR EACH ROW EXECUTE FUNCTION ct.guard_resource_binding();
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['resource_limits','resource_reservations'] LOOP
 EXECUTE format('ALTER TABLE ct.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE ct.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY resource_trusted ON ct.%I TO ct_governor,ct_resource_service,ct_product_api,ct_computer_broker,ct_context_service USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY tenant_read ON ct.%I FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant())',t);
 END LOOP;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['identities','principals','evidence_heads','evidence_events'] LOOP EXECUTE format('CREATE POLICY resource_backend ON ct.%I TO ct_resource_service USING(true) WITH CHECK(true)',t);END LOOP;END$$;
RESET ROLE;
GRANT SELECT ON ct.tenants TO ct_recovery;
GRANT INSERT ON ct.task_operations TO ct_recovery;
GRANT SELECT,INSERT,UPDATE ON ct.resource_limits TO ct_governor;
GRANT SELECT ON ct.resource_limits,ct.resource_reservations TO ct_governor,ct_resource_service,ct_product_api,ct_computer_broker,ct_context_service,ct_tenant_a,ct_tenant_b;
GRANT UPDATE(active_jobs,reserved_storage,spent_or_reserved_units) ON ct.resource_limits TO ct_resource_service,ct_product_api,ct_computer_broker,ct_context_service;
GRANT INSERT ON ct.resource_reservations TO ct_resource_service,ct_product_api,ct_computer_broker,ct_context_service;
GRANT UPDATE(state,used_units) ON ct.resource_reservations TO ct_resource_service,ct_product_api,ct_computer_broker,ct_context_service;
GRANT SELECT ON ct.identities,ct.principals,ct.evidence_heads TO ct_resource_service;
GRANT UPDATE(lock_tag) ON ct.identities,ct.principals TO ct_resource_service;
GRANT UPDATE ON ct.evidence_heads TO ct_resource_service;
GRANT INSERT ON ct.evidence_events TO ct_resource_service;
COMMIT;
