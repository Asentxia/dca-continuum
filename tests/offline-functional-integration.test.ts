/** Offline synthetic milestone: real PostgreSQL, donor AEON ranking and NEXUS
 * execution; scripted model observation only, NOT real-model autonomy. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pool, tx } from '../src/db.js';
import { enrolled } from '../src/service-auth.js';
import { ContextService } from '../src/context-service.js';
import { RecallService } from '../src/recall-service.js';
import {
  createE2Ingress,
  createE2ReviewIngress,
  E2_EXTRACTION_PROTOCOL,
} from '../src/e2-ingress.js';
import { E2RecoveryGate } from '../src/e2-recovery.js';
import { LOCAL_MODEL_PROTOCOL } from '../src/model-protocol.js';
import { LocalModelProtocolDouble } from '../internal/fixtures/local-model-protocol.js';
import { NativeAeonRanker } from '../src/aeon/offline-ranker.js';
import { AeonReferenceIndex } from '../src/aeon/reference-index.js';
import { AeonGovernedAdmission } from '../src/aeon/governed-admission.js';
import {
  createNexusLocalIngress,
  NEXUS_LOCAL_PROFILE,
} from '../src/nexus-local.js';
import { ConsoleReads } from '../src/console/reads.js';
import { CursorCodec } from '../src/console/pagination.js';
import { fixture } from './implementation-helpers.js';
import { admin, gov, fence } from './helpers.js';

const db = pool('ct_context_service');
const consoleDb = pool('ct_console_reader');
const created: Awaited<ReturnType<typeof fixture>>[] = [];
after(async () => {
  await Promise.all(created.map((f) => f.close()));
  await Promise.all([db.end(), consoleDb.end(), admin.end(), gov.end()]);
});

// Fixed import-free module: (func (export "run") (result i32) i32.const 42).
const wasm = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3,
  114, 117, 110, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
]);

test('offline VERA journey: canonical work/context, actual donor ranking+WASM, governed extraction, restart and withdrawal', async () => {
  const f = await fixture('offline-journey');
  created.push(f);
  let journalKnown = true;
  const gate = new E2RecoveryGate(
    {
      normalOperationLease: async () =>
        journalKnown
          ? {
              state: 'NORMAL_UNRESTORED',
              domain: 'offline-journey',
              fence,
              validUntil: Date.now() + 60_000,
            }
          : null,
    },
    'offline-journey',
  );
  let context = new ContextService(db, gate);
  const credential = await f.token('machine');
  const worker = await f.machine.verify(credential);
  const ownerCredential = await f.token('user');
  const owner = await f.human.verify(ownerCredential);
  const task = 'offline-journey-task';
  await f.product.createTask(worker, {
    id: task,
    principal: f.principal,
    objective: 'Offline bounded computation and governed candidate',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    ...f.admission.a,
  });
  const source = await context.ingest(worker, {
    id: 'offline-journey-source',
    expectedVersion: 0,
    payload: { permittedSyntheticInput: 42 },
    source: { kind: 'document', reference: 'synthetic-local' },
    ttlSeconds: 3600,
  });
  const ref = { id: source.id, version: source.version, digest: source.digest };
  await context.approve(owner, ref.id, ref.version, ref.digest);
  const ranker = new NativeAeonRanker(resolve('.artifacts/aeon/ranker'));
  const index = new AeonReferenceIndex(
    {
      candidates: async () => [
        {
          reference: ref,
          distance: 0.8,
          neighborWeight: 2,
        },
      ],
    },
    ranker,
  );
  const recall = new RecallService(db, context, f.machine, index);
  const recalled = await recall.recall(credential, {
    text: 'synthetic candidate',
    limit: 4,
  });
  assert.equal(recalled.status, 'HITS');
  assert.equal(recalled.hits[0].id, ref.id);
  assert.equal(recalled.authority, false);

  const native = process.env.NEXUS_NATIVE_BINARY;
  assert.ok(
    native,
    'native binary must be prepared explicitly, never downloaded at runtime',
  );
  const nexus = createNexusLocalIngress({
    profile: NEXUS_LOCAL_PROFILE,
    executable: resolve(native),
    verifyCredential: async (token) => {
      const actor = await f.machine.verify(token);
      return tx(db, async (c) => {
        const identity = await enrolled(c, actor);
        if (identity.kind !== 'machine' || identity.domain_role !== 'worker')
          throw Error('denied');
        return { subject: actor.subject, tenant: identity.tenant as string };
      });
    },
    modules: [{ tenant: 'a', id: 'answer', bytes: wasm }],
    // This trusted callback rechecks the existing canonical workload enrollment.
    // The native child receives neither credential nor database connection.
    authorize: async (binding) => {
      try {
        const current = await f.machine.verify(credential);
        return await tx(db, async (c) => {
          const identity = await enrolled(c, current);
          return (
            binding.caller.subject === current.subject &&
            binding.caller.tenant === identity.tenant &&
            binding.module === 'answer' &&
            identity.tenant === 'a' &&
            identity.principal === f.principal &&
            identity.active === true
          );
        });
      } catch {
        return false;
      }
    },
  });
  const request = {
    tenant: 'a',
    computationId: 'journey',
    module: 'answer',
    path: 'run',
    fuel: 100_000,
    memory: 65536,
    timeout: 1000,
    fork: false as const,
  };
  const computation = await nexus.execute(
    credential,
    'bounded-computation',
    1,
    request,
  );
  assert.equal(computation.status, 'LOCAL_RESULT');
  if (computation.status !== 'LOCAL_RESULT')
    assert.fail('native computation failed');
  assert.equal(computation.value, 42);
  assert.equal(computation.scope, 'LOCAL_ONLY_NOT_PROVIDER_OBSERVATION');
  assert.equal(
    (
      await nexus.execute(credential, 'bounded-computation', 1, {
        ...request,
        tenant: 'b',
      })
    ).status,
    'DENIED',
  );

  const ingress = createE2Ingress(context, f.machine);
  const binding = {
    protocol: LOCAL_MODEL_PROTOCOL,
    invocationId: randomUUID(),
    source: ref,
  };
  const scripted = new LocalModelProtocolDouble({
    kind: 'RESPONSE',
    terminal: 'END',
    wire: Buffer.from(
      JSON.stringify({
        ...binding,
        completion: 'COMPLETE',
        proposal: {
          kind: 'UNVERIFIED_TEXT',
          text: 'Synthetic result 42; unverified proposal, not authority.',
        },
      }),
    ),
  });
  const handle = await ingress.recordObservation(
    credential,
    binding,
    await scripted.observe(binding),
  );
  const admission = new AeonGovernedAdmission({ admit: ingress.admit });
  const input = {
    source: ref,
    extractionProtocol: E2_EXTRACTION_PROTOCOL,
    ttlSeconds: 300,
    observationBinding: handle,
  };
  const receipt = await admission.admit(credential, input);
  assert.equal(receipt.authority, false);
  const review = await createE2ReviewIngress(context, f.human).inspect(
    ownerCredential,
    receipt.result,
  );
  assert.equal(review.quarantined, true);
  await assert.rejects(
    context.inspectDerivedProposal(
      { ...owner, expires: Date.now() + 3_600_000, authTime: Date.now() },
      receipt.result,
    ),
  );
  await assert.rejects(
    context.admitDerivedProposal(
      { ...worker, expires: Date.now() + 3_600_000 },
      input,
    ),
  );
  await assert.rejects(context.resolve(worker, receipt.result));
  await assert.rejects(
    context.approve(
      owner,
      receipt.result.id,
      receipt.result.version,
      receipt.result.digest,
      true,
    ),
  );

  // Recreate service objects while keeping PostgreSQL state and VERA identity.
  // This is service-composition restart, not a host/backup-restoration claim.
  context = new ContextService(db, gate);
  const restarted = createE2Ingress(context, f.machine);
  const handle2 = await restarted.recordObservation(
    credential,
    binding,
    await scripted.observe(binding),
  );
  const repeated = await restarted.admit(credential, {
    ...input,
    observationBinding: handle2,
  });
  assert.equal(repeated.receiptId, receipt.receiptId);
  assert.equal(repeated.resultExpires, receipt.resultExpires);
  assert.equal(
    (
      await admin.query(
        'SELECT principal FROM ct.tasks WHERE tenant=$1 AND id=$2',
        ['a', task],
      )
    ).rows[0].principal,
    f.principal,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) n FROM ct.e2_derivation_receipts WHERE tenant=$1 AND result_id=$2',
        ['a', receipt.result.id],
      )
    ).rows[0].n,
    '1',
  );
  assert.equal(f.provider.sends, 0);

  const consoleReads = new ConsoleReads(
    consoleDb,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    'offline-journey',
    fence,
  );
  const ordinaryContext = await consoleReads.read(owner, 'context', {
    id: receipt.result.id,
  });
  assert.equal(
    JSON.stringify(ordinaryContext).includes(receipt.receiptId),
    false,
  );
  assert.equal(
    ordinaryContext.items.length,
    0,
    'ordinary console is not an E2 record-class review surface',
  );

  journalKnown = false;
  await assert.rejects(
    createE2ReviewIngress(context, f.human).inspect(
      ownerCredential,
      receipt.result,
    ),
  );
  await assert.rejects(
    new ContextService(db).inspectDerivedProposal(owner, receipt.result),
  );
  journalKnown = true; // Fixture outage only; restored domains have no reopen path.
  await context.erase(owner, ref.id);
  await assert.rejects(
    restarted.admit(credential, { ...input, observationBinding: handle2 }),
  );
  await assert.rejects(
    createE2ReviewIngress(context, f.human).inspect(
      ownerCredential,
      receipt.result,
    ),
  );
  const deniedRecall = await new RecallService(
    db,
    context,
    f.machine,
    index,
  ).recall(credential, { text: 'stale candidate', limit: 4 });
  assert.equal(deniedRecall.status, 'DEGRADED');
  assert.deepEqual(deniedRecall.hits, []);

  journalKnown = false;
  await assert.rejects(
    createE2ReviewIngress(context, f.human).inspect(
      ownerCredential,
      receipt.result,
    ),
  );
  await assert.rejects(
    new ContextService(db).inspectDerivedProposal(owner, receipt.result),
  );
  await gov.query(
    'UPDATE ct.identities SET active=false,version=version+1 WHERE id=$1',
    ['offline-journey-worker-a'],
  );
  assert.equal(
    (await nexus.execute(credential, 'bounded-computation', 1, request)).status,
    'DENIED',
  );
  assert.equal(f.provider.sends, 0);
});
