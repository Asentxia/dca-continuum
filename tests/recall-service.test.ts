import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import type pg from 'pg';
import { pool, canonical, sha } from '../src/db.js';
import {
  ContextService,
  type ContextInput,
  type ContextReference,
  type ContextResolution,
} from '../src/context-service.js';
import { IdentityVerifier } from '../src/identity-provider.js';
import { RecallService, type RecallOutcome } from '../src/recall-service.js';
import {
  RESTRICTED_MEMORY_CAPS,
  type DerivedReferenceIndexPort,
  type RecallQuery,
  type RecallScope,
  type ReferenceIndexReply,
} from '../src/restricted-memory-protocol.js';
import { LocalReferenceIndexDouble } from '../internal/fixtures/local-reference-index.js';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';

// DB acceptance AUTHORING ONLY. Do not run/import this file until the parent
// authorizes the disposable fixture. These tests are not harness-registered here.
// Generated signing keys and credentials remain transient, never logged/exported
// or compared in assertions that could print them. No live authentication claim.
type LocalFixture = Awaited<ReturnType<typeof fixture>>;
const db = pool('ct_context_service');
const context = new ContextService(db);
const fixtures: LocalFixture[] = [];
const owned = new Map<
  string,
  { fixture: LocalFixture; tenant: string; id: string }
>();
const query: RecallQuery = { text: 'same external alias', limit: 16 };

type WorkResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: unknown }>;
type Failures = {
  primary?: Readonly<{ error: unknown }>;
  secondary: unknown[];
};
const outstandingWork = new Set<Promise<unknown>>();
const unexpectedFixtureFailures: Error[] = [];

// Capture rejection immediately, including when a barrier/body fails first.
// A captured expected canonical rejection is data for the independent oracle;
// it is not converted into a passing result or printed with fixture credentials.
function startWork<T>(run: () => Promise<T>): Promise<WorkResult<T>> {
  const work = Promise.resolve()
    .then(run)
    .then(
      (value): WorkResult<T> => ({ ok: true, value }),
      (error: unknown): WorkResult<T> => ({ ok: false, error }),
    );
  outstandingWork.add(work);
  void work.then(() => {
    outstandingWork.delete(work);
  });
  return work;
}
function failures(): Failures {
  return { secondary: [] };
}
function addFailure(state: Failures, error: unknown) {
  if (state.primary) {
    if (state.primary.error !== error && !state.secondary.includes(error))
      state.secondary.push(error);
  } else state.primary = { error };
}
async function cleanup(
  state: Failures,
  label: string,
  run: () => void | Promise<unknown>,
) {
  try {
    await run();
    return true;
  } catch {
    // Cleanup errors must neither replace the body assertion nor reflect raw
    // credential/connection/error objects. Preserve their distinct failing phase.
    state.secondary.push(Error('R1 ' + label + ' cleanup failed'));
    return false;
  }
}
function finishFailures(state: Failures) {
  if (state.primary) {
    if (state.secondary.length)
      throw new AggregateError(
        [state.primary.error, ...state.secondary],
        'R1 primary failure retained; additional work/cleanup also failed',
        { cause: state.primary.error },
      );
    throw state.primary.error;
  }
  if (state.secondary.length)
    throw new AggregateError(state.secondary, 'R1 cleanup failed');
}
async function fixtureObserver(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    // Recall intentionally catches resolver failures. A fixture callback failure
    // must still fail the test hook, not masquerade as canonical eligibility.
    unexpectedFixtureFailures.push(Error('R1 fixture observer action failed'));
    throw error;
  }
}
async function fixtureTransaction<T>(
  ownerPool: pg.Pool,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  const state = failures();
  let committed = false;
  let value: T | undefined;
  try {
    await client.query('BEGIN');
    value = await body(client);
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    addFailure(state, error);
  } finally {
    const rolledBack =
      committed ||
      (await cleanup(state, 'fixture rollback', () =>
        client.query('ROLLBACK'),
      ));
    await cleanup(state, 'fixture client release', () =>
      client.release(!rolledBack),
    );
  }
  finishFailures(state);
  return value as T;
}

before(async () => {
  const existing = (
    await admin.query(
      "SELECT (SELECT count(*) FROM ct.identities WHERE left(id,3)='r1-') AS identities,(SELECT count(*) FROM ct.context_heads WHERE left(id,3)='r1-') AS contexts",
    )
  ).rows[0];
  assert.deepEqual(
    existing,
    { identities: '0', contexts: '0' },
    'R1 requires unused controlled fixture identifiers; never purge a tenant',
  );
});

after(async () => {
  const errors: Error[] = [...unexpectedFixtureFailures];
  if (outstandingWork.size) {
    errors.push(Error('R1 work escaped its owning helper'));
    await Promise.all([...outstandingWork]);
  }
  for (const record of owned.values()) {
    try {
      const head = (
        await admin.query(
          'SELECT principal,deleted FROM ct.context_heads WHERE tenant=$1 AND id=$2',
          [record.tenant, record.id],
        )
      ).rows[0];
      if (!head) continue;
      assert.equal(
        head.principal,
        record.fixture.principal,
        'Refusing cleanup outside the exact owned principal',
      );
      if (!head.deleted)
        await context.erase(
          await record.fixture.actor('user', record.tenant),
          record.id,
        );
      assert.equal(
        (
          await admin.query(
            'SELECT count(*) AS n FROM ct.context_versions WHERE tenant=$1 AND id=$2 AND payload IS NOT NULL',
            [record.tenant, record.id],
          )
        ).rows[0].n,
        '0',
      );
    } catch {
      errors.push(Error('R1 exact-owned context cleanup failed'));
    }
  }
  // Canonical nonpayload tombstones/evidence and existing fixture metadata stay
  // in the disposable DB. No shared helper/global sweep or tenant purge is added.
  const closed = await Promise.all(
    [
      ...fixtures.map((f) => () => f.close()),
      () => db.end(),
      () => admin.end(),
      () => gov.end(),
    ].map((close) => startWork<unknown>(async () => close())),
  );
  for (const result of closed)
    if (!result.ok) errors.push(Error('R1 fixture connection cleanup failed'));
  if (errors.length)
    throw new AggregateError(
      errors,
      'R1 cleanup failed without secret details',
    );
});

