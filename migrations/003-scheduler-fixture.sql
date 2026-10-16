DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ct_scheduler') THEN CREATE ROLE ct_scheduler LOGIN; END IF; END$$;
GRANT CREATE ON DATABASE ct_test TO ct_scheduler;
CREATE SCHEMA ctq AUTHORIZATION ct_scheduler;
SET ROLE ct_scheduler;
-- Explicit two-phase workload projection, not domain authority or a general workflow interpreter.
CREATE TABLE ctq.jobs(id text PRIMARY KEY,version integer NOT NULL CHECK(version IN(1,2)),input jsonb NOT NULL,phase text NOT NULL DEFAULT 'READY' CHECK(phase IN('READY','WAITING','DONE','BLOCKED')),approved boolean NOT NULL DEFAULT false,due timestamptz,lease_until timestamptz,owner uuid,done integer[] NOT NULL DEFAULT '{}',revision bigint NOT NULL DEFAULT 0);
CREATE TABLE ctq.outbox(id text PRIMARY KEY,task_id text NOT NULL REFERENCES ctq.jobs(id),start_after timestamptz NOT NULL DEFAULT now(),sent boolean NOT NULL DEFAULT false);
RESET ROLE;
