import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as boundary from '../src/bounded-computation-contract.js';

const {
  BOUNDED_COMPUTATION_V1,
  resolveBoundedComputation,
  requestBoundedComputation,
} = boundary;

const noRuntime = { status: 'DENIED', reason: 'NO_RUNTIME', permanent: false };
const unsupportedInterface = {
  status: 'DENIED',
  reason: 'UNSUPPORTED_INTERFACE',
  permanent: true,
};
const unsupportedVersion = {
  status: 'DENIED',
  reason: 'UNSUPPORTED_VERSION',
  permanent: true,
};

function unreadableInput() {
  const touches: string[] = [];
  const fail = (trap: string): never => {
    touches.push(trap);
    throw Error('opaque input was accessed: ' + trap);
  };
  const input = new Proxy(() => fail('invoke'), {
    get: () => fail('get'),
    set: () => fail('set'),
    has: () => fail('has'),
    ownKeys: () => fail('ownKeys'),
    getOwnPropertyDescriptor: () => fail('getOwnPropertyDescriptor'),
    getPrototypeOf: () => fail('getPrototypeOf'),
    defineProperty: () => fail('defineProperty'),
    deleteProperty: () => fail('deleteProperty'),
    apply: () => fail('apply'),
  });
  return { input, touches };
}

test('v1 records only the accepted vocabulary and discloses missing validation', () => {
  assert.deepEqual(BOUNDED_COMPUTATION_V1, {
    id: 'bounded-computation',
    version: 1,
    allowedRequestFields: [
      'tenant',
      'computationId',
      'module',
      'path',
      'fuel',
      'memory',
      'timeout',
      'fork',
    ],
    implementation: 'RECORDING_AND_DENIAL_ONLY',
    operationalValidation: 'UNSPECIFIED',
    resultScope: 'LOCAL_ONLY_NOT_PROVIDER_OBSERVATION',
  });
});

test('callers cannot alter the recorded id, version, or field vocabulary', () => {
  assert.ok(Object.isFrozen(BOUNDED_COMPUTATION_V1));
  const fields = BOUNDED_COMPUTATION_V1.allowedRequestFields;
  assert.ok(Object.isFrozen(fields));
  assert.equal(Reflect.set(BOUNDED_COMPUTATION_V1, 'id', 'other'), false);
  assert.equal(Reflect.set(BOUNDED_COMPUTATION_V1, 'version', 2), false);
  assert.equal(Reflect.set(fields, '0', 'provider'), false);
  assert.equal(Reflect.set(fields, String(fields.length), 'credential'), false);
  assert.equal(Reflect.deleteProperty(fields, '0'), false);
});

test('the known contract resolves and requests to explicit local NO_RUNTIME denial', () => {
  assert.deepEqual(
    resolveBoundedComputation('bounded-computation', 1),
    noRuntime,
  );
  for (const request of [
    undefined,
    null,
    false,
    '',
    [],
    {},
    Symbol('opaque'),
  ]) {
    assert.deepEqual(
      requestBoundedComputation('bounded-computation', 1, request),
      noRuntime,
    );
  }
});

test('unknown or malformed ids are permanently unsupported, without normalization', () => {
  for (const id of [
    undefined,
    null,
    false,
    1,
    '',
    'other',
    'Bounded-computation',
    'bounded-computation ',
    ['bounded-computation'],
    { id: 'bounded-computation' },
    Symbol('bounded-computation'),
  ]) {
    assert.deepEqual(resolveBoundedComputation(id, 1), unsupportedInterface);
    assert.deepEqual(
      requestBoundedComputation(id, 1, {}),
      unsupportedInterface,
    );
  }
  assert.deepEqual(resolveBoundedComputation('other', 2), unsupportedInterface);
});

test('unknown or malformed versions are permanently unsupported, without coercion', () => {
  for (const version of [
    undefined,
    null,
    false,
    0,
    -1,
    2,
    1.1,
    '1',
    1n,
    NaN,
    Infinity,
    [1],
    { version: 1 },
    Symbol('1'),
  ]) {
    assert.deepEqual(
      resolveBoundedComputation('bounded-computation', version),
      unsupportedVersion,
    );
    assert.deepEqual(
      requestBoundedComputation('bounded-computation', version, {}),
      unsupportedVersion,
    );
  }
});

test('no denial path reads, enumerates, mutates, serializes, or invokes a request', () => {
  const { input, touches } = unreadableInput();
  assert.deepEqual(
    requestBoundedComputation('bounded-computation', 1, input),
    noRuntime,
  );
  assert.deepEqual(
    requestBoundedComputation('other', 1, input),
    unsupportedInterface,
  );
  assert.deepEqual(
    requestBoundedComputation('bounded-computation', 2, input),
    unsupportedVersion,
  );
  assert.deepEqual(touches, []);
});

test('resolving hostile id/version objects never inspects or coerces them', () => {
  const { input, touches } = unreadableInput();
  assert.deepEqual(resolveBoundedComputation(input, 1), unsupportedInterface);
  assert.deepEqual(
    resolveBoundedComputation('bounded-computation', input),
    unsupportedVersion,
  );
  assert.deepEqual(
    requestBoundedComputation(input, input, input),
    unsupportedInterface,
  );
  assert.deepEqual(touches, []);
});

test('fake success and authority/provider/module hooks cannot become effects', () => {
  let calls = 0;
  const forbidden = () => {
    calls++;
    throw Error('a request hook was invoked');
  };
  // Opaque probes, not approved value types, units, or bounds.
  const request = Object.freeze({
    tenant: 'unverified-tenant',
    computationId: 'unverified-computation',
    module: forbidden,
    path: forbidden,
    fuel: forbidden,
    memory: forbidden,
    timeout: forbidden,
    fork: forbidden,
    status: 'COMMITTED',
    verified: true,
    operation: forbidden,
    grant: forbidden,
    approval: forbidden,
    capability: forbidden,
    fact: forbidden,
    credential: forbidden,
    provider: Object.freeze({ send: forbidden, lookup: forbidden }),
  });
  assert.deepEqual(
    requestBoundedComputation('bounded-computation', 1, request),
    noRuntime,
  );
  assert.equal(calls, 0);
});

test('requests stay local and cannot alter or add data to shared denial results', () => {
  for (const [id, version, expected] of [
    ['bounded-computation', 1, noRuntime],
    ['other', 1, unsupportedInterface],
    ['bounded-computation', 2, unsupportedVersion],
  ] as const) {
    const first = requestBoundedComputation(id, version, {
      tenant: 'tenant-a',
    });
    assert.ok(Object.isFrozen(first));
    assert.equal(Reflect.set(first, 'status', 'COMMITTED'), false);
    assert.equal(Reflect.set(first, 'permanent', !first.permanent), false);
    assert.equal(Reflect.set(first, 'tenant', 'tenant-a'), false);
    const second = requestBoundedComputation(id, version, {
      tenant: 'tenant-b',
    });
    assert.strictEqual(first, second);
    assert.deepEqual(second, expected);
  }
});

test('the module exposes metadata and denials, not a runtime or effect adapter', () => {
  assert.deepEqual(Object.keys(boundary).sort(), [
    'BOUNDED_COMPUTATION_V1',
    'requestBoundedComputation',
    'resolveBoundedComputation',
  ]);
});