async function setup(name: string) {
  const f = await fixture('r1-' + name);
  fixtures.push(f);
  return f;
}
function own(f: LocalFixture, id: string, tenant = 'a') {
  assert.ok(fixtures.includes(f) && id.startsWith('r1-'));
  const key = JSON.stringify([tenant, id]);
  const previous = owned.get(key);
  if (previous) assert.equal(previous.fixture.principal, f.principal);
  else owned.set(key, { fixture: f, tenant, id });
}
function input(id: string, changes: Partial<ContextInput> = {}): ContextInput {
  return {
    id,
    expectedVersion: 0,
    payload: { note: id },
    source: { kind: 'document', reference: 'local-fixture:' + id },
    ttlSeconds: 3600,
    ...changes,
  };
}
function reference(value: {
  id: string;
  version: number;
  digest: string;
}): ContextReference {
  return { id: value.id, version: value.version, digest: value.digest };
}
async function reviewed(
  f: LocalFixture,
  id: string,
  changes: Partial<ContextInput> = {},
  tenant = 'a',
  shareTenant = false,
) {
  own(f, id, tenant);
  const result = await context.ingest(
    await f.actor('machine', tenant),
    input(id, changes),
  );
  await context.approve(
    await f.actor('user', tenant),
    result.id,
    result.version,
    result.digest,
    shareTenant,
  );
  return reference(result);
}
async function snapshot(id: string, tenant = 'a') {
  return (
    await admin.query(
      'SELECT h.version,h.principal,h.visibility,h.quarantined,h.deleted,h.revision,v.digest,v.source::text AS source_bytes,v.payload,v.erased_at FROM ct.context_heads h JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version WHERE h.tenant=$1 AND h.id=$2',
      [tenant, id],
    )
  ).rows[0];
}
async function corruptionEvents(id: string) {
  return (
    await admin.query(
      "SELECT count(*) AS n FROM ct.evidence_events WHERE tenant='a' AND kind='CONTEXT_CORRUPTION_QUARANTINED' AND payload::jsonb->>'id'=$1",
      [id],
    )
  ).rows[0].n as string;
}
async function effects() {
  return (
    await admin.query(
      "SELECT (SELECT count(*) FROM ct.grants WHERE tenant IN('a','b')) AS grants,(SELECT count(*) FROM ct.approvals WHERE tenant IN('a','b')) AS approvals,(SELECT count(*) FROM ct.assignments WHERE tenant IN('a','b')) AS assignments,(SELECT count(*) FROM ct.operations WHERE tenant IN('a','b')) AS operations,(SELECT count(*) FROM ct.outbox WHERE tenant IN('a','b')) AS outbox",
    )
  ).rows[0];
}
async function recallWithoutEffects(
  reader: RecallService,
  credential: string,
  requested: RecallQuery,
) {
  const before = await effects();
  const result = await reader.recall(credential, requested);
  // Applied to every exercised R1 outcome, including fixture barriers and the
  // declared ContextService integrity mutation. Context evidence is not an
  // authority/operation/outbox write and does not dispatch a provider effect.
  assert.deepEqual(await effects(), before);
  for (const f of fixtures) assert.equal(f.provider.sends, 0);
  return result;
}
function degraded(result: RecallOutcome) {
  assert.deepEqual(result, {
    status: 'DEGRADED',
    hits: [],
    authority: false,
    execution: 'NONE',
  });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.hits));
}
function empty(result: RecallOutcome) {
  assert.deepEqual(result, {
    status: 'EMPTY',
    hits: [],
    authority: false,
    execution: 'NONE',
  });
}
function hits(result: RecallOutcome, ids: readonly string[]) {
  assert.equal(result.status, 'HITS');
  assert.equal(result.authority, false);
  assert.equal(result.execution, 'NONE');
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    ids,
  );
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.hits));
  for (const hit of result.hits) assert.equal(hit.authority, false);
}
function scripted(reply: unknown) {
  const calls: { scope: RecallScope; query: RecallQuery }[] = [];
  const index: DerivedReferenceIndexPort = {
    async lookup(scope, requested) {
      calls.push({ scope, query: requested });
      return reply as ReferenceIndexReply;
    },
  };
  return { index, calls };
}
function observingContext(
  real = context,
  afterResolve?: (value: ContextResolution) => Promise<void>,
) {
  const attempts: ContextReference[] = [];
  const service = Object.create(real) as ContextService;
  service.resolve = async (actor, ref) => {
    attempts.push(ref);
    const value = await real.resolve(actor, ref);
    if (afterResolve) await fixtureObserver(() => afterResolve(value));
    return value;
  };
  return { service, attempts };
}
function gate() {
  let enter!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return { reached, released, enter, resume };
}
async function reached<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('R1 test barrier timeout')),
          10000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function waitingIndex(reply: unknown) {
  const barrier = gate();
  const index: DerivedReferenceIndexPort = {
    async lookup() {
      barrier.enter();
      await barrier.released;
      return reply as ReferenceIndexReply;
    },
  };
  return { index, ...barrier };
}
async function duringIndex(
  f: LocalFixture,
  reply: unknown,
  action: () => Promise<void>,
  credential?: string,
  real = context,
  enrollmentDb = db,
) {
  const waiting = waitingIndex(reply);
  const authenticated = credential ?? (await f.token('machine'));
  const result = startWork(() =>
    recallWithoutEffects(
      new RecallService(enrollmentDb, real, f.machine, waiting.index),
      authenticated,
      query,
    ),
  );
  const state = failures();
  let actionWork: Promise<WorkResult<void>> | undefined;
  try {
    await reached(waiting.reached);
    actionWork = startWork(action);
    const actionResult = await reached(actionWork);
    if (!actionResult.ok) addFailure(state, actionResult.error);
  } catch (error) {
    addFailure(state, error);
  } finally {
    await cleanup(state, 'index gate release', () => waiting.resume());
  }
  // Release the index BEFORE draining a possibly lock-blocked action. A test
  // timeout must not leave a queued revoke running into enrollment restoration.
  if (actionWork) {
    const actionResult = await actionWork;
    if (!actionResult.ok) addFailure(state, actionResult.error);
  }
  const settled = await result;
  if (!settled.ok) addFailure(state, settled.error);
  finishFailures(state);
  if (!settled.ok) throw Error('R1 index work did not complete');
  return settled.value;
}

// Test-only query instrumentation delegates to the REAL pool/client. No
// production hook, replacement eligibility SQL, config access or new privilege.
function observedPool(
  afterQuery: (
    sql: string,
    result: pg.QueryResult,
    client: pg.PoolClient,
  ) => void | pg.QueryResult | Promise<void | pg.QueryResult>,
  beforeQuery?: (
    sql: string,
    values: readonly unknown[] | undefined,
    client: pg.PoolClient,
  ) => void | Promise<void>,
): pg.Pool {
  const wrapped = Object.create(db) as pg.Pool;
  wrapped.connect = (async () => {
    const client = await db.connect();
    const proxy = Object.create(client) as pg.PoolClient;
    proxy.query = (async (sql: string, values?: unknown[]) => {
      await beforeQuery?.(sql, values, client);
      const result = await client.query(sql, values);
      return (await afterQuery(sql, result, client)) ?? result;
    }) as pg.PoolClient['query'];
    proxy.release = client.release.bind(client);
    return proxy;
  }) as pg.Pool['connect'];
  return wrapped;
}

function enrollmentBindings(row: Record<string, unknown>) {
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    audience: row.audience,
    kind: row.kind,
    tenant: row.tenant,
    principal: row.principal,
    domain_role: row.domain_role,
  };
}
function ownedEnrollmentBindings(f: LocalFixture, tenant = 'a') {
  assert.ok(fixtures.includes(f) && f.prefix.startsWith('r1-'));
  const id = `${f.prefix}-worker-${tenant}`;
  return {
    id,
    issuer: f.issuer,
    subject: id,
    audience: f.audience,
    kind: 'machine',
    tenant,
    principal: f.principal,
    domain_role: 'worker',
  };
}
async function ownedEnrollment(f: LocalFixture, tenant = 'a') {
  const expected = ownedEnrollmentBindings(f, tenant);
  const row = (
    await admin.query('SELECT * FROM ct.identities WHERE id=$1', [expected.id])
  ).rows[0];
  assert.ok(row, 'Exact owned enrollment must exist');
  assert.deepEqual(enrollmentBindings(row), expected);
  assert.equal(typeof row.version, 'string');
  assert.match(row.version, /^(?:0|-?[1-9][0-9]*)$/);
  return row;
}

