-- New tasks name a current mandate. Existing rows stay unbound and cannot be backfilled.
BEGIN;
SET ROLE ct_owner;
ALTER TABLE ct.tasks
  ADD COLUMN organization text,
  ADD COLUMN mandate text,
  ADD COLUMN mandate_version bigint;
ALTER TABLE ct.tasks ADD CONSTRAINT tasks_mandate_complete CHECK(
  (organization IS NULL AND mandate IS NULL AND mandate_version IS NULL) OR
  (organization IS NOT NULL AND mandate IS NOT NULL AND mandate_version IS NOT NULL));
ALTER TABLE ct.tasks
  ADD CONSTRAINT tasks_organization_fkey FOREIGN KEY(tenant,organization) REFERENCES ct.organizations(tenant,id);
ALTER TABLE ct.tasks
  ADD CONSTRAINT tasks_mandate_fkey FOREIGN KEY(tenant,organization,mandate) REFERENCES ct.mandates(tenant,organization,id);
ALTER TABLE ct.tasks
  ADD CONSTRAINT tasks_mandate_version_fkey FOREIGN KEY(tenant,organization,mandate,mandate_version) REFERENCES ct.mandate_versions(tenant,organization,mandate,version);
CREATE OR REPLACE FUNCTION ct.guard_task() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.principal,NEW.objective,NEW.plan_version,NEW.deadline,NEW.created_by,NEW.organization,NEW.mandate,NEW.mandate_version) IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.principal,OLD.objective,OLD.plan_version,OLD.deadline,OLD.created_by,OLD.organization,OLD.mandate,OLD.mandate_version) OR (OLD.status='CANCELLED' AND NEW.status<>'CANCELLED') THEN RAISE EXCEPTION 'immutable task intent/cancellation';END IF;
 IF NEW.status<>OLD.status AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'task CAS';END IF;RETURN NEW;END$$;
CREATE FUNCTION ct.admit_task_mandate() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE v bigint; active boolean; member text; BEGIN
 IF NEW.organization IS NULL OR NEW.mandate IS NULL OR NEW.mandate_version IS NULL THEN RAISE EXCEPTION 'task mandate required'; END IF;
 -- Same order as product admission: principal, mandate, then VERA membership.
 -- FOR SHARE conflicts with a principal update, a mandate update, and a membership delete.
 SELECT p.active INTO active FROM ct.principals p WHERE p.tenant=NEW.tenant AND p.id=NEW.principal FOR SHARE;
 IF active IS DISTINCT FROM true THEN RAISE EXCEPTION 'inactive principal'; END IF;
 SELECT ct.share_mandate(NEW.tenant, NEW.organization, NEW.mandate) INTO v;
 IF v IS NULL OR v<>NEW.mandate_version THEN RAISE EXCEPTION 'mandate is not current'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ct.mandate_versions WHERE tenant=NEW.tenant AND organization=NEW.organization AND mandate=NEW.mandate AND version=NEW.mandate_version) THEN RAISE EXCEPTION 'mandate version missing'; END IF;
 SELECT ct.share_vera_membership(NEW.tenant, NEW.organization, NEW.principal) INTO member;
 IF member IS NULL THEN RAISE EXCEPTION 'vera membership required'; END IF;
 RETURN NEW;END$$;
CREATE TRIGGER task_mandate_admission BEFORE INSERT ON ct.tasks FOR EACH ROW EXECUTE FUNCTION ct.admit_task_mandate();
DO $$DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['organizations','memberships','mandates','mandate_versions'] LOOP
 EXECUTE format('CREATE POLICY regency_product_read ON ct.%I FOR SELECT TO ct_product_api USING(true)', t);
END LOOP;END$$;
-- PostgreSQL 17 requires UPDATE privilege for FOR SHARE. ct_product_api has
-- SELECT only, so the table owner takes that lock in the caller's transaction.
-- FOR SHARE conflicts with an update of the mandate row and a delete of the
-- membership row. It does not grant the product role a write privilege.
CREATE FUNCTION ct.share_mandate(p_tenant text, p_organization text, p_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v bigint;
BEGIN
  SELECT m.current_version INTO v FROM ct.mandates m
  WHERE m.tenant = p_tenant AND m.organization = p_organization AND m.id = p_id
  FOR SHARE;
  RETURN v;
END $$;
CREATE FUNCTION ct.share_vera_membership(p_tenant text, p_organization text, p_subject text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE s text;
BEGIN
  SELECT m.subject_id INTO s FROM ct.memberships m
  WHERE m.tenant = p_tenant AND m.organization = p_organization
    AND m.subject_kind = 'vera' AND m.subject_id = p_subject
  FOR SHARE;
  RETURN s;
END $$;
RESET ROLE;
REVOKE ALL ON FUNCTION ct.share_mandate(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ct.share_vera_membership(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ct.share_mandate(text, text, text), ct.share_vera_membership(text, text, text) TO ct_product_api, ct_authority_api;
GRANT SELECT ON ct.organizations,ct.memberships,ct.mandates,ct.mandate_versions TO ct_product_api;
COMMIT;
