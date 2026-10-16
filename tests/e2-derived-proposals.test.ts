import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pool, canonical } from '../src/db.js';
import {
  ContextService,
  type ContextReference,
} from '../src/context-service.js';
import {
  createE2Ingress,
  createE2ReviewIngress,
  E2_EXTRACTION_PROTOCOL,
  type E2AdmissionReceipt,
} from '../src/e2-ingress.js';
import { E2RecoveryGate, E2_RETENTION_DEFAULTS } from '../src/e2-recovery.js';
import { LOCAL_MODEL_PROTOCOL } from '../src/model-protocol.js';
import { fixture } from './implementation-helpers.js';
import { admin, gov, fence } from './helpers.js';
const db = pool('ct_context_service');
const runId = randomUUID().slice(0, 8);
let journalKnown = true,
  journalFence = fence,
  journalRestored = false;
const gate = new E2RecoveryGate(
  {
    async normalOperationLease() {
      return journalKnown && !journalRestored
        ? {
            state: 'NORMAL_UNRESTORED',
            domain: 'offline-e2-fixture',
            fence: journalFence,
            validUntil: Date.now() + 60000,
          }
        : null;
    },
  },
  'offline-e2-fixture',
);
const context = new ContextService(db, gate);
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const owned: {
  id: string;
  f: Awaited<ReturnType<typeof fixture>>;
  tenant: string;
}[] = [];
async function setup(name: string) {
  const f = await fixture('e2-' + name + '-' + runId);
  fixtures.push(f);
  return f;
}
function own(f: Awaited<ReturnType<typeof fixture>>, id: string, tenant = 'a') {
  owned.push({ id, f, tenant });
}
async function source(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  ttl = 3600,
  tenant = 'a',
  share = false,
) {
  const id = 'e2-source-' + name + '-' + runId;
  own(f, id, tenant);
  const r = await context.ingest(await f.actor('machine', tenant), {
    id,
    expectedVersion: 0,
    payload: { note: 'sensitive source ' + name },
    source: { kind: 'document', reference: 'fixture' },
    ttlSeconds: ttl,
  });
  await context.approve(
    await f.actor('user', tenant),
    r.id,
    r.version,
    r.digest,
    share,
  );
  return { id: r.id, version: r.version, digest: r.digest };
}
async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  ref: ContextReference,
  text = 'An inert uncertain proposal',
  ttl = 60,
  tenant = 'a',
  service = context,
) {
  const ingress = createE2Ingress(service, f.machine),
    token = await f.token('machine', tenant);
  const binding = {
    protocol: LOCAL_MODEL_PROTOCOL,
    invocationId: randomUUID(),
    source: ref,
  };
  const wire = Buffer.from(
    JSON.stringify({
      ...binding,
      completion: 'COMPLETE',
      proposal: { kind: 'UNVERIFIED_TEXT', text },
    }),
  );
  const handle = await ingress.recordObservation(token, binding, {
    kind: 'RESPONSE',
    terminal: 'END',
    wire,
  });
  const input = {
    source: ref,
    extractionProtocol: E2_EXTRACTION_PROTOCOL,
    ttlSeconds: ttl,
    observationBinding: handle,
  };
  return { ingress, token, input, wire };
}
async function admit(
  f: Awaited<ReturnType<typeof fixture>>,
  ref: ContextReference,
  text?: string,
  ttl?: number,
  tenant = 'a',
) {
  const p = await prepared(f, ref, text, ttl, tenant);
  const r = await p.ingress.admit(p.token, p.input);
  own(f, r.result.id, tenant);
  return r;
}
async function review(
  f: Awaited<ReturnType<typeof fixture>>,
  ref: ContextReference,
  tenant = 'a',
) {
  return createE2ReviewIngress(context, f.human).inspect(
    await f.token('user', tenant),
    ref,
  );
}
async function receiptRows() {
  return (
    await admin.query(
      'SELECT * FROM ct.e2_derivation_receipts ORDER BY tenant,receipt_id',
    )
  ).rows;
}
async function admittedEvents() {
  return (
    await admin.query(
      "SELECT * FROM ct.evidence_events WHERE kind='E2_ADMITTED' ORDER BY tenant,seq",
    )
  ).rows;
}
const deny = /^E2 unavailable$/;
async function unavailable(p: Promise<unknown>) {
  await assert.rejects(p, (e: Error) => deny.test(e.message));
}
after(async () => {
  const errors: unknown[] = [];
  for (const item of owned) {
    try {
      const row = (
        await admin.query(
          'SELECT principal,deleted FROM ct.context_heads WHERE tenant=$1 AND id=$2',
          [item.tenant, item.id],
        )
      ).rows[0];
      if (!row) continue;
      assert.equal(row.principal, item.f.principal, 'exact-owned cleanup only');
      if (!row.deleted)
        await context.erase(await item.f.actor('user', item.tenant), item.id);
    } catch (e) {
      errors.push(e);
    }
  }
  await Promise.all([
    ...fixtures.map((f) => f.close()),
    db.end(),
    admin.end(),
    gov.end(),
  ]);
  if (errors.length) throw new AggregateError(errors, 'E2 cleanup failure');
});