async function restoreEnrollment(
  f: LocalFixture,
  body: () => Promise<void>,
  tenant = 'a',
) {
  const original = await ownedEnrollment(f, tenant);
  assert.equal(original.issuer, f.issuer);
  assert.equal(original.kind, 'machine');
  const state = failures();
  try {
    await body();
  } catch (error) {
    addFailure(state, error);
  } finally {
    await cleanup(state, 'exact enrollment restore', async () => {
      await fixtureTransaction(gov, async (client) => {
        const current = (
          await client.query(
            'SELECT * FROM ct.identities WHERE id=$1 FOR UPDATE',
            [original.id],
          )
        ).rows[0];
        assert.ok(current, 'Refuse cleanup of a missing owned enrollment');
        assert.deepEqual(
          enrollmentBindings(current),
          enrollmentBindings(original),
          'Never rewrite immutable enrollment bindings during cleanup',
        );
        assert.equal(typeof current.version, 'string');
        assert.ok(BigInt(current.version) >= BigInt(original.version));
        // The unchanged identity trigger requires an advancing fence on active
        // changes. NEVER restore a saved counter or rebind id/tenant/principal.
        const restored = await client.query(
          'UPDATE ct.identities SET active=$2,version=version+1 WHERE id=$1 AND issuer=$3 AND subject=$4 AND audience=$5 AND kind=$6 AND tenant=$7 AND principal=$8 AND domain_role=$9 RETURNING *',
          [
            original.id,
            original.active,
            original.issuer,
            original.subject,
            original.audience,
            original.kind,
            original.tenant,
            original.principal,
            original.domain_role,
          ],
        );
        assert.equal(
          restored.rowCount,
          1,
          'Restore only the exact owned enrollment',
        );
        assert.deepEqual(
          enrollmentBindings(restored.rows[0]),
          enrollmentBindings(original),
        );
        assert.equal(restored.rows[0].active, original.active);
        assert.equal(
          BigInt(restored.rows[0].version),
          BigInt(current.version) + 1n,
        );
      });
    });
  }
  finishFailures(state);
}
async function deactivate(f: LocalFixture) {
  await ownedEnrollment(f);
  assert.equal(
    (
      await gov.query(
        'UPDATE ct.identities SET active=false,version=version+1 WHERE id=$1 AND issuer=$2',
        [`${f.prefix}-worker-a`, f.issuer],
      )
    ).rowCount,
    1,
  );
}
async function databaseExpired(expires: number) {
  const deadline = performance.now() + 12000;
  do {
    if (
      (
        await admin.query(
          'SELECT clock_timestamp()>=to_timestamp($1::double precision/1000) AS ready',
          [expires],
        )
      ).rows[0].ready === true
    )
      return;
    await delay(10);
  } while (performance.now() < deadline);
  throw Error('R1 test DB expiry witness timeout');
}
async function shortCredential(f: LocalFixture, seconds = 4) {
  const credential = await f.token('machine', 'a', {
    exp: Math.floor(Date.now() / 1000) + seconds,
  });
  const actor = await f.machine.verify(credential);
  return { credential, expires: actor.expires };
}

async function duringHeadWait(
  ref: ContextReference,
  start: () => Promise<RecallOutcome>,
  action: (holderPid: number) => Promise<void>,
  releaseForDrain: () => void = () => {},
) {
  assert.ok(owned.has(JSON.stringify(['a', ref.id])));
  const record = owned.get(JSON.stringify(['a', ref.id]))!;
  const held = await admin.connect();
  let pending: Promise<WorkResult<RecallOutcome>> | undefined;
  let actionWork: Promise<WorkResult<void>> | undefined;
  const state = failures();
  try {
    await held.query('BEGIN');
    const holderPid = await backendPid(held);
    const head = await held.query(
      'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', ref.id],
    );
    assert.equal(head.rowCount, 1);
    assert.equal(head.rows[0].principal, record.fixture.principal);
    pending = startWork(start);
    actionWork = startWork(() => action(holderPid));
    const result = await reached(actionWork);
    if (!result.ok) addFailure(state, result.error);
  } catch (error) {
    addFailure(state, error);
  } finally {
    const rolledBack = await cleanup(state, 'head holder rollback', () =>
      held.query('ROLLBACK'),
    );
    // Destroy only this owned client if rollback failed; never terminate a
    // backend/service or return a possibly lock-holding transaction to the pool.
    await cleanup(state, 'head holder release', () =>
      held.release(!rolledBack),
    );
    if (state.primary || state.secondary.length)
      await cleanup(state, 'head dependent gate release', releaseForDrain);
  }
  if (actionWork) {
    const result = await actionWork;
    if (!result.ok) addFailure(state, result.error);
  }
  // Drain started work even if setup/the barrier failed; no latent DB work may
  // continue into exact-owned teardown or mask the primary regression failure.
  const result = pending ? await pending : undefined;
  if (result && !result.ok) addFailure(state, result.error);
  finishFailures(state);
  if (!result?.ok) throw Error('R1 head-wait fixture did not start');
  return result.value;
}

const contextHeadSql =
  'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE';
async function backendPid(client: pg.PoolClient): Promise<number> {
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
    .pid;
  assert.ok(Number.isInteger(pid) && pid > 0, 'Owned backend PID required');
  return pid;
}
function headWaitProbe(ref: ContextReference) {
  const identified = gate();
  let readerPid: number | undefined;
  let submissions = 0;
  const observed = observedPool(
    () => {},
    async (sql, values, client) => {
      if (sql !== contextHeadSql) return;
      assert.deepEqual(values, ['a', ref.id]);
      submissions++;
      assert.equal(submissions, 1, 'Only the single delegated head query');
      readerPid = await backendPid(client);
      // Identification is BEFORE submission, NOT evidence of blocking. The
      // independent PostgreSQL PID-pair oracle below is mandatory afterwards.
      identified.enter();
    },
  );
  return {
    pool: observed,
    identified: identified.reached,
    get readerPid() {
      if (readerPid === undefined) throw Error('R1 reader not identified');
      return readerPid;
    },
    get submissions() {
      return submissions;
    },
  };
}
async function waitForBlockingPair(
  holderPid: number,
  waiterPid: number,
  expectedSql: string,
) {
  assert.ok(Number.isInteger(holderPid) && holderPid > 0);
  assert.ok(Number.isInteger(waiterPid) && waiterPid > 0);
  assert.notEqual(holderPid, waiterPid);
  const deadline = performance.now() + 12000;
  do {
    const result = await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=$1 AND a.datname=current_database() AND a.state='active' AND a.wait_event_type='Lock' AND a.query=$3 AND $2::integer=ANY(pg_blocking_pids(a.pid))) AS ready",
      [waiterPid, holderPid, expectedSql],
    );
    if (result.rows[0].ready === true) return;
    await delay(10);
  } while (performance.now() < deadline);
  throw Error(
    'R1 exact owned holder/waiter PostgreSQL blocking pair not observed',
  );
}
function captureResolution(
  real: ContextService,
  afterCanonical?: () => Promise<void>,
) {
  const attempts: ContextReference[] = [];
  const settlements: WorkResult<ContextResolution>[] = [];
  const service = Object.create(real) as ContextService;
  service.resolve = async (actor, ref) => {
    attempts.push(ref);
    const result = await startWork(() => real.resolve(actor, ref));
    settlements.push(result);
    if (afterCanonical) await fixtureObserver(afterCanonical);
    if (!result.ok) throw result.error;
    return result.value;
  };
  return { service, attempts, settlements };
}
function assertCanonicalIdentityDenied(
  seen: ReturnType<typeof captureResolution>,
  ref: ContextReference,
) {
  assert.deepEqual(seen.attempts, [ref]);
  assert.equal(seen.settlements.length, 1);
  const result = seen.settlements[0];
  assert.ok(
    !result.ok,
    'The SINGLE actual canonical resolve must refuse expiry, independently of final R1 DEGRADED',
  );
  if (!result.ok)
    assert.ok(
      result.error instanceof Error &&
        result.error.message === 'identity denied',
      'Expected exact existing canonical identity refusal; no error reflection',
    );
}

