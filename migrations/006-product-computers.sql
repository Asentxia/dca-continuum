-- Additive product and logical-computer schema. Offline validation only until reviewed for staging.
BEGIN;
DO $$DECLARE r text;BEGIN FOREACH r IN ARRAY ARRAY['ct_product_api','ct_computer_broker','ct_context_service','ct_recovery','ct_evidence_export','ct_resource_service'] LOOP
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I LOGIN',r); END IF;
 END LOOP;END$$;
SET ROLE ct_owner;
CREATE TABLE ct.tasks(tenant text NOT NULL,id text NOT NULL,principal text NOT NULL,objective text NOT NULL CHECK(length(objective)<=8000),plan_version integer NOT NULL DEFAULT 1 CHECK(plan_version>0),deadline timestamptz NOT NULL,status text NOT NULL DEFAULT 'PLANNED' CHECK(status IN('PLANNED','CANCELLED')),revision bigint NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES ct.identities(id),lock_tag bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE TABLE ct.task_operations(tenant text NOT NULL,task text NOT NULL,operation text NOT NULL,PRIMARY KEY(tenant,operation),FOREIGN KEY(tenant,task) REFERENCES ct.tasks(tenant,id),FOREIGN KEY(tenant,operation) REFERENCES ct.operations(tenant,id));
CREATE FUNCTION ct.guard_task_operation() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE t ct.tasks;o ct.operations;BEGIN
 SELECT * INTO t FROM ct.tasks WHERE tenant=NEW.tenant AND id=NEW.task; SELECT * INTO o FROM ct.operations WHERE tenant=NEW.tenant AND id=NEW.operation;
 IF t.principal<>o.principal OR t.id<>o.task_id OR t.plan_version<>o.plan_version THEN RAISE EXCEPTION 'task/action binding mismatch';END IF;RETURN NEW;END$$;
CREATE TRIGGER task_operation_binding BEFORE INSERT ON ct.task_operations FOR EACH ROW EXECUTE FUNCTION ct.guard_task_operation();
CREATE FUNCTION ct.guard_task() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.objective,NEW.plan_version,NEW.deadline,NEW.created_by) IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.objective,OLD.plan_version,OLD.deadline,OLD.created_by) OR (OLD.status='CANCELLED' AND NEW.status<>'CANCELLED') THEN RAISE EXCEPTION 'immutable task intent/cancellation';END IF;
 IF NEW.status<>OLD.status AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'task CAS';END IF;RETURN NEW;END$$;
CREATE TRIGGER task_contract BEFORE UPDATE ON ct.tasks FOR EACH ROW EXECUTE FUNCTION ct.guard_task();
CREATE TABLE ct.computers(tenant text NOT NULL,id text NOT NULL,principal text NOT NULL,generation integer NOT NULL CHECK(generation>0),state text NOT NULL CHECK(state IN('STOPPED','STARTING','RUNNING','LOST','DESTROYING')),placement text,manifest_digest text,revision bigint NOT NULL DEFAULT 1,lock_tag bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant,id),UNIQUE(tenant,principal),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE FUNCTION ct.guard_computer() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE g integer;BEGIN
 SELECT generation INTO g FROM ct.principals WHERE tenant=NEW.tenant AND id=NEW.principal;
 IF NEW.generation<>g THEN RAISE EXCEPTION 'computer generation must equal principal fence';END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.tenant,NEW.id,NEW.principal) IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal) OR NEW.generation<OLD.generation OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'immutable computer/CAS fence';END IF; END IF; RETURN NEW;END$$;
CREATE TRIGGER computer_contract BEFORE INSERT OR UPDATE ON ct.computers FOR EACH ROW EXECUTE FUNCTION ct.guard_computer();
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['tasks','task_operations','computers'] LOOP
 EXECUTE format('ALTER TABLE ct.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE ct.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY product_trusted ON ct.%I TO ct_governor,ct_product_api,ct_computer_broker,ct_controller,ct_cap_issuer,ct_authority_api,ct_recovery USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY tenant_read ON ct.%I FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant())',t);
 END LOOP;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['principals','grants','operations','approvals','identities','evidence_heads','evidence_events','outbox'] LOOP
 EXECUTE format('CREATE POLICY product_services ON ct.%I TO ct_product_api,ct_computer_broker,ct_recovery USING(true) WITH CHECK(true)',t);
 END LOOP;END$$;
RESET ROLE;
GRANT USAGE ON SCHEMA ct TO ct_product_api,ct_computer_broker,ct_context_service,ct_recovery,ct_evidence_export,ct_resource_service;
GRANT SELECT ON ct.control,ct.identities,ct.principals,ct.grants,ct.approvals,ct.operations,ct.tasks,ct.task_operations,ct.computers,ct.evidence_heads TO ct_product_api,ct_computer_broker,ct_recovery;
GRANT UPDATE(lock_tag) ON ct.control,ct.identities,ct.principals,ct.grants,ct.tasks TO ct_product_api,ct_computer_broker,ct_recovery;
GRANT INSERT ON ct.tasks,ct.task_operations TO ct_product_api;
GRANT INSERT(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) ON ct.operations TO ct_product_api;
GRANT UPDATE(status,revision) ON ct.tasks TO ct_product_api;
GRANT UPDATE(active,version) ON ct.identities TO ct_product_api;
GRANT INSERT,UPDATE ON ct.computers TO ct_computer_broker;
GRANT UPDATE(generation) ON ct.principals TO ct_computer_broker;
GRANT UPDATE ON ct.evidence_heads TO ct_product_api,ct_computer_broker,ct_recovery;
GRANT INSERT ON ct.evidence_events,ct.outbox TO ct_product_api,ct_computer_broker,ct_recovery;
GRANT SELECT ON ct.tasks,ct.task_operations TO ct_controller,ct_cap_issuer,ct_authority_api;
GRANT UPDATE(lock_tag) ON ct.tasks TO ct_controller,ct_cap_issuer;
GRANT SELECT ON ct.tasks,ct.task_operations,ct.computers TO ct_tenant_a,ct_tenant_b,ct_governor;
GRANT SELECT ON ct.computers TO ct_cap_issuer,ct_controller;
COMMIT;
