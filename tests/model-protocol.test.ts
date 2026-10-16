import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyModel,
  LOCAL_MODEL_PROTOCOL,
  MODEL_PROTOCOL_CAPS,
  validateModelBinding,
  type ModelClassification,
  type ModelObservation,
  type ModelRequestBinding,
} from '../src/model-protocol.js';
import { LocalModelProtocolDouble } from '../internal/fixtures/local-model-protocol.js';

const binding: ModelRequestBinding = {
  protocol: LOCAL_MODEL_PROTOCOL,
  invocationId: '12345678-1234-4123-8123-123456789abc',
  source: { id: '001:CTX', version: 1, digest: 'c'.repeat(64) },
};
function document(text = 'An inert candidate statement.') {
  return {
    protocol: binding.protocol,
    invocationId: binding.invocationId,
    source: { ...binding.source },
    completion: 'COMPLETE',
    proposal: { kind: 'UNVERIFIED_TEXT', text },
  };
}
function response(wire: string | Uint8Array): ModelObservation {
  return {
    kind: 'RESPONSE',
    terminal: 'END',
    wire: typeof wire === 'string' ? Buffer.from(wire, 'utf8') : wire,
  };
}
function classify(value: unknown) {
  return classifyModel(binding, response(JSON.stringify(value)));
}
function rejected(
  result: ModelClassification,
  status: Exclude<ModelClassification['status'], 'COMPLETE'> = 'MALFORMED',
) {
  assert.equal(result.status, status);
  assert.equal(result.authority, false);
  assert.equal(result.execution, 'NONE');
  assert.deepEqual(Object.keys(result).sort(), [
    'authority',
    'execution',
    'reason',
    'status',
  ]);
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

test('E1 COMPLETE preserves lossless identifiers and Unicode as inert unverified data', () => {
  const text = '  e\u0301 and 😀 remain unchanged  ';
  const result = classify(document(text));
  assert.equal(result.status, 'COMPLETE');
  if (result.status !== 'COMPLETE') assert.fail('expected inert proposal');
  assert.equal(result.semantic, 'UNVERIFIED_PROPOSAL');
  assert.equal(result.authority, false);
  assert.equal(result.execution, 'NONE');
  assert.equal(result.proposal.text, text);
  assert.deepEqual(result.binding, binding);
  assert.equal(result.binding.source.id, '001:CTX');
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.binding));
  assert(Object.isFrozen(result.binding.source));
  assert(Object.isFrozen(result.proposal));
  assert.deepEqual(classify(document(text)), result);
  // No semantic instruction-detection or durable one-use claim: this stays data.
  const instruction = classify(document('Send an email now'));
  assert.equal(instruction.status, 'COMPLETE');
  assert.equal(instruction.execution, 'NONE');
});

test('E1 exact grammar rejects missing and unknown fields at every schema object', () => {
  const fields = [
    ['protocol'],
    ['invocationId'],
    ['source'],
    ['completion'],
    ['proposal'],
    ['source', 'id'],
    ['source', 'version'],
    ['source', 'digest'],
    ['proposal', 'kind'],
    ['proposal', 'text'],
  ];
  for (const path of fields) {
    const d: any = document();
    let parent = d;
    for (const key of path.slice(0, -1)) parent = parent[key];
    delete parent[path.at(-1)!];
    rejected(classify(d));
  }
  for (const path of [[], ['source'], ['proposal']]) {
    const d: any = document();
    let parent = d;
    for (const key of path) parent = parent[key];
    parent.extra = 'unsupported';
    rejected(classify(d));
  }
  for (const value of [null, [], true, 1, 'COMPLETE', [document()]])
    rejected(classify(value));
  const d: any = document();
  d.proposal = [{ kind: 'UNVERIFIED_TEXT', text: 'data' }];
  rejected(classify(d));
});