test('E2 atomic private quarantine, immutable replay, inert exact review; no release or ordinary ingest refresh', async () => {
  const f = await setup('atomic'),
    s = await source(f, 'atomic'),
    p = await prepared(f, s);
  const beforeEvents = (await admittedEvents()).length;
  const r = await p.ingress.admit(p.token, p.input);
  own(f, r.result.id);
  assert.equal(r.authority, false);
  assert.equal(r.execution, 'NONE');
  assert.equal(r.status, 'PRIVATE_QUARANTINED_UNVERIFIED');
  p.wire.fill(0); // post-validation mutable wire cannot change the copied proposal
  const row = (
    await admin.query(
      'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2',
      ['a', r.result.id],
    )
  ).rows[0];
  assert.equal(row.quarantined, true);
  assert.equal(row.visibility, 'PRIVATE');
  assert.equal(row.principal, f.principal);
  assert.equal((await admittedEvents()).length, beforeEvents + 1);
  const replay = await p.ingress.admit(await f.token('machine'), p.input);
  assert.deepEqual(replay, r);
  const secondInvocation = await prepared(f, s);
  assert.deepEqual(
    await secondInvocation.ingress.admit(
      secondInvocation.token,
      secondInvocation.input,
    ),
    r,
  );
  assert.equal((await admittedEvents()).length, beforeEvents + 1);
  assert.equal(Object.hasOwn(replay, 'payload'), false);
  const reviewed = await review(f, r.result);
  assert.deepEqual(reviewed.payload, {
    kind: 'UNVERIFIED_TEXT',
    text: 'An inert uncertain proposal',
  });
  await unavailable(context.resolve(await f.actor('machine'), r.result));
  await unavailable(
    context.inspectQuarantine(await f.actor('user'), r.result.id),
  );
  for (const share of [false, true])
    await unavailable(
      context.approve(
        await f.actor('user'),
        r.result.id,
        1,
        r.result.digest,
        share,
      ),
    );
  await unavailable(
    context.ingest(await f.actor('machine'), {
      id: r.result.id,
      expectedVersion: 1,
      payload: 'refresh',
      source: { kind: 'agent', reference: 'ordinary' },
      ttlSeconds: 30,
    }),
  );
  await unavailable(
    review(f, {
      ...r.result,
      digest: '0'.repeat(64),
    }),
  );
  for (const [text, ttl] of [
    ['Changed proposal', 60],
    ['An inert uncertain proposal', 61],
  ] as const) {
    const other = await prepared(f, s, text, ttl);
    await unavailable(other.ingress.admit(other.token, other.input));
  }
  assert.deepEqual(await p.ingress.admit(p.token, p.input), r);
  const event = (await admittedEvents()).at(-1)!;
  assert.deepEqual(Object.keys(JSON.parse(event.payload)).sort(), [
    'authority',
    'execution',
    'receiptId',
  ]);
  assert.ok(
    !canonical(await receiptRows()).includes('An inert uncertain proposal'),
  );
});

