import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pool, tx } from '../src/db.js';
import { ModelConnectionService } from '../src/model-connection-service.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence } from './helpers.js';
import { ConsoleCommands } from '../src/console/commands.js';
import {
  geminiUrl,
  liveGeminiTransport,
  modelsFromList,
  textFromGenerate,
  type GeminiTransport,
} from '../src/gemini-text.js';
import { openCredential } from '../src/model-credential.js';
import type { HumanCommand } from '../src/console/contracts.js';

const prefix = 'model-' + randomBytes(4).toString('hex');
const key = 'AIza' + 'model-connection-test-key-value';
process.env.CT_MODEL_CREDENTIAL_KEK = Buffer.alloc(32, 3).toString('base64');
let f: Awaited<ReturnType<typeof fixture>>;
let writeDb: pg.Pool;
let commands: ConsoleCommands;
let calls = 0;

class MockGemini implements GeminiTransport {
  readonly mock = true;
  mode:
    | 'ok'
    | 'invalid'
    | 'limit'
    | 'malformed'
    | 'timeout'
    | 'tool'
    | 'uncertain'
    | 'body'
    | 'transport' = 'ok';
  gate: Promise<void> | null = null;
  lastGenerate: {
    maxOutputTokens: number;
    maxResponseBytes: number;
  } | null = null;
  async listModels(apiKey: string) {
    calls += 1;
    if (apiKey !== key) throw Error('gemini key rejected');
    if (this.mode === 'malformed') throw Error('gemini model list malformed');
    if (this.mode === 'limit') throw Error('gemini rate limited');
    if (this.mode === 'timeout') throw Error('The operation was aborted');
    return modelsFromList({
      models: [
        {
          name: 'models/mock-text',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/mock-alt',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    });
  }
  async generate(input: {
    apiKey: string;
    model: string;
    text: string;
    timeoutMs: number;
    maxOutputTokens: number;
    maxResponseBytes: number;
  }) {
    if (this.gate) await this.gate;
    assert.ok(input.maxOutputTokens >= 1);
    assert.ok(input.maxResponseBytes >= 256);
    calls += 1;
    this.lastGenerate = {
      maxOutputTokens: input.maxOutputTokens,
      maxResponseBytes: input.maxResponseBytes,
    };
    assert.equal(input.apiKey, key);
    assert.ok(
      input.model === 'models/mock-text' || input.model === 'models/mock-alt',
    );
    if (this.mode === 'invalid') throw Error('gemini key rejected');
    if (this.mode === 'transport') throw Error('gemini provider error');
    if (this.mode === 'body') throw Error('gemini response too large');
    if (this.mode === 'tool') throw Error('gemini tool rejected');
    if (this.mode === 'timeout') throw Error('The operation was aborted');
    if (this.mode === 'malformed') throw Error('gemini response malformed');
    if (this.mode === 'limit') throw Error('gemini rate limited');
    const hostile = '<img src=x onerror=alert(1)>';
    return textFromGenerate({
      candidates: [
        { content: { parts: [{ text: input.text + ' ' + hostile }] } },
      ],
      ...(this.mode === 'uncertain'
        ? {}
        : { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } }),
    });
  }
}
const mock = new MockGemini();

function command(
  kind: HumanCommand['kind'],
  target: string,
  input: Record<string, unknown>,
  idempotency = randomBytes(8).toString('hex'),
): HumanCommand {
  return {
    schema_version: 1 as const,
    idempotency_key: idempotency,
    kind,
    target,
    expected_version: 0,
    input,
  };
}

before(async () => {
  spawnSync(
    'psql',
    [
      '-d',
      'ct_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'migrations/023-gemini-connections.sql',
    ],
    { encoding: 'utf8' },
  );
  f = await fixture(prefix);
  writeDb = pool('ct_authority_api');
  commands = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    fence,
    'LOCAL_FIXTURE',
  );
  commands.useTransport(mock);
});
after(async () => {
  if (f) await f.close();
  await writeDb?.end();
  await admin.end();
});

test('an existing database keeps tasks and VERA profiles when the connection migration is applied', () => {
  const database = 'ct_provider_read_test';
  const psql = (args: string[]) =>
    spawnSync('psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8',
    });
  spawnSync('dropdb', ['--if-exists', database], { encoding: 'utf8' });
  assert.equal(
    spawnSync('createdb', [database], { encoding: 'utf8' }).status,
    0,
  );
  const listed = readFileSync(
    'tools/apply-console-migrations.sh',
    'utf8',
  ).match(/for m in ([^;]+);do/);
  assert.ok(listed);
  const files = listed[1].trim().split(/\s+/);
  assert.equal(files.at(-1), '023-gemini-connections.sql');
  for (const file of files) {
    if (file === '019-task-mandate-admission.sql') break;
    assert.equal(psql(['-f', `migrations/${file}`]).status, 0, file);
  }
  assert.equal(
    psql([
      '-c',
      `INSERT INTO ct.tenants VALUES('a') ON CONFLICT DO NOTHING;
       INSERT INTO ct.principals(tenant,id,epoch,generation,active) VALUES('a','kept-vera',1,1,true);
       INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,domain_role) VALUES('kept-owner','iss','sub','aud','user','a','owner');
       INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by) VALUES('a','kept-task','kept-vera','Keep this task',now()+interval '1 day','kept-owner');`,
    ]).status,
    0,
  );
  let apply = false;
  for (const file of files) {
    if (file === '019-task-mandate-admission.sql') apply = true;
    if (!apply || file === '023-gemini-connections.sql') continue;
    assert.equal(psql(['-f', `migrations/${file}`]).status, 0, file);
  }
  assert.equal(
    psql([
      '-c',
      `INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest)
       VALUES('a','kept-vera','Kept','Existing profile',1,'kept-owner','${'ab'.repeat(32)}');`,
    ]).status,
    0,
  );
  const before = psql([
    '-Atc',
    `SELECT id||objective||revision::text FROM ct.tasks ORDER BY id;
     SELECT id||name||description||revision::text FROM ct.vera_profiles ORDER BY id;`,
  ]).stdout;
  assert.match(before, /kept-task/);
  assert.match(before, /Kept/);
  assert.equal(psql(['-f', 'migrations/023-gemini-connections.sql']).status, 0);
  const afterRows = psql([
    '-Atc',
    `SELECT id||objective||revision::text FROM ct.tasks ORDER BY id;
     SELECT id||name||description||revision::text FROM ct.vera_profiles ORDER BY id;`,
  ]).stdout;
  assert.equal(afterRows, before);
  assert.match(
    psql(['-Atc', "SELECT to_regclass('ct.model_connections')"]).stdout,
    /model_connections/,
  );
  spawnSync('dropdb', ['--if-exists', database], { encoding: 'utf8' });
});

test('gemini requests stay on the fixed Google origin', async () => {
  assert.equal(
    geminiUrl('/v1beta/models').origin,
    'https://generativelanguage.googleapis.com',
  );
  assert.throws(() => geminiUrl('https://evil.example/v1beta/models'));
  assert.throws(() => geminiUrl('/v1beta/models?key=secret'));
  assert.equal(process.env.CT_ENABLE_GEMINI, undefined);
  assert.throws(() => liveGeminiTransport(), /gemini live calls disabled/);
  const seen: RequestInit[] = [];
  process.env.CT_ENABLE_GEMINI = 'yes';
  try {
    const transport = liveGeminiTransport(async (url, init) => {
      seen.push(init);
      assert.equal(url.origin, 'https://generativelanguage.googleapis.com');
      assert.equal(url.search, '');
      const headers = init.headers as Record<string, string>;
      assert.equal(headers['x-goog-api-key'], 'stub-key');
      return {
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'models/mock-text',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      };
    });
    const models = await transport.listModels('stub-key');
    assert.equal(models[0].name, 'models/mock-text');
    assert.equal(seen[0].redirect, 'error');
    const generated = liveGeminiTransport(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.generationConfig.maxOutputTokens, 8);
      assert.equal(String(init.body).includes('stub-key'), false);
      return {
        status: 200,
        arrayBuffer: async () => new Uint8Array(300).buffer,
        json: async () => {
          throw Error('body was read after the byte cap');
        },
      };
    });
    await assert.rejects(
      generated.generate({
        apiKey: 'stub-key',
        model: 'models/mock-text',
        text: 'hi',
        timeoutMs: 1000,
        maxOutputTokens: 8,
        maxResponseBytes: 256,
      }),
      /gemini response too large/,
    );
  } finally {
    delete process.env.CT_ENABLE_GEMINI;
  }
});