async function withQueuedRevocation(
  f: LocalFixture,
  body: (writer: {
    pid: number;
    sql: string;
    submit: () => void;
    afterCanonical: () => Promise<void>;
    allowCommit: () => void;
    result: () => Promise<WorkResult<pg.QueryResult>>;
    readonly committed: boolean;
    readonly canonicalObserved: boolean;
  }) => Promise<void>,
) {
  const original = await ownedEnrollment(f);
  assert.equal(original.active, true);
  const client = await gov.connect();
  const state = failures();
  const allowCommit = gate();
  const updated = gate();
  let writerWork: Promise<WorkResult<pg.QueryResult>> | undefined;
  let committed = false;
  let writerRolledBack = false;
  let writerDisposed = false;
  let canonicalObserved = false;
  const sql =
    'UPDATE ct.identities SET active=false,version=version+1 WHERE id=$1 AND issuer=$2 AND subject=$3 AND audience=$4 AND kind=$5 AND tenant=$6 AND principal=$7 AND domain_role=$8 RETURNING *';
  try {
    await client.query('BEGIN');
    const pid = await backendPid(client);
    await body({
      pid,
      sql,
      submit() {
        assert.equal(
          writerWork,
          undefined,
          'Submit the owned writer only once',
        );
        writerWork = startWork(async () => {
          try {
            const changed = await client.query(sql, [
              original.id,
              original.issuer,
              original.subject,
              original.audience,
              original.kind,
              original.tenant,
              original.principal,
              original.domain_role,
            ]);
            assert.equal(changed.rowCount, 1);
            assert.deepEqual(
              enrollmentBindings(changed.rows[0]),
              enrollmentBindings(original),
            );
            assert.equal(changed.rows[0].active, false);
            assert.equal(
              BigInt(changed.rows[0].version),
              BigInt(original.version) + 1n,
            );
            updated.enter();
            // Explicit test-only commit barrier: the ACTUAL reader result must
            // already be captured before the writer is allowed to COMMIT normally.
            await allowCommit.released;
            await client.query('COMMIT');
            committed = true; // Actual PostgreSQL COMMIT acknowledgement.
            return changed;
          } catch (error) {
            // End this OWNED transaction before startWork publishes failure.
            // The reader's final enrollment checkpoint must not wait on a lock
            // whose rollback is deferred until after that reader has returned.
            const failedWriter = failures();
            addFailure(failedWriter, error);
            writerRolledBack = await cleanup(
              failedWriter,
              'failed queued writer rollback',
              () => client.query('ROLLBACK'),
            );
            if (!writerRolledBack)
              writerDisposed = await cleanup(
                failedWriter,
                'failed queued writer disposal',
                () => client.release(true),
              );
            finishFailures(failedWriter);
            throw error;
          }
        });
      },
      async afterCanonical() {
        canonicalObserved = true;
        if (!writerWork) return;
        try {
          // A writer error must also unblock this observer, never strand it on
          // an UPDATE-success gate which can no longer be reached.
          await Promise.race([updated.reached, writerWork.then(() => {})]);
        } finally {
          allowCommit.resume();
        }
        const result = await writerWork;
        if (!result.ok) throw result.error;
      },
      allowCommit: () => allowCommit.resume(),
      async result() {
        if (!writerWork) throw Error('R1 owned writer was not submitted');
        return writerWork;
      },
      get committed() {
        return committed;
      },
      get canonicalObserved() {
        return canonicalObserved;
      },
    });
  } catch (error) {
    addFailure(state, error);
  } finally {
    await cleanup(state, 'writer commit gate release', () =>
      allowCommit.resume(),
    );
    if (writerWork) {
      const result = await writerWork;
      if (!result.ok) addFailure(state, result.error);
    }
    const rolledBack =
      committed ||
      writerRolledBack ||
      writerDisposed ||
      (await cleanup(state, 'queued writer rollback', () =>
        client.query('ROLLBACK'),
      ));
    if (!writerDisposed)
      await cleanup(state, 'queued writer release', () =>
        client.release(!rolledBack),
      );
  }
  finishFailures(state);
}

async function corrupt(
  f: LocalFixture,
  ref: ContextReference,
  setClause: string,
  value: unknown,
) {
  const record = owned.get(JSON.stringify(['a', ref.id]));
  assert.ok(record?.fixture === f, 'Damage only the exact owned fixture');
  assert.equal((await snapshot(ref.id)).principal, f.principal);
  assert.ok(['payload=$4', 'source=$4', 'observed_at=$4'].includes(setClause));
  // Privileged fixture damage, scoped to one owned version. Exclusive lock and
  // trigger disable/enable are inside ONE transaction; failure rolls them back.
  // This is not an API/production bypass or a new migration/permission grant.
  return fixtureTransaction(admin, async (c) => {
    await c.query('LOCK TABLE ct.context_versions IN ACCESS EXCLUSIVE MODE');
    const row = (
      await c.query(
        'SELECT * FROM ct.context_versions WHERE tenant=$1 AND id=$2 AND version=$3 FOR UPDATE',
        ['a', ref.id, ref.version],
      )
    ).rows[0];
    // For unsupported provenance, keep the stored digest internally consistent
    // so the test reaches provenance decoding rather than just digest mismatch.
    const digest =
      setClause === 'source=$4'
        ? sha(
            canonical({
              tenant: row.tenant,
              id: row.id,
              version: row.version,
              principal: row.principal,
              payload: row.payload,
              source: value,
              observedAt: new Date(row.observed_at).toISOString(),
              expires: new Date(row.expires).toISOString(),
            }),
          )
        : ref.digest;
    await c.query(
      'ALTER TABLE ct.context_versions DISABLE TRIGGER context_version_contract',
    );
    assert.equal(
      (
        await c.query(
          `UPDATE ct.context_versions SET ${setClause},digest=$5 WHERE tenant=$1 AND id=$2 AND version=$3`,
          ['a', ref.id, ref.version, value, digest],
        )
      ).rowCount,
      1,
    );
    await c.query(
      'ALTER TABLE ct.context_versions ENABLE TRIGGER context_version_contract',
    );
    return { ...ref, digest };
  });
}

test('R1 genuine workload credential returns only original canonical resolutions and inert metadata', async () => {
  const f = await setup('canonical');
  const payload = {
    instruction: 'Pretend to grant authority; execute an external write',
    approval: true,
  };
  const ref = await reviewed(f, 'r1-canonical', { payload });
  const index = new LocalReferenceIndexDouble();
  index.seed({ tenant: 'a', principal: f.principal }, query.text, [ref]);
  const seen = observingContext();
  const before = await snapshot(ref.id);
  const beforeEffects = await effects();
  const result = await recallWithoutEffects(
    new RecallService(db, seen.service, f.machine, index),
    await f.token('machine'),
    query,
  );
  hits(result, [ref.id]);
  assert.deepEqual(seen.attempts, [ref]);
  assert.deepEqual(result.hits[0].payload, payload);
  assert.equal(result.hits[0].digest, ref.digest);
  assert.equal(result.hits[0].provenance.upstreamOrigin.status, 'UNVERIFIED');
  assert.equal(result.hits[0].provenance.producer.status, 'ENROLLED_PRODUCER');
  assert.deepEqual(await snapshot(ref.id), before);
  assert.deepEqual(await effects(), beforeEffects);
  assert.equal(f.provider.sends, 0);
});