test('E2 verifier ingress rejects forged credential, JSON handles, source substitution and noncomplete E1 without writes', async () => {
  const f = await setup('ingress'),
    s = await source(f, 'ingress'),
    p = await prepared(f, s);
  const rows = await receiptRows(),
    events = await admittedEvents();
  await unavailable(p.ingress.admit('not-a-jwt', p.input));
  await unavailable(
    p.ingress.admit(p.token, {
      ...p.input,
      observationBinding: JSON.parse('{}'),
    }),
  );
  await unavailable(
    p.ingress.admit(p.token, { ...p.input, source: { ...s, version: 2 } }),
  );
  await unavailable(p.ingress.admit(p.token, { ...p.input, ttlSeconds: 0 }));
  await unavailable(
    p.ingress.admit(p.token, { ...p.input, ttlSeconds: 604801 }),
  );
  for (const terminal of ['PARTIAL', 'LIMIT'] as const)
    await unavailable(
      p.ingress.recordObservation(
        p.token,
        {
          protocol: LOCAL_MODEL_PROTOCOL,
          invocationId: randomUUID(),
          source: s,
        },
        { kind: 'RESPONSE', terminal, wire: p.wire },
      ),
    );
  await unavailable(
    p.ingress.recordObservation(
      p.token,
      { protocol: LOCAL_MODEL_PROTOCOL, invocationId: randomUUID(), source: s },
      { kind: 'OUTAGE' },
    ),
  );
  await unavailable(
    p.ingress.recordObservation(
      p.token,
      { protocol: LOCAL_MODEL_PROTOCOL, invocationId: randomUUID(), source: s },
      { kind: 'RESPONSE', terminal: 'END', wire: Buffer.from('{}') },
    ),
  );
  // Even a genuine server handle cannot authenticate a lookalike actor.
  const forged = {
    ...(await f.actor('machine')),
    expires: Date.now() + 86400000,
  };
  await unavailable(context.admitDerivedProposal(forged, p.input));
  await unavailable(
    context.admitDerivedProposal(await f.actor('machine'), p.input),
  );
  await unavailable(
    context.inspectDerivedProposal({ ...(await f.actor('user')) }, s),
  );
  assert.deepEqual(await receiptRows(), rows);
  assert.deepEqual(await admittedEvents(), events);
});

test('E2 independent unknown/restored journal and default construction deny even while ordinary recovery control active', async () => {
  const f = await setup('restore'),
    s = await source(f, 'restore'),
    p = await prepared(f, s),
    r = await p.ingress.admit(p.token, p.input);
  own(f, r.result.id);
  try {
    journalKnown = false;
    await unavailable(p.ingress.admit(p.token, p.input));
    await unavailable(review(f, r.result));
    journalKnown = true;
    journalRestored = true;
    assert.equal(
      (await admin.query('SELECT blocked FROM ct.control WHERE singleton'))
        .rows[0].blocked,
      false,
    );
    await unavailable(p.ingress.admit(p.token, p.input));
    await unavailable(review(f, r.result));
    journalRestored = false;
    journalFence = 'not-current';
    await unavailable(p.ingress.admit(p.token, p.input));
    const closed = await prepared(
      f,
      s,
      undefined,
      60,
      'a',
      new ContextService(db),
    );
    await unavailable(closed.ingress.admit(closed.token, closed.input));
  } finally {
    journalKnown = true;
    journalRestored = false;
    journalFence = fence;
  }
  assert.deepEqual(E2_RETENTION_DEFAULTS, {
    auditDays: 90,
    retryDays: 30,
    purgeEnabled: false,
  });
});

