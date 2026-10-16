import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodeUtf8, readBoundedChunks } from '../src/bounded-body.js';
import { redact } from '../src/console/redaction.js';
import { LocalIndependentFenceStore } from '../src/fence-store.js';
import { callController } from '../src/controller-client.js';
import { mapRunloopStatus } from '../src/runloop-driver.js';
import { pool } from '../src/db.js';
import { RenewingCapabilityClient } from '../src/capability-renewal.js';
import { bootstrap, makeOp } from './helpers.js';

const root = process.cwd();

function enforce(script: string, cwd: string) {
  return spawnSync('python3', [path.join(root, script), '--enforce'], {
    cwd,
    encoding: 'utf8',
  });
}

async function ledger(kind: 'production' | 'release', body: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ct-ledger-'));
  if (kind === 'production') {
    await mkdir(path.join(dir, 'qualification'), { recursive: true });
    await writeFile(
      path.join(dir, 'qualification/PRODUCTION-GATES.json'),
      JSON.stringify(body),
    );
    return { dir, result: enforce('qualification/check-gates.py', dir) };
  }
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(
    path.join(dir, 'docs/RELEASE-GATES.json'),
    JSON.stringify(body),
  );
  return { dir, result: enforce('tools/check-release.py', dir) };
}

test('an unrecognized scheduler decision cannot make production ready', async () => {
  const live = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(path.join(root, 'qualification/PRODUCTION-GATES.json'), 'utf8'),
  );
  for (const gate of live.gates) gate.status = 'PASS';
  live.schedulerDecision = 'UNKNOWN';
  const { dir, result } = await ledger('production', live);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed/);
  await rm(dir, { recursive: true, force: true });
});
test('an unrecognized scheduler decision cannot allow canon promotion', async () => {
  const live = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(path.join(root, 'docs/RELEASE-GATES.json'), 'utf8'),
  );
  for (const gate of live.gates) gate.status = 'PASS_PRODUCTION';
  live.schedulerDecision = 'UNKNOWN';
  const { dir, result } = await ledger('release', live);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed/);
  await rm(dir, { recursive: true, force: true });
});
test('production gate checker rejects an empty ledger', async () => {
  const { dir, result } = await ledger('production', {
    gates: [],
    allowedStatuses: ['PASS'],
    schedulerDecision: 'HELD',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed/);
  await rm(dir, { recursive: true, force: true });
});

test('production gate checker rejects a missing required gate', async () => {
  const live = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(path.join(root, 'qualification/PRODUCTION-GATES.json'), 'utf8'),
  );
  live.gates = live.gates.filter((g: { id: string }) => g.id !== 'P3');
  const { dir, result } = await ledger('production', live);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed/);
  await rm(dir, { recursive: true, force: true });
});

test('production gate checker rejects a duplicate gate', async () => {
  const live = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(path.join(root, 'qualification/PRODUCTION-GATES.json'), 'utf8'),
  );
  live.gates.push({ ...live.gates[0], status: 'PASS' });
  const { dir, result } = await ledger('production', live);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed/);
  await rm(dir, { recursive: true, force: true });
});

test('release gate checker rejects empty, missing and duplicate definitions', async () => {
  for (const body of [
    { gates: [], schedulerDecision: 'HELD' },
    {
      gates: Array.from({ length: 11 }, (_, i) => ({
        id: `G${i + 1}`,
        status: 'PARTIAL',
      })),
      schedulerDecision: 'HELD',
    },
    {
      gates: [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `G${i + 1}`,
          status: 'PARTIAL',
        })),
        { id: 'G1', status: 'PASS_PRODUCTION' },
      ],
      schedulerDecision: 'HELD',
    },
  ]) {
    const { dir, result } = await ledger('release', body);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /malformed/);
    await rm(dir, { recursive: true, force: true });
  }
});

test('current ledgers stay blocked without being treated as malformed', () => {
  const production = enforce('qualification/check-gates.py', root);
  const release = enforce('tools/check-release.py', root);
  assert.equal(production.status, 1);
  assert.equal(release.status, 1);
  assert.doesNotMatch(production.stdout, /malformed/);
  assert.doesNotMatch(release.stdout, /malformed/);
  assert.match(production.stdout, /"productionReady": false/);
  assert.match(release.stdout, /"canonPromotionAllowed": false/);
});

test('split UTF-8 chunks decode once and malformed bytes are rejected', async () => {
  async function* split() {
    yield Buffer.from([0x56, 0x45, 0x52, 0x41, 0x20, 0xe2]);
    yield Buffer.from([0x80, 0x94]);
  }
  assert.equal(decodeUtf8(await readBoundedChunks(split(), 32)), 'VERA —');
  async function* bad() {
    yield Buffer.from([0xff]);
  }
  await assert.rejects(
    readBoundedChunks(bad(), 32).then(decodeUtf8),
    /malformed utf-8/,
  );
});

