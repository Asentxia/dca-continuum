BEGIN;
DO $$BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ct_authority_api') THEN CREATE ROLE ct_authority_api LOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ct_cap_issuer') THEN CREATE ROLE ct_cap_issuer LOGIN; END IF;
END$$;
SET ROLE ct_owner;
CREATE TABLE ct.identities(id text PRIMARY KEY,issuer text NOT NULL,subject text NOT NULL,audience text NOT NULL,kind text NOT NULL CHECK(kind IN('user','machine')),tenant text NOT NULL REFERENCES ct.tenants(id),principal text,domain_role text NOT NULL CHECK(domain_role IN('owner','worker')),active boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1,CHECK((kind='user' AND domain_role='owner') OR (kind='machine' AND domain_role='worker' AND principal IS NOT NULL)),UNIQUE(issuer,subject,audience,kind),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE TABLE ct.assignments(identity_id text NOT NULL REFERENCES ct.identities(id),tenant text NOT NULL,operation text NOT NULL,digest text NOT NULL,expires timestamptz NOT NULL,PRIMARY KEY(identity_id,tenant,operation),FOREIGN KEY(tenant,operation) REFERENCES ct.operations(tenant,id));
CREATE FUNCTION ct.guard_assignment() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE i ct.identities; o ct.operations; BEGIN
 SELECT * INTO i FROM ct.identities WHERE id=NEW.identity_id; SELECT * INTO o FROM ct.operations WHERE tenant=NEW.tenant AND id=NEW.operation;
 IF i.kind<>'machine' OR i.tenant<>NEW.tenant OR i.principal<>o.principal OR NEW.digest<>o.digest THEN RAISE EXCEPTION 'assignment must bind enrolled machine, tenant, principal and operation digest'; END IF;RETURN NEW;END$$;
CREATE TRIGGER assignment_binding BEFORE INSERT OR UPDATE ON ct.assignments FOR EACH ROW EXECUTE FUNCTION ct.guard_assignment();
ALTER TABLE ct.identities ENABLE ROW LEVEL SECURITY;ALTER TABLE ct.identities FORCE ROW LEVEL SECURITY;
ALTER TABLE ct.assignments ENABLE ROW LEVEL SECURITY;ALTER TABLE ct.assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_trusted ON ct.identities TO ct_governor,ct_authority_api,ct_cap_issuer USING(true) WITH CHECK(true);
CREATE POLICY assignment_trusted ON ct.assignments TO ct_governor,ct_authority_api,ct_cap_issuer USING(true) WITH CHECK(true);
DO $$DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['principals','grants','operations','approvals','evidence_heads','evidence_events','outbox'] LOOP
 EXECUTE format('CREATE POLICY identity_services ON ct.%I TO ct_authority_api,ct_cap_issuer USING(true) WITH CHECK(true)',t);
 END LOOP;END$$;
RESET ROLE;
GRANT USAGE ON SCHEMA ct TO ct_authority_api,ct_cap_issuer;
GRANT SELECT ON ct.control,ct.principals,ct.grants,ct.operations,ct.approvals,ct.evidence_heads,ct.identities,ct.assignments TO ct_authority_api,ct_cap_issuer;
GRANT UPDATE(lock_tag) ON ct.control,ct.principals,ct.approvals TO ct_authority_api,ct_cap_issuer;
-- Grant row lock without permitting an issuer to change authority or budgets.
ALTER TABLE ct.grants ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
GRANT UPDATE(lock_tag) ON ct.grants TO ct_cap_issuer;
GRANT INSERT,UPDATE ON ct.identities TO ct_governor;
GRANT SELECT,INSERT,UPDATE,DELETE ON ct.assignments TO ct_governor;
GRANT INSERT ON ct.grants TO ct_authority_api;
GRANT UPDATE(revoked,version) ON ct.grants TO ct_authority_api;
GRANT INSERT,UPDATE(digest,grant_version,approved_by,expires) ON ct.approvals TO ct_authority_api;
GRANT INSERT ON ct.assignments TO ct_authority_api;
GRANT UPDATE ON ct.evidence_heads TO ct_authority_api,ct_cap_issuer;
GRANT INSERT ON ct.evidence_events,ct.outbox TO ct_authority_api,ct_cap_issuer;
-- Non-authority lock columns allow online identity/assignment/operation row checks.
ALTER TABLE ct.identities ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
ALTER TABLE ct.assignments ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
ALTER TABLE ct.operations ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
GRANT UPDATE(lock_tag) ON ct.identities,ct.assignments,ct.operations TO ct_authority_api,ct_cap_issuer;
GRANT SELECT ON ct.identities TO ct_governor;

CREATE POLICY controller_identity ON ct.identities TO ct_controller USING(true);
GRANT SELECT ON ct.identities TO ct_controller;
GRANT UPDATE(lock_tag) ON ct.identities TO ct_controller;
COMMIT;
