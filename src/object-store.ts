import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const bytesHash = (b: Uint8Array) =>
  createHash('sha256').update(b).digest('hex');
export async function writeContainedFile(
  parent: fs.FileHandle,
  name: string,
  data: Uint8Array,
) {
  const dest = `/proc/self/fd/${parent.fd}/${name}`;
  try {
    const created = await fs.open(
      dest,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await created.writeFile(data);
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'ENOTDIR')
      throw Error('object path escapes');
    if (e.code !== 'EEXIST') throw e;
    const existing = await fs.open(
      dest,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const got = new Uint8Array(await existing.readFile());
      if (bytesHash(got) !== bytesHash(data))
        throw Error('immutable object conflict');
    } finally {
      await existing.close();
    }
  }
  await parent.sync();
}
export interface ImmutableObjectStore {
  putIfAbsent(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  erase(key: string): Promise<void>;
}
export function safeObjectKey(key: string) {
  if (
    typeof key !== 'string' ||
    key.length > 512 ||
    key
      .split('/')
      .some(
        (s) => !s || s === '.' || s === '..' || !/^[A-Za-z0-9._:-]+$/.test(s),
      )
  )
    throw Error('object key');
  return key;
}
export class LocalObjectStore implements ImmutableObjectStore {
  constructor(private root: string) {}
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await fs.lstat(this.root);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (s.mode & 0o077) !== 0 ||
      s.uid !== process.getuid?.()
    )
      throw Error('private trusted object root required');
  }
  private async parentDirectory(key: string) {
    await this.initialize();
    const parts = safeObjectKey(key).split('/');
    const handles: fs.FileHandle[] = [];
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let current = await fs.open(this.root, flags);
    handles.push(current);
    try {
      for (const part of parts.slice(0, -1)) {
        const via = `/proc/self/fd/${current.fd}/${part}`;
        let next: fs.FileHandle;
        try {
          next = await fs.open(via, flags);
        } catch (e: any) {
          if (e.code === 'ELOOP' || e.code === 'ENOTDIR')
            throw Error('object path escapes');
          if (e.code !== 'ENOENT') throw e;
          await fs.mkdir(via, { mode: 0o700 });
          try {
            next = await fs.open(via, flags);
          } catch (again: any) {
            if (again.code === 'ELOOP' || again.code === 'ENOTDIR')
              throw Error('object path escapes');
            throw again;
          }
        }
        handles.push(next);
        current = next;
      }
      return { parent: current, name: parts[parts.length - 1], handles };
    } catch (e) {
      await Promise.all(handles.map((handle) => handle.close()));
      throw e;
    }
  }
  async putIfAbsent(key: string, data: Uint8Array) {
    const opened = await this.parentDirectory(key);
    try {
      await writeContainedFile(opened.parent, opened.name, data);
    } finally {
      await Promise.all(opened.handles.map((handle) => handle.close()));
    }
  }
  async get(key: string) {
    const opened = await this.parentDirectory(key);
    let f: fs.FileHandle;
    try {
      f = await fs.open(
        `/proc/self/fd/${opened.parent.fd}/${opened.name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (e: any) {
      await Promise.all(opened.handles.map((handle) => handle.close()));
      if (e.code === 'ELOOP' || e.code === 'ENOTDIR')
        throw Error('object path escapes');
      throw e;
    }
    await Promise.all(opened.handles.map((handle) => handle.close()));
    try {
      const stat = await f.stat();
      if (stat.size > 16777216) throw Error('object size limit');
      return new Uint8Array(await f.readFile());
    } finally {
      await f.close();
    }
  }
  async erase(key: string) {
    const opened = await this.parentDirectory(key);
    try {
      await fs.unlink(`/proc/self/fd/${opened.parent.fd}/${opened.name}`);
    } catch (e: any) {
      if (e.code === 'ELOOP' || e.code === 'ENOTDIR')
        throw Error('object path escapes');
      if (e.code !== 'ENOENT') throw e;
    } finally {
      await Promise.all(opened.handles.map((handle) => handle.close()));
    }
  }
}