test('a sealed key never enters the command journal, evidence, or error text', async () => {
  const owner = await f.actor('user');
  const id = prefix + '-connection';
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await commands.execute(
      owner,
      command('create_model_connection', id, { name: 'Desk Gemini' }),
    );
    const sealed = await commands.sealModelCredential(owner, id, key);
    assert.equal(sealed.sealed, true);
    assert.equal(JSON.stringify(sealed).includes(key), false);
    await assert.rejects(
      commands.execute(
        owner,
        command('create_model_connection', id + '-x', { apiKey: key }),
      ),
      /command secret rejected/,
    );
  } finally {
    console.error = original;
  }
  const stored = (
    await admin.query(
      `SELECT encode(ciphertext,'escape') AS bytes FROM ct.model_connection_secrets WHERE connection_id=$1`,
      [id],
    )
  ).rows[0];
  assert.equal(String(stored.bytes).includes(key), false);
  const sealedRow = (
    await admin.query(
      'SELECT nonce,ciphertext,key_version FROM ct.model_connection_secrets WHERE connection_id=$1',
      [id],
    )
  ).rows[0];
  const opened = openCredential({
    nonce: sealedRow.nonce,
    ciphertext: sealedRow.ciphertext,
    keyVersion: Number(sealedRow.key_version),
  });
  assert.equal(opened, key);
  const journal = (
    await admin.query(
      `SELECT coalesce(result::text,'')||coalesce(error_code,'') AS text FROM ct.console_commands WHERE tenant='a'`,
    )
  ).rows
    .map((row) => row.text)
    .join('\n');
  const evidence = (
    await admin.query(`SELECT payload FROM ct.evidence_events WHERE tenant='a'`)
  ).rows
    .map((row) => row.payload)
    .join('\n');
  assert.equal(journal.includes(key), false);
  assert.equal(evidence.includes(key), false);
  assert.equal(logs.join('\n').includes(key), false);
});

