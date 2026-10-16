import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  RESTRICTED_MEMORY_CAPS,
  RestrictedMemoryProtocolError,
  validateContextReference,
  validateIndexReply,
  validateRecallQuery,
  validateRecallScope,
  type RecallScope,
} from '../src/restricted-memory-protocol.js';
import { LocalReferenceIndexDouble } from '../internal/fixtures/local-reference-index.js';

const scope: RecallScope = { tenant: 'tenant-a', principal: 'vera-a' };
const query = { text: 'external-name', limit: 16 };
function reference(id = '001:CTX', version = 1, digest = 'c'.repeat(64)) {
  return { id, version, digest };
}
function invalid(
  body: () => unknown,
  code?: RestrictedMemoryProtocolError['code'],
) {
  assert.throws(
    body,
    (error) =>
      error instanceof RestrictedMemoryProtocolError &&
      (code === undefined || error.code === code),
  );
}
async function environment(
  key: string,
  value: string | undefined,
  body: () => unknown | Promise<unknown>,
) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test('E1 scope is explicit opaque tenant plus VERA without header/default/auth claims', () => {
  const value = { tenant: '001|tenant', principal: '  VERA:001  ' };
  assert.deepEqual(validateRecallScope(value), value);
  for (const value of [
    {},
    { tenant: 'tenant-a' },
    { principal: 'vera-a' },
    { ...scope, header: 'other' },
    { ...scope, actor: 'owner' },
    { ...scope, tenant: 1 },
    { ...scope, principal: null },
    { ...scope, tenant: '' },
    { ...scope, principal: ' ' },
    { ...scope, tenant: 'a\nb' },
    { ...scope, principal: '\ud800' },
  ])
    invalid(() => validateRecallScope(value));
});

test('E1 query grammar preserves text and checks UTF8 bytes and integer limits exactly', () => {
  const original = { text: '  e\u0301 stays unchanged  ', limit: 1 };
  assert.deepEqual(validateRecallQuery(original), original);
  for (const text of ['a'.repeat(1024), 'é'.repeat(512)]) {
    assert.equal(Buffer.byteLength(text), RESTRICTED_MEMORY_CAPS.queryBytes);
    assert.equal(validateRecallQuery({ text, limit: 16 }).text, text);
    invalid(
      () => validateRecallQuery({ text: text + 'a', limit: 16 }),
      'QUERY_BOUNDS',
    );
  }
  for (const value of [
    {},
    { ...query, text: '' },
    { ...query, text: '\u00a0 ' },
    { ...query, text: '\udfff' },
    { ...query, text: 'a\0b' },
    { ...query, text: 'a\u0085b' },
    { ...query, limit: 0 },
    { ...query, limit: 17 },
    { ...query, limit: 1.5 },
    { ...query, limit: '16' },
    { ...query, limit: NaN },
    { ...query, tenant: 'other' },
  ])
    invalid(() => validateRecallQuery(value));
});

test('E1 typed references retain identifier spelling and bounded lossless versions', () => {
  for (const id of ['001', '1', 'Aa:._-001', 'A'.repeat(128)]) {
    const input = reference(id, 2147483647);
    assert.deepEqual(validateContextReference(input), input);
    assert(Object.isFrozen(validateContextReference(input)));
  }
  for (const value of [
    null,
    [],
    { ...reference(), id: 1 },
    reference(''),
    reference('a b'),
    reference(' A'),
    reference('A'.repeat(129)),
    reference('é'),
    reference('ctx', 0),
    reference('ctx', -0),
    reference('ctx', -1),
    reference('ctx', 1.1),
    reference('ctx', 2147483648),
    reference('ctx', Number.MAX_SAFE_INTEGER + 1),
    reference('ctx', NaN),
    { ...reference(), version: '1' },
    reference('ctx', 1, 'C'.repeat(64)),
    reference('ctx', 1, 'c'.repeat(63)),
    { ...reference(), tenant: scope.tenant },
    { ...reference(), payload: 'not permitted' },
    { ...reference(), provenance: 'not permitted' },
    { ...reference(), authority: true },
  ])
    invalid(() => validateContextReference(value));
  // A typed number has no raw lexical form; it is not network-wire validation.
  assert.equal(validateContextReference(reference('ctx', 1)).version, 1);
});

test('E1 reply count caps apply before stable exact deduplication', () => {
  const a = reference('a');
  const b = reference('b');
  const input = { status: 'AVAILABLE', references: [b, a, b, a] };
  const result = validateIndexReply(input, { ...query, limit: 4 });
  assert.equal(result.status, 'AVAILABLE');
  if (result.status !== 'AVAILABLE') assert.fail('reference reply');
  assert.deepEqual(result.references, [b, a]);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.references));
  assert(Object.isFrozen(result.references[0]));
  invalid(
    () => validateIndexReply(input, { ...query, limit: 3 }),
    'REPLY_BOUNDS',
  );
  const maximum = { status: 'AVAILABLE', references: Array(16).fill(a) };
  assert.equal(validateIndexReply(maximum, query).status, 'AVAILABLE');
  invalid(
    () =>
      validateIndexReply(
        { status: 'AVAILABLE', references: Array(17).fill(a) },
        query,
      ),
    'REPLY_BOUNDS',
  );
});

