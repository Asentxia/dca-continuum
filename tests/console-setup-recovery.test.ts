import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const providerDb = 'ct_provider_read_test';
const browserDb = 'ct_console_browser';

function env(extra: Record<string, string> = {}) {
  const pathValue = [process.env.CT_PG_BIN ?? '', process.env.PATH ?? '']
    .filter(Boolean)
    .join(':');
  return {
    ...process.env,
    PATH: pathValue,
    CT_RUNTIME_ENV: 'local-test',
    CT_ALLOW_LOCAL_FIXTURES: 'yes',
    CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
    PGHOST: '127.0.0.1',
    PGPORT: '55432',
    PGUSER: 'localtest',
    ...extra,
  };
}

function psql(database: string, sql: string) {
  const bin = process.env.CT_PG_BIN
    ? path.join(process.env.CT_PG_BIN, 'psql')
    : 'psql';
  return execFileSync(
    bin,
    [
      '-h',
      '127.0.0.1',
      '-p',
      '55432',
      '-U',
      'localtest',
      '-d',
      database,
      '-Atc',
      sql,
    ],
    { encoding: 'utf8', env: env() },
  ).trim();
}

function ownedCluster() {
  assert.equal(
    realpathSync(psql('postgres', 'SHOW data_directory')),
    realpathSync(path.resolve('.local/pgdata')),
  );
}

function dropDisposable(database: string) {
  assert.notEqual(database, 'ct_console_dev');
  psql(
    'postgres',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid()`,
  );
  const drop = process.env.CT_PG_BIN
    ? path.join(process.env.CT_PG_BIN, 'dropdb')
    : 'dropdb';
  execFileSync(drop, ['--if-exists', database], {
    env: env(),
    stdio: 'ignore',
  });
}

function exists(database: string) {
  return (
    psql(
      'postgres',
      `SELECT 1 FROM pg_database WHERE datname='${database}'`,
    ) === '1'
  );
}

function everydayTasks() {
  if (!exists('ct_console_dev')) return null;
  return psql('ct_console_dev', 'SELECT count(*) FROM ct.tasks');
}

function migrationFiles() {
  const script = readFileSync('tools/apply-console-migrations.sh', 'utf8');
  const listed = script.match(/for m in ([^;]+);do/);
  assert.ok(listed);
  const files = listed[1].trim().split(/\s+/);
  assert.equal(files.at(-1), '022-e2-derived-proposals.sql');
  return files;
}

function bash(
  script: string,
  database: string,
  extra: Record<string, string> = {},
) {
  return spawnSync('bash', [script, database], {
    encoding: 'utf8',
    env: env(extra),
  });
}

test('a half-built console database is refused and a failed new one is removed', () => {
  ownedCluster();
  const preserved = everydayTasks();
  dropDisposable(providerDb);
  const failedNew = bash('tools/ensure-console-db.sh', providerDb, {
    CT_CONSOLE_MIGRATION_PROBE_FAIL: 'yes',
  });
  assert.equal(failedNew.status, 1);
  assert.match(failedNew.stderr, /removed partially prepared/);
  assert.equal(exists(providerDb), false);
  const created = process.env.CT_PG_BIN
    ? path.join(process.env.CT_PG_BIN, 'createdb')
    : 'createdb';
  execFileSync(created, [providerDb], { env: env(), stdio: 'ignore' });
  const psqlBin = process.env.CT_PG_BIN
    ? path.join(process.env.CT_PG_BIN, 'psql')
    : 'psql';
  for (const file of migrationFiles()) {
    execFileSync(
      psqlBin,
      [
        '-h',
        '127.0.0.1',
        '-p',
        '55432',
        '-U',
        'localtest',
        '-d',
        providerDb,
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        `migrations/${file}`,
      ],
      { env: env(), stdio: 'pipe' },
    );
    if (file === '010-resource-controls.sql') break;
  }
  const incomplete = bash('tools/apply-console-migrations.sh', providerDb);
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /Refusing incomplete console database/);
  assert.equal(exists(providerDb), true);
  assert.equal(
    psql(providerDb, "SELECT to_regclass('ct.tenants') IS NOT NULL"),
    't',
  );
  assert.notEqual(
    psql(
      providerDb,
      "SELECT to_regclass('ct.e2_derivation_receipts') IS NOT NULL",
    ),
    't',
  );
  dropDisposable(providerDb);
  assert.equal(bash('tools/ensure-console-db.sh', providerDb).status, 0);
  psql(providerDb, 'DROP TABLE ct.applied_console_migrations');
  const legacy = bash('tools/apply-console-migrations.sh', providerDb);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(
    psql(providerDb, 'SELECT count(*) FROM ct.applied_console_migrations'),
    String(migrationFiles().length),
  );
  assert.equal(bash('tools/ensure-console-db.sh', providerDb).status, 0);
  assert.equal(everydayTasks(), preserved);
});

async function listenPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const number = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return number;
}

function startApi(port: number) {
  let text = '';
  const child = spawn(
    process.execPath,
    ['dist/internal/fixtures/console-server.js'],
    {
      env: env({
        CT_DATABASE: browserDb,
        CT_API_PORT: String(port),
        CT_FIXTURE_SERVER_KEY: 'setup-recovery-test',
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
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('API did not stop')), 8000),
    ),
  ]);
}

test('a half-built fixture example is not skipped on restart', async () => {
  ownedCluster();
  const preserved = everydayTasks();
  dropDisposable(browserDb);
  assert.equal(bash('tools/ensure-console-db.sh', browserDb).status, 0);
  const port = await listenPort();
  let running = startApi(port);
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (running.child.exitCode !== null) throw Error(running.output());
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/read');
        if (response.status < 500) break;
      } catch {
        /* still starting */
      }
      if (attempt === 79) throw Error(running.output());
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await stopApi(running.child);
    const tasksBefore = psql(
      browserDb,
      "SELECT count(*) FROM ct.tasks WHERE tenant='a'",
    );
    psql(
      browserDb,
      "DELETE FROM ct.work_coordination WHERE tenant='a' AND task='t-ledger-uncertain'",
    );
    running = startApi(port);
    const exited = await Promise.race([
      new Promise<number | null>((resolve) =>
        running.child.once('exit', (code) => resolve(code)),
      ),
      new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(null), 8000),
      ),
    ]);
    assert.notEqual(exited, 0);
    assert.match(running.output(), /ledger-uncertain is incomplete/);
    assert.equal(
      psql(
        browserDb,
        "SELECT count(*) FROM ct.tasks WHERE tenant='a' AND id='t-ledger-uncertain'",
      ),
      '1',
    );
    assert.equal(
      psql(browserDb, "SELECT count(*) FROM ct.tasks WHERE tenant='a'"),
      tasksBefore,
    );
  } finally {
    await stopApi(running.child);
  }
  assert.equal(everydayTasks(), preserved);
});