test('mock tests stay pending and enforce text limits without a spending cap', async () => {
  const owner = await f.actor('user');
  const id = prefix + '-connection';
  await commands.execute(
    owner,
    command('set_model_connection_limits', id, {
      maxRequests: 10,
      maxInputChars: 1000,
      maxOutputChars: 1000,
      maxOutputTokens: 64,
      maxResponseBytes: 4096,
      maxConcurrent: 1,
      timeoutMs: 2000,
    }),
  );
  const before = calls;
  const tested = await commands.execute(
    owner,
    command('test_model_connection', id, {}),
  );
  assert.equal(tested.status, 'APPLIED');
  const result = tested.result as Record<string, unknown>;
  assert.equal(result.liveVerified, false);
  assert.equal(result.verification, 'mock-tested / live test pending');
  assert.equal(result.spendingCap, false);
  assert.equal(calls, before + 1);
  await commands.execute(
    owner,
    command('select_model_connection_model', id, { model: 'models/mock-text' }),
  );
  const unsupported = await commands.execute(
    owner,
    command('select_model_connection_model', id, {
      model: 'models/not-listed',
    }),
  );
  assert.equal(unsupported.status, 'DENIED');
  const vera = prefix + '-vera';
  await commands.execute(
    owner,
    command('create_vera', vera, {
      name: 'Connected',
      description: 'Profile stays a profile.',
    }),
  );
  await commands.execute(
    owner,
    command('assign_model_connection', id, { principal: vera }),
  );
  const hostile = await commands.execute(
    owner,
    command('try_vera_text', id, {
      principal: vera,
      text: 'Say hello',
    }),
  );
  assert.equal(hostile.status, 'APPLIED', JSON.stringify(hostile.result));
  const answer = hostile.result as Record<string, string>;
  assert.equal(answer.authority, false);
  assert.match(String(answer.text), /<img src=x onerror=alert\(1\)>/);
  assert.equal(String(answer.text).includes(key), false);
  const again = calls;
  const replayKey = 'replay-' + prefix;
  await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Once' }, replayKey),
  );
  await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Once' }, replayKey),
  );
  assert.equal(calls, again + 1);
  mock.mode = 'uncertain';
  const uncertain = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Maybe' }),
  );
  assert.equal((uncertain.result as { outcome: string }).outcome, 'UNCERTAIN');
  mock.mode = 'limit';
  const limited = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Stop' }),
  );
  assert.equal((limited.result as { outcome: string }).outcome, 'RATE_LIMIT');
  mock.mode = 'ok';
  const other = await f.actor('user', 'b');
  const denied = await commands.execute(
    other,
    command('assign_model_connection', id, { principal: vera }),
  );
  assert.equal(denied.status, 'DENIED');
  const label = (
    await admin.query(
      'SELECT verification_label FROM ct.model_connections WHERE id=$1',
      [id],
    )
  ).rows[0].verification_label;
  assert.equal(label, 'mock-tested / live test pending');
  await assert.rejects(
    admin.query(
      `UPDATE ct.model_connections SET verification_label='live-verified' WHERE id=$1`,
      [id],
    ),
  );
});

