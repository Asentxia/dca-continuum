import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './implementation-helpers.js';
import { admin, gov, fence } from './helpers.js';
import { pool } from '../src/db.js';
import { ConsoleReads } from '../src/console/reads.js';
import { ConsoleCommands } from '../src/console/commands.js';
import { CursorCodec } from '../src/console/pagination.js';
import { WorkCoordination } from '../src/console/coordination.js';
import { ManualControl } from '../src/console/manual-control.js';
import { consoleApi } from '../src/console/api.js';
import { EnvelopeSchema, CommandSchema } from '../src/console/contracts.js';
import { operationTruth } from '../src/console/semantics.js';
let f: Awaited<ReturnType<typeof fixture>>,
  reads: ConsoleReads,
  commands: ConsoleCommands,
  readDb: ReturnType<typeof pool>,
  writeDb: ReturnType<typeof pool>,
  coord: WorkCoordination,
  api: ReturnType<typeof consoleApi>,
  url: string;
before(async () => {
  f = await fixture('canonical');
  readDb = pool('ct_console_reader');
  writeDb = pool('ct_authority_api');
  reads = new ConsoleReads(
    readDb,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    'canonical-test-revision',
    fence,
  );
  commands = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    fence,
    'LOCAL_FIXTURE',
  );
  coord = new WorkCoordination(writeDb, fence);
  api = consoleApi(f.human, reads, commands);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  url = 'http://127.0.0.1:' + (api.address() as any).port;
});
after(async () => {
  if (api) await new Promise<void>((r) => api.close(() => r()));
  if (f) await f.close();
  if (readDb) await readDb.end();
  if (writeDb) await writeDb.end();
  await admin.end();
  await gov.end();
});
function cmd(
  kind: string,
  target: string,
  input: any = {},
  version = 0,
  key = kind + '-' + target,
) {
  return {
    schema_version: 1,
    idempotency_key: key,
    kind,
    target,
    expected_version: version,
    input,
  };
}
async function call(
  path: string,
  body?: unknown,
  kind: 'user' | 'machine' = 'user',
  tenant = 'a',
) {
  return fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer ' + (await f.token(kind, tenant)),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
test('A01/A11 real signature + independent enrollment enforce human/tenant reads', async () => {
  const a = await reads.read(await f.actor('user'), 'session'),
    b = await reads.read(await f.actor('user', 'b'), 'session');
  assert.equal(a.session?.tenant, 'a');
  assert.equal(b.session?.tenant, 'b');
  assert.ok(a.items[0].fields.identitySource?.toString().includes('TEST'));
  await assert.rejects(reads.read(await f.actor('machine'), 'session'));
  assert.equal((await fetch(url + '/read')).status, 401);
  assert.equal(
    (await call('/read?section=session', undefined, 'machine')).status,
    403,
  );
});
test('A02/A33/A37 readiness and availability never claim live P1/provider/HA qualification', async () => {
  const x = await reads.read(await f.actor('user'), 'setup');
  assert.ok(x.items.some((x) => x.status === 'Qualification pending'));
  assert.equal(x.features.protectedProvider.state, 'qualification_pending');
  assert.equal(x.features.scheduler.state, 'qualification_pending');
  assert.equal(x.features.manualControl.state, 'qualification_pending');
  const y = await reads.read(await f.actor('user'), 'settings');
  assert.equal(y.items[0].fields.P3, 'NOT RUN');
  assert.equal(y.items[0].fields.scheduler, 'HELD');
});
test('A06 concurrent same-key task creation has one atomic result; changed body conflicts', async () => {
  const owner = await f.actor('user'),
    body = cmd('create_task', 'console-new-task', {
      principal: f.principal,
      objective: 'Recorded task, not executed work',
      deadline: new Date(Date.now() + 3600000).toISOString(),
      ...f.admission.a,
    });
  const results = await Promise.all([
    commands.execute(owner, body),
    commands.execute(owner, body),
  ]);
  assert.equal(results[0].command_id, results[1].command_id);
  assert.equal(results.filter((x) => !x.reused).length, 1);
  assert.equal((results[0].result as any).workflowAdmitted, false);
  await assert.rejects(
    commands.execute(owner, {
      ...body,
      input: { ...body.input, objective: 'altered' },
    }),
  );
  assert.equal(
    (await commands.lookup(owner, body.idempotency_key)).status,
    'APPLIED',
  );
  assert.equal(
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM ct.tasks WHERE tenant='a' AND id='console-new-task'",
        )
      ).rows[0].n,
    ),
    1,
  );
});
test('A05 authoritative task with approval is pending, never business completion', async () => {
  const { x } = await f.intent('console-pending', true);
  const r = await reads.read(await f.actor('user'), 'work', { id: x.task });
  assert.equal(r.items[0].status, 'Pending exact review');
  assert.equal(
    r.items[0].fields.businessGoal,
    'Not automatically proven by effects',
  );
});
test('A16/A17 exact immutable approval and ledger/history are one transaction', async () => {
  const { x, op } = await f.intent('console-approve');
  const owner = await f.actor('user');
  const request = cmd(
    'approve',
    x.id,
    { digest: op.digest, expires: x.deadline, approvalRevision: 0 },
    1,
  );
  const r = await commands.execute(owner, request);
  assert.equal(r.status, 'APPLIED');
  assert.equal(
    (await commands.lookup(owner, request.idempotency_key)).command_id,
    r.command_id,
  );
  const count = await admin.query(
    "SELECT count(*) n FROM ct.approval_history WHERE tenant='a' AND operation=$1",
    [x.id],
  );
  assert.equal(Number(count.rows[0].n), 1);
  assert.equal((await f.product.status(owner, x.task)).phase, 'PLANNED');
  assert.equal(f.provider.sends, 0);
  const second = await commands.execute(owner, {
    ...request,
    idempotency_key: 'stale-second-tab',
  });
  assert.equal(second.status, 'DENIED');
  assert.equal(
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM ct.approval_history WHERE tenant='a' AND operation=$1",
          [x.id],
        )
      ).rows[0].n,
    ),
    1,
  );
});
test('A17 stale preview digest/version/fresh MFA cannot apply approval', async () => {
  const { x, op } = await f.intent('console-approval-denied');
  const owner = await f.actor('user');
  for (const change of [
    { digest: '0'.repeat(64), version: 1 },
    { digest: op.digest, version: 2 },
  ])
    assert.equal(
      (
        await commands.execute(
          owner,
          cmd(
            'approve',
            x.id,
            { digest: change.digest, expires: x.deadline, approvalRevision: 0 },
            change.version,
            'deny-' + change.digest.slice(0, 6) + '-' + change.version,
          ),
        )
      ).status,
      'DENIED',
    );
  await assert.rejects(
    commands.execute(
      { ...owner, authTime: Date.now() - 300001 },
      cmd(
        'approve',
        x.id,
        { digest: op.digest, expires: x.deadline, approvalRevision: 0 },
        1,
      ),
    ),
  );
  assert.equal(f.provider.sends, 0);
});
test('A17 command rollback after contended lock expires identity: no approval/history', async () => {
  const { x, op } = await f.intent('console-lock-expiry'),
    owner = await f.actor('user'),
    locker = await admin.connect();
  await locker.query('BEGIN');
  await locker.query(
    "SELECT * FROM ct.principals WHERE tenant='a' AND id=$1 FOR UPDATE",
    [f.principal],
  );
  const pending = commands.execute(
    { ...owner, expires: Date.now() + 250 },
    cmd(
      'approve',
      x.id,
      { digest: op.digest, expires: x.deadline, approvalRevision: 0 },
      1,
    ),
  );
  await new Promise((r) => setTimeout(r, 400));
  await locker.query('ROLLBACK');
  locker.release();
  assert.equal((await pending).status, 'DENIED');
  assert.equal(
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM ct.approvals WHERE tenant='a' AND operation=$1",
          [x.id],
        )
      ).rows[0].n,
    ),
    0,
  );
});
test('A18 append-only decision history survives approval expiration and refuses mutation', async () => {
  const { x, op } = await f.intent('console-history');
  const owner = await f.actor('user'),
    expiry = new Date(Date.now() + 200).toISOString();
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'approve',
          x.id,
          { digest: op.digest, expires: expiry, approvalRevision: 0 },
          1,
        ),
      )
    ).status,
    'APPLIED',
  );
  await new Promise((r) => setTimeout(r, 240));
  const view = await reads.read(owner, 'approvals', { id: x.id });
  assert.equal(
    view.items[0].fields.approvalStatus,
    'Expired decision retained',
  );
  await assert.rejects(
    writeDb.query("UPDATE ct.approval_history SET approved_by='forged'"),
  );
  await assert.rejects(writeDb.query('DELETE FROM ct.approval_history'));
});
test('A12 machine assignment rejects human identity and persists exact binding', async () => {
  const { x } = await f.intent('console-assign');
  const owner = await f.actor('user');
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'assign',
          x.id,
          { identity: 'canonical-owner-a', expires: x.deadline },
          1,
          'human-as-worker',
        ),
      )
    ).status,
    'DENIED',
  );
  await admin.query(
    "DELETE FROM ct.assignments WHERE tenant='a' AND operation=$1",
    [x.id],
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'assign',
          x.id,
          { identity: 'canonical-worker-a', expires: x.deadline },
          1,
        ),
      )
    ).status,
    'APPLIED',
  );
  assert.equal(
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM ct.assignments WHERE tenant='a' AND operation=$1",
          [x.id],
        )
      ).rows[0].n,
    ),
    1,
  );
});
test('A20 strict bounded grants deny unsupported selector/unsafe scope', async () => {
  const owner = await f.actor('user'),
    base = {
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: new Date(Date.now() + 3600000).toISOString(),
      maxCost: 1,
      budget: 3,
    };
  assert.equal(
    (await commands.execute(owner, cmd('create_grant', 'console-grant', base)))
      .status,
    'APPLIED',
  );
  for (const [n, extra] of [
    { resource: 'arbitrary' },
    { budget: 0 },
    { expires: new Date(Date.now() + 172900000).toISOString() },
  ].entries())
    assert.equal(
      (
        await commands.execute(
          owner,
          cmd('create_grant', 'console-invalid-' + n, { ...base, ...extra }),
        )
      ).status,
      'DENIED',
    );
  assert.throws(() =>
    CommandSchema.parse({ ...cmd('create_grant', 'bad', base), tenant: 'b' }),
  );
});
test('A21 lost revoke reply is looked up, not repeated; future capability admission denied', async () => {
  const { x } = await f.intent('console-revoke', true),
    owner = await f.actor('user'),
    cap = await f.capability(x.id);
  const request = cmd('revoke_grant', x.grant, {}, 1);
  const result = await commands.execute(owner, request);
  assert.equal(result.status, 'APPLIED');
  assert.equal(
    (await commands.lookup(owner, request.idempotency_key)).command_id,
    result.command_id,
  );
  assert.equal((await f.controller.dispatch(cap, x.id)).state, 'DENIED');
  const view = await reads.read(owner, 'authority', { id: x.grant });
  assert.equal(view.items[0].status, 'Grant revoked');
  assert.ok(
    view.items[0].fields.inFlight?.toString().includes('may still finish'),
  );
});
test('A22/A24 unsupported COMMITTED assertion with a valid chain cannot produce success', async () => {
  assert.equal(
    operationTruth({
      state: 'COMMITTED',
      provider: 'fixture',
      observation: { signature: 'valid' },
    }).verified,
    false,
  );
  const { x } = await f.intent('console-effect', true);
  const committed = await f.controller.dispatch(await f.capability(x.id), x.id);
  assert.equal(operationTruth(committed).verified, true);
  const row = await reads.read(await f.actor('user'), 'work', { id: x.task });
  assert.equal(row.items[0].status, 'Effects verified — goal review required');
});
test('A31 revoked UNKNOWN stays owned/uncertain, with no browser reconcile/retry route', async () => {
  const { x } = await f.intent('console-unknown', true);
  f.provider.loseAck = true;
  assert.equal(
    (await f.controller.dispatch(await f.capability(x.id), x.id)).state,
    'UNKNOWN',
  );
  f.provider.loseAck = false;
  await f.authority.revoke(await f.actor('user'), x.grant);
  const r = await reads.read(await f.actor('user'), 'recovery', { id: x.id });
  assert.equal(r.items[0].status, 'Outcome uncertain');
  assert.equal(r.items[0].fields.recoveryOwner, f.principal);
  assert.equal((r.items[0].fields.verification as any).canRetry, false);
  for (const path of ['/dispatch', '/reconcile', '/renew'])
    assert.equal((await call(path, {})).status, 404);
});
test('A07/A08 project reads reference the same scoped tasks; dependency cycles and crossing fail', async () => {
  const owner = await f.actor('user');
  await coord.project(
    owner,
    'weekly',
    'Weekly operations',
    'Known fixture scope',
  );
  const a = await f.intent('coord-a'),
    b = await f.intent('coord-b');
  await coord.link(owner, a.x.task, 'weekly', 0);
  await coord.link(owner, b.x.task, 'weekly', 0);
  await coord.dependency(owner, a.x.task, b.x.task, 1);
  await assert.rejects(coord.dependency(owner, b.x.task, a.x.task, 1));
  const project = await reads.read(owner, 'projects', { id: 'weekly' });
  assert.ok((project.items[0].fields.tasks as string[]).includes(a.x.task));
  const task = await reads.read(owner, 'work', { id: a.x.task });
  assert.ok((task.items[0].fields.dependencies as string[]).includes(b.x.task));
  await assert.rejects(
    coord.link(await f.actor('user', 'b'), a.x.task, 'weekly', 0),
  );
});
test('A09 competing handoffs keep one owner and do not transfer existing operation authority', async () => {
  const owner = await f.actor('user'),
    worker = await f.actor('machine'),
    old = await f.intent('handoff-safe', true);
  await coord.link(owner, old.x.task, 'weekly', 0);
  await gov.query(
    "INSERT INTO ct.principals(tenant,id,epoch,generation) VALUES('a','handoff-target',1,1)",
  );
  await gov.query(
    "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,principal,domain_role) VALUES('target-worker',$1,'target-subject',$2,'machine','a','handoff-target','worker')",
    [f.issuer, f.audience],
  );
  const offers = await Promise.allSettled([
    coord.offer(owner, old.x.task, 'handoff-target', 1),
    coord.offer(owner, old.x.task, 'handoff-target', 1),
  ]);
  assert.equal(offers.filter((x) => x.status === 'fulfilled').length, 1);
  const offer = (
    offers.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>
  ).value;
  await assert.rejects(coord.accept(worker, offer.id));
  const accepted = await coord.accept(
    { ...worker, subject: 'target-subject' },
    offer.id,
  );
  assert.equal(accepted.authorityTransferred, false);
  assert.equal(
    (
      await admin.query(
        "SELECT principal FROM ct.operations WHERE tenant='a' AND id=$1",
        [old.x.id],
      )
    ).rows[0].principal,
    f.principal,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT accountable_vera FROM ct.work_coordination WHERE tenant='a' AND task=$1",
        [old.x.task],
      )
    ).rows[0].accountable_vera,
    'handoff-target',
  );
});
test('A10/A14 model replacement changes binding only, never VERA or operation identity', async () => {
  await gov.query(
    "INSERT INTO ct.cognition_bindings VALUES('a',$1,1,'test-provider','test-model-1','test-config-v1','NEEDS_TESTING'),('a',$1,2,'test-provider','test-model-2','test-config-v2','NEEDS_TESTING')",
    [f.principal],
  );
  const view = await reads.read(await f.actor('user'), 'agents', {
    id: f.principal,
  });
  assert.equal(view.items[0].id, f.principal);
  assert.equal((view.items[0].fields.cognition as any).revision, 2);
  assert.equal(view.items[0].fields.VERA, f.principal);
});
test('A24/A25 evidence pagination binds tenant/filter/snapshot and export redacts selected page', async () => {
  const owner = await f.actor('user');
  const page = await reads.read(owner, 'evidence');
  assert.ok(page.cursor);
  assert.equal(page.items.length, 60);
  const second = await reads.read(owner, 'evidence', { cursor: page.cursor! });
  assert.ok(second.items[0].id > page.items[59].id);
  await assert.rejects(
    reads.read(await f.actor('user', 'b'), 'evidence', {
      cursor: page.cursor!,
    }),
  );
  await assert.rejects(
    reads.read(owner, 'evidence', { q: 'different', cursor: page.cursor! }),
  );
  const exp = await commands.execute(
    owner,
    cmd(
      'export_evidence',
      'selected-evidence',
      {
        sequences: page.items.slice(0, 3).map((x) => x.version),
        snapshot: page.projection_version,
      },
      page.projection_version,
    ),
  );
  assert.equal(exp.status, 'APPLIED');
  assert.equal((exp.result as any).completeness, 'partial');
  assert.equal((exp.result as any).scope, 'AUTHORIZED_SELECTED_PAGE');
  await assert.rejects(reads.read(owner, 'evidence', { cursor: page.cursor! }));
});
test('A32/A34 durable ack and notice-read never resolve cause or UNKNOWN', async () => {
  await gov.query(
    "INSERT INTO ct.incidents(tenant,id,root_id,cause,severity,status,title,owner_vera,source_version) VALUES('a','incident-one','console-unknown','LOST_ACK',0,'OPEN','Provider outcome uncertain',$1,1)",
    [f.principal],
  );
  await gov.query(
    "INSERT INTO ct.incident_tasks VALUES('a','incident-one','t-console-unknown')",
  );
  await gov.query(
    "INSERT INTO ct.notifications(tenant,id,incident,source_version,channel,delivery_state) VALUES('a','notice-one','incident-one',1,'in-app','IN_APP')",
  );
  await assert.rejects(
    gov.query(
      "INSERT INTO ct.notifications(tenant,id,incident,source_version,channel,delivery_state) VALUES('a','notice-duplicate','incident-one',1,'in-app','IN_APP')",
    ),
  );
  const owner = await f.actor('user');
  assert.equal(
    (await commands.execute(owner, cmd('ack_incident', 'incident-one', {}, 1)))
      .status,
    'APPLIED',
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd('mark_notification_read', 'notice-one', {}, 1),
      )
    ).status,
    'APPLIED',
  );
  assert.equal(
    (await reads.read(owner, 'incidents', { id: 'incident-one' })).items[0]
      .status,
    'ACKNOWLEDGED',
  );
  assert.equal(
    (await reads.read(owner, 'recovery', { id: 'console-unknown' })).items[0]
      .status,
    'Outcome uncertain',
  );
  assert.equal(
    (await reads.read(owner, 'focus')).items.some(
      (x) => x.fields.root === 'console-unknown',
    ),
    true,
  );
});
test('A19/A35 resource read shows actual reservations, no invented currency/spend', async () => {
  const view = await reads.read(await f.actor('user'), 'usage');
  assert.equal(view.items[0].fields.unit, 'test units');
  assert.equal(
    view.items[0].fields.measuredMoneySpent,
    'unknown — no billing meter',
  );
  assert.ok(Number(view.items[0].fields.jobsReserved) > 0);
});
test('A26/A28 separate raw Computer failures and generation never become stopped or workspaceRevision', async () => {
  await admin.query(
    "INSERT INTO ct.computers(tenant,id,principal,generation,state) VALUES('a','canonical-computer',$1,1,'LOST')",
    [f.principal],
  );
  await gov.query(
    "INSERT INTO ct.computer_observations VALUES('a','canonical-computer',1,'restore_failed','local-process','lost','LOCAL_FIXTURE',now(),now()+interval '1 hour','ready')",
  );
  const view = await reads.read(await f.actor('user'), 'computers', {
    id: 'canonical-computer',
  });
  assert.equal(view.items[0].status, 'LOST');
  assert.equal(view.items[0].fields.rawProviderState, 'restore_failed');
  assert.equal(view.items[0].fields.checkpointStatus, 'ready');
  assert.equal(view.items[0].fields.generation, 1);
  assert.equal(view.features.computerLifecycle.state, 'qualification_pending');
});
test('A29/A30 durable lease denies missing/multitab/stale generation, fences effects and hand-back never resumes', async () => {
  await admin.query(
    "UPDATE ct.computer_observations SET raw_state='ready',health='healthy' WHERE tenant='a' AND computer='canonical-computer'",
  );
  await admin.query(
    "UPDATE ct.computers SET state='RUNNING',revision=revision+1 WHERE tenant='a' AND id='canonical-computer'",
  );
  const owner = await f.actor('user'),
    manual = new ManualControl(writeDb, fence, true),
    live = new ManualControl(writeDb, fence, false),
    old = await f.intent('manual-no-bypass', true),
    cap = await f.capability(old.x.id);
  await assert.rejects(live.take(owner, 'canonical-computer', 1));
  await assert.rejects(
    manual.validate(owner, '00000000-0000-0000-0000-000000000000'),
  );
  const lease = await manual.take(owner, 'canonical-computer', 1);
  await assert.rejects(manual.take(owner, 'canonical-computer', 1));
  assert.equal((await f.controller.dispatch(cap, old.x.id)).state, 'DENIED');
  await manual.validate(owner, lease.id);
  assert.equal((await manual.handBack(owner, lease.id)).agentResumed, false);
  await assert.rejects(manual.validate(owner, lease.id));
  assert.equal(
    (
      await admin.query(
        "SELECT execution_mode FROM ct.principals WHERE tenant='a' AND id=$1",
        [f.principal],
      )
    ).rows[0].execution_mode,
    'PAUSED',
  );
});
test('A39 runtime envelopes and strict schemas fail closed; crossing objects is generic empty', async () => {
  assert.throws(() => EnvelopeSchema.parse({ schema_version: 99 }));
  assert.throws(() =>
    CommandSchema.parse({ ...cmd('approve', 'x'), approved: true }),
  );
  const response = await reads.read(await f.actor('user', 'b'), 'work', {
    id: 'console-new-task',
  });
  assert.equal(response.items.length, 0);
  assert.equal(response.total, 0);
  await assert.rejects(
    readDb.query(
      "UPDATE ct.operations SET state='COMMITTED',version=version+1",
    ),
  );
  await assert.rejects(readDb.query('UPDATE ct.identities SET active=false'));
});
test('Stage commands remain qualification-pending, even with a signed fresh owner', async () => {
  const staged = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    fence,
    'STAGING',
  );
  await assert.rejects(
    staged.execute(
      await f.actor('user'),
      cmd('create_task', 'stage-no-write', {
        principal: f.principal,
        objective: 'not a live effect',
        deadline: new Date(Date.now() + 10000).toISOString(),
        ...f.admission.a,
      }),
    ),
  );
});
test('Regency records stay visible and never change a grant or approval', async () => {
  const owner = await f.actor('user');
  const grants = async () =>
    (
      await admin.query(
        "SELECT count(*)::int n, COALESCE(max(version),0)::int v FROM ct.grants WHERE tenant='a'",
      )
    ).rows[0];
  const approvals = async () =>
    Number(
      (
        await admin.query(
          "SELECT count(*)::int n FROM ct.approvals WHERE tenant='a'",
        )
      ).rows[0].n,
    );
  const beforeGrants = await grants();
  const beforeApprovals = await approvals();
  const created = await commands.execute(
    owner,
    cmd('create_organization', 'regency-org', { name: 'Asentxia' }),
  );
  assert.equal(created.status, 'APPLIED');
  assert.equal((created.result as any).effectAuthority, false);
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd('define_role', 'writer', {
          organization: 'regency-org',
          name: 'write',
        }),
      )
    ).status,
    'APPLIED',
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd('add_membership', f.principal, {
          organization: 'regency-org',
          subjectKind: 'vera',
          roleId: 'steward',
          ownerSeat: false,
        }),
      )
    ).status,
    'APPLIED',
  );
  const mandate = await commands.execute(
    owner,
    cmd('record_mandate', 'operating', {
      organization: 'regency-org',
      title: 'Operate',
      body: 'Plan and work inside permissions already granted.',
    }),
  );
  assert.equal(mandate.status, 'APPLIED');
  assert.equal((mandate.result as any).effectAuthority, false);
  assert.deepEqual(await grants(), beforeGrants);
  assert.equal(await approvals(), beforeApprovals);
  const view = await reads.read(owner, 'governance');
  const recorded = view.items.find((item) => item.id === 'regency-org');
  assert.ok(recorded);
  assert.equal(recorded.title, 'Asentxia');
  assert.equal(recorded.fields.effectAuthority, false);
  assert.equal(
    (recorded.fields.note as string).includes('does not authorize'),
    true,
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'rename_organization',
          'regency-org',
          { name: 'Stale' },
          9,
          'rename-stale',
        ),
      )
    ).status,
    'DENIED',
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'rename_organization',
          'regency-org',
          { name: 'Asentxia Desk' },
          1,
          'rename-current',
        ),
      )
    ).status,
    'APPLIED',
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'rename_organization',
          'regency-org',
          { name: 'Conflict' },
          1,
          'rename-conflict',
        ),
      )
    ).status,
    'DENIED',
  );
  assert.equal(
    (
      await commands.execute(
        await f.actor('user', 'b'),
        cmd(
          'rename_organization',
          'regency-org',
          { name: 'Stolen' },
          2,
          'rename-cross-tenant',
        ),
      )
    ).status,
    'DENIED',
  );
  const other = await reads.read(await f.actor('user', 'b'), 'governance');
  assert.equal(
    other.items.some((item) => item.id === 'regency-org'),
    false,
  );
  const current = await reads.read(owner, 'governance');
  const currentOrg = current.items.find((item) => item.id === 'regency-org');
  assert.ok(currentOrg);
  const seat = (currentOrg.fields.memberships as any[]).find(
    (member) => member.ownerSeat,
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'remove_membership',
          seat.subjectId,
          { organization: 'regency-org', subjectKind: 'human' },
          seat.revision,
          'drop-last-owner',
        ),
      )
    ).status,
    'DENIED',
  );
  assert.equal(
    (
      await commands.execute(
        await f.actor('user', 'b'),
        cmd(
          'remove_membership',
          seat.subjectId,
          { organization: 'regency-org', subjectKind: 'human' },
          seat.revision,
          'guess-member',
        ),
      )
    ).status,
    'DENIED',
  );
  const kept = await reads.read(owner, 'governance');
  const keptOrg = kept.items.find((item) => item.id === 'regency-org');
  assert.ok(keptOrg);
  assert.equal(keptOrg.title, 'Asentxia Desk');
  assert.equal(
    (keptOrg.fields.mandates as any[]).find(
      (mandate) => mandate.id === 'operating',
    ).body,
    'Plan and work inside permissions already granted.',
  );
  assert.ok(
    (keptOrg.fields.memberships as any[]).some(
      (member) => member.ownerSeat && member.subjectId === seat.subjectId,
    ),
  );
  assert.deepEqual(await grants(), beforeGrants);
  assert.equal(await approvals(), beforeApprovals);
  await admin.query(
    "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,domain_role) VALUES('regency-second-owner',$1,'regency-second-owner',$2,'user','a','owner')",
    [f.issuer, f.audience],
  );
  assert.equal(
    (
      await commands.execute(
        owner,
        cmd(
          'add_membership',
          'regency-second-owner',
          {
            organization: 'regency-org',
            subjectKind: 'human',
            roleId: 'steward',
            ownerSeat: true,
          },
          0,
          'second-owner',
        ),
      )
    ).status,
    'APPLIED',
  );
  const first = await admin.connect();
  const second = await admin.connect();
  try {
    await first.query('BEGIN');
    await first.query(
      "DELETE FROM ct.memberships WHERE tenant='a' AND organization='regency-org' AND subject_kind='human' AND subject_id=$1",
      [seat.subjectId],
    );
    const otherDelete = (async () => {
      await second.query('BEGIN');
      await second.query(
        "DELETE FROM ct.memberships WHERE tenant='a' AND organization='regency-org' AND subject_kind='human' AND subject_id='regency-second-owner'",
      );
    })();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await first.query('COMMIT');
    await assert.rejects(otherDelete, /last organization owner/);
  } finally {
    await second.query('ROLLBACK').catch(() => undefined);
    await first.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
  }
});