test('E2 source-aware tenant and VERA isolation, including shared source owned by another VERA', async () => {
  const a = await setup('scope-a'),
    b = await setup('scope-b'),
    s = await source(a, 'scope');
  const foreign = await prepared(b, s);
  await unavailable(foreign.ingress.admit(foreign.token, foreign.input));
  const crossTenant = await prepared(a, s, undefined, 60, 'b');
  await unavailable(
    crossTenant.ingress.admit(crossTenant.token, crossTenant.input),
  );
  await context.approve(await a.actor('user'), s.id, s.version, s.digest, true);
  const r = await admit(b, s);
  await unavailable(context.resolve(await b.actor('machine'), r.result));
  const nested = await prepared(b, r.result);
  await unavailable(nested.ingress.admit(nested.token, nested.input));
  await context.approve(
    await a.actor('user'),
    s.id,
    s.version,
    s.digest,
    false,
  );
  const replay = await prepared(b, s);
  await unavailable(replay.ingress.admit(replay.token, replay.input));
  // Tenant owner has explicit existing tenant-wide private-context review rights.
  assert.equal((await review(a, r.result)).authority, false);
  await unavailable(review(a, r.result, 'b'));
});

test('E2 source replacement/deletion and result erasure are terminal, never allocate a replacement receipt', async () => {
  const f = await setup('terminal');
  for (const mode of ['source-replace', 'source-delete', 'result-erase']) {
    const s = await source(f, mode),
      p = await prepared(f, s),
      r = await p.ingress.admit(p.token, p.input);
    own(f, r.result.id);
    const rows = (await receiptRows()).length,
      events = (await admittedEvents()).length;
    if (mode === 'source-replace')
      await context.ingest(await f.actor('machine'), {
        id: s.id,
        expectedVersion: 1,
        payload: 'new unrelated source version',
        source: { kind: 'document', reference: 'fixture' },
        ttlSeconds: 3600,
      });
    else
      await context.erase(
        await f.actor('user'),
        mode === 'source-delete' ? s.id : r.result.id,
      );
    await unavailable(p.ingress.admit(p.token, p.input));
    await unavailable(review(f, r.result));
    assert.equal((await receiptRows()).length, rows);
    assert.equal((await admittedEvents()).length, events);
    const stored = (
      await admin.query(
        'SELECT * FROM ct.e2_derivation_receipts WHERE tenant=$1 AND receipt_id=$2',
        ['a', r.receiptId],
      )
    ).rows[0];
    assert.ok(stored.withdrawn_at);
    assert.equal(
      stored.withdrawal_code,
      mode === 'source-replace'
        ? 'SOURCE_REPLACED'
        : mode === 'source-delete'
          ? 'SOURCE_DELETED'
          : 'RESULT_ERASED',
    );
    if (mode === 'source-replace')
      assert.equal(
        (
          await admin.query(
            'SELECT payload FROM ct.context_versions WHERE tenant=$1 AND id=$2 AND version=2',
            ['a', s.id],
          )
        ).rows[0].payload,
        '"new unrelated source version"',
      );
  }
});

test('E2 TTL source bound and elapsed result expiry deny replay, do not extend expiry', async () => {
  const f = await setup('expiry'),
    s = await source(f, 'expiry', 3);
  const over = await prepared(f, s, undefined, 3);
  await unavailable(over.ingress.admit(over.token, over.input));
  const p = await prepared(f, s, undefined, 1),
    r = await p.ingress.admit(p.token, p.input);
  own(f, r.result.id);
  while (
    (
      await admin.query('SELECT clock_timestamp()>=$1::timestamptz AS ready', [
        r.resultExpires,
      ])
    ).rows[0].ready !== true
  )
    await delay(30);
  const rows = await receiptRows();
  await unavailable(p.ingress.admit(p.token, p.input));
  await unavailable(review(f, r.result));
  assert.deepEqual(await receiptRows(), rows);
});