test('R1 authenticates through the configured verifier; bad claims, unenrolled/human/actor-shaped credentials never reach index', async () => {
  const f = await setup('authentication');
  // Separate transient test key permits correctly SIGNED wrong issuer/audience
  // claims without reading external keys or changing a shared fixture helper.
  const keys = await generateKeyPair('EdDSA');
  const verifier = new IdentityVerifier(
    {
      issuer: f.issuer,
      jwksUri: f.issuer + '/jwks',
      audience: f.audience,
      algorithms: ['EdDSA'],
      kind: 'machine',
    },
    createLocalJWKSet({
      keys: [
        { ...(await exportJWK(keys.publicKey)), kid: 'r1-test', alg: 'EdDSA' },
      ],
    }),
  );
  const signed = (changes: Record<string, unknown> = {}) =>
    new SignJWT({
      iss: f.issuer,
      aud: f.audience,
      sub: `${f.prefix}-worker-a`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      ...changes,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'r1-test' })
      .sign(keys.privateKey);
  const port = scripted({ status: 'AVAILABLE', references: [] });
  const service = new RecallService(db, context, verifier, port.index);
  empty(await recallWithoutEffects(service, await signed(), query));
  assert.equal(port.calls.length, 1);
  for (const credential of [
    '',
    'not-a-signed-token',
    await signed({ iss: 'https://wrong-r1.test-identity.invalid' }),
    await signed({ aud: 'urn:continuum:wrong-r1' }),
    await signed({ exp: Math.floor(Date.now() / 1000) - 1 }),
    await signed({ sub: 'r1-never-enrolled-worker' }),
    (await f.actor('machine')) as unknown as string,
  ])
    degraded(await recallWithoutEffects(service, credential, query));
  assert.equal(port.calls.length, 1);
  degraded(
    await recallWithoutEffects(
      new RecallService(db, context, f.human, port.index),
      await f.token('user'),
      query,
    ),
  );
  assert.equal(port.calls.length, 1);
});

test('R1 snapshots strict query bounds before any lookup and passes only frozen server scope', async () => {
  const f = await setup('query');
  const ref = await reviewed(f, 'r1-query');
  const port = scripted({
    status: 'AVAILABLE',
    references: Array(16).fill(ref),
  });
  const seen = observingContext();
  const service = new RecallService(db, seen.service, f.machine, port.index);
  const credential = await f.token('machine');
  const boundary = { text: 'é'.repeat(512), limit: 16 };
  hits(await recallWithoutEffects(service, credential, boundary), [ref.id]);
  assert.equal(
    Buffer.byteLength(boundary.text),
    RESTRICTED_MEMORY_CAPS.queryBytes,
  );
  assert.deepEqual(port.calls[0], {
    scope: { tenant: 'a', principal: f.principal },
    query: boundary,
  });
  assert.ok(
    Object.isFrozen(port.calls[0].scope) &&
      Object.isFrozen(port.calls[0].query),
  );
  assert.deepEqual(Object.keys(port.calls[0].scope).sort(), [
    'principal',
    'tenant',
  ]);
  assert.notEqual(port.calls[0].query, boundary);
  assert.equal(seen.attempts.length, 1);
  const calls = port.calls.length;
  for (const malformed of [
    { ...boundary, text: boundary.text + 'a' },
    { text: ' ', limit: 1 },
    { text: 'a\nb', limit: 1 },
    { text: '\ud800', limit: 1 },
    { ...query, limit: 0 },
    { ...query, limit: 17 },
    { ...query, limit: 1.5 },
    { ...query, limit: '16' },
    { ...query, tenant: 'b' },
  ])
    degraded(
      await recallWithoutEffects(service, credential, malformed as RecallQuery),
    );
  assert.equal(port.calls.length, calls);
  assert.equal(seen.attempts.length, 1);
});

test('R1 caps before stable exact dedup and rejects conflicting or malformed complete replies before resolving', async () => {
  const f = await setup('references');
  const first = await reviewed(f, 'r1-references-first');
  const second = await reviewed(f, 'r1-references-second');
  const seen = observingContext();
  const credential = await f.token('machine');
  const run = (reply: unknown, requested = query) =>
    recallWithoutEffects(
      new RecallService(db, seen.service, f.machine, scripted(reply).index),
      credential,
      requested,
    );
  hits(
    await run({
      status: 'AVAILABLE',
      references: [second, first, second, first],
    }),
    [second.id, first.id],
  );
  assert.deepEqual(seen.attempts, [second, first]);
  for (const reply of [
    { status: 'AVAILABLE', references: Array(17).fill(first) },
    { status: 'AVAILABLE', references: [first, { ...first, version: 2 }] },
    {
      status: 'AVAILABLE',
      references: [first, { ...first, digest: '0'.repeat(64) }],
    },
    { status: 'AVAILABLE', references: [{ ...first, version: '1' }] },
    { status: 'AVAILABLE', references: [{ ...first, digest: 'A'.repeat(64) }] },
    { status: 'AVAILABLE', references: [{ ...first, tenant: 'b' }] },
    {
      status: 'AVAILABLE',
      references: [{ ...first, payload: 'not canonical' }],
    },
    { status: 'AVAILABLE', references: [first], payload: 'not canonical' },
    { status: 'AVAILABLE', references: [first], authority: true },
    { status: 'UNAVAILABLE', references: [] },
  ])
    degraded(await run(reply));
  degraded(
    await run(
      { status: 'AVAILABLE', references: [first, first] },
      { ...query, limit: 1 },
    ),
  );
  assert.deepEqual(seen.attempts, [second, first]);
});

test('R1 complete tenant/principal/alias namespace is not context permission and explicit TENANT sharing still uses the resolver', async () => {
  const first = await setup('namespace-first');
  const other = await setup('namespace-other');
  const sameId = 'r1-namespace-same-id';
  const a = await reviewed(first, sameId, { payload: { tenant: 'a' } });
  const b = await reviewed(first, sameId, { payload: { tenant: 'b' } }, 'b');
  const privateOther = await reviewed(other, 'r1-namespace-private');
  const shared = await reviewed(other, 'r1-namespace-shared', {}, 'a', true);
  const index = new LocalReferenceIndexDouble();
  index.seed({ tenant: 'a', principal: first.principal }, query.text, [a]);
  index.seed({ tenant: 'b', principal: first.principal }, query.text, [b]);
  index.seed({ tenant: 'a', principal: other.principal }, query.text, [
    privateOther,
  ]);
  const service = new RecallService(db, context, first.machine, index);
  assert.deepEqual(
    (await recallWithoutEffects(service, await first.token('machine'), query))
      .hits[0].payload,
    { tenant: 'a' },
  );
  assert.deepEqual(
    (
      await recallWithoutEffects(
        service,
        await first.token('machine', 'b'),
        query,
      )
    ).hits[0].payload,
    { tenant: 'b' },
  );
  hits(
    await recallWithoutEffects(
      new RecallService(db, context, other.machine, index),
      await other.token('machine'),
      query,
    ),
    [privateOther.id],
  );
  for (const rejected of [b, privateOther]) {
    const malicious = scripted({ status: 'AVAILABLE', references: [rejected] });
    degraded(
      await recallWithoutEffects(
        new RecallService(db, context, first.machine, malicious.index),
        await first.token('machine'),
        query,
      ),
    );
  }
  const allowed = scripted({ status: 'AVAILABLE', references: [shared] });
  hits(
    await recallWithoutEffects(
      new RecallService(db, context, first.machine, allowed.index),
      await first.token('machine'),
      query,
    ),
    [shared.id],
  );
  await context.approve(
    await other.actor('user'),
    shared.id,
    shared.version,
    shared.digest,
    false,
  );
  degraded(
    await recallWithoutEffects(
      new RecallService(db, context, first.machine, allowed.index),
      await first.token('machine'),
      query,
    ),
  );
});