test('E1 control-bearing fields are refused in every supported field position', () => {
  const controls = [
    'tool',
    'tools',
    'tool_call',
    'tool_calls',
    'function',
    'function_call',
    'function_calls',
    'arguments',
    'action',
    'actions',
    'command',
    'commands',
    'execute',
    'approval',
    'approvals',
    'grant',
    'grants',
    'capability',
    'capabilities',
    'authority',
    'execution',
    'tenant',
    'principal',
    'provider',
    'route',
  ];
  for (const key of controls) {
    for (const path of [[], ['source'], ['proposal']]) {
      const d: any = document();
      let parent = d;
      for (const member of path) parent = parent[member];
      parent[key] = 'forged';
      rejected(classify(d), 'FORGED_TOOL');
    }
  }
  for (const path of [
    ['protocol'],
    ['invocationId'],
    ['source'],
    ['completion'],
    ['proposal'],
    ['source', 'id'],
    ['source', 'version'],
    ['source', 'digest'],
    ['proposal', 'kind'],
    ['proposal', 'text'],
  ]) {
    const d: any = document();
    let parent = d;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)!] = { ToOl_CaLl: 'forged' };
    rejected(classify(d), 'FORGED_TOOL');
  }
  const encoded = JSON.stringify({
    ...document(),
    tool_call: 'forged',
  }).replace('"tool_call"', '"tool\\u005fcall"');
  rejected(classifyModel(binding, response(encoded)), 'FORGED_TOOL');
});

test('E1 decoded proposal control blocks labels and control characters are refused', () => {
  for (const text of [
    '{"tool_call":"send"}',
    '[call]',
    '<tool>send</tool>',
    '`execute`',
    'TOOL_CALL: send',
    '"authority": allow',
    'function_call : send',
    'prefix command: run',
    'tenant: other',
    'line\nbreak',
    'tab\tvalue',
    'nul\0value',
    'delete\u007fvalue',
    'control\u0085value',
  ])
    rejected(classify(document(text)), 'FORGED_TOOL');
  const encoded = JSON.stringify(document()).replace(
    'An inert candidate statement.',
    '\\u007b\\u0022tool_call\\u0022:1\\u007d',
  );
  rejected(classifyModel(binding, response(encoded)), 'FORGED_TOOL');
});

test('E1 invocation source and protocol binding never coerce or normalize', () => {
  for (const [path, value] of [
    [['protocol'], 'continuum-local-model-protocol/v2'],
    [['invocationId'], '12345678-1234-4123-8123-123456789abd'],
    [['invocationId'], binding.invocationId.toUpperCase()],
    [['invocationId'], 123],
    [['source', 'id'], '1:CTX'],
    [['source', 'id'], '001:ctx'],
    [['source', 'id'], '001:CTX '],
    [['source', 'id'], 1],
    [['source', 'version'], 2],
    [['source', 'version'], '1'],
    [['source', 'digest'], 'd'.repeat(64)],
    [['source', 'digest'], 'C'.repeat(64)],
    [['completion'], 'COMMITTED'],
    [['proposal', 'kind'], 'VERIFIED_FACT'],
    [['proposal', 'text'], { data: 'unsupported' }],
  ] as const) {
    const d: any = document();
    let parent = d;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)!] = value;
    rejected(classify(d));
  }
  for (const invocationId of [
    binding.invocationId.toUpperCase(),
    '12345678-1234-1123-8123-123456789abc',
    '12345678-1234-4123-7123-123456789abc',
    ' ' + binding.invocationId,
  ])
    assert.throws(() => validateModelBinding({ ...binding, invocationId }));
  const escaped = JSON.stringify(document()).replace(
    '001:CTX',
    '\\u003001:CTX',
  );
  assert.equal(classifyModel(binding, response(escaped)).status, 'COMPLETE');
});

test('E1 wire versions require canonical bounded integer lexemes without rounding', () => {
  const wire = JSON.stringify(document());
  for (const lexeme of [
    '0',
    '-0',
    '-1',
    '1.0',
    '1e0',
    '1E+0',
    '01',
    '2147483648',
    '9007199254740993',
    '1e999',
    '"1"',
    'true',
    'null',
  ])
    rejected(
      classifyModel(
        binding,
        response(wire.replace('"version":1', `"version":${lexeme}`)),
      ),
    );
  const maximum: ModelRequestBinding = {
    ...binding,
    source: { ...binding.source, version: 2147483647 },
  };
  const d = document();
  d.source.version = maximum.source.version;
  assert.equal(
    classifyModel(maximum, response(JSON.stringify(d))).status,
    'COMPLETE',
  );
  const id128 = 'A'.repeat(128);
  const maxId: ModelRequestBinding = {
    ...binding,
    source: { ...binding.source, id: id128 },
  };
  const idDocument = { ...document(), source: { ...maxId.source } };
  assert.equal(
    classifyModel(maxId, response(JSON.stringify(idDocument))).status,
    'COMPLETE',
  );
  rejected(
    classifyModel(
      { ...maxId, source: { ...maxId.source, id: id128 + 'A' } },
      response(JSON.stringify(idDocument)),
    ),
  );
});

