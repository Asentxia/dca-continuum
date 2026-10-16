import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('web/public/fonts');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'FONT-NOTICES.json'), 'utf8'),
);
test('vendored fonts ship their upstream notices', () => {
  assert.ok(Array.isArray(manifest.fonts) && manifest.fonts.length >= 2);
  for (const font of manifest.fonts) {
    const asset = path.join(root, font.file);
    const notice = path.join(root, font.notice);
    assert.equal(fs.existsSync(asset), true, font.file);
    const text = fs.readFileSync(notice, 'utf8');
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(
      text,
      new RegExp(font.copyright.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(font.license, 'OFL-1.1');
  }
});
