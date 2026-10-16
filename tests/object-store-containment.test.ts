import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { LocalObjectStore, writeContainedFile } from '../src/object-store.js';

test('object writes do not follow a symlink in a parent directory', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-objects-'));
  const outside = path.join(base, 'outside');
  const root = path.join(base, 'root');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.mkdir(path.join(root, 'tenants'), { recursive: true, mode: 0o700 });
  await fs.symlink(outside, path.join(root, 'tenants', 'escaped'), 'dir');
  const store = new LocalObjectStore(root);
  try {
    await assert.rejects(
      store.putIfAbsent(
        'tenants/escaped/blob',
        Buffer.from('must-not-leave-the-root'),
      ),
      /object path/,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
test('swapping a parent directory after it is opened cannot redirect the write', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-objects-'));
  const outside = path.join(base, 'outside');
  const root = path.join(base, 'root');
  const real = path.join(base, 'tenants-real');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.mkdir(real, { recursive: true, mode: 0o700 });
  const parent = await fs.open(
    real,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  await fs.symlink(outside, root, 'dir');
  try {
    await writeContainedFile(parent, 'blob', Buffer.from('stays-in-inode'));
    assert.equal(
      await fs.readFile(path.join(real, 'blob'), 'utf8'),
      'stays-in-inode',
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await parent.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