test('E1 duplicate decoded keys including escaped aliases cannot be overwritten', () => {
  const wire = JSON.stringify(document());
  for (const malformed of [
    wire.replace('"protocol":', `"protocol":"${binding.protocol}","protocol":`),
    wire.replace('"source":', '"source":{},"sour\\u0063e":'),
    wire.replace('"id":', `"id":"other","\\u0069d":`),
    wire.replace('"text":', '"text":"prefix","te\\u0078t":'),
    wire.replace('"version":', '"version":2,"version":'),
    wire.replace('"kind":', '"kind":"UNVERIFIED_TEXT","kind":'),
  ])
    rejected(classifyModel(binding, response(malformed)));
});

test('E1 fatal UTF8 BOM and lone-surrogate escapes cannot become replacement data', () => {
  const wire = Buffer.from(JSON.stringify(document()), 'utf8');
  for (const bytes of [
    Uint8Array.of(0xc0, 0xaf),
    Uint8Array.of(0xff),
    Uint8Array.of(0xed, 0xa0, 0x80),
    Buffer.concat([Uint8Array.of(0xef, 0xbb, 0xbf), wire]),
  ])
    rejected(classifyModel(binding, response(bytes)));
  for (const escaped of ['\\ud800', '\\udfff', '\\ud800x', 'x\\udfff'])
    rejected(
      classifyModel(
        binding,
        response(
          JSON.stringify(document()).replace(
            'An inert candidate statement.',
            escaped,
          ),
        ),
      ),
    );
  const pair = JSON.stringify(document()).replace(
    'An inert candidate statement.',
    '\\ud83d\\ude00',
  );
  assert.equal(classifyModel(binding, response(pair)).status, 'COMPLETE');
});

test('E1 comments wrappers trailing documents and trailing commas reject whole response', () => {
  const wire = JSON.stringify(document());
  for (const malformed of [
    '```json\n' + wire + '\n```',
    '// comment\n' + wire,
    '/* comment */' + wire,
    wire + '{}',
    wire + ' trailing',
    wire.slice(0, -1) + ',}',
    '{' + wire,
    '',
    ' ',
    '\ufeff' + wire,
    ' \ufeff' + wire,
  ])
    rejected(classifyModel(binding, response(malformed)));
  assert.equal(
    classifyModel(binding, response('\r\n\t ' + wire + '\n ')).status,
    'COMPLETE',
  );
});

test('E1 raw model wire cap checks bytes at boundary and boundary plus one', () => {
  const wire = JSON.stringify(document());
  const padding = MODEL_PROTOCOL_CAPS.wireBytes - Buffer.byteLength(wire);
  const maximum = wire + ' '.repeat(padding);
  assert.equal(Buffer.byteLength(maximum), 32768);
  assert.equal(classifyModel(binding, response(maximum)).status, 'COMPLETE');
  const result = classifyModel(binding, response(maximum + ' '));
  rejected(result);
  if (result.status === 'COMPLETE') assert.fail('expected wire bound');
  assert.equal(result.reason, 'WIRE_BOUNDS');
});

test('E1 single proposal text cap counts decoded UTF8 bytes and never truncates', () => {
  for (const text of ['a'.repeat(4096), 'é'.repeat(2048)]) {
    assert.equal(
      Buffer.byteLength(text),
      MODEL_PROTOCOL_CAPS.proposalTextBytes,
    );
    const result = classify(document(text));
    assert.equal(result.status, 'COMPLETE');
    if (result.status !== 'COMPLETE') assert.fail('expected full text');
    assert.equal(result.proposal.text, text);
    rejected(classify(document(text + 'a')));
  }
  for (const text of ['', ' ', '\u00a0', ' '.repeat(4096)])
    rejected(classify(document(text)));
});

test('E1 parser depth and node caps are enforced before schema acceptance', () => {
  const depth4 = '{"x":{"x":{"x":null}}}';
  const depth5 = '{"x":{"x":{"x":{"x":null}}}}';
  const withinDepth = classifyModel(binding, response(depth4));
  const overDepth = classifyModel(binding, response(depth5));
  rejected(withinDepth);
  rejected(overDepth);
  if (withinDepth.status === 'COMPLETE' || overDepth.status === 'COMPLETE')
    assert.fail('not the response schema');
  assert.equal(withinDepth.reason, 'SCHEMA_OR_BINDING');
  assert.equal(overDepth.reason, 'JSON_BOUNDS');
  // Count values/containers, not object keys: root array + 127 nulls = 128.
  const withinNodes = classifyModel(
    binding,
    response(JSON.stringify(Array(127).fill(null))),
  );
  const overNodes = classifyModel(
    binding,
    response(JSON.stringify(Array(128).fill(null))),
  );
  rejected(withinNodes);
  rejected(overNodes);
  if (withinNodes.status === 'COMPLETE' || overNodes.status === 'COMPLETE')
    assert.fail('arrays are unsupported responses');
  assert.equal(withinNodes.reason, 'SCHEMA_OR_BINDING');
  assert.equal(overNodes.reason, 'JSON_BOUNDS');
});

