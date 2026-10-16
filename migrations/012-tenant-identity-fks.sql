-- Tenant-local creator/actor integrity. Cluster recovery still records one operator on every tenant run.
BEGIN;
SET ROLE ct_owner;
ALTER TABLE ct.identities ADD CONSTRAINT identities_tenant_id_key UNIQUE (tenant, id);
ALTER TABLE ct.tasks DROP CONSTRAINT tasks_created_by_fkey;
ALTER TABLE ct.tasks
  ADD CONSTRAINT tasks_created_by_tenant_fkey
  FOREIGN KEY (tenant, created_by) REFERENCES ct.identities (tenant, id);
ALTER TABLE ct.assignments DROP CONSTRAINT assignments_identity_id_fkey;
ALTER TABLE ct.assignments
  ADD CONSTRAINT assignments_identity_tenant_fkey
  FOREIGN KEY (tenant, identity_id) REFERENCES ct.identities (tenant, id);
-- started_by stays a global identity reference: one cluster operator opens every tenant recovery run.
DO $$BEGIN
 IF to_regclass('ct.console_commands') IS NOT NULL THEN
  ALTER TABLE ct.console_commands DROP CONSTRAINT console_commands_actor_fkey;
  ALTER TABLE ct.console_commands
    ADD CONSTRAINT console_commands_actor_tenant_fkey
    FOREIGN KEY (tenant, actor) REFERENCES ct.identities (tenant, id);
 END IF;
 IF to_regclass('ct.handoffs') IS NOT NULL THEN
  ALTER TABLE ct.handoffs DROP CONSTRAINT handoffs_offered_by_fkey;
  ALTER TABLE ct.handoffs DROP CONSTRAINT handoffs_accepted_by_fkey;
  ALTER TABLE ct.handoffs
    ADD CONSTRAINT handoffs_offered_by_tenant_fkey
    FOREIGN KEY (tenant, offered_by) REFERENCES ct.identities (tenant, id);
  ALTER TABLE ct.handoffs
    ADD CONSTRAINT handoffs_accepted_by_tenant_fkey
    FOREIGN KEY (tenant, accepted_by) REFERENCES ct.identities (tenant, id);
 END IF;
 IF to_regclass('ct.manual_leases') IS NOT NULL THEN
  ALTER TABLE ct.manual_leases DROP CONSTRAINT manual_leases_human_identity_fkey;
  ALTER TABLE ct.manual_leases
    ADD CONSTRAINT manual_leases_human_tenant_fkey
    FOREIGN KEY (tenant, human_identity) REFERENCES ct.identities (tenant, id);
 END IF;
END$$;
RESET ROLE;
COMMIT;
