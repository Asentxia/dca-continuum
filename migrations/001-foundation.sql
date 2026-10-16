-- New, additive validation schema. Never run against production without migration review.
DO $$BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ct_owner') THEN CREATE ROLE ct_owner NOLOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ct_governor') THEN CREATE ROLE ct_governor LOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ct_controller') THEN CREATE ROLE ct_controller LOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ct_tenant_a') THEN CREATE ROLE ct_tenant_a LOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ct_tenant_b') THEN CREATE ROLE ct_tenant_b LOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ct_provider') THEN CREATE ROLE ct_provider LOGIN; END IF;
END$$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA ct AUTHORIZATION ct_owner;
SET ROLE ct_owner;
CREATE TABLE ct.control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), blocked boolean NOT NULL DEFAULT true, fence text NOT NULL);
INSERT INTO ct.control VALUES(true,true,'UNENROLLED');
CREATE TABLE ct.tenants(id text PRIMARY KEY);
CREATE TABLE ct.role_tenants(db_role name PRIMARY KEY,tenant text NOT NULL REFERENCES ct.tenants(id));
CREATE TABLE ct.principals(tenant text NOT NULL REFERENCES ct.tenants(id),id text NOT NULL,epoch integer NOT NULL CHECK(epoch>0),generation integer NOT NULL CHECK(generation>0),active boolean NOT NULL DEFAULT true,PRIMARY KEY(tenant,id));
CREATE TABLE ct.grants(tenant text NOT NULL,id text NOT NULL,principal text NOT NULL,action text NOT NULL,resource text NOT NULL,version integer NOT NULL DEFAULT 1,revoked boolean NOT NULL DEFAULT false,expires timestamptz NOT NULL,max_cost bigint NOT NULL CHECK(max_cost>=0),budget bigint NOT NULL CHECK(budget>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=budget),approval_required boolean NOT NULL DEFAULT true,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE TABLE ct.operations(tenant text NOT NULL,id text NOT NULL,principal text NOT NULL,grant_id text NOT NULL,epoch integer NOT NULL,generation integer NOT NULL,fence text NOT NULL,grant_version integer NOT NULL,task_id text NOT NULL,plan_version integer NOT NULL,provider text NOT NULL,action text NOT NULL,resource text NOT NULL,params jsonb NOT NULL,digest text NOT NULL CHECK(length(digest)=64),idempotency_key text NOT NULL,cost bigint NOT NULL CHECK(cost>=0),deadline timestamptz NOT NULL,state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN ('REQUESTED','RESERVED','SENDING','COMMITTED','UNKNOWN','DENIED','FAILED_KNOWN_NO_EFFECT')),version bigint NOT NULL DEFAULT 1,attempt uuid,lease_until timestamptz,observation jsonb,PRIMARY KEY(tenant,id),UNIQUE(tenant,provider,idempotency_key),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id),FOREIGN KEY(tenant,grant_id) REFERENCES ct.grants(tenant,id));
CREATE TABLE ct.approvals(tenant text NOT NULL,operation text NOT NULL,digest text NOT NULL,grant_version integer NOT NULL,approved_by text NOT NULL,expires timestamptz NOT NULL,PRIMARY KEY(tenant,operation),FOREIGN KEY(tenant,operation) REFERENCES ct.operations(tenant,id));
CREATE TABLE ct.evidence_heads(tenant text PRIMARY KEY REFERENCES ct.tenants(id),seq bigint NOT NULL DEFAULT 0,hash text NOT NULL DEFAULT 'GENESIS');
CREATE TABLE ct.evidence_events(tenant text NOT NULL,seq bigint NOT NULL,kind text NOT NULL,payload text NOT NULL,prev_hash text NOT NULL,hash text NOT NULL,PRIMARY KEY(tenant,seq),FOREIGN KEY(tenant) REFERENCES ct.tenants(id));
CREATE TABLE ct.outbox(tenant text NOT NULL,id uuid NOT NULL,kind text NOT NULL,operation text NOT NULL,payload jsonb NOT NULL,delivered boolean NOT NULL DEFAULT false,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,operation) REFERENCES ct.operations(tenant,id));
CREATE TABLE ct.inbox(tenant text NOT NULL,message_id uuid NOT NULL,received timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant,message_id),FOREIGN KEY(tenant) REFERENCES ct.tenants(id));
CREATE TABLE ct.context_items(tenant text NOT NULL,id text NOT NULL,version integer NOT NULL,payload text NOT NULL,digest text NOT NULL,quarantined boolean NOT NULL DEFAULT false,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant) REFERENCES ct.tenants(id));
CREATE FUNCTION ct.guard_operation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.grant_id,NEW.epoch,NEW.generation,NEW.fence,NEW.grant_version,NEW.task_id,NEW.plan_version,NEW.provider,NEW.action,NEW.resource,NEW.params,NEW.digest,NEW.idempotency_key,NEW.cost,NEW.deadline)
 IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.grant_id,OLD.epoch,OLD.generation,OLD.fence,OLD.grant_version,OLD.task_id,OLD.plan_version,OLD.provider,OLD.action,OLD.resource,OLD.params,OLD.digest,OLD.idempotency_key,OLD.cost,OLD.deadline) THEN RAISE EXCEPTION 'immutable operation binding'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='REQUESTED' AND NEW.state IN('RESERVED','DENIED')) OR (OLD.state='RESERVED' AND NEW.state IN('SENDING','DENIED','UNKNOWN')) OR (OLD.state='SENDING' AND NEW.state IN('COMMITTED','UNKNOWN','FAILED_KNOWN_NO_EFFECT')) OR (OLD.state='UNKNOWN' AND NEW.state='COMMITTED')) THEN RAISE EXCEPTION 'illegal operation transition % -> %',OLD.state,NEW.state; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'operation CAS version must advance by one'; END IF;
 RETURN NEW; END$$;