test('fine-grained GitHub token text is redacted', () => {
  const token = 'github_pat_' + 'A'.repeat(22);
  assert.equal(redact(`see ${token}`), '[Sensitive value omitted]');
  assert.equal(redact('github-public-readonly'), 'github-public-readonly');
});

test('local fence activation requires a closed fence and exact digest', async () => {
  const open = await mkdtemp(path.join(os.tmpdir(), 'ct-fence-'));
  const store = new LocalIndependentFenceStore(open);
  await store.initialize({
    revision: 1,
    fence: 'fence',
    blocked: false,
    authorityDigest: 'a'.repeat(64),
  });
  await assert.rejects(
    store.activate(1, 'b'.repeat(64)),
    /closed recovery required/,
  );
  const closed = await mkdtemp(path.join(os.tmpdir(), 'ct-fence-'));
  const blocked = new LocalIndependentFenceStore(closed);
  await blocked.initialize({
    revision: 1,
    fence: 'fence',
    blocked: true,
    authorityDigest: 'a'.repeat(64),
  });
  await assert.rejects(
    blocked.activate(1, 'short'),
    /approval manifest digest/,
  );
  await blocked.activate(1, 'b'.repeat(64));
  assert.equal((await blocked.read()).blocked, false);
});

test('unknown provider status is not reported as starting', () => {
  assert.equal(mapRunloopStatus('running'), 'RUNNING');
  assert.equal(mapRunloopStatus('shutdown'), 'STOPPED');
  assert.equal(mapRunloopStatus('provisioning'), 'STARTING');
  assert.throws(() => mapRunloopStatus('mystery'), /unmapped provider status/);
});

test('controller extra cannot replace the reviewed operation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ct-sock-'));
  const socket = path.join(dir, 'controller.sock');
  let sent = '';
  const server = net.createServer((connection) => {
    const chunks: Buffer[] = [];
    connection.on('data', (chunk) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const split = text.indexOf('\r\n\r\n');
      if (split < 0) return;
      const head = text.slice(0, split);
      const length = Number(head.match(/content-length: (\d+)/i)?.[1] ?? 0);
      const body = text.slice(split + 4);
      if (Buffer.byteLength(body) < length) return;
      sent = body.slice(0, length);
      const payload = JSON.stringify({
        id: 'reviewed-op',
        state: 'COMMITTED',
        version: '1',
      });
      connection.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  try {
    const result = await callController(
      socket,
      'capability',
      'reviewed-op',
      '/dispatch',
      {
        operation: 'other-op',
      },
    );
    assert.equal(result.id, 'reviewed-op');
    assert.equal(JSON.parse(sent).operation, 'reviewed-op');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('stalled controller response fails closed without another send', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ct-sock-'));
  const socket = path.join(dir, 'controller.sock');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  await assert.rejects(
    callController(
      socket,
      'capability',
      'operation',
      '/dispatch',
      undefined,
      200,
    ),
    /controller response deadline/,
  );
  server.close();
});

test('identity renewal endpoint must be the configured HTTPS origin', async () => {
  const source = {
    async current() {
      return 'workload-token';
    },
  };
  for (const endpoint of [
    'http://approved.example',
    'https://approved.example@other.example',
    'https://user:secret@approved.example',
    'https://approved.example/renew',
    'https://approved.example/?q=1',
    'https://approved.example/#fragment',
  ])
    assert.throws(
      () => new RenewingCapabilityClient(endpoint, source),
      /HTTPS identity endpoint required/,
    );
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    return new Response(null, { status: 403 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      new RenewingCapabilityClient(
        'https://approved.example/',
        source,
      ).forOperation('op-1'),
      /renewal denied/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls, ['https://approved.example/renew']);
});
test('recovery role cannot insert a sendable REQUESTED operation', async () => {
  await bootstrap();
  const id = 'recovery-import-' + Date.now();
  await makeOp(id);
  const db = pool('ct_recovery');
  await assert.rejects(
    db.query(
      `INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,state,version)
       SELECT tenant,$2,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key||'-copy',cost,deadline,'REQUESTED',1
       FROM ct.operations WHERE tenant='a' AND id=$1`,
      [id, id + '-canary'],
    ),
    /recovery cannot import a sendable outcome/,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,state,version,observation)
       SELECT tenant,$2,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key||'-obs',cost,deadline,'UNKNOWN',1,'{"fabricated":true}'::jsonb
       FROM ct.operations WHERE tenant='a' AND id=$1`,
      [id, id + '-observation'],
    ),
    /recovery cannot import a sendable outcome/,
  );
  await db.end();
});
