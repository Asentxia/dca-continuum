BEGIN;
SET ROLE ct_owner;
CREATE TABLE ct.context_heads(tenant text NOT NULL,id text NOT NULL,principal text,version integer NOT NULL DEFAULT 0 CHECK(version>=0),quarantined boolean NOT NULL DEFAULT true,visibility text NOT NULL DEFAULT 'PRIVATE' CHECK(visibility IN('PRIVATE','TENANT')),deleted boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 1,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant) REFERENCES ct.tenants(id),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE TABLE ct.context_versions(tenant text NOT NULL,id text NOT NULL,version integer NOT NULL CHECK(version>0),principal text,payload text,digest text NOT NULL CHECK(length(digest)=64),source jsonb NOT NULL,observed_at timestamptz NOT NULL,expires timestamptz NOT NULL,erased_at timestamptz,PRIMARY KEY(tenant,id,version),FOREIGN KEY(tenant,id) REFERENCES ct.context_heads(tenant,id));
ALTER TABLE ct.context_heads ADD CONSTRAINT context_current_version FOREIGN KEY(tenant,id,version) REFERENCES ct.context_versions(tenant,id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION ct.guard_context_version() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.version,NEW.principal,NEW.digest,NEW.source,NEW.observed_at,NEW.expires) IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.version,OLD.principal,OLD.digest,OLD.source,OLD.observed_at,OLD.expires) OR NOT(OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.payload IS NULL) THEN RAISE EXCEPTION 'immutable context version; erasure only';END IF;RETURN NEW;END$$;
CREATE TRIGGER context_version_contract BEFORE UPDATE ON ct.context_versions FOR EACH ROW EXECUTE FUNCTION ct.guard_context_version();
CREATE TABLE ct.artifact_manifests(tenant text NOT NULL,id text NOT NULL,computer text NOT NULL,principal text NOT NULL,generation integer NOT NULL,manifest jsonb NOT NULL,digest text NOT NULL CHECK(length(digest)=64),status text NOT NULL DEFAULT 'READY' CHECK(status IN('READY','QUARANTINED','DELETED')),PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,computer) REFERENCES ct.computers(tenant,id),FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id));
CREATE TABLE ct.artifact_gc_locks(tenant text PRIMARY KEY REFERENCES ct.tenants(id),lock_tag bigint NOT NULL DEFAULT 0);
CREATE TABLE ct.artifact_deletions(tenant text NOT NULL,id text NOT NULL,digests jsonb NOT NULL,done boolean NOT NULL DEFAULT false,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,id) REFERENCES ct.artifact_manifests(tenant,id));
CREATE FUNCTION ct.guard_artifact() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ROW(NEW.tenant,NEW.id,NEW.computer,NEW.principal,NEW.generation,NEW.manifest,NEW.digest) IS DISTINCT FROM ROW(OLD.tenant,OLD.id,OLD.computer,OLD.principal,OLD.generation,OLD.manifest,OLD.digest) OR (OLD.status='DELETED' AND NEW.status<>'DELETED') THEN RAISE EXCEPTION 'immutable artifact/tombstone';END IF;RETURN NEW;END$$;
CREATE TRIGGER artifact_contract BEFORE UPDATE ON ct.artifact_manifests FOR EACH ROW EXECUTE FUNCTION ct.guard_artifact();
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['context_heads','context_versions','artifact_manifests','artifact_gc_locks','artifact_deletions'] LOOP
 EXECUTE format('ALTER TABLE ct.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE ct.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY context_service ON ct.%I TO ct_context_service USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY tenant_read ON ct.%I FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant())',t);
 END LOOP;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['identities','principals','evidence_heads','evidence_events','computers'] LOOP EXECUTE format('CREATE POLICY context_backend ON ct.%I TO ct_context_service USING(true) WITH CHECK(true)',t);END LOOP;END$$;
RESET ROLE;
GRANT SELECT ON ct.identities,ct.principals,ct.computers,ct.evidence_heads TO ct_context_service;
GRANT UPDATE(lock_tag) ON ct.identities,ct.principals,ct.computers TO ct_context_service;
GRANT SELECT,INSERT,UPDATE ON ct.context_heads,ct.artifact_gc_locks,ct.artifact_deletions TO ct_context_service;
GRANT SELECT,INSERT ON ct.context_versions,ct.artifact_manifests TO ct_context_service;
GRANT UPDATE(payload,erased_at) ON ct.context_versions TO ct_context_service;
GRANT UPDATE(status) ON ct.artifact_manifests TO ct_context_service;
GRANT UPDATE ON ct.evidence_heads TO ct_context_service;
GRANT INSERT ON ct.evidence_events TO ct_context_service;
GRANT SELECT ON ct.context_heads,ct.context_versions,ct.artifact_manifests TO ct_tenant_a,ct_tenant_b;
COMMIT;
