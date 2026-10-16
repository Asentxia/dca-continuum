import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function runMigrationHelper(
  env: Record<string, string | undefined>,
  stub = false,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ct-migration-guard-'));
  const log = path.join(directory, 'psql.log');
  const binary = path.join(directory, 'psql');
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CT_STUB_PSQL_LOG"\nif printf "%s" "$*" | grep -q data_directory; then printf "/tmp\\n"; fi\nexit 0\n',
  );
  chmodSync(binary, 0o755);
  const result = spawnSync(
    'bash',
    ['tools/apply-console-migrations.sh', 'ct_console_test'],
    {
      encoding: 'utf8',
      env: {
        ...env,
        PATH: stub ? `${directory}:/usr/bin:/bin` : '/usr/bin:/bin',
        CT_STUB_PSQL_LOG: log,
      },
    },
  );
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  rmSync(directory, { recursive: true, force: true });
  return { result, calls };
}

function assertNoSql(calls: string) {
  assert.equal(calls, '');
  assert.doesNotMatch(calls, /migrations\//);
}

test('migration helper rejects a non-local profile before SQL', () => {
  const { result, calls } = runMigrationHelper({
    CT_RUNTIME_ENV: 'production',
    CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing local fixtures/);
  assertNoSql(calls);
});

test('migration helper rejects a non-loopback endpoint before SQL', () => {
  const { result, calls } = runMigrationHelper({
    CT_RUNTIME_ENV: 'local-test',
    CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
    PGHOST: 'no-database.invalid',
    PGPORT: '55432',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing non-fixture database endpoint/);
  assertNoSql(calls);
});

test('migration helper rejects a libpq override before SQL', () => {
  const { result, calls } = runMigrationHelper({
    CT_RUNTIME_ENV: 'local-test',
    CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
    PGHOST: '127.0.0.1',
    PGPORT: '55432',
    PGOPTIONS: '-c search_path=public',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing libpq connection override/);
  assertNoSql(calls);
});

test('migration helper rejects a foreign cluster before applying migrations', () => {
  const { result, calls } = runMigrationHelper(
    {
      CT_RUNTIME_ENV: 'local-test',
      CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
      PGHOST: '127.0.0.1',
      PGPORT: '55432',
    },
    true,
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Refusing another cluster/);
  assert.match(calls, /data_directory/);
  assert.doesNotMatch(calls, /migrations\//);
});