test('E1 same ID conflicting version or digest rejects without latest selection', () => {
  for (const other of [reference('a', 2), reference('a', 1, 'd'.repeat(64))])
    invalid(
      () =>
        validateIndexReply(
          { status: 'AVAILABLE', references: [reference('a'), other] },
          query,
        ),
      'CONFLICTING_REFERENCE',
    );
  const separate = validateIndexReply(
    { status: 'AVAILABLE', references: [reference('001'), reference('1')] },
    query,
  );
  assert.equal(separate.status, 'AVAILABLE');
  if (separate.status !== 'AVAILABLE') assert.fail('separate identifiers');
  assert.equal(separate.references.length, 2);
});

test('E1 typed index envelope shape rejects payloads eligibility and unsupported status', () => {
  for (const value of [
    null,
    [],
    {},
    { status: 'UNKNOWN' },
    { status: 'AVAILABLE' },
    { status: 'AVAILABLE', references: null },
    { status: 'AVAILABLE', references: [reference()], payload: 'hidden' },
    {
      status: 'AVAILABLE',
      references: [{ ...reference(), eligibility: true }],
    },
    {
      status: 'AVAILABLE',
      references: [{ ...reference(), producer: 'reader' }],
    },
    { status: 'UNAVAILABLE', references: [] },
    { status: 'UNAVAILABLE', fallback: 'other' },
  ])
    invalid(() => validateIndexReply(value, query));
  assert.deepEqual(validateIndexReply({ status: 'UNAVAILABLE' }, query), {
    status: 'UNAVAILABLE',
  });
  assert.deepEqual(
    validateIndexReply({ status: 'AVAILABLE', references: [] }, query),
    { status: 'AVAILABLE', references: [] },
  );
});

test('E1 encoded typed envelope bound is not a raw network wire or escaping check', () => {
  const maximum = {
    status: 'AVAILABLE',
    references: Array.from({ length: 16 }, (_, i) =>
      reference(String(i).padStart(128, 'A'), 2147483647),
    ),
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(maximum), 'utf8');
  assert(encodedBytes < RESTRICTED_MEMORY_CAPS.encodedEnvelopeBytes);
  assert.equal(RESTRICTED_MEMORY_CAPS.encodedEnvelopeBytes, 16384);
  assert.equal(validateIndexReply(maximum, query).status, 'AVAILABLE');
  // Under this grammar 16 ASCII references cannot reach 16 KiB. Raw whitespace
  // may exceed it before deserialization, but that wire is not an input to E1.
  const raw = ' '.repeat(16385) + JSON.stringify(maximum);
  assert(Buffer.byteLength(raw) > RESTRICTED_MEMORY_CAPS.encodedEnvelopeBytes);
  assert.equal(validateIndexReply(JSON.parse(raw), query).status, 'AVAILABLE');
});

test('E1 data shapes reject getters symbols inherited fallbacks and sparse candidates', () => {
  let accesses = 0;
  const accessor: any = {};
  Object.defineProperty(accessor, 'status', {
    enumerable: true,
    get() {
      accesses++;
      return 'AVAILABLE';
    },
  });
  accessor.references = [];
  invalid(() => validateIndexReply(accessor, query));
  assert.equal(accesses, 0);
  const symbol = { ...reference(), [Symbol('hidden')]: 'not permitted' };
  invalid(() => validateContextReference(symbol));
  const inherited = Object.create(reference());
  invalid(() => validateContextReference(inherited));
  const hidden: any = { ...query };
  Object.defineProperty(hidden, 'tenant', { value: 'other' });
  invalid(() => validateRecallQuery(hidden));
  invalid(() =>
    validateIndexReply({ status: 'AVAILABLE', references: Array(1) }, query),
  );
  const getterArray = [reference()];
  Object.defineProperty(getterArray, '0', {
    enumerable: true,
    get() {
      accesses++;
      return reference();
    },
  });
  invalid(() =>
    validateIndexReply({ status: 'AVAILABLE', references: getterArray }, query),
  );
  assert.equal(accesses, 0);
});

