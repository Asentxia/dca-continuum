import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, type ChildProcess, spawnSync } from 'node:child_process';
import { admin, gov, makeOp, count, bootstrap, fence } from './helpers.js';
import { append, pool, tx, sha } from '../src/db.js';
import { secrets, config, start, stop, capability } from './process-helpers.js';
import { callController } from '../src/controller-client.js';
import {
  fixturePriv,
  unshareIsolated,
} from '../internal/fixtures/fixture-priv.js';
const socket = process.cwd() + '/.local/release-controller.sock';
let provider: ChildProcess, controller: ChildProcess;
before(async () => {
  await bootstrap();
  config('.local/release-provider.json', {});
  provider = await start(
    'dist/tests/provider-emulator.js',
    '.local/release-provider.json',
    'release-provider',
  );
  config('.local/release-controller.json', { socket });
  controller = await start(
    'dist/tests/controller-process.js',
    '.local/release-controller.json',
    'release-controller',
  );
});
after(async () => {
  await stop(controller);
  await stop(provider);
  await Promise.all([admin.end(), gov.end()]);
});
test('Local recovery fence rejects an old capability against a newly bound operation', async () => {
  await makeOp('release-cap-fence');
  const cap = capability(['release-cap-fence'], {
    deploymentFence: 'pre-restore-fence',
  });
  assert.equal(
    (await callController(socket, cap, 'release-cap-fence')).state,
    'DENIED',
  );
  assert.equal(await count('release-cap-fence'), 0);
});
test('Local principal and grant authority cannot be rolled backwards', async () => {
  await makeOp('release-monotonic');
  await assert.rejects(
    gov.query("UPDATE ct.principals SET epoch=0 WHERE tenant='a'"),
    /monotonic/,
  );
  await assert.rejects(
    gov.query(
      "UPDATE ct.grants SET expires=now()+interval '100 days' WHERE id='g-release-monotonic'",
    ),
    /higher grant version/,
  );
});
test('Local compute process and filesystem destruction reconstructs data; generation fences stale agent', async () => {
  const path = process.cwd() + '/.local/agent-workspace';
  fs.mkdirSync(path, { recursive: true });
  fs.chmodSync(path, 0o777);
  fs.writeFileSync(path + '/checkpoint.txt', 'durable task checkpoint');
  const manifest = {
    computerId: 'fixture-computer',
    generation: 1,
    blob: 'durable task checkpoint',
    digest: sha('durable task checkpoint'),
  };
  fs.writeFileSync('.local/artifact-manifest.json', JSON.stringify(manifest), {
    mode: 0o600,
  });
  const child = spawn(
    'sudo',
    unshareIsolated(65534, [
      process.execPath,
      '-e',
      "console.log('READY '+process.pid);setInterval(()=>{},1000)",
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', (b) => resolve(Number(String(b).split(' ')[1])));
    child.once('error', reject);
  });
  const old = await makeOp('release-old-computer');
  const kill = spawnSync('sudo', ['-n', fixturePriv, 'kill', String(pid)]);
  assert.equal(kill.status, 0);
  await new Promise<void>((r) => child.once('exit', () => r()));
  fs.rmSync(path, { recursive: true });
  assert.equal(fs.existsSync(path), false);
  await tx(gov, async (c) => {
    await c.query('SELECT * FROM ct.control FOR SHARE');
    await c.query(
      "UPDATE ct.principals SET generation=generation+1 WHERE tenant='a' AND id='agent'",
    );
    await append(c, 'a', 'COMPUTER_RECONSTITUTED', {
      computerId: manifest.computerId,
      newGeneration: 2,
    });
  });
  assert.equal(
    (await callController(socket, capability([old.id]), old.id)).state,
    'DENIED',
  );
  fs.mkdirSync(path);
  const recovered = JSON.parse(
    fs.readFileSync('.local/artifact-manifest.json', 'utf8'),
  );
  assert.equal(sha(recovered.blob), recovered.digest);
  fs.writeFileSync(path + '/checkpoint.txt', recovered.blob);
  const fresh = await makeOp('release-new-computer');
  assert.equal(
    (
      await callController(
        socket,
        capability([fresh.id], { generation: 2 }),
        fresh.id,
      )
    ).state,
    'COMMITTED',
  );
  assert.equal(await count(old.id), 0);
  assert.equal(await count(fresh.id), 1);
  fs.writeFileSync(
    '.artifacts/core/local-computer-recovery.json',
    JSON.stringify(
      {
        logicalComputer: manifest.computerId,
        oldGeneration: 1,
        newGeneration: 2,
        killedUid: 65534,
        scratchDestroyed: true,
        artifactDigestMatched: true,
        oldCapabilityDenied: true,
        newApprovedOperationCommitted: true,
        scope:
          'local process/scratch directory; not VM host or managed provider recovery',
      },
      null,
      2,
    ),
  );
});
