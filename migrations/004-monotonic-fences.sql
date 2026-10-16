SET ROLE ct_owner;
CREATE FUNCTION ct.guard_principal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.epoch<OLD.epoch OR NEW.generation<OLD.generation OR (NOT OLD.active AND NEW.active AND NEW.epoch<=OLD.epoch) THEN RAISE EXCEPTION 'principal fences must be monotonic'; END IF;RETURN NEW;
END$$;
CREATE TRIGGER principal_monotonic BEFORE UPDATE ON ct.principals FOR EACH ROW EXECUTE FUNCTION ct.guard_principal();
CREATE FUNCTION ct.guard_grant_version() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.version<OLD.version OR (ROW(NEW.principal,NEW.action,NEW.resource,NEW.revoked,NEW.expires,NEW.max_cost,NEW.budget,NEW.approval_required) IS DISTINCT FROM ROW(OLD.principal,OLD.action,OLD.resource,OLD.revoked,OLD.expires,OLD.max_cost,OLD.budget,OLD.approval_required) AND NEW.version<=OLD.version) THEN RAISE EXCEPTION 'changed authority requires a higher grant version'; END IF;RETURN NEW;
END$$;
CREATE TRIGGER grant_version_monotonic BEFORE UPDATE ON ct.grants FOR EACH ROW EXECUTE FUNCTION ct.guard_grant_version();
RESET ROLE;