test('E1 transport outage partial and limit cannot be upgraded or salvage a proposal', () => {
  const wire = response(JSON.stringify(document()));
  rejected(classifyModel(binding, { kind: 'OUTAGE' }), 'OUTAGE');
  for (const [terminal, status] of [
    ['PARTIAL', 'PARTIAL'],
    ['LIMIT', 'TRUNCATED'],
  ] as const) {
    assert.equal(wire.kind, 'RESPONSE');
    if (wire.kind !== 'RESPONSE') assert.fail('response');
    rejected(classifyModel(binding, { ...wire, terminal }), status);
    rejected(
      classifyModel(binding, {
        kind: 'RESPONSE',
        terminal,
        wire: Uint8Array.of(0xff),
      }),
      status,
    );
  }
  rejected(
    classifyModel(binding, {
      ...wire,
      terminal: 'UNKNOWN',
    } as unknown as ModelObservation),
  );
  rejected(
    classifyModel(binding, { kind: 'OUTAGE', proposal: document() } as any),
  );
  let accesses = 0;
  const accessor: any = {};
  Object.defineProperty(accessor, 'kind', {
    enumerable: true,
    get() {
      accesses++;
      return 'OUTAGE';
    },
  });
  rejected(classifyModel(binding, accessor));
  assert.throws(() => new LocalModelProtocolDouble(accessor));
  assert.equal(accesses, 0);
});

test('E1 local model double snapshots scripted observations without retry or fallback', async () => {
  const input = response(JSON.stringify(document()));
  const double = new LocalModelProtocolDouble(input);
  assert.equal(input.kind, 'RESPONSE');
  if (input.kind !== 'RESPONSE') assert.fail('response');
  input.wire.fill(0);
  const first = await double.observe(binding);
  assert.equal(classifyModel(binding, first).status, 'COMPLETE');
  assert.equal(first.kind, 'RESPONSE');
  if (first.kind !== 'RESPONSE') assert.fail('scripted response');
  first.wire.fill(0);
  assert.equal(
    classifyModel(binding, await double.observe(binding)).status,
    'COMPLETE',
  );
  assert.equal(double.observations, 2);
  double.setObservation({
    kind: 'RESPONSE',
    terminal: 'PARTIAL',
    wire: Buffer.from(JSON.stringify(document())),
  });
  rejected(classifyModel(binding, await double.observe(binding)), 'PARTIAL');
  assert.equal(double.observations, 3);
  double.reset();
  rejected(classifyModel(binding, await double.observe(binding)), 'OUTAGE');
  assert.equal(double.observations, 4);
  assert.throws(() =>
    double.setObservation({
      kind: 'RESPONSE',
      terminal: 'END',
      wire: new Uint8Array(MODEL_PROTOCOL_CAPS.wireBytes + 1),
    }),
  );
});

test('E1 model fixture guard rejects nonlocal construction and later profile changes', async () => {
  const double = new LocalModelProtocolDouble({ kind: 'OUTAGE' });
  for (const [key, value] of [
    ['CT_RUNTIME_ENV', 'production'],
    ['CT_ALLOW_LOCAL_FIXTURES', 'no'],
    ['NODE_ENV', 'production'],
  ]) {
    await environment(key, value, async () => {
      assert.throws(
        () => new LocalModelProtocolDouble({ kind: 'OUTAGE' }),
        /explicit isolated local fixture profile required/,
      );
      await assert.rejects(
        double.observe(binding),
        /explicit isolated local fixture profile required/,
      );
      assert.throws(() => double.reset());
      assert.throws(() => double.setObservation({ kind: 'OUTAGE' }));
      assert.throws(() => double.observations);
    });
  }
});

