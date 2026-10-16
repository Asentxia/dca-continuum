import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';
import { ComputerService } from '../src/computers.js';
import { LocalComputerDriver } from '../internal/fixtures/local-computer-driver.js';
import { nsenterIsolated } from '../internal/fixtures/fixture-priv.js';
import { RunloopDriver } from '../src/runloop-driver.js';
import { pinPublicTarget, publicAddress } from '../src/network-policy.js';
let f: Awaited<ReturnType<typeof fixture>>,
  driver: LocalComputerDriver,
  service: ComputerService;
before(async () => {
  f = await fixture('computer');
  driver = new LocalComputerDriver(path.resolve('.local/computer-fixtures'));
  service = new ComputerService(f.productDb, driver, 'fixture-fence-v1');
  // The broker, not the product API, holds lifecycle permissions.
  const { pool } = await import('../src/db.js');
  (service as any).db = pool('ct_computer_broker');
});
after(async () => {
  if (driver) await driver.close();
  if (service) await (service as any).db.end();
  if (f) await f.close();
  await admin.end();
  await gov.end();
});
test('Computer public-DNS policy blocks private, metadata, mapped IPv6 and mixed answers', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.2',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0.0.0.0',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('93.184.216.34'), true);
  assert.equal(
    (
      await pinPublicTarget(
        'https://api.example.test/path',
        'api.example.test',
        async () => ['93.184.216.34'],
      )
    ).address,
    '93.184.216.34',
  );
  await assert.rejects(
    pinPublicTarget(
      'https://api.example.test/path',
      'api.example.test',
      async () => ['93.184.216.34', '10.0.0.1'],
    ),
  );
});
test('Computer URL policy refuses SSRF, alternate ports, credentials and host tricks', async () => {
  for (const raw of [
    'http://api.example.test',
    'https://evil.test',
    'https://api.example.test.evil.test',
    'https://u:p@api.example.test',
    'https://api.example.test:8443',
    'https://api.example.test/#x',
    'https://127.0.0.1',
  ])
    await assert.rejects(
      pinPublicTarget(raw, 'api.example.test', async () => ['93.184.216.34']),
    );
});
test('Computer managed driver disabled by default; no credential access or network', async () => {
  let reads = 0,
    calls = 0;
  const disabled = new RunloopDriver(
    {
      enabled: false,
      approvalReference: '',
      blueprintId: '',
      networkPolicyId: '',
    },
    async () => {
      reads++;
      return 'fixture-not-live';
    },
    async () => {
      calls++;
      throw Error('must not run');
    },
  );
  await assert.rejects(
    disabled.start({
      tenant: 'a',
      computer: 'test',
      principal: f.principal,
      generation: 1,
      requestId: 'test:1',
    }),
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});
test('Computer official SDK emits only pinned, restricted, secret-free placement parameters', async () => {
  const requests: any[] = [];
  let metadata: Record<string, string> = {};
  const fakeFetch: typeof fetch = async (u, o) => {
    requests.push({
      url: String(u),
      method: o?.method,
      body: o?.body ? JSON.parse(String(o.body)) : null,
    });
    if (o?.body) metadata = JSON.parse(String(o.body)).metadata;
    return new Response(
      JSON.stringify({ id: 'dbx-fixture', status: 'running', metadata }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const managed = new RunloopDriver(
    {
      enabled: true,
      approvalReference: 'fixture-approved',
      blueprintId: 'bp-fixture-private',
      networkPolicyId: 'np-fixture-deny',
    },
    async () => 'fixture-not-live',
    fakeFetch,
  );
  const view = await managed.start({
    tenant: 'a',
    computer: 'managed-fixture',
    principal: f.principal,
    generation: 1,
    requestId: 'request-1',
  });
  assert.equal(view.status, 'RUNNING');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.startsWith('https://api.runloop.ai/'));
  assert.equal(
    requests[0].body.launch_parameters.network_policy_id,
    'np-fixture-deny',
  );
  for (const forbidden of ['secrets', 'gateways', 'mcp', 'tunnel'])
    assert.equal(requests[0].body[forbidden], undefined);
  assert.deepEqual(Object.keys(requests[0].body.environment_variables).sort(), [
    'CT_COMPUTER',
    'CT_GENERATION',
  ]);
});
test('Computer uncertain create has no SDK retry and no second service provisioning attempt', async () => {
  let calls = 0;
  const managed = new RunloopDriver(
    {
      enabled: true,
      approvalReference: 'fixture-approved',
      blueprintId: 'bp-fixture',
      networkPolicyId: 'np-fixture',
    },
    async () => 'fixture-not-live',
    async () => {
      calls++;
      throw Error('fixture lost create acknowledgement');
    },
  );
  const broker = (service as any).db;
  const guarded = new ComputerService(broker, managed, 'fixture-fence-v1');
  const owner = await f.actor('user', 'b');
  await guarded.register(owner, 'uncertain-computer', f.principal);
  await assert.rejects(guarded.start(owner, 'uncertain-computer'));
  await assert.rejects(guarded.start(owner, 'uncertain-computer'));
  assert.equal(calls, 1);
  const r = (
    await admin.query(
      "SELECT state FROM ct.computers WHERE tenant='b' AND id='uncertain-computer'",
    )
  ).rows[0];
  assert.equal(r.state, 'STARTING');
});
test('Computer managed lifecycle is owner-only and tenant-bound', async () => {
  await assert.rejects(
    service.register(await f.actor('machine'), 'self-computer', f.principal),
  );
  const owner = await f.actor('user');
  await service.register(owner, 'logical-computer', f.principal);
  await assert.rejects(
    service.start(await f.actor('user', 'b'), 'logical-computer'),
  );
  const placement = await service.start(owner, 'logical-computer');
  assert.equal(placement.state, 'RUNNING');
  assert.equal(
    (
      await service.authorizePlacement(
        await f.actor('machine'),
        'logical-computer',
        placement.placement,
        1,
      )
    ).tenant,
    'a',
  );
  await assert.rejects(
    service.authorizePlacement(
      await f.actor('machine', 'b'),
      'logical-computer',
      placement.placement,
      1,
    ),
  );
  await assert.rejects(
    service.authorizePlacement(
      await f.actor('machine'),
      'logical-computer',
      'forged-placement',
      1,
    ),
  );
});
test('Computer actual separate UID/network process cannot read credentials or tenant peer scratch', async () => {
  const r = (
      await admin.query(
        "SELECT * FROM ct.computers WHERE tenant='a' AND id='logical-computer'",
      )
    ).rows[0],
    d = driver.details(r.placement);
  const other = await driver.start({
      tenant: 'b',
      computer: 'peer',
      principal: f.principal,
      generation: 1,
      requestId: 'peer-1',
    }),
    peer = driver.details(other.id);
  const secret = path.resolve('.local/computer-controller-fixture.secret');
  await fs.writeFile(secret, randomBytes(32), { mode: 0o600 });
  const probe = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');(async()=>{const checks={uid:process.getuid()===${d.uid},noCapabilities:/CapEff:\\s+0+/.test(fs.readFileSync('/proc/self/status','utf8')),credentialBlocked:false,peerBlocked:false,dbBlocked:false,networkEscapeBlocked:cp.spawnSync('unshare',['--net']).status!==0};try{fs.readFileSync(${JSON.stringify(secret)})}catch{checks.credentialBlocked=true}try{fs.readdirSync(${JSON.stringify(peer.directory)})}catch{checks.peerBlocked=true}checks.dbBlocked=await new Promise(r=>{const s=net.connect({host:'127.0.0.1',port:55432},()=>{s.destroy();r(false)});s.on('error',()=>r(true));s.setTimeout(1500,()=>{s.destroy();r(true)})});console.log(JSON.stringify(checks));process.exit(Object.values(checks).every(Boolean)?0:1)})()`;
  const p = spawnSync(
    'sudo',
    nsenterIsolated(d.pid, d.uid, [process.execPath, '-e', probe]),
    { encoding: 'utf8', timeout: 10000 },
  );
  await fs.unlink(secret);
  assert.equal(p.status, 0, p.stderr + p.stdout);
  await fs.writeFile(
    '.artifacts/implementation/COMPUTER-NAMESPACE-RAW.json',
    JSON.stringify(
      {
        scope: 'local Linux process/UID/network namespace, not managed VM',
        checks: JSON.parse(p.stdout),
        pid: d.pid,
        uid: d.uid,
      },
      null,
      2,
    ),
  );
});
test('Computer destroyed scratch and process fence already-issued effect authority', async () => {
  const { x } = await f.intent('computer-old-effect', true);
  const cap = await f.capability(x.id);
  const r = (
      await admin.query(
        "SELECT * FROM ct.computers WHERE tenant='a' AND id='logical-computer'",
      )
    ).rows[0],
    d = driver.details(r.placement);
  await fs.writeFile(
    path.join(d.directory, 'checkpoint.txt'),
    'fixture durable checkpoint',
  );
  const destroyed = await service.destroy(
    await f.actor('user'),
    'logical-computer',
  );
  assert.equal(destroyed.generation, 2);
  await assert.rejects(fs.stat(d.directory));
  assert.equal((await f.controller.dispatch(cap, x.id)).state, 'DENIED');
  await assert.rejects(
    service.authorizePlacement(
      await f.actor('machine'),
      'logical-computer',
      r.placement,
      1,
    ),
  );
  const replacement = await service.start(
    await f.actor('user'),
    'logical-computer',
  );
  assert.equal(replacement.generation, 2);
  assert.notEqual(replacement.placement, r.placement);
  await service.authorizePlacement(
    await f.actor('machine'),
    'logical-computer',
    replacement.placement,
    2,
  );
  const fresh = await f.intent('computer-new-effect', true);
  assert.equal(
    (await f.controller.dispatch(await f.capability(fresh.x.id), fresh.x.id))
      .state,
    'COMMITTED',
  );
});
test('Computer product role and agent cannot change generation or placement', async () => {
  await assert.rejects(
    f.productDb.query(
      "UPDATE ct.principals SET generation=generation+1 WHERE tenant='a'",
    ),
  );
  await assert.rejects(
    f.productDb.query(
      "UPDATE ct.computers SET placement='forged',revision=revision+1 WHERE tenant='a'",
    ),
  );
});
