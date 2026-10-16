import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the installed production PostCSS version matches the override', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const expected = pkg.overrides.postcss;
  assert.equal(lock.packages['node_modules/postcss'].version, expected);
});
