-- PostgreSQL SELECT FOR SHARE/UPDATE requires UPDATE on at least one column.
-- Non-semantic columns permit authority row locks without permitting changes to
-- the actual principal, approval or recovery-fence fields.
ALTER TABLE ct.control ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
ALTER TABLE ct.principals ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
ALTER TABLE ct.approvals ADD COLUMN lock_tag bigint NOT NULL DEFAULT 0;
GRANT UPDATE(lock_tag) ON ct.control,ct.principals,ct.approvals TO ct_controller;