test('disconnect blocks a reserved request and a later one', async () => {
  const owner = await f.actor('user');
  const id = prefix + '-connection';
  const vera = prefix + '-vera';
  const before = calls;
  await admin.query(
    `UPDATE ct.model_connection_limits SET requests_reserved=requests_reserved+1, concurrent_requests=concurrent_requests+1 WHERE connection_id=$1`,
    [id],
  );
  await admin.query(
    `INSERT INTO ct.model_text_attempts(tenant,id,connection_id,principal,idempotency_key,state,input_chars,dispatch)
     VALUES('a',$2,$1,'agent',$2,'RESERVED',4,'text')`,
    [id, 'queued-' + randomBytes(4).toString('hex')],
  );
  await commands.execute(owner, command('revoke_model_connection', id, {}));
  const blocked = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'After disconnect' }),
  );
  assert.equal(blocked.status, 'DENIED');
  assert.equal(calls, before);
  const row = (
    await admin.query(
      `SELECT state FROM ct.model_text_attempts WHERE connection_id=$1 AND state='BLOCKED'`,
      [id],
    )
  ).rows;
  assert.equal(row.length, 1);
});

test('missing and wrong encryption keys fail without revealing the provider key', async () => {
  const saved = process.env.CT_MODEL_CREDENTIAL_KEK;
  const owner = await f.actor('user');
  const id = prefix + '-keycheck';
  await commands.execute(
    owner,
    command('create_model_connection', id, { name: 'Key check' }),
  );
  delete process.env.CT_MODEL_CREDENTIAL_KEK;
  await assert.rejects(
    commands.sealModelCredential(owner, id, key),
    /model credential key unavailable/,
  );
  process.env.CT_MODEL_CREDENTIAL_KEK = Buffer.alloc(32, 9).toString('base64');
  await commands.sealModelCredential(owner, id, key);
  process.env.CT_MODEL_CREDENTIAL_KEK = Buffer.alloc(32, 4).toString('base64');
  await commands.execute(
    owner,
    command('set_model_connection_limits', id, {
      maxRequests: 2,
      maxInputChars: 100,
      maxOutputChars: 100,
      maxOutputTokens: 16,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      timeoutMs: 1000,
    }),
  );
  const tested = await commands.execute(
    owner,
    command('test_model_connection', id, {}),
  );
  assert.equal(JSON.stringify(tested).includes(key), false);
  assert.notEqual((tested.result as { outcome?: string }).outcome, 'LISTED');
  process.env.CT_MODEL_CREDENTIAL_KEK = saved;
});

test('provider output is rendered as text', async () => {
  const source = readFileSync(
    'web/components/ModelConnectionPanel.tsx',
    'utf8',
  );
  assert.match(source, /<p className="model-text">\{text\}<\/p>/);
  assert.equal(source.includes('dangerouslySetInnerHTML'), false);
});

