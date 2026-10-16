-- Regency records inside Continuum. A role or mandate is not effect authority.
BEGIN;
DO $$BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ct_console_reader') THEN CREATE ROLE ct_console_reader LOGIN; END IF;
END$$;
SET ROLE ct_owner;
CREATE TABLE ct.organizations(tenant text NOT NULL,id text NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),revision bigint NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES ct.identities(id),PRIMARY KEY(tenant,id),FOREIGN KEY(tenant) REFERENCES ct.tenants(id));
CREATE TABLE ct.role_definitions(tenant text NOT NULL,organization text NOT NULL,id text NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),revision bigint NOT NULL DEFAULT 1,PRIMARY KEY(tenant,organization,id),FOREIGN KEY(tenant,organization) REFERENCES ct.organizations(tenant,id));
CREATE TABLE ct.memberships(tenant text NOT NULL,organization text NOT NULL,subject_kind text NOT NULL CHECK(subject_kind IN('human','vera')),subject_id text NOT NULL,role_id text NOT NULL,owner_seat boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 1,PRIMARY KEY(tenant,organization,subject_kind,subject_id),FOREIGN KEY(tenant,organization,role_id) REFERENCES ct.role_definitions(tenant,organization,id));
CREATE TABLE ct.mandates(tenant text NOT NULL,organization text NOT NULL,id text NOT NULL,revision bigint NOT NULL DEFAULT 1,current_version bigint NOT NULL CHECK(current_version>0),PRIMARY KEY(tenant,organization,id),FOREIGN KEY(tenant,organization) REFERENCES ct.organizations(tenant,id));
CREATE TABLE ct.mandate_versions(tenant text NOT NULL,organization text NOT NULL,mandate text NOT NULL,version bigint NOT NULL CHECK(version>0),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),recorded_by text NOT NULL REFERENCES ct.identities(id),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant,organization,mandate,version),FOREIGN KEY(tenant,organization,mandate) REFERENCES ct.mandates(tenant,organization,id));
CREATE FUNCTION ct.guard_regency_membership() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.owner_seat AND NEW.subject_kind<>'human' THEN RAISE EXCEPTION 'a VERA cannot own an organization'; END IF;
 IF NEW.subject_kind='human' AND NOT EXISTS(SELECT 1 FROM ct.identities i WHERE i.id=NEW.subject_id AND i.tenant=NEW.tenant AND i.kind='user') THEN RAISE EXCEPTION 'human membership must name a person in this tenant'; END IF;
 IF NEW.subject_kind='vera' AND NOT EXISTS(SELECT 1 FROM ct.principals p WHERE p.tenant=NEW.tenant AND p.id=NEW.subject_id) THEN RAISE EXCEPTION 'VERA membership must name a principal in this tenant'; END IF;
 RETURN NEW;END$$;
CREATE TRIGGER regency_membership_scope BEFORE INSERT OR UPDATE ON ct.memberships FOR EACH ROW EXECUTE FUNCTION ct.guard_regency_membership();
CREATE FUNCTION ct.keep_organization_owner() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE n int; ten text; org text; BEGIN
 IF TG_OP='DELETE' AND OLD.owner_seat THEN ten=OLD.tenant; org=OLD.organization;
 ELSIF TG_OP='UPDATE' AND OLD.owner_seat AND NOT NEW.owner_seat THEN ten=NEW.tenant; org=NEW.organization;
 ELSE RETURN COALESCE(NEW,OLD); END IF;
 PERFORM 1 FROM ct.organizations WHERE tenant=ten AND id=org FOR UPDATE;
 SELECT count(*) INTO n FROM ct.memberships WHERE tenant=ten AND organization=org AND owner_seat AND NOT (subject_kind=OLD.subject_kind AND subject_id=OLD.subject_id);
 IF n=0 THEN RAISE EXCEPTION 'last organization owner'; END IF;
 RETURN COALESCE(NEW,OLD);END$$;
CREATE TRIGGER organization_owner_retained BEFORE UPDATE OR DELETE ON ct.memberships FOR EACH ROW EXECUTE FUNCTION ct.keep_organization_owner();
CREATE FUNCTION ct.guard_mandate_version() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable mandate version'; END$$;
CREATE TRIGGER mandate_version_immutable BEFORE UPDATE OR DELETE ON ct.mandate_versions FOR EACH ROW EXECUTE FUNCTION ct.guard_mandate_version();
CREATE FUNCTION ct.mandate_version_exists() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM ct.mandate_versions v WHERE v.tenant=NEW.tenant AND v.organization=NEW.organization AND v.mandate=NEW.id AND v.version=NEW.current_version) THEN RAISE EXCEPTION 'mandate version missing'; END IF;
 RETURN NEW;END$$;
CREATE CONSTRAINT TRIGGER mandate_current_version AFTER INSERT OR UPDATE ON ct.mandates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ct.mandate_version_exists();
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['organizations','role_definitions','memberships','mandates','mandate_versions'] LOOP
 EXECUTE format('ALTER TABLE ct.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ct.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY regency_trusted ON ct.%I TO ct_owner,ct_governor,ct_authority_api USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY regency_read ON ct.%I FOR SELECT TO ct_console_reader USING(true)',t);
 EXECUTE format('CREATE POLICY tenant_read ON ct.%I FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant())',t);
END LOOP;END$$;
RESET ROLE;
GRANT SELECT,INSERT,UPDATE ON ct.organizations,ct.role_definitions,ct.mandates TO ct_authority_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON ct.memberships TO ct_authority_api;
GRANT SELECT,INSERT ON ct.mandate_versions TO ct_authority_api;
GRANT SELECT ON ct.organizations,ct.role_definitions,ct.memberships,ct.mandates,ct.mandate_versions TO ct_console_reader,ct_governor;
COMMIT;