test('E2 DB grants, forced RLS, immutable fields/terminal state and marker constraints', async () => {
  const f = await setup('schema'),
    s = await source(f, 'schema'),
    r = await admit(f, s);
  const table = (
    await admin.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ct.e2_derivation_receipts'::regclass",
    )
  ).rows[0];
  assert.deepEqual(table, { relrowsecurity: true, relforcerowsecurity: true });
  for (const role of [
    'ct_tenant_a',
    'ct_tenant_b',
    'ct_product_api',
    'ct_controller',
    'ct_recovery',
  ]) {
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'ct.e2_derivation_receipts','SELECT') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  }
  await assert.rejects(
    db.query(
      'DELETE FROM ct.e2_derivation_receipts WHERE tenant=$1 AND receipt_id=$2',
      ['a', r.receiptId],
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      'UPDATE ct.e2_derivation_receipts SET binding_digest=$3 WHERE tenant=$1 AND receipt_id=$2',
      ['a', r.receiptId, '0'.repeat(64)],
    ),
    /permission denied/,
  );
  await assert.rejects(
    admin.query(
      "UPDATE ct.e2_derivation_receipts SET result_expires=result_expires+interval '1 second' WHERE receipt_id=$1",
      [r.receiptId],
    ),
    /immutable E2 receipt/,
  );
  await assert.rejects(
    db.query(
      "UPDATE ct.context_heads SET visibility='TENANT' WHERE tenant=$1 AND id=$2",
      ['a', r.result.id],
    ),
    /cannot refresh\/release\/share/,
  );
  await context.erase(await f.actor('user'), r.result.id);
  await assert.rejects(
    db.query(
      'UPDATE ct.e2_derivation_receipts SET withdrawn_at=NULL,withdrawal_code=NULL WHERE tenant=$1 AND receipt_id=$2',
      ['a', r.receiptId],
    ),
    /immutable E2 receipt/,
  );
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const id = 'e2-forged-marker-' + randomUUID();
    await c.query(
      'INSERT INTO ct.context_heads(tenant,id,principal) VALUES($1,$2,$3)',
      ['a', id, f.principal],
    );
    await c.query(
      `INSERT INTO ct.context_versions(tenant,id,version,principal,payload,digest,source,observed_at,expires)
      VALUES('a',$1,1,$2,'"inert"',$3,$4,clock_timestamp(),clock_timestamp()+interval '1 minute')`,
      [
        id,
        f.principal,
        '0'.repeat(64),
        {
          e2: {
            recordClass: 'E2_DERIVED_UNVERIFIED_V1',
            receiptId: randomUUID(),
          },
        },
      ],
    );
    await c.query(
      "UPDATE ct.context_heads SET version=1 WHERE tenant='a' AND id=$1",
      [id],
    );
    await assert.rejects(c.query('COMMIT'), /E2 marker requires exact receipt/);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('E2 corrupt source commits protective quarantine only; wrong reference never quarantines healthy source', async () => {
  const f = await setup('corrupt'),
    s = await source(f, 'corrupt'),
    p = await prepared(f, s);
  const rows = await receiptRows(),
    events = await admittedEvents();
  const wrong = await prepared(f, { ...s, digest: '0'.repeat(64) });
  await unavailable(wrong.ingress.admit(wrong.token, wrong.input));
  assert.equal(
    (
      await admin.query(
        'SELECT quarantined FROM ct.context_heads WHERE tenant=$1 AND id=$2',
        ['a', s.id],
      )
    ).rows[0].quarantined,
    false,
  );
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      'ALTER TABLE ct.context_versions DISABLE TRIGGER context_version_contract',
    );
    await c.query(
      'UPDATE ct.context_versions SET payload=$3 WHERE tenant=$1 AND id=$2',
      ['a', s.id, '"damaged"'],
    );
    await c.query(
      'ALTER TABLE ct.context_versions ENABLE TRIGGER context_version_contract',
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await unavailable(p.ingress.admit(p.token, p.input));
  assert.equal(
    (
      await admin.query(
        'SELECT quarantined FROM ct.context_heads WHERE tenant=$1 AND id=$2',
        ['a', s.id],
      )
    ).rows[0].quarantined,
    true,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*) n FROM ct.evidence_events WHERE kind='CONTEXT_CORRUPTION_QUARANTINED' AND payload::jsonb->>'id'=$1",
        [s.id],
      )
    ).rows[0].n,
    '1',
  );
  assert.deepEqual(await receiptRows(), rows);
  assert.deepEqual(await admittedEvents(), events);
});

