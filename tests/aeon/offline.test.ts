import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NativeAeonRanker } from '../../src/aeon/offline-ranker.js';
import {
  AeonReferenceIndex,
  type AeonCandidate,
} from '../../src/aeon/reference-index.js';
import {
  AeonGovernedAdmission,
  AEON_E2_PROTOCOL,
} from '../../src/aeon/governed-admission.js';

const ranker = new NativeAeonRanker(resolve('.artifacts/aeon/ranker'));
const scope = { tenant: 'synthetic-tenant', principal: 'synthetic-vera' };
const query = { text: 'synthetic query; never sent to child', limit: 16 };
const ref = (id: string) => ({ id, version: 1, digest: 'a'.repeat(64) });
const candidate = (
  id: string,
  distance: number,
  neighborWeight = 0,
): AeonCandidate => ({ reference: ref(id), distance, neighborWeight });
function index(items: readonly AeonCandidate[]) {
  return new AeonReferenceIndex({ candidates: async () => items }, ranker);
}

test('exact upstream bytes, not a reimplemented AEON score function', () => {
  const hash = (path: string) =>
    createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(
    hash('vendor/aeon/augmenter.rs'),
    '86f974d75502d9f57c0790dbf3b61253b1dd60114d01d67910de008da5faca8c',
  );
  assert.equal(
    hash('vendor/aeon/LICENSE'),
    '046d505b195d400a42747cc576219b551d2989a302ebd2b2aea5c5d5609db3f9',
  );
});
test('native donor changes rank through co-access bonus, clamps and ties stably', async () => {
  const result = await index([
    candidate('plain', 0.2),
    candidate('promoted', 0.7, 5),
    candidate('tie', 0.1, 1),
  ]).lookup(scope, query);
  assert.deepEqual(result, {
    status: 'AVAILABLE',
    references: [ref('promoted'), ref('tie'), ref('plain')],
  });
  assert.equal('payload' in result, false);
});
test('query limit enforced only after native scoring and sorting', async () => {
  assert.deepEqual(
    await index([candidate('a', 1), candidate('b', 0.9, 5)]).lookup(scope, {
      ...query,
      limit: 1,
    }),
    { status: 'AVAILABLE', references: [ref('b')] },
  );
});
test('empty and maximum-sized input run actual donor without cache', async () => {
  assert.deepEqual(await index([]).lookup(scope, query), {
    status: 'AVAILABLE',
    references: [],
  });
  const items = Array.from({ length: 16 }, (_, i) =>
    candidate(`id${i}`, i / 16),
  );
  assert.equal((await ranker.score(items)).length, 16);
  let calls = 0;
  const local = new AeonReferenceIndex(
    {
      candidates: async (actualScope, actualQuery) => {
        assert.deepEqual(actualScope, scope);
        assert.deepEqual(actualQuery, query);
        calls++;
        return calls === 1 ? [candidate('a', 0.4)] : [];
      },
    },
    ranker,
  );
  assert.equal((await local.lookup(scope, query)).status, 'AVAILABLE');
  assert.deepEqual(await local.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [],
  });
  assert.equal(calls, 2);
});
test('metadata mutation while awaiting rank cannot substitute returned reference', async () => {
  const mutable = candidate('original', 0.4) as any;
  const local = new AeonReferenceIndex(
    { candidates: async () => [mutable] },
    {
      score: async (inputs) => {
        mutable.reference.id = 'substituted';
        mutable.distance = 2;
        return ranker.score(inputs);
      },
    },
  );
  assert.deepEqual(await local.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [ref('original')],
  });
});
test('bad references, scores, duplicates, extra payloads and excessive count refuse atomically', async () => {
  const cases: unknown[] = [
    [candidate('a', NaN)],
    [candidate('a', -1)],
    [candidate('a', 2.1)],
    [candidate('a', 0, Infinity)],
    [candidate('a', 0, 5.1)],
    [candidate('a', 0.4), candidate('a', 0.3)],
    [{ ...candidate('a', 0.3), payload: 'never allowed' }],
    [{ ...candidate('a', 0.3), reference: { ...ref('a'), digest: 'bad' } }],
    Array.from({ length: 17 }, (_, i) => candidate(`id${i}`, 0.1)),
    new Array(1),
  ];
  for (const items of cases)
    assert.deepEqual(
      await index(items as AeonCandidate[]).lookup(scope, query),
      { status: 'UNAVAILABLE' },
    );
});
test('accessors are not invoked at candidate boundary', async () => {
  let touched = false;
  const c = { ...candidate('a', 0.2) };
  Object.defineProperty(c, 'reference', {
    enumerable: true,
    get() {
      touched = true;
      throw Error('no');
    },
  });
  assert.deepEqual(await index([c]).lookup(scope, query), {
    status: 'UNAVAILABLE',
  });
  assert.equal(touched, false);
});
test('malformed scope/query and source/ranker outage never expose partial refs', async () => {
  assert.deepEqual(await index([]).lookup({ ...scope, tenant: '' }, query), {
    status: 'UNAVAILABLE',
  });
  assert.deepEqual(await index([]).lookup(scope, { ...query, limit: 17 }), {
    status: 'UNAVAILABLE',
  });
  const thrown = new AeonReferenceIndex(
    {
      candidates: async () => {
        throw Error('private');
      },
    },
    ranker,
  );
  assert.deepEqual(await thrown.lookup(scope, query), {
    status: 'UNAVAILABLE',
  });
  const missing = new AeonReferenceIndex(
    { candidates: async () => [candidate('a', 0.2)] },
    new NativeAeonRanker('/nonexistent/aeon'),
  );
  assert.deepEqual(await missing.lookup(scope, query), {
    status: 'UNAVAILABLE',
  });
});
test('native bridge rejects malformed numbers and oversize input independently', async () => {
  await assert.rejects(
    ranker.score([{ distance: Infinity, neighborWeight: 0 }]),
  );
  await assert.rejects(
    ranker.score(
      Array.from({ length: 17 }, () => ({ distance: 0, neighborWeight: 0 })),
    ),
  );
  for (const args of [
    ['NaN'],
    ['0.15', 'NaN,0'],
    ['0.15', '0,6'],
    ['0.15', '-1,0'],
    ['0.15', ...Array(17).fill('0,0')],
  ]) {
    assert.throws(() =>
      execFileSync(resolve('.artifacts/aeon/ranker'), args, {
        env: {},
        stdio: 'pipe',
      }),
    );
  }
});
test('malformed child output refuses; fixed trusted path required', async () => {
  assert.throws(() => new NativeAeonRanker('worker-supplied-command'));
  await assert.rejects(
    new NativeAeonRanker('/usr/bin/printf').score([
      { distance: 0.2, neighborWeight: 0 },
    ]),
  );
});
test('E2-only delegation preserves opaque handle and never falls back on denial', async () => {
  // Contract test double, NOT E2 admission/storage qualification.
  const handle = Object.freeze({});
  let calls = 0;
  const admission = new AeonGovernedAdmission({
    admit: async (credential: string, input: any) => {
      calls++;
      assert.equal(credential, 'synthetic');
      assert.equal(input.observationBinding, handle);
      assert.equal(input.extractionProtocol, AEON_E2_PROTOCOL);
      throw Error('canonical E2 denied');
    },
  });
  const input = {
    source: ref('source'),
    extractionProtocol: AEON_E2_PROTOCOL,
    ttlSeconds: 30,
    observationBinding: handle,
  };
  await assert.rejects(
    admission.admit('synthetic', input),
    /canonical E2 denied/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    admission.admit('synthetic', { ...input, ttlSeconds: 0 }),
  );
  await assert.rejects(
    admission.admit('synthetic', {
      ...input,
      extractionProtocol: 'bad' as any,
    }),
  );
  assert.equal(calls, 1);
});