test('E1 pure model source has no gateway executor admission or fixture fallback import', () => {
  const source = fs.readFileSync('src/model-protocol.ts', 'utf8');
  assert(!/from ['"][^'"]*internal\//.test(source));
  assert(!/\b(?:fetch|setTimeout|setInterval|eval)\s*\(/.test(source));
  assert(
    !/from ['"](?:pg|node:(?:fs|http|https|net|child_process))['"]/.test(
      source,
    ),
  );
  assert(
    !/\b(?:ingest|approve|send|exec|spawn|admitExtraction)\s*\(/.test(source),
  );
  assert.deepEqual(
    Object.getOwnPropertyNames(LocalModelProtocolDouble.prototype).sort(),
    [
      'constructor',
      'observations',
      'observe',
      'reset',
      'setObservation',
    ].sort(),
  );
});

test('E1 actual byte bounds cannot be hidden by typed-array properties', () => {
  const text = JSON.stringify(document());
  const bytes = Buffer.from(
    text +
      ' '.repeat(
        MODEL_PROTOCOL_CAPS.wireBytes + 1 - Buffer.byteLength(text, 'utf8'),
      ),
  );
  assert.equal(bytes.byteLength, MODEL_PROTOCOL_CAPS.wireBytes + 1);
  rejected(classifyModel(binding, response(bytes)));
  const hiddenLength = new Uint8Array(bytes);
  Object.defineProperty(hiddenLength, 'byteLength', { value: 0 });
  rejected(classifyModel(binding, response(hiddenLength)));
  assert.throws(
    () => new LocalModelProtocolDouble(response(hiddenLength)),
    /local model observation bounds/,
  );
});

test('E1 typed transport proxies refuse safely and carrier accessors stay inert', async () => {
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(document())));
  rejected(classifyModel(binding, response(new Proxy(bytes, {}))));
  let accesses = 0;
  const trapped = new Proxy(bytes, {
    get() {
      accesses++;
      throw Error('carrier get trap');
    },
    getPrototypeOf() {
      accesses++;
      throw Error('carrier prototype trap');
    },
  });
  rejected(classifyModel(binding, response(trapped)));
  assert.throws(
    () => new LocalModelProtocolDouble(response(trapped)),
    /local model observation bounds/,
  );
  assert.equal(accesses, 0);
  for (const key of [
    'byteLength',
    'byteOffset',
    'buffer',
    'length',
    'constructor',
    Symbol.toStringTag,
  ]) {
    Object.defineProperty(bytes, key, {
      get() {
        accesses++;
        throw Error('carrier accessor');
      },
    });
  }
  assert.equal(classifyModel(binding, response(bytes)).status, 'COMPLETE');
  const double = new LocalModelProtocolDouble(response(bytes));
  assert.equal(
    classifyModel(binding, await double.observe(binding)).status,
    'COMPLETE',
  );
  assert.equal(accesses, 0);
  assert.equal(double.observations, 1);
});

test('E1 observation inspection exceptions become a failure classification', () => {
  const revoked = Proxy.revocable(response(JSON.stringify(document())), {});
  revoked.revoke();
  rejected(classifyModel(binding, revoked.proxy));
  const trapped = new Proxy(response(JSON.stringify(document())), {
    getPrototypeOf() {
      throw Error('private observation error must not be echoed');
    },
  });
  rejected(classifyModel(binding, trapped));
  const result = classifyModel(binding, trapped);
  assert.notEqual(result.status, 'COMPLETE');
  if (result.status === 'COMPLETE') assert.fail('unexpected proposal');
  assert.equal(result.reason, 'OBSERVATION');
  assert.equal(classify(document()).status, 'COMPLETE');
});

test('E1 legitimate sliced carriers are bounded by view extent not backing storage', async () => {
  const body = Buffer.from(JSON.stringify(document()), 'utf8');
  const backing = new Uint8Array(MODEL_PROTOCOL_CAPS.wireBytes * 3);
  backing.fill(0x20);
  backing.set(body, 256);
  const small = new Uint8Array(backing.buffer, 256, body.byteLength);
  assert(backing.byteLength > MODEL_PROTOCOL_CAPS.wireBytes);
  assert.equal(classifyModel(binding, response(small)).status, 'COMPLETE');
  const boundary = new Uint8Array(
    backing.buffer,
    256,
    MODEL_PROTOCOL_CAPS.wireBytes,
  );
  assert.equal(classifyModel(binding, response(boundary)).status, 'COMPLETE');
  const over = new Uint8Array(
    backing.buffer,
    256,
    MODEL_PROTOCOL_CAPS.wireBytes + 1,
  );
  rejected(classifyModel(binding, response(over)));
  const double = new LocalModelProtocolDouble(response(small));
  assert.equal(
    classifyModel(binding, await double.observe(binding)).status,
    'COMPLETE',
  );
  assert.throws(
    () => double.setObservation(response(over)),
    /local model observation bounds/,
  );
});