test('E2 admission failure rolls back result, receipt and event together', async () => {
  const f = await setup('rollback'),
    s = await source(f, 'rollback'),
    p = await prepared(f, s);
  const before = await receiptRows(),
    events = await admittedEvents();
  const heads = (
    await admin.query('SELECT id FROM ct.context_heads ORDER BY tenant,id')
  ).rows;
  await admin.query(`CREATE FUNCTION ct.e2_test_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.kind='E2_ADMITTED' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER e2_test_fail_event BEFORE INSERT ON ct.evidence_events FOR EACH ROW EXECUTE FUNCTION ct.e2_test_fail_event()`);
  try {
    await unavailable(p.ingress.admit(p.token, p.input));
  } finally {
    await admin.query(
      'DROP TRIGGER e2_test_fail_event ON ct.evidence_events;DROP FUNCTION ct.e2_test_fail_event()',
    );
  }
  assert.deepEqual(await receiptRows(), before);
  assert.deepEqual(await admittedEvents(), events);
  assert.deepEqual(
    (await admin.query('SELECT id FROM ct.context_heads ORDER BY tenant,id'))
      .rows,
    heads,
  );
});

test('E2 concurrent identical admission serializes to one receipt and one event', async () => {
  const f = await setup('concurrent'),
    s = await source(f, 'concurrent'),
    p = await prepared(f, s);
  const before = (await admittedEvents()).length;
  const results = await Promise.all(
    Array.from({ length: 6 }, () => p.ingress.admit(p.token, p.input)),
  );
  own(f, results[0].result.id);
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal((await admittedEvents()).length, before + 1);
});

async function waitForLock() {
  for (let n = 0; n < 200; n++) {
    if (
      (
        await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename='ct_context_service' AND wait_event_type='Lock'",
        )
      ).rowCount
    )
      return;
    await delay(20);
  }
  throw Error('expected real PostgreSQL lock wait not observed');
}
test('E2 fresh token check AFTER a real principal lock wait denies expired credential', async () => {
  const f = await setup('wait-expiry'),
    s = await source(f, 'wait-expiry'),
    p = await prepared(f, s);
  const token = await f.token('machine', 'a', {
      exp: Math.floor(Date.now() / 1000) + 2,
    }),
    actor = await f.machine.verify(token);
  const c = await admin.connect();
  await c.query('BEGIN');
  await c.query(
    'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
    ['a', f.principal],
  );
  const pending = p.ingress.admit(token, p.input);
  const observed = unavailable(pending);
  try {
    await waitForLock();
    while (Date.now() < actor.expires + 20) await delay(25);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  await observed;
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) n FROM ct.e2_derivation_receipts WHERE tenant=$1 AND principal=$2',
        ['a', f.principal],
      )
    ).rows[0].n,
    '0',
  );
});

test('E2 identity revoke committed ahead of blocked enrollment denies without writes', async () => {
  const f = await setup('wait-revoke'),
    s = await source(f, 'wait-revoke'),
    p = await prepared(f, s);
  const c = await admin.connect();
  await c.query('BEGIN');
  await c.query(
    'UPDATE ct.identities SET active=false,version=version+1 WHERE id=$1',
    [(await f.actor('machine')).subject],
  );
  const pending = unavailable(p.ingress.admit(p.token, p.input));
  try {
    await waitForLock();
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  await pending;
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) n FROM ct.e2_derivation_receipts WHERE tenant=$1 AND principal=$2',
        ['a', f.principal],
      )
    ).rows[0].n,
    '0',
  );
});