const openLimits = {
  maxRequests: 10,
  maxInputChars: 1000,
  maxOutputChars: 1000,
  maxOutputTokens: 32,
  maxResponseBytes: 2048,
  maxConcurrent: 1 as const,
  timeoutMs: 1000,
};

async function prepare(id: string, limits: typeof openLimits = openLimits) {
  mock.mode = 'ok';
  mock.gate = null;
  const owner = await f.actor('user');
  const vera = id + '-vera';
  await commands.execute(
    owner,
    command('create_model_connection', id, { name: 'Durable' }),
  );
  await commands.sealModelCredential(owner, id, key);
  await commands.execute(
    owner,
    command('set_model_connection_limits', id, limits),
  );
  await commands.execute(owner, command('test_model_connection', id, {}));
  await commands.execute(
    owner,
    command('select_model_connection_model', id, { model: 'models/mock-text' }),
  );
  await commands.execute(
    owner,
    command('create_vera', vera, {
      name: 'Named agent',
      description: 'A profile, not a permission.',
    }),
  );
  await commands.execute(
    owner,
    command('assign_model_connection', id, { principal: vera }),
  );
  return { owner, vera };
}

async function attemptState(idempotency: string) {
  const row = (
    await admin.query(
      `SELECT state, outcome, response_text FROM ct.model_text_attempts
       WHERE tenant='a' AND idempotency_key=$1`,
      [idempotency],
    )
  ).rows[0];
  return row as
    | { state: string; outcome: string | null; response_text: string | null }
    | undefined;
}

test('duplicate submissions and crash recovery send a request at most once', async () => {
  const id = prefix + '-once';
  const { owner, vera } = await prepare(id);
  const direct = new ModelConnectionService(mock);
  const before = calls;
  const reserved = await tx(writeDb, (c) =>
    direct.reserveText(c, owner, id, vera, 'Hold', 'held-' + prefix),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, before);
  assert.equal((await attemptState('held-' + prefix))?.state, 'RESERVED');
  const admitted = await tx(writeDb, (c) =>
    direct.admit(c, 'a', reserved.attempt),
  );
  assert.equal(admitted.send, true);
  assert.equal(calls, before);
  const recovered = await tx(writeDb, (c) =>
    direct.recover(c, 'a', reserved.attempt),
  );
  assert.equal(recovered.outcome, 'UNCERTAIN');
  assert.equal(recovered.mayStillComplete, true);
  const second = await tx(writeDb, (c) =>
    direct.admit(c, 'a', reserved.attempt),
  );
  assert.equal(second.send, false);
  assert.equal(calls, before);
  let release: () => void = () => undefined;
  mock.gate = new Promise((resolve) => {
    release = resolve;
  });
  const idem = 'crash-' + prefix;
  const first = commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Crash' }, idem),
  );
  for (let i = 0; i < 50; i++) {
    if ((await attemptState(idem))?.state === 'SENDING') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await attemptState(idem))?.state, 'SENDING');
  const replay = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Crash' }, idem),
  );
  assert.equal(replay.status, 'PENDING');
  const during = calls;
  release();
  mock.gate = null;
  const finished = await first;
  assert.equal(finished.status, 'APPLIED');
  assert.match(String((finished.result as { text?: string }).text), /Crash/);
  assert.equal(calls, during + 1);
  assert.equal((await attemptState(idem))?.state, 'SETTLED');
  const dup = 'dup-' + prefix;
  const sent = calls;
  const pair = await Promise.all([
    commands.execute(
      owner,
      command('try_vera_text', id, { principal: vera, text: 'Once' }, dup),
    ),
    commands.execute(
      owner,
      command('try_vera_text', id, { principal: vera, text: 'Once' }, dup),
    ),
  ]);
  assert.equal(calls, sent + 1);
  assert.equal(pair.filter((row) => row.status === 'APPLIED').length, 2);
  assert.equal(JSON.stringify(pair).includes(key), false);
});

