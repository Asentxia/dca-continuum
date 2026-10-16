BEGIN;
SET ROLE ct_owner;
CREATE TABLE ct.recovery_runs(tenant text NOT NULL,id text NOT NULL,old_fence text NOT NULL,new_fence text NOT NULL,external_revision bigint NOT NULL,state text NOT NULL CHECK(state IN('BLOCKED','READY','COMPLETE')),authority_digest text NOT NULL,authority_checked boolean NOT NULL DEFAULT false,inventory_checked boolean NOT NULL DEFAULT false,inventory_digest text NOT NULL DEFAULT '',started_by text NOT NULL REFERENCES ct.identities(id),PRIMARY KEY(tenant,id),FOREIGN KEY(tenant) REFERENCES ct.tenants(id));
ALTER TABLE ct.recovery_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE ct.recovery_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY recovery_trusted ON ct.recovery_runs TO ct_recovery USING(true) WITH CHECK(true);
CREATE POLICY recovery_read ON ct.recovery_runs TO ct_product_api,ct_evidence_export USING(true);
CREATE FUNCTION ct.guard_operation_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.state='REQUESTED' AND NEW.version=1 AND NEW.attempt IS NULL AND NEW.observation IS NULL THEN RETURN NEW;END IF;
 IF current_user<>'ct_recovery' OR NEW.state<>'UNKNOWN' THEN RAISE EXCEPTION 'initial outcome cannot be asserted by caller';END IF;
 IF NOT EXISTS(SELECT FROM ct.control WHERE singleton AND blocked) OR NOT EXISTS(SELECT FROM ct.recovery_runs WHERE tenant=NEW.tenant AND state='BLOCKED') THEN RAISE EXCEPTION 'recovery insert requires closed run';END IF;RETURN NEW;END$$;
CREATE TRIGGER operation_initial_contract BEFORE INSERT ON ct.operations FOR EACH ROW EXECUTE FUNCTION ct.guard_operation_insert();
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
CREATE FUNCTION ct.guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.id,NEW.issuer,NEW.subject,NEW.audience,NEW.kind,NEW.tenant,NEW.principal,NEW.domain_role) IS DISTINCT FROM ROW(OLD.id,OLD.issuer,OLD.subject,OLD.audience,OLD.kind,OLD.tenant,OLD.principal,OLD.domain_role) OR NEW.version<OLD.version OR (NEW.active IS DISTINCT FROM OLD.active AND NEW.version<=OLD.version) THEN RAISE EXCEPTION 'immutable enrollment/monotonic identity fence';END IF;RETURN NEW;END$$;
CREATE TRIGGER identity_contract BEFORE UPDATE ON ct.identities FOR EACH ROW EXECUTE FUNCTION ct.guard_identity();
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['evidence_heads','evidence_events','operations','identities'] LOOP EXECUTE format('CREATE POLICY export_read ON ct.%I FOR SELECT TO ct_evidence_export USING(true)',t);END LOOP;END$$;
RESET ROLE;
REVOKE INSERT ON ct.operations FROM ct_product_api;
GRANT INSERT(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline) ON ct.operations TO ct_product_api;
GRANT SELECT ON ct.tenants TO ct_recovery;
GRANT SELECT,INSERT,UPDATE ON ct.recovery_runs TO ct_recovery;
GRANT SELECT ON ct.recovery_runs TO ct_product_api,ct_evidence_export;
GRANT SELECT ON ct.evidence_events TO ct_recovery,ct_evidence_export;
GRANT INSERT ON ct.operations,ct.task_operations TO ct_recovery;
GRANT UPDATE(state,version,observation,lock_tag) ON ct.operations TO ct_recovery;
GRANT INSERT ON ct.control TO ct_recovery;
GRANT UPDATE(blocked,fence,lock_tag) ON ct.control TO ct_recovery;
GRANT UPDATE(epoch) ON ct.principals TO ct_recovery;
GRANT UPDATE(revoked,version) ON ct.grants TO ct_recovery;
GRANT UPDATE(active,version) ON ct.identities TO ct_recovery;
GRANT SELECT ON ct.evidence_heads,ct.evidence_events,ct.operations,ct.identities TO ct_evidence_export;
COMMIT;
