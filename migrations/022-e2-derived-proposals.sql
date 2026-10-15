BEGIN;
SET ROLE ct_owner;
CREATE TABLE ct.e2_derivation_receipts (
 tenant text NOT NULL,
 receipt_id text NOT NULL CHECK(receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 principal text NOT NULL,
 source_id text NOT NULL,
 source_version integer NOT NULL CHECK(source_version>0),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 result_id text NOT NULL,
 result_version integer NOT NULL CHECK(result_version>0),
 result_digest text NOT NULL CHECK(result_digest ~ '^[0-9a-f]{64}$'),
 binding_digest text NOT NULL CHECK(binding_digest ~ '^[0-9a-f]{64}$'),
 extraction_protocol_version text NOT NULL CHECK(extraction_protocol_version='continuum-derived-unverified-text/v1'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 result_expires timestamptz NOT NULL CHECK(isfinite(result_expires) AND result_expires>recorded_at),
 withdrawn_at timestamptz CHECK(isfinite(withdrawn_at)),
 withdrawal_code text CHECK(withdrawal_code IN('SOURCE_DELETED','SOURCE_EXPIRED','SOURCE_REPLACED','RESULT_ERASED','RESULT_EXPIRED','RECOVERY_WITHDRAWN')),
 PRIMARY KEY(tenant,receipt_id),
 UNIQUE(tenant,principal,source_id,source_version,source_digest,extraction_protocol_version),
 UNIQUE(tenant,result_id,result_version),
 CHECK(source_id<>result_id),
 CHECK((withdrawn_at IS NULL)=(withdrawal_code IS NULL)),
 FOREIGN KEY(tenant,principal) REFERENCES ct.principals(tenant,id),
 FOREIGN KEY(tenant,source_id,source_version) REFERENCES ct.context_versions(tenant,id,version),
 FOREIGN KEY(tenant,result_id,result_version) REFERENCES ct.context_versions(tenant,id,version)
);
ALTER TABLE ct.e2_derivation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.e2_derivation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY e2_context_only ON ct.e2_derivation_receipts TO ct_context_service USING(true) WITH CHECK(true);
-- INVOKER functions. No SECURITY DEFINER, dynamic SQL, worker or tenant grants.
CREATE FUNCTION ct.guard_e2_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ct.context_versions%ROWTYPE; r ct.context_versions%ROWTYPE; h ct.context_heads%ROWTYPE; sh ct.context_heads%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'withdrawn_at'-'withdrawal_code') IS DISTINCT FROM (to_jsonb(OLD)-'withdrawn_at'-'withdrawal_code')
     OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL OR NEW.withdrawal_code IS NULL
     OR NEW.withdrawn_at<OLD.recorded_at THEN RAISE EXCEPTION 'immutable E2 receipt'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO s FROM ct.context_versions WHERE tenant=NEW.tenant AND id=NEW.source_id AND version=NEW.source_version;
 SELECT * INTO r FROM ct.context_versions WHERE tenant=NEW.tenant AND id=NEW.result_id AND version=NEW.result_version;
 SELECT * INTO h FROM ct.context_heads WHERE tenant=NEW.tenant AND id=NEW.result_id;
 SELECT * INTO sh FROM ct.context_heads WHERE tenant=NEW.tenant AND id=NEW.source_id;
 -- Reads take no new locks: runtime already holds sorted principals, then heads.
 -- FKs add KEY SHARE on existing principals/versions, never after evidence append.
 IF s.id IS NULL OR r.id IS NULL OR h.id IS NULL OR sh.id IS NULL OR
    s.digest<>NEW.source_digest OR r.digest<>NEW.result_digest OR
    r.principal IS DISTINCT FROM NEW.principal OR h.principal IS DISTINCT FROM NEW.principal OR
    r.expires<>NEW.result_expires OR r.observed_at<>NEW.recorded_at OR
    s.expires<NEW.result_expires OR s.erased_at IS NOT NULL OR r.erased_at IS NOT NULL OR
    s.source ? 'e2' OR s.payload IS NULL OR r.payload IS NULL OR
    sh.version<>NEW.source_version OR sh.deleted OR sh.quarantined OR
    h.version<>NEW.result_version OR h.deleted OR NOT h.quarantined OR h.visibility<>'PRIVATE' OR
    r.source->'e2' IS DISTINCT FROM jsonb_build_object('recordClass','E2_DERIVED_UNVERIFIED_V1','receiptId',NEW.receipt_id) OR
    r.source->'provenance'->'upstreamOrigin'->>'status' IS DISTINCT FROM 'UNVERIFIED' OR
    NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'E2 lineage contract'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER e2_receipt_contract BEFORE INSERT OR UPDATE ON ct.e2_derivation_receipts FOR EACH ROW EXECUTE FUNCTION ct.guard_e2_receipt();
CREATE FUNCTION ct.guard_e2_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source ? 'e2' AND NOT EXISTS(SELECT FROM ct.e2_derivation_receipts e
   WHERE e.tenant=NEW.tenant AND e.result_id=NEW.id AND e.result_version=NEW.version AND e.result_digest=NEW.digest
     AND NEW.source->'e2'=jsonb_build_object('recordClass','E2_DERIVED_UNVERIFIED_V1','receiptId',e.receipt_id))
 THEN RAISE EXCEPTION 'E2 marker requires exact receipt'; END IF;
 RETURN NEW;
END$$;
CREATE CONSTRAINT TRIGGER e2_marker_contract AFTER INSERT ON ct.context_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ct.guard_e2_marker();
CREATE FUNCTION ct.guard_e2_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT FROM ct.context_versions v WHERE v.tenant=OLD.tenant AND v.id=OLD.id AND v.version=OLD.version AND v.source ? 'e2')
 AND (NEW.version<>OLD.version OR NOT NEW.quarantined OR NEW.visibility<>'PRIVATE' OR (OLD.deleted AND NOT NEW.deleted))
 THEN RAISE EXCEPTION 'E2 head cannot refresh/release/share'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER e2_head_contract BEFORE UPDATE ON ct.context_heads FOR EACH ROW EXECUTE FUNCTION ct.guard_e2_head();
REVOKE ALL ON FUNCTION ct.guard_e2_receipt(),ct.guard_e2_marker(),ct.guard_e2_head() FROM PUBLIC;
RESET ROLE;
REVOKE ALL ON ct.e2_derivation_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON ct.e2_derivation_receipts TO ct_context_service;
GRANT UPDATE(withdrawn_at,withdrawal_code) ON ct.e2_derivation_receipts TO ct_context_service;
-- Recovery control lock is always acquired BEFORE enrollment/principals/heads.
GRANT SELECT ON ct.control TO ct_context_service;
GRANT UPDATE(lock_tag) ON ct.control TO ct_context_service;
SET ROLE ct_owner;
CREATE POLICY e2_control_read ON ct.control FOR SELECT TO ct_context_service USING(true);
RESET ROLE;
COMMIT;