test('R1 mixed canonical rejection is sticky and every unique remaining reference is attempted without partial identifiers', async () => {
  const f = await setup('sticky');
  const first = await reviewed(f, 'r1-sticky-first');
  const last = await reviewed(f, 'r1-sticky-last');
  const missing = {
    id: 'r1-sticky-missing',
    version: 1,
    digest: 'a'.repeat(64),
  };
  for (const references of [
    [first, missing, last],
    [missing, first, last],
  ]) {
    const seen = observingContext();
    const service = new RecallService(
      db,
      seen.service,
      f.machine,
      scripted({ status: 'AVAILABLE', references }).index,
    );
    degraded(
      await recallWithoutEffects(service, await f.token('machine'), query),
    );
    assert.deepEqual(seen.attempts, references);
  }
  assert.equal((await snapshot(first.id)).quarantined, false);
  assert.equal((await snapshot(last.id)).quarantined, false);
});

test('R1 empty unavailable malformed and thrown-port outcomes all perform fresh post-wait enrollment and DB-time checks', async () => {
  const f = await setup('all-outcomes');
  const cases: unknown[] = [
    { status: 'AVAILABLE', references: [] },
    { status: 'UNAVAILABLE' },
    { status: 'AVAILABLE', references: [{ invalid: true }] },
    'throw',
  ];
  const beforeEffects = await effects();
  for (const reply of cases) {
    let clocks = 0;
    let enrollments = 0;
    const observed = observedPool((sql) => {
      if (sql === 'SELECT clock_timestamp() t') clocks++;
      if (sql.startsWith('SELECT * FROM ct.identities')) enrollments++;
    });
    const index: DerivedReferenceIndexPort = {
      async lookup() {
        assert.equal(clocks, 2);
        assert.equal(enrollments, 1);
        if (reply === 'throw')
          throw Error('private index error must not escape');
        return reply as ReferenceIndexReply;
      },
    };
    const result = await recallWithoutEffects(
      new RecallService(observed, context, f.machine, index),
      await f.token('machine'),
      query,
    );
    if (reply === cases[0]) empty(result);
    else degraded(result);
    assert.equal(clocks, 4);
    assert.equal(enrollments, 2);
  }
  assert.deepEqual(await effects(), beforeEffects);
});

test('R1 missing invalid or nonfinite fresh DB-time cannot become EMPTY on either checkpoint', async () => {
  const f = await setup('finite-clock');
  for (const target of [2, 4]) {
    for (const invalid of [
      undefined,
      null,
      'not a timestamp',
      Infinity,
      new Date(NaN),
    ]) {
      let clocks = 0;
      const observed = observedPool((sql, result) => {
        if (sql === 'SELECT clock_timestamp() t' && ++clocks === target)
          return { ...result, rows: [{ t: invalid }] };
      });
      const port = scripted({ status: 'AVAILABLE', references: [] });
      degraded(
        await recallWithoutEffects(
          new RecallService(observed, context, f.machine, port.index),
          await f.token('machine'),
          query,
        ),
      );
      assert.equal(port.calls.length, target === 2 ? 0 : 1);
    }
  }
});

test('R1 an injected enrollment-query failure yields the same generic result without lookup fallback', async () => {
  const f = await setup('db-outage');
  const observed = observedPool(
    () => {},
    (sql) => {
      if (sql.startsWith('SELECT * FROM ct.identities'))
        throw Error('private fixture query error must not escape');
    },
  );
  const port = scripted({ status: 'AVAILABLE', references: [] });
  degraded(
    await recallWithoutEffects(
      new RecallService(observed, context, f.machine, port.index),
      await f.token('machine'),
      query,
    ),
  );
  assert.equal(port.calls.length, 0);
});

test('R1 revocation commits while an unlocked index wait holds empty or hit candidates', async () => {
  const f = await setup('index-revoke');
  const ref = await reviewed(f, 'r1-index-revoke');
  for (const references of [[], [ref]]) {
    await restoreEnrollment(f, async () => {
      degraded(
        await duringIndex(f, { status: 'AVAILABLE', references }, async () => {
          // If R1 held its enrollment lock over lookup, this query could not
          // commit before the test-only wait is released.
          await deactivate(f);
        }),
      );
    });
  }
  assert.equal((await snapshot(ref.id)).quarantined, false);
});

test('R1 genuine verified token expiring during empty or hit index waits is denied using fresh DB time', async () => {
  const f = await setup('index-expiry');
  const ref = await reviewed(f, 'r1-index-expiry');
  for (const references of [[], [ref]]) {
    const short = await shortCredential(f);
    degraded(
      await duringIndex(
        f,
        { status: 'AVAILABLE', references },
        () => databaseExpired(short.expires),
        short.credential,
      ),
    );
  }
  assert.equal((await snapshot(ref.id)).quarantined, false);
});

test('R1 INJECTED enrollment-result ID tenant and VERA mismatch fails closed; not a real enrollment rebind', async () => {
  const f = await setup('scope-change');
  const other = await setup('scope-destination');
  const ref = await reviewed(f, 'r1-scope-change');
  for (const [field, value] of [
    ['id', `${f.prefix}-worker-replaced`],
    ['tenant', 'b'],
    ['principal', other.principal],
  ] as const) {
    const canonicalBefore = await ownedEnrollment(f);
    let injectionArmed = false;
    let injections = 0;
    const observed = observedPool((sql, result) => {
      if (injectionArmed && sql.startsWith('SELECT * FROM ct.identities')) {
        injectionArmed = false;
        injections++;
        return {
          ...result,
          rows: result.rows.map((row) => ({ ...row, [field]: value })),
        };
      }
    });
    const seen = observingContext();
    // Synthetic enrollment RESULT only, after the real SELECT. The unchanged
    // immutable-enrollment trigger forbids these real rebindings. This is not
    // a claim that such transitions or any live authentication were exercised.
    degraded(
      await duringIndex(
        f,
        { status: 'AVAILABLE', references: [ref] },
        async () => {
          injectionArmed = true;
        },
        undefined,
        seen.service,
        observed,
      ),
    );
    assert.equal(injections, 1);
    assert.deepEqual(seen.attempts, []);
    assert.deepEqual(await ownedEnrollment(f), canonicalBefore);
  }
});

test('R1 lossless bigint witness distinguishes adjacent versions above 2^53 instead of rounding them', async () => {
  const f = await setup('lossless-version');
  const ref = await reviewed(f, 'r1-lossless-version');
  await restoreEnrollment(f, async () => {
    await gov.query(
      'UPDATE ct.identities SET version=$3 WHERE id=$1 AND issuer=$2',
      [`${f.prefix}-worker-a`, f.issuer, '9007199254740992'],
    );
    assert.equal(
      (
        await admin.query('SELECT version FROM ct.identities WHERE id=$1', [
          `${f.prefix}-worker-a`,
        ])
      ).rows[0].version,
      '9007199254740992',
    );
    hits(
      await recallWithoutEffects(
        new RecallService(
          db,
          context,
          f.machine,
          scripted({ status: 'AVAILABLE', references: [ref] }).index,
        ),
        await f.token('machine'),
        query,
      ),
      [ref.id],
    );
    degraded(
      await duringIndex(
        f,
        { status: 'AVAILABLE', references: [ref] },
        async () => {
          await gov.query(
            'UPDATE ct.identities SET version=$3 WHERE id=$1 AND issuer=$2',
            [`${f.prefix}-worker-a`, f.issuer, '9007199254740993'],
          );
        },
      ),
    );
  });
});

test('R1 scope change during candidate work aborts remaining candidates and discards earlier payloads', async () => {
  const f = await setup('candidate-scope');
  const first = await reviewed(f, 'r1-candidate-scope-first');
  const last = await reviewed(f, 'r1-candidate-scope-last');
  await restoreEnrollment(f, async () => {
    const seen = observingContext(context, async () => {
      await gov.query(
        'UPDATE ct.identities SET version=version+1 WHERE id=$1 AND issuer=$2',
        [`${f.prefix}-worker-a`, f.issuer],
      );
    });
    degraded(
      await recallWithoutEffects(
        new RecallService(
          db,
          seen.service,
          f.machine,
          scripted({ status: 'AVAILABLE', references: [first, last] }).index,
        ),
        await f.token('machine'),
        query,
      ),
    );
    assert.deepEqual(seen.attempts, [first]);
  });
});

