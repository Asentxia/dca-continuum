import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
async function load(path: string) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
}
test('Legacy PostgreSQL dispatch guard refuses before SQL and never mints a token', async () => {
  const m = await load('tests/fixtures/legacy-fail-closed/effect-boundary.ts');
  const db = {
    query: () => {
      throw Error('SQL reached');
    },
  };
  await assert.rejects(
    new m.EffectBoundary().commitTimeRecheckAndDispatch(
      db,
      'a',
      { state: 'AWAITING_APPROVAL' },
      '',
    ),
    /disabled/,
  );
});
test('Legacy MCP no longer reports simulated dispatch success', async () => {
  const m = await load('tests/fixtures/legacy-fail-closed/mcp.ts');
  assert.equal(
    (await new m.ContinuumMCP().handleToolCall('execute_effect', {}, {}))
      .status,
    'NOT_ENABLED',
  );
});