test('revocation blocks only requests that have not been admitted', async () => {
  const id = prefix + '-revoke';
  const { owner, vera } = await prepare(id);
  const direct = new ModelConnectionService(mock);
  const before = calls;
  const reserved = await tx(writeDb, (c) =>
    direct.reserveText(c, owner, id, vera, 'Queued', 'queued-' + prefix),
  );
  const revoked = await commands.execute(
    owner,
    command('revoke_model_connection', id, {}),
  );
  assert.equal(
    (revoked.result as { sentRequestsMayComplete: boolean })
      .sentRequestsMayComplete,
    true,
  );
  const admitted = await tx(writeDb, (c) =>
    direct.admit(c, 'a', reserved.attempt),
  );
  assert.equal(admitted.send, false);
  assert.equal((await attemptState('queued-' + prefix))?.state, 'BLOCKED');
  const later = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'After' }),
  );
  assert.equal(later.status, 'DENIED');
  assert.equal(calls, before);
  const live = prefix + '-inflight';
  const ready = await prepare(live);
  let release: () => void = () => undefined;
  mock.gate = new Promise((resolve) => {
    release = resolve;
  });
  const idem = 'inflight-' + prefix;
  const started = calls;
  const pending = commands.execute(
    ready.owner,
    command(
      'try_vera_text',
      live,
      { principal: ready.vera, text: 'Sent' },
      idem,
    ),
  );
  for (let i = 0; i < 50; i++) {
    if ((await attemptState(idem))?.state === 'SENDING') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await attemptState(idem))?.state, 'SENDING');
  await commands.execute(
    ready.owner,
    command('revoke_model_connection', live, {}),
  );
  assert.equal((await attemptState(idem))?.state, 'SENDING');
  release();
  mock.gate = null;
  const finished = await pending;
  assert.equal(finished.status, 'APPLIED');
  assert.equal((finished.result as { sent: boolean }).sent, true);
  assert.notEqual((await attemptState(idem))?.state, 'BLOCKED');
  assert.equal(calls, started + 1);
  const follow = await commands.execute(
    ready.owner,
    command('try_vera_text', live, { principal: ready.vera, text: 'Again' }),
  );
  assert.equal(follow.status, 'DENIED');
  assert.equal(calls, started + 1);
});

