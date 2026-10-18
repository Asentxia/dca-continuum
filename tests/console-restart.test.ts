import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pool } from '../src/db.js';

const database = 'ct_console_test';

function localEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    CT_RUNTIME_ENV: 'local-test',
    CT_ALLOW_LOCAL_FIXTURES: 'yes',
    CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
    CT_DATABASE: database,
    PGHOST: '127.0.0.1',
    PGPORT: '55432',
    PGUSER: 'localtest',
    ...extra,
  };
}

async function listenPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const number = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return number;
}

async function ready(url: string, child: ChildProcess, output: () => string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null)
      throw Error('API exited before ready\n' + output());
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* process is still binding */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error('API did not become ready\n' + output());
}

function startApi(port: number, key: string) {
  let text = '';
  const child = spawn(
    process.execPath,
    ['dist/internal/fixtures/console-server.js'],
    {
      env: localEnv({
        CT_API_PORT: String(port),
        CT_FIXTURE_SERVER_KEY: key,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk) => {
    text += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    text += chunk;
  });
  return { child, output: () => text };
}

async function stopApi(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('API did not stop')), 8000),
    ),
  ]);
}

async function command(
  port: number,
  token: string,
  body: Record<string, unknown>,
) {
  const response = await fetch('http://127.0.0.1:' + port + '/command', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

test('tasks and VERA profiles survive an API restart', async () => {
  Object.assign(process.env, localEnv());
  const bin = process.env.CT_PG_BIN
    ? path.join(process.env.CT_PG_BIN, 'psql')
    : 'psql';
  const { execFileSync } = await import('node:child_process');
  const dataDirectory = execFileSync(
    bin,
    [
      '-h',
      '127.0.0.1',
      '-p',
      '55432',
      '-U',
      'localtest',
      '-d',
      'postgres',
      '-Atc',
      'SHOW data_directory',
    ],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(
    realpathSync(dataDirectory),
    realpathSync(path.resolve('.local/pgdata')),
    'refusing a cluster that is not this checkout',
  );
  execFileSync('bash', ['tools/ensure-console-db.sh', database], {
    env: localEnv(),
    stdio: 'inherit',
  });
  const port = await listenPort();
  const key = randomBytes(32).toString('hex');
  const suffix = randomBytes(4).toString('hex');
  const veraId = 'restart-vera-' + suffix;
  const taskId = 'restart-task-' + suffix;
  let first: ReturnType<typeof startApi> | undefined;
  let second: ReturnType<typeof startApi> | undefined;
  let db: ReturnType<typeof pool> | undefined;
  try {
    const firstApi = startApi(port, key);
    first = firstApi;
    await ready(
      'http://127.0.0.1:' + port + '/read',
      firstApi.child,
      firstApi.output,
    );
    const login = await fetch('http://127.0.0.1:' + port + '/__fixture/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-server-key': key,
      },
      body: JSON.stringify({ tenant: 'a' }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).token as string;
    await command(port, token, {
      schema_version: 1,
      idempotency_key: 'create-' + veraId,
      kind: 'create_vera',
      target: veraId,
      expected_version: 0,
      input: {
        name: 'Persistent VERA ' + suffix,
        description: 'Created before restart',
      },
    });
    await command(port, token, {
      schema_version: 1,
      idempotency_key: 'edit-' + veraId,
      kind: 'update_vera_profile',
      target: veraId,
      expected_version: 1,
      input: {
        name: 'Edited persistent VERA ' + suffix,
        description: 'Edited before restart',
      },
    });
    await command(port, token, {
      schema_version: 1,
      idempotency_key: 'create-' + taskId,
      kind: 'create_task',
      target: taskId,
      expected_version: 0,
      input: {
        principal: 'p-focus',
        objective: 'Persistent task ' + suffix,
        deadline: new Date(Date.now() + 3600000).toISOString(),
        organization: 'focus-org',
        mandate: 'focus-mandate',
        mandateVersion: 1,
      },
    });
    const databasePool = pool('localtest', database);
    db = databasePool;
    const before = async () => ({
      task: (
        await databasePool.query(
          'SELECT id,objective,organization,mandate,mandate_version::text AS mandate_version FROM ct.tasks WHERE tenant=$1 AND id=$2',
          ['a', taskId],
        )
      ).rows[0],
      profile: (
        await databasePool.query(
          'SELECT id,name,description,revision::text AS revision,created_by FROM ct.vera_profiles WHERE tenant=$1 AND id=$2',
          ['a', veraId],
        )
      ).rows[0],
      tasks: Number(
        (
          await databasePool.query(
            "SELECT count(*) AS n FROM ct.tasks WHERE tenant='a'",
          )
        ).rows[0].n,
      ),
      profiles: Number(
        (
          await databasePool.query(
            "SELECT count(*) AS n FROM ct.vera_profiles WHERE tenant='a'",
          )
        ).rows[0].n,
      ),
    });
    const saved = await before();
    assert.equal(saved.task.objective, 'Persistent task ' + suffix);
    assert.equal(saved.profile.name, 'Edited persistent VERA ' + suffix);
    assert.equal(saved.profile.revision, '2');
    await stopApi(first.child);
    second = startApi(port, key);
    await ready(
      'http://127.0.0.1:' + port + '/read',
      second.child,
      second.output,
    );
    assert.deepEqual(await before(), saved);
    const again = await fetch('http://127.0.0.1:' + port + '/__fixture/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-server-key': key,
      },
      body: JSON.stringify({ tenant: 'a' }),
    });
    const nextToken = (await again.json()).token as string;
    const read = await fetch(
      'http://127.0.0.1:' + port + '/read?section=agents&id=' + veraId,
      { headers: { authorization: 'Bearer ' + nextToken } },
    );
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(body.items[0].title, 'Edited persistent VERA ' + suffix);
    assert.equal(body.items[0].fields.profileRevision, 2);
  } finally {
    await Promise.allSettled([
      first ? stopApi(first.child) : Promise.resolve(),
      second ? stopApi(second.child) : Promise.resolve(),
      db ? db.end() : Promise.resolve(),
    ]);
  }
});
