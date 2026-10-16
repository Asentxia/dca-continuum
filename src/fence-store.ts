import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical } from './db.js';
export interface IndependentFence {
  revision: number;
  fence: string;
  blocked: boolean;
  authorityDigest: string;
  approvalDigest?: string;
}
export interface FenceStore {
  read(): Promise<IndependentFence>;
  advance(expected: number, authorityDigest: string): Promise<IndependentFence>;
  activate(expected: number, approvalDigest: string): Promise<void>;
}
// Offline adapter only. Its directory must be OUTSIDE PostgreSQL data/backups, mode 0700.
// A production stage must bind the same interface to an independently administered conditional store.
export class LocalIndependentFenceStore implements FenceStore {
  constructor(private directory: string) {}
  private filename() {
    return path.join(this.directory, 'fence.json');
  }
  async initialize(x: IndependentFence) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const f = await fs.open(this.filename(), 'wx', 0o600);
    try {
      await f.writeFile(canonical(x));
      await f.sync();
    } finally {
      await f.close();
    }
  }
  async read() {
    const f = await fs.open(
      this.filename(),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const x = JSON.parse(await f.readFile('utf8'));
      if (
        !Number.isSafeInteger(x.revision) ||
        x.revision < 1 ||
        typeof x.fence !== 'string' ||
        typeof x.blocked !== 'boolean' ||
        typeof x.authorityDigest !== 'string'
      )
        throw Error('invalid independent fence');
      return x as IndependentFence;
    } finally {
      await f.close();
    }
  }
  private async change(
    expected: number,
    fn: (x: IndependentFence) => IndependentFence,
  ) {
    const lock = await fs.open(
      path.join(this.directory, 'fence.lock'),
      'wx',
      0o600,
    );
    try {
      const old = await this.read();
      if (old.revision !== expected) throw Error('independent fence CAS');
      const next = fn(old),
        tmp = path.join(this.directory, randomUUID() + '.tmp'),
        out = await fs.open(tmp, 'wx', 0o600);
      try {
        await out.writeFile(canonical(next));
        await out.sync();
      } finally {
        await out.close();
      }
      await fs.rename(tmp, this.filename());
      const dir = await fs.open(this.directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return next;
    } finally {
      await lock.close();
      await fs.unlink(path.join(this.directory, 'fence.lock'));
    }
  }
  advance(expected: number, authorityDigest: string) {
    return this.change(expected, (x) => ({
      revision: x.revision + 1,
      fence: randomUUID(),
      blocked: true,
      authorityDigest,
    }));
  }
  async activate(expected: number, approvalDigest: string) {
    if (!/^[0-9a-f]{64}$/.test(approvalDigest))
      throw Error('approval manifest digest');
    await this.change(expected, (x) => {
      if (!x.blocked) throw Error('closed recovery required');
      return { ...x, revision: x.revision + 1, blocked: false, approvalDigest };
    });
  }
  async assertActive(expected: string) {
    const x = await this.read();
    if (x.blocked || x.fence !== expected)
      throw Error('independent recovery fence blocked/stale');
  }
}
export async function assertExternalFence(store: FenceStore, expected: string) {
  const x = await store.read();
  if (x.blocked || x.fence !== expected)
    throw Error('independent recovery fence blocked/stale');
}