test('limits and provider failures do not become a successful answer', async () => {
  const id = prefix + '-limits';
  const { owner, vera } = await prepare(id, {
    ...openLimits,
    maxRequests: 3,
    maxInputChars: 4,
    maxOutputTokens: 16,
  });
  const before = calls;
  const tooLong = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'hello' }),
  );
  assert.equal(tooLong.status, 'DENIED');
  assert.equal(calls, before);
  const first = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'hi' }),
  );
  assert.equal(first.status, 'APPLIED');
  assert.equal(mock.lastGenerate?.maxOutputTokens, 16);
  const second = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'yo' }),
  );
  assert.equal(second.status, 'APPLIED');
  const capped = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'no' }),
  );
  assert.equal(capped.status, 'DENIED');
  assert.equal(calls, before + 2);
  const narrow = prefix + '-narrow';
  const small = await prepare(narrow, { ...openLimits, maxOutputChars: 1 });
  const hidden = await commands.execute(
    small.owner,
    command('try_vera_text', narrow, {
      principal: small.vera,
      text: 'hi',
    }),
  );
  assert.equal((hidden.result as { outcome: string }).outcome, 'OUTPUT_LIMIT');
  assert.equal((hidden.result as { text?: string }).text, undefined);
  const held = prefix + '-held';
  const busy = await prepare(held);
  const direct = new ModelConnectionService(mock);
  const mark = calls;
  await tx(writeDb, (c) =>
    direct.reserveText(
      c,
      busy.owner,
      held,
      busy.vera,
      'Wait',
      'slot-' + prefix,
    ),
  );
  const crowded = await commands.execute(
    busy.owner,
    command('try_vera_text', held, { principal: busy.vera, text: 'Next' }),
  );
  assert.equal(crowded.status, 'DENIED');
  assert.equal(calls, mark);
  const failures = prefix + '-failures';
  const ready = await prepare(failures, { ...openLimits, maxRequests: 12 });
  const cases: Array<[MockGemini['mode'], string, boolean]> = [
    ['body', 'BODY_LIMIT', false],
    ['transport', 'PROVIDER_ERROR', true],
    ['timeout', 'TIMEOUT', true],
    ['malformed', 'MALFORMED', false],
    ['invalid', 'INVALID_KEY', false],
    ['tool', 'TOOL_REJECTED', false],
    ['limit', 'RATE_LIMIT', false],
    ['uncertain', 'UNCERTAIN', true],
  ];
  for (const [mode, outcome, uncertain] of cases) {
    mock.mode = mode;
    const sent = calls;
    const result = await commands.execute(
      ready.owner,
      command('try_vera_text', failures, {
        principal: ready.vera,
        text: mode,
      }),
    );
    assert.equal(result.status, 'APPLIED', mode);
    const body = result.result as {
      outcome: string;
      mayStillComplete?: boolean;
      authority?: boolean;
      text?: string;
    };
    assert.equal(body.outcome, outcome);
    assert.equal(body.mayStillComplete ?? false, uncertain);
    assert.notEqual(body.authority, true);
    assert.equal(calls, sent + 1);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  mock.mode = 'ok';
  const bare = prefix + '-bare';
  const ownerOnly = await f.actor('user');
  await commands.execute(
    ownerOnly,
    command('create_model_connection', bare, { name: 'Bare' }),
  );
  await commands.sealModelCredential(ownerOnly, bare, key);
  await commands.execute(
    ownerOnly,
    command('set_model_connection_limits', bare, openLimits),
  );
  await admin.query(
    'DELETE FROM ct.model_connection_limits WHERE connection_id=$1',
    [bare],
  );
  const missing = calls;
  const unavailable = await commands.execute(
    ownerOnly,
    command('test_model_connection', bare, {}),
  );
  assert.equal(unavailable.status, 'DENIED');
  assert.equal(calls, missing);
});

test('stale, cross-tenant, and disabled calls are refused without a provider send', async () => {
  const id = prefix + '-guard';
  const { owner, vera } = await prepare(id);
  const before = calls;
  const stale = await f.human.verify(
    await f.token('user', 'a', {
      auth_time: Math.floor(Date.now() / 1000) - 600,
    }),
  );
  await assert.rejects(
    commands.execute(
      stale,
      command('try_vera_text', id, { principal: vera, text: 'Stale' }),
    ),
    /fresh owner MFA required/,
  );
  const other = await f.actor('user', 'b');
  const foreign = await commands.execute(
    other,
    command('try_vera_text', id, { principal: vera, text: 'Other' }),
  );
  assert.equal(foreign.status, 'DENIED');
  const machine = await f.actor('machine');
  await assert.rejects(
    commands.execute(
      machine,
      command('try_vera_text', id, { principal: vera, text: 'Machine' }),
    ),
    /fresh owner MFA required/,
  );
  assert.equal(calls, before);
  const disabled = new ConsoleCommands(
    writeDb,
    f.authority,
    f.product,
    fence,
    'LOCAL_FIXTURE',
  );
  const checked = await disabled.execute(
    owner,
    command('test_model_connection', id, {}),
  );
  const body = checked.result as { outcome?: string; message?: string };
  assert.equal(body.outcome, 'LIVE_DISABLED');
  assert.match(String(body.message), /did not verify the key or connection/);
  assert.equal(JSON.stringify(checked).includes(key), false);
  const label = (
    await admin.query(
      'SELECT verification_label FROM ct.model_connections WHERE id=$1',
      [id],
    )
  ).rows[0].verification_label;
  assert.equal(label, 'mock-tested / live test pending');
  assert.equal(calls, before);
});

