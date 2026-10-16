-- Narrow human-managed VERA records. Not a lifecycle/authority or enrollment API.
-- Candidate only: the integration owner registers/applies it after review.
BEGIN;
SET ROLE ct_owner;

CREATE TABLE ct.vera_profiles (
  tenant text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  -- Match the service's nonblank string.trim() check without normalizing text.
  name text NOT NULL CHECK (
    length(name) BETWEEN 1 AND 200
    AND btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  description text NOT NULL CHECK (length(description) <= 8000),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL,
  -- Immutable original request, independent of later name/description edits.
  creation_digest text NOT NULL CHECK (length(creation_digest) = 64),
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant) REFERENCES ct.tenants (id),
  FOREIGN KEY (tenant, id) REFERENCES ct.principals (tenant, id),
  FOREIGN KEY (tenant, created_by) REFERENCES ct.identities (tenant, id)
);

CREATE FUNCTION ct.guard_vera_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'VERA profile must start at revision 1';
    END IF;
  ELSE
    IF ROW(NEW.tenant, NEW.id, NEW.created_by, NEW.creation_digest)
      IS DISTINCT FROM
      ROW(OLD.tenant, OLD.id, OLD.created_by, OLD.creation_digest) THEN
      RAISE EXCEPTION 'immutable VERA profile identity/creation binding';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'VERA profile CAS revision must advance by one';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vera_profile_contract
  BEFORE INSERT OR UPDATE ON ct.vera_profiles
  FOR EACH ROW EXECUTE FUNCTION ct.guard_vera_profile();

ALTER TABLE ct.vera_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.vera_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY vera_profile_trusted ON ct.vera_profiles
  TO ct_governor, ct_authority_api USING (true) WITH CHECK (true);
CREATE POLICY vera_profile_console_read ON ct.vera_profiles
  FOR SELECT TO ct_console_reader USING (true);
CREATE POLICY vera_profile_tenant_read ON ct.vera_profiles
  FOR SELECT TO ct_tenant_a, ct_tenant_b USING (tenant = ct.my_tenant());

REVOKE ALL ON ct.vera_profiles FROM PUBLIC;
REVOKE ALL ON FUNCTION ct.guard_vera_profile() FROM PUBLIC;
RESET ROLE;

GRANT SELECT ON ct.vera_profiles
  TO ct_authority_api, ct_governor, ct_console_reader, ct_tenant_a, ct_tenant_b;
GRANT INSERT (tenant, id, name, description, revision, created_by, creation_digest)
  ON ct.vera_profiles TO ct_authority_api, ct_governor;
GRANT UPDATE (name, description, revision)
  ON ct.vera_profiles TO ct_authority_api, ct_governor;
GRANT EXECUTE ON FUNCTION ct.guard_vera_profile() TO ct_authority_api, ct_governor;
-- Existing trusted API role only; no principal update or worker grant is added.
GRANT INSERT (tenant, id, epoch, generation, active, execution_mode)
  ON ct.principals TO ct_authority_api;
COMMIT;