test('E1 local index full tenant VERA alias tuple prevents collisions and defaults', async () => {
  const index = new LocalReferenceIndexDouble();
  const b = { ...scope, tenant: 'tenant-b' };
  const v = { ...scope, principal: 'vera-b' };
  index.seed(scope, query.text, [reference('a')]);
  index.seed(b, query.text, [reference('b')]);
  index.seed(v, query.text, [reference('v')]);
  assert.deepEqual(await index.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [reference('a')],
  });
  assert.deepEqual(await index.lookup(b, query), {
    status: 'AVAILABLE',
    references: [reference('b')],
  });
  assert.deepEqual(await index.lookup(v, query), {
    status: 'AVAILABLE',
    references: [reference('v')],
  });
  const left = { tenant: 'a|b', principal: 'c' };
  const right = { tenant: 'a', principal: 'b|c' };
  index.seed(left, query.text, [reference('left')]);
  index.seed(right, query.text, [reference('right')]);
  assert.notDeepEqual(
    await index.lookup(left, query),
    await index.lookup(right, query),
  );
  index.seed(scope, '001', [reference('one-zero-zero')]);
  index.seed(scope, '1', [reference('one')]);
  assert.notDeepEqual(
    await index.lookup(scope, { ...query, text: '001' }),
    await index.lookup(scope, { ...query, text: '1' }),
  );
  await assert.rejects(index.lookup({ tenant: scope.tenant } as any, query));
  await assert.rejects(
    index.lookup({ ...scope, header: 'other' } as any, query),
  );
  assert.deepEqual(
    await index.lookup({ ...scope, tenant: 'not-seeded' }, query),
    { status: 'AVAILABLE', references: [] },
  );
});

test('E1 local index snapshots references and never truncates a scripted reply', async () => {
  const index = new LocalReferenceIndexDouble();
  const input = [reference('a'), reference('b')];
  index.seed(scope, query.text, input);
  input[0].id = 'mutated';
  input.push(reference('third'));
  assert.deepEqual(await index.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [reference('a'), reference('b')],
  });
  await assert.rejects(
    index.lookup(scope, { ...query, limit: 1 }),
    (error) =>
      error instanceof RestrictedMemoryProtocolError &&
      error.code === 'REPLY_BOUNDS',
  );
  assert.throws(() =>
    index.seed(scope, query.text, Array(17).fill(reference())),
  );
  assert.throws(() =>
    index.seed(scope, query.text, [reference('a'), reference('a', 2)]),
  );
});

test('E1 explicit index loss reset is isolated and never recreates candidate records', async () => {
  const first = new LocalReferenceIndexDouble();
  const independent = new LocalReferenceIndexDouble();
  first.seed(scope, query.text, [reference('a')]);
  independent.seed(scope, query.text, [reference('b')]);
  first.setAvailable(false);
  assert.deepEqual(await first.lookup(scope, query), { status: 'UNAVAILABLE' });
  first.setAvailable(true);
  assert.deepEqual(await first.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [reference('a')],
  });
  first.reset();
  assert.deepEqual(await first.lookup(scope, query), { status: 'UNAVAILABLE' });
  assert.deepEqual(await independent.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [reference('b')],
  });
  first.setAvailable(true);
  assert.deepEqual(await first.lookup(scope, query), {
    status: 'AVAILABLE',
    references: [],
  });
});

test('E1 index fixture guard rejects construction and every method after profile drift', async () => {
  const index = new LocalReferenceIndexDouble();
  for (const [key, value] of [
    ['CT_RUNTIME_ENV', 'production'],
    ['CT_ALLOW_LOCAL_FIXTURES', 'no'],
    ['NODE_ENV', 'production'],
  ]) {
    await environment(key, value, async () => {
      assert.throws(
        () => new LocalReferenceIndexDouble(),
        /explicit isolated local fixture profile required/,
      );
      await assert.rejects(index.lookup(scope, query));
      assert.throws(() => index.seed(scope, query.text, []));
      assert.throws(() => index.reset());
      assert.throws(() => index.setAvailable(true));
    });
  }
});

test('E1 reference protocol has no active recall admission authentication or execution consumer', () => {
  const source = fs.readFileSync('src/restricted-memory-protocol.ts', 'utf8');
  assert(!/from ['"][^'"]*internal\//.test(source));
  assert(!/\b(?:fetch|setTimeout|setInterval|eval)\s*\(/.test(source));
  assert(
    !/from ['"](?:pg|node:(?:fs|http|https|net|child_process))['"]/.test(
      source,
    ),
  );
  assert(
    !/\b(?:enrolled|resolve|ingest|approve|send|exec|spawn|recall)\s*\(/.test(
      source,
    ),
  );
  assert.deepEqual(
    Object.getOwnPropertyNames(LocalReferenceIndexDouble.prototype).sort(),
    ['constructor', 'seed', 'lookup', 'setAvailable', 'reset'].sort(),
  );
  for (const file of [
    'internal/fixtures/local-reference-index.ts',
    'internal/fixtures/local-model-protocol.ts',
  ]) {
    const fixture = fs.readFileSync(file, 'utf8');
    assert(fixture.includes('assertLocalFixtures'));
    assert(
      !/from ['"](?:pg|node:(?:fs|http|https|net|child_process))['"]/.test(
        fixture,
      ),
    );
    assert(
      !/\b(?:fetch|setTimeout|setInterval|ingest|approve|send|exec|spawn)\s*\(/.test(
        fixture,
      ),
    );
  }
});