CREATE TRIGGER operation_contract BEFORE UPDATE ON ct.operations FOR EACH ROW EXECUTE FUNCTION ct.guard_operation();
CREATE FUNCTION ct.forbid_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'append-only evidence'; END$$;
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON ct.evidence_events FOR EACH ROW EXECUTE FUNCTION ct.forbid_evidence_mutation();
-- No identity based on a writable GUC. session_user cannot be changed by runtime roles.
CREATE FUNCTION ct.my_tenant() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,ct AS $$ SELECT tenant FROM ct.role_tenants WHERE db_role=session_user $$;
REVOKE ALL ON FUNCTION ct.my_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ct.my_tenant() TO ct_tenant_a,ct_tenant_b;
DO $$DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['principals','grants','operations','approvals','evidence_heads','evidence_events','outbox','inbox','context_items'] LOOP
 EXECUTE format('ALTER TABLE ct.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ct.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY trusted ON ct.%I TO ct_governor,ct_controller USING (true) WITH CHECK (true)',t);
 EXECUTE format('CREATE POLICY tenant_read ON ct.%I FOR SELECT TO ct_tenant_a,ct_tenant_b USING (tenant=ct.my_tenant())',t);
 END LOOP; END$$;
RESET ROLE;
GRANT USAGE ON SCHEMA ct TO ct_governor,ct_controller,ct_tenant_a,ct_tenant_b;
GRANT SELECT ON ALL TABLES IN SCHEMA ct TO ct_governor,ct_controller;
GRANT INSERT,UPDATE ON ct.tenants,ct.role_tenants,ct.principals,ct.grants,ct.approvals,ct.context_items,ct.control TO ct_governor;
GRANT INSERT ON ct.operations,ct.evidence_heads TO ct_governor;
GRANT UPDATE(state,version,attempt,lease_until,observation) ON ct.operations TO ct_controller;
GRANT UPDATE(reserved) ON ct.grants TO ct_controller;
GRANT UPDATE ON ct.evidence_heads TO ct_governor,ct_controller;
GRANT INSERT ON ct.evidence_events,ct.outbox,ct.inbox TO ct_governor,ct_controller;
GRANT UPDATE(delivered) ON ct.outbox TO ct_controller;
GRANT SELECT ON ct.principals,ct.operations,ct.context_items,ct.evidence_events TO ct_tenant_a,ct_tenant_b;
-- The provider emulator is a distinct truth/credential role, not an effect worker.
CREATE SCHEMA provider AUTHORIZATION ct_provider;
SET ROLE ct_provider;
CREATE TABLE provider.effects(seq bigserial PRIMARY KEY,tenant text NOT NULL,operation text NOT NULL,digest text NOT NULL,idempotency_key text NOT NULL,payload jsonb NOT NULL,created timestamptz NOT NULL DEFAULT now());
-- Deliberately no UNIQUE operation/key: duplicate sends are observable, not hidden by oracle dedup.
RESET ROLE;