test('R1 final checkpoint rejects a reader revoked after a successful resolution without publishing buffered hits', async () => {
  const f = await setup('final-revoke');
  const ref = await reviewed(f, 'r1-final-revoke');
  await restoreEnrollment(f, async () => {
    const seen = observingContext(context, () => deactivate(f));
    degraded(
      await recallWithoutEffects(
        new RecallService(
          db,
          seen.service,
          f.machine,
          scripted({ status: 'AVAILABLE', references: [ref] }).index,
        ),
        await f.token('machine'),
        query,
      ),
    );
    assert.deepEqual(seen.attempts, [ref]);
  });
  assert.equal((await snapshot(ref.id)).quarantined, false);
});

test('R1 final checkpoint rejects token expiry after successful resolution', async () => {
  const f = await setup('final-expiry');
  const ref = await reviewed(f, 'r1-final-expiry');
  const short = await shortCredential(f);
  const seen = observingContext(context, () => databaseExpired(short.expires));
  degraded(
    await recallWithoutEffects(
      new RecallService(
        db,
        seen.service,
        f.machine,
        scripted({ status: 'AVAILABLE', references: [ref] }).index,
      ),
      short.credential,
      query,
    ),
  );
  assert.deepEqual(seen.attempts, [ref]);
});

test('R1 real ContextService head-lock wait rechecks token DB expiry after the lock', async () => {
  const f = await setup('head-expiry');
  const ref = await reviewed(f, 'r1-head-expiry');
  // Fixture-only duration leaves room to OBSERVE blocking while still valid.
  // This is neither a production timeout nor an owner-approved latency target.
  const short = await shortCredential(f, 8);
  const probe = headWaitProbe(ref);
  const seen = captureResolution(new ContextService(probe.pool));
  const settled = await duringHeadWait(
    ref,
    () =>
      recallWithoutEffects(
        new RecallService(
          db,
          seen.service,
          f.machine,
          scripted({ status: 'AVAILABLE', references: [ref] }).index,
        ),
        short.credential,
        query,
      ),
    async (holderPid) => {
      await reached(probe.identified);
      const readerPid = probe.readerPid;
      await waitForBlockingPair(holderPid, readerPid, contextHeadSql);
      assert.equal(probe.submissions, 1);
      assert.equal(seen.settlements.length, 0);
      assert.equal(
        (
          await admin.query(
            'SELECT clock_timestamp()<to_timestamp($1::double precision/1000) AS valid',
            [short.expires],
          )
        ).rows[0].valid,
        true,
        'Token must still be valid once the ACTUAL reader wait is observed',
      );
      await databaseExpired(short.expires);
      // The same owned PostgreSQL wait must persist across the expiry boundary,
      // not just a before-submission callback or a final consumer checkpoint.
      await waitForBlockingPair(holderPid, readerPid, contextHeadSql);
      assert.equal(seen.settlements.length, 0);
    },
  );
  degraded(settled);
  assert.equal(probe.submissions, 1);
  assertCanonicalIdentityDenied(seen, ref);
  assert.equal((await snapshot(ref.id)).quarantined, false);
});

test('R1 queued revocation during a context head wait commits after item transaction and final checkpoint denies', async () => {
  const f = await setup('head-revoke');
  const ref = await reviewed(f, 'r1-head-revoke');
  await restoreEnrollment(f, async () => {
    await withQueuedRevocation(f, async (writer) => {
      const probe = headWaitProbe(ref);
      const seen = captureResolution(
        new ContextService(probe.pool),
        writer.afterCanonical,
      );
      const credential = await f.token('machine');
      const settled = await duringHeadWait(
        ref,
        () =>
          recallWithoutEffects(
            new RecallService(
              db,
              seen.service,
              f.machine,
              scripted({ status: 'AVAILABLE', references: [ref] }).index,
            ),
            credential,
            query,
          ),
        async (holderPid) => {
          await reached(probe.identified);
          const readerPid = probe.readerPid;
          await waitForBlockingPair(holderPid, readerPid, contextHeadSql);
          assert.equal(seen.settlements.length, 0);
          writer.submit();
          // This is the ACTUAL leased writer blocked on the ACTUAL reader's
          // enrollment SHARE lock, while that reader is blocked on our head.
          await waitForBlockingPair(readerPid, writer.pid, writer.sql);
          assert.equal(writer.committed, false);
          assert.equal(writer.canonicalObserved, false);
          assert.equal(seen.settlements.length, 0);
        },
        writer.allowCommit,
      );
      const written = await writer.result();
      assert.ok(written.ok, 'The exact owned writer must actually commit');
      assert.equal(writer.committed, true);
      assert.equal(writer.canonicalObserved, true);
      degraded(settled);
      assert.deepEqual(seen.attempts, [ref]);
      assert.equal(probe.submissions, 1);
      assert.equal(seen.settlements.length, 1);
      const canonical = seen.settlements[0];
      assert.ok(
        canonical.ok,
        'Queued revocation cannot commit until the canonical reader releases its enrollment lock',
      );
      if (canonical.ok) {
        assert.equal(canonical.value.id, ref.id);
        assert.equal(canonical.value.digest, ref.digest);
        assert.equal(canonical.value.authority, false);
      }
      const current = await ownedEnrollment(f);
      assert.equal(current.active, false);
    });
  });
});

test('R1 stale refreshed quarantined and erased candidates deny at their own real resolution point', async () => {
  const f = await setup('eligibility');
  for (const change of ['refresh', 'quarantine', 'erase'] as const) {
    const ref = await reviewed(f, 'r1-eligibility-' + change);
    const seen = observingContext();
    degraded(
      await duringIndex(
        f,
        { status: 'AVAILABLE', references: [ref] },
        async () => {
          if (change === 'refresh')
            await reviewed(f, ref.id, {
              expectedVersion: 1,
              payload: { new: true },
            });
          else if (change === 'erase')
            await context.erase(await f.actor('user'), ref.id);
          else
            await admin.query(
              'UPDATE ct.context_heads SET quarantined=true,revision=revision+1 WHERE tenant=$1 AND id=$2',
              ['a', ref.id],
            );
        },
        undefined,
        seen.service,
      ),
    );
    assert.deepEqual(seen.attempts, [ref]);
  }
});

test('R1 naturally expired context candidates deny without treating expiry as corruption', async () => {
  const f = await setup('context-expiry');
  const ref = await reviewed(f, 'r1-context-expiry', { ttlSeconds: 4 });
  const expires = new Date(
    (
      await admin.query(
        'SELECT expires FROM ct.context_versions WHERE tenant=$1 AND id=$2 AND version=$3',
        ['a', ref.id, ref.version],
      )
    ).rows[0].expires,
  ).getTime();
  degraded(
    await duringIndex(f, { status: 'AVAILABLE', references: [ref] }, () =>
      databaseExpired(expires),
    ),
  );
  assert.equal((await snapshot(ref.id)).quarantined, false);
  assert.equal(await corruptionEvents(ref.id), '0');
});

test('R1 documents per-item non-atomic freshness: erasure after an earlier item resolution is not a second snapshot', async () => {
  const f = await setup('validation-points');
  const first = await reviewed(f, 'r1-validation-points-first');
  const last = await reviewed(f, 'r1-validation-points-last');
  const seen = observingContext(context, async (value) => {
    if (value.id === first.id)
      await context.erase(await f.actor('user'), first.id);
  });
  const result = await recallWithoutEffects(
    new RecallService(
      db,
      seen.service,
      f.machine,
      scripted({ status: 'AVAILABLE', references: [first, last] }).index,
    ),
    await f.token('machine'),
    query,
  );
  hits(result, [first.id, last.id]);
  assert.deepEqual(result.hits[0].payload, { note: first.id });
  assert.equal((await snapshot(first.id)).payload, null);
  assert.equal((await snapshot(first.id)).deleted, true);
  assert.deepEqual(seen.attempts, [first, last]);
});