test('a closed recovery fence stops sealing and dispatch before a provider call', async () => {
  const id = prefix + '-fence';
  const owner = await f.actor('user');
  await commands.execute(
    owner,
    command('create_model_connection', id, { name: 'Fenced' }),
  );
  await admin.query('UPDATE ct.control SET blocked=true WHERE singleton');
  try {
    await assert.rejects(
      commands.sealModelCredential(owner, id, key),
      /recovery fence/,
    );
  } finally {
    await admin.query('UPDATE ct.control SET blocked=false WHERE singleton');
  }
  await commands.sealModelCredential(owner, id, key);
  const { vera } = await prepare(id + '-ready');
  const readyOwner = await f.actor('user');
  const before = calls;
  const idem = 'fence-' + prefix;
  commands.beforeAdmit = async () => {
    await admin.query('UPDATE ct.control SET blocked=true WHERE singleton');
  };
  try {
    await assert.rejects(
      commands.execute(
        readyOwner,
        command(
          'try_vera_text',
          id + '-ready',
          { principal: vera, text: 'Wait' },
          idem,
        ),
      ),
      /recovery fence/,
    );
    assert.equal(calls, before);
    assert.equal((await attemptState(idem))?.state, 'RESERVED');
  } finally {
    commands.beforeAdmit = null;
    await admin.query('UPDATE ct.control SET blocked=false WHERE singleton');
  }
  const sent = await commands.execute(
    readyOwner,
    command(
      'try_vera_text',
      id + '-ready',
      { principal: vera, text: 'Wait' },
      idem,
    ),
  );
  assert.equal(sent.status, 'APPLIED');
  assert.equal(calls, before + 1);
});

test('stale bindings, locked limits, and stranded attempts stay honest', async () => {
  const id = prefix + '-bind';
  const { owner, vera } = await prepare(id);
  const before = calls;
  const changed = await commands.execute(
    owner,
    command('select_model_connection_model', id, { model: 'models/mock-alt' }),
  );
  assert.equal(changed.status, 'APPLIED');
  const drifted = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Old' }),
  );
  assert.equal(drifted.status, 'DENIED');
  assert.equal(calls, before);
  await commands.execute(
    owner,
    command('assign_model_connection', id, { principal: vera }),
  );
  const current = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'New' }),
  );
  assert.equal(current.status, 'APPLIED');
  assert.equal(mock.lastGenerate?.maxOutputTokens, 32);
  assert.equal(calls, before + 1);
  const other = prefix + '-other';
  await commands.execute(
    owner,
    command('create_model_connection', other, { name: 'Other' }),
  );
  await commands.sealModelCredential(owner, other, key);
  await commands.execute(
    owner,
    command('set_model_connection_limits', other, openLimits),
  );
  await commands.execute(owner, command('test_model_connection', other, {}));
  await commands.execute(
    owner,
    command('select_model_connection_model', other, {
      model: 'models/mock-text',
    }),
  );
  await commands.execute(
    owner,
    command('assign_model_connection', other, { principal: vera }),
  );
  const displaced = await commands.execute(
    owner,
    command('try_vera_text', id, { principal: vera, text: 'Displaced' }),
  );
  assert.equal(displaced.status, 'DENIED');
  const locked = await commands.execute(
    owner,
    command('set_model_connection_limits', id, {
      ...openLimits,
      maxRequests: 1,
    }),
  );
  assert.equal(locked.status, 'DENIED');
  const stored = (
    await admin.query(
      'SELECT max_requests FROM ct.model_connection_limits WHERE connection_id=$1',
      [id],
    )
  ).rows[0].max_requests;
  assert.equal(Number(stored), 10);
  const direct = new ModelConnectionService(mock);
  const stuck = 'stuck-' + prefix;
  await tx(writeDb, (c) =>
    direct.reserveText(c, owner, other, vera, 'Old', stuck),
  );
  await admin.query(
    `UPDATE ct.model_text_attempts
     SET state='SENDING', updated_at=clock_timestamp() - interval '2 minutes'
     WHERE tenant='a' AND idempotency_key=$1`,
    [stuck],
  );
  const mark = calls;
  const resumed = await commands.execute(
    owner,
    command('try_vera_text', other, { principal: vera, text: 'Next' }),
  );
  assert.equal(resumed.status, 'APPLIED');
  assert.equal(calls, mark + 1);
  assert.equal((await attemptState(stuck))?.state, 'UNCERTAIN');
  assert.equal((await attemptState(stuck))?.outcome, 'POSSIBLY_SENT');
});