test('E2 exact review commits quarantine for corrupt source/result envelopes and source expiry before lineage rejection', async () => {
  const f = await setup('envelope-corruption');
  for (const mode of [
    'source-null',
    'source-e2',
    'result-marker',
    'source-expiry',
  ]) {
    const s = await source(f, mode, 3600, 'a', mode === 'source-e2'),
      r = await admit(f, s);
    const target = mode === 'result-marker' ? r.result : s;
    const rows = await receiptRows(),
      events = await admittedEvents();
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'ALTER TABLE ct.context_versions DISABLE TRIGGER context_version_contract',
      );
      if (mode === 'source-expiry')
        await c.query(
          "UPDATE ct.context_versions SET expires=clock_timestamp()+interval '30 seconds' WHERE tenant='a' AND id=$1",
          [s.id],
        );
      else
        await c.query(
          "UPDATE ct.context_versions SET source=$2::jsonb WHERE tenant='a' AND id=$1",
          [
            target.id,
            mode === 'source-null'
              ? 'null'
              : JSON.stringify({
                  e2:
                    mode === 'source-e2'
                      ? null
                      : { recordClass: 'CORRUPTED', receiptId: r.receiptId },
                }),
          ],
        );
      await c.query(
        'ALTER TABLE ct.context_versions ENABLE TRIGGER context_version_contract',
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    await unavailable(review(f, r.result));
    assert.equal(
      (
        await admin.query(
          "SELECT quarantined FROM ct.context_heads WHERE tenant='a' AND id=$1",
          [target.id],
        )
      ).rows[0].quarantined,
      true,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*) n FROM ct.evidence_events WHERE kind='CONTEXT_CORRUPTION_QUARANTINED' AND payload::jsonb->>'id'=$1",
          [target.id],
        )
      ).rows[0].n,
      '1',
    );
    assert.deepEqual(await receiptRows(), rows);
    assert.deepEqual(await admittedEvents(), events);
  }
});

test('E2 exact owner review repeats genuine MFA freshness after a real principal lock wait', async () => {
  const f = await setup('wait-mfa'),
    s = await source(f, 'wait-mfa'),
    r = await admit(f, s);
  const authTime = Math.floor(Date.now() / 1000) - 299;
  const token = await f.token('user', 'a', { auth_time: authTime });
  const c = await admin.connect();
  await c.query('BEGIN');
  await c.query(
    "SELECT * FROM ct.principals WHERE tenant='a' AND id=$1 FOR UPDATE",
    [f.principal],
  );
  const pending = unavailable(
    createE2ReviewIngress(context, f.human).inspect(token, r.result),
  );
  try {
    await waitForLock();
    while (Date.now() < authTime * 1000 + 300020) await delay(25);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  await pending;
});

test('E2 concurrent ordinary source replacement withdraws only old binding before replay can pass', async () => {
  const f = await setup('wait-replace'),
    s = await source(f, 'wait-replace'),
    r = await admit(f, s),
    p = await prepared(f, s);
  const actor = await f.actor('machine'),
    rows = (await receiptRows()).length,
    events = (await admittedEvents()).length;
  const c = await admin.connect();
  await c.query('BEGIN');
  await c.query(
    "SELECT * FROM ct.principals WHERE tenant='a' AND id=$1 FOR UPDATE",
    [f.principal],
  );
  const replacement = context.ingest(actor, {
    id: s.id,
    expectedVersion: 1,
    payload: 'live refreshed source',
    source: { kind: 'document', reference: 'fixture' },
    ttlSeconds: 3600,
  });
  // Observe the updater waiting first, then queue E2 behind the same principal.
  await waitForLock();
  const replay = unavailable(p.ingress.admit(p.token, p.input));
  try {
    let seen = false;
    for (let n = 0; n < 200; n++) {
      if (
        Number(
          (
            await admin.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE usename='ct_context_service' AND wait_event_type='Lock'",
            )
          ).rows[0].n,
        ) >= 2
      ) {
        seen = true;
        break;
      }
      await delay(20);
    }
    assert.ok(seen, 'both real PostgreSQL waiters must be visible');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  const next = await replacement;
  await replay;
  assert.equal(next.version, 2);
  assert.equal((await receiptRows()).length, rows);
  assert.equal((await admittedEvents()).length, events);
  assert.equal(
    (
      await admin.query(
        "SELECT withdrawal_code FROM ct.e2_derivation_receipts WHERE tenant='a' AND receipt_id=$1",
        [r.receiptId],
      )
    ).rows[0].withdrawal_code,
    'SOURCE_REPLACED',
  );
  assert.equal(
    (
      await admin.query(
        "SELECT payload FROM ct.context_versions WHERE tenant='a' AND id=$1 AND version=2",
        [s.id],
      )
    ).rows[0].payload,
    '"live refreshed source"',
  );
  await unavailable(review(f, r.result));
});
