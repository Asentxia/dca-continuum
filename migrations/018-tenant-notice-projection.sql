-- Derived tenant notices. A notice is not a grant, an approval, a send, or provider truth.
BEGIN;
SET ROLE ct_owner;
CREATE TABLE ct.notice_projection(tenant text NOT NULL,seq bigint NOT NULL CHECK(seq>0),subject_id text NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 200),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 500),source text NOT NULL CHECK(source='governor'),PRIMARY KEY(tenant,seq),FOREIGN KEY(tenant,seq) REFERENCES ct.evidence_events(tenant,seq));
CREATE TABLE ct.notice_deliveries(tenant text NOT NULL,seq bigint NOT NULL CHECK(seq>0),PRIMARY KEY(tenant,seq),FOREIGN KEY(tenant,seq) REFERENCES ct.evidence_events(tenant,seq));
ALTER TABLE ct.notice_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.notice_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE ct.notice_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct.notice_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_governor ON ct.notice_projection TO ct_owner,ct_governor USING(true) WITH CHECK(true);
CREATE POLICY notice_governor ON ct.notice_deliveries TO ct_owner,ct_governor USING(true) WITH CHECK(true);
CREATE POLICY notice_console_read ON ct.notice_projection FOR SELECT TO ct_console_reader USING(true);
CREATE POLICY notice_console_read ON ct.notice_deliveries FOR SELECT TO ct_console_reader USING(true);
CREATE POLICY notice_tenant_read ON ct.notice_projection FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant());
CREATE POLICY notice_tenant_read ON ct.notice_deliveries FOR SELECT TO ct_tenant_a,ct_tenant_b USING(tenant=ct.my_tenant());
RESET ROLE;
GRANT SELECT,INSERT,DELETE ON ct.notice_projection,ct.notice_deliveries TO ct_governor;
GRANT SELECT ON ct.notice_projection,ct.notice_deliveries TO ct_console_reader,ct_tenant_a,ct_tenant_b;
COMMIT;