test('R1 wrong caller digest never quarantines healthy content or appends corruption evidence', async () => {
  const f = await setup('wrong-digest');
  const ref = await reviewed(f, 'r1-wrong-digest');
  const wrong = {
    ...ref,
    digest: ref.digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
  };
  const before = await snapshot(ref.id);
  const beforeEffects = await effects();
  degraded(
    await recallWithoutEffects(
      new RecallService(
        db,
        context,
        f.machine,
        scripted({ status: 'AVAILABLE', references: [wrong] }).index,
      ),
      await f.token('machine'),
      query,
    ),
  );
  assert.deepEqual(await snapshot(ref.id), before);
  assert.equal(await corruptionEvents(ref.id), '0');
  assert.deepEqual(await effects(), beforeEffects);
});

test('R1 actual stored digest provenance or timestamp damage commits sole ContextService quarantine despite whole-batch DEGRADED', async () => {
  const f = await setup('corruption');
  const healthy = await reviewed(f, 'r1-corruption-healthy');
  for (const [name, clause, value] of [
    ['digest', 'payload=$4', canonical({ privilegedFixtureDamage: true })],
    [
      'provenance',
      'source=$4',
      {
        kind: 'document',
        reference: 'bad-fixture',
        provenance: { version: 9 },
      },
    ],
    ['timestamp', 'observed_at=$4', '-infinity'],
  ] as const) {
    const original = await reviewed(f, 'r1-corruption-' + name);
    const broken = await corrupt(f, original, clause, value);
    const beforeEffects = await effects();
    const seen = observingContext();
    degraded(
      await recallWithoutEffects(
        new RecallService(
          db,
          seen.service,
          f.machine,
          scripted({
            status: 'AVAILABLE',
            references: [healthy, broken],
          }).index,
        ),
        await f.token('machine'),
        query,
      ),
    );
    assert.deepEqual(seen.attempts, [healthy, broken]);
    assert.equal((await snapshot(broken.id)).quarantined, true);
    assert.equal(await corruptionEvents(broken.id), '1');
    assert.equal((await snapshot(healthy.id)).quarantined, false);
    assert.deepEqual(await effects(), beforeEffects);
    assert.equal(f.provider.sends, 0);
  }
});

test('R1 repeats verification and canonical resolution with no payload negative or actor cache; index reset cannot resurrect erasure', async () => {
  const f = await setup('no-cache');
  const index = new LocalReferenceIndexDouble();
  const scope = { tenant: 'a', principal: f.principal };
  const seen = observingContext();
  let verifications = 0;
  const verifier = Object.create(f.machine) as IdentityVerifier;
  verifier.verify = async (credential) => {
    verifications++;
    return f.machine.verify(credential);
  };
  const service = new RecallService(db, seen.service, verifier, index);
  const credential = await f.token('machine');
  empty(await recallWithoutEffects(service, credential, query));
  const original = await reviewed(f, 'r1-no-cache', {
    payload: { revision: 1 },
  });
  index.seed(scope, query.text, [original]);
  hits(await recallWithoutEffects(service, credential, query), [original.id]);
  const fresh = await reviewed(f, original.id, {
    expectedVersion: 1,
    payload: { revision: 2 },
  });
  degraded(await recallWithoutEffects(service, credential, query));
  index.seed(scope, query.text, [fresh]);
  const result = await recallWithoutEffects(service, credential, query);
  hits(result, [fresh.id]);
  assert.deepEqual(result.hits[0].payload, { revision: 2 });
  const beforeLoss = await snapshot(fresh.id);
  index.reset();
  degraded(await recallWithoutEffects(service, credential, query));
  assert.deepEqual(await snapshot(fresh.id), beforeLoss);
  index.seed(scope, query.text, [fresh]);
  index.setAvailable(true);
  await context.erase(await f.actor('user'), fresh.id);
  degraded(await recallWithoutEffects(service, credential, query));
  assert.equal((await snapshot(fresh.id)).payload, null);
  await restoreEnrollment(f, async () => {
    await deactivate(f);
    degraded(await recallWithoutEffects(service, credential, query));
  });
  assert.equal(verifications, 7);
  assert.deepEqual(seen.attempts, [original, original, fresh, fresh]);
});

test('R1 historical UNKNOWN producer and original source/digest bytes are data, never inferred from the reader', async () => {
  const f = await setup('historical');
  const id = 'r1-historical';
  own(f, id);
  const source = {
    kind: 'document',
    reference: 'historical-source-attribution',
  };
  const payload = canonical({ note: 'historical data' });
  const ref = await fixtureTransaction(admin, async (c) => {
    const times = (
      await c.query(
        "SELECT clock_timestamp() AS observed_at,clock_timestamp()+interval '1 hour' AS expires",
      )
    ).rows[0];
    const digest = sha(
      canonical({
        tenant: 'a',
        id,
        version: 1,
        principal: f.principal,
        payload,
        source,
        observedAt: new Date(times.observed_at).toISOString(),
        expires: new Date(times.expires).toISOString(),
      }),
    );
    await c.query(
      'INSERT INTO ct.context_heads(tenant,id,principal,version,quarantined) VALUES($1,$2,$3,1,false)',
      ['a', id, f.principal],
    );
    await c.query(
      'INSERT INTO ct.context_versions(tenant,id,version,principal,payload,digest,source,observed_at,expires) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
      [
        'a',
        id,
        f.principal,
        payload,
        digest,
        source,
        times.observed_at,
        times.expires,
      ],
    );
    return { id, version: 1, digest };
  });
  const before = await snapshot(id);
  const beforeEffects = await effects();
  const result = await recallWithoutEffects(
    new RecallService(
      db,
      context,
      f.machine,
      scripted({ status: 'AVAILABLE', references: [ref] }).index,
    ),
    await f.token('machine'),
    query,
  );
  hits(result, [id]);
  assert.deepEqual(result.hits[0].source, source);
  assert.deepEqual(result.hits[0].provenance, {
    version: 1,
    producer: { status: 'UNKNOWN' },
    upstreamOrigin: { status: 'UNVERIFIED' },
  });
  assert.deepEqual(await snapshot(id), before);
  assert.deepEqual(await effects(), beforeEffects);
  assert.equal(f.provider.sends, 0);
});

test('R1 source boundary has no alternate context SQL cache defaults fixture import model execution or product hook', () => {
  const source = fs.readFileSync('src/recall-service.ts', 'utf8');
  assert(!/from ['"][^'"]*internal\//.test(source));
  assert(
    !/from ['"][^'"]*(?:model|cognition|gateway|controller|memory)\.js['"]/.test(
      source,
    ),
  );
  assert(
    !/\b(?:context_heads|context_versions|visibility|quarantined|payload|digest)\b/.test(
      source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''),
    ),
  );
  assert(
    !/\b(?:Date\.now|setTimeout|setInterval|fetch|ingest|approve|erase|send|spawn|exec)\s*\(/.test(
      source,
    ),
  );
  assert(
    !/\b(?:new Map|new pg\.Pool|LocalReferenceIndexDouble)\b/.test(source),
  );
  assert(!/\.get\s*\(/.test(source));
  assert.deepEqual(Object.getOwnPropertyNames(RecallService.prototype).sort(), [
    'checkpoint',
    'constructor',
    'recall',
  ]);
});
