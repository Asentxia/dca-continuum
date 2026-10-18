import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pool } from '../src/db.js';
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
  mode:
    | 'ok'
    | 'invalid'
    | 'limit'
    | 'malformed'
    | 'timeout'
    | 'tool'
    | 'uncertain' = 'ok';
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
      ],
    });
  }
  async generate(input: {
    apiKey: string;
    model: string;
    text: string;
    timeoutMs: number;
  }) {
    calls += 1;
    assert.equal(input.apiKey, key);
    assert.equal(input.model, 'models/mock-text');
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
    `INSERT INTO ct.model_text_attempts(tenant,id,connection_id,principal,idempotency_key,state,input_chars)
     VALUES('a',$2,$1,'agent',$2,'RESERVED',4)`,
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

test('provider output is rendered as text', async () => {
  const source = readFileSync(
    'web/components/ModelConnectionPanel.tsx',
    'utf8',
  );
  assert.match(source, /<p className="model-text">\{text\}<\/p>/);
  assert.equal(source.includes('dangerouslySetInnerHTML'), false);
});
