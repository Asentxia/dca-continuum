import type pg from 'pg';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { tx, canonical, sha, append } from './db.js';
import { reserveResources, settleResources } from './resource-controls.js';
import { enrolled, identifier } from './service-auth.js';
import type { VerifiedIdentity } from './identity-provider.js';
import { bytesHash, type ImmutableObjectStore } from './object-store.js';
export interface ArtifactManifest {
  tenant: string;
  id: string;
  computer: string;
  principal: string;
  generation: number;
  contractVersion: 1;
  files: { path: string; digest: string; size: number }[];
}
export function safeArtifactPath(s: string) {
  if (
    typeof s !== 'string' ||
    s.length > 256 ||
    s.startsWith('/') ||
    s.includes('\\') ||
    /[\x00-\x1f]/.test(s) ||
    s.split('/').some((x) => !x || x === '.' || x === '..')
  )
    throw Error('artifact relative path');
  return s;
}
export const blobKey = (tenant: string, digest: string) => {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw Error('blob digest');
  return `tenants/${sha(tenant)}/blobs/${digest}`;
};
export class ArtifactService {
  constructor(
    private db: pg.Pool,
    private objects: ImmutableObjectStore,
  ) {}
  private async gcLock(c: pg.PoolClient, tenant: string) {
    await c.query(
      'INSERT INTO ct.artifact_gc_locks(tenant) VALUES($1) ON CONFLICT DO NOTHING',
      [tenant],
    );
    await c.query(
      'SELECT * FROM ct.artifact_gc_locks WHERE tenant=$1 FOR UPDATE',
      [tenant],
    );
  }
  async capture(
    actor: VerifiedIdentity,
    id: string,
    computer: string,
    files: { path: string; bytes: Uint8Array }[],
  ) {
    const copied = files.map((f) => ({
      path: f.path,
      bytes: Uint8Array.from(f.bytes),
    }));
    if (
      !copied.length ||
      copied.length > 100 ||
      copied.reduce((n, f) => n + f.bytes.length, 0) > 8388608
    )
      throw Error('artifact bounds');
    const reservation = await tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      const comp = (
        await c.query('SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2', [
          i.tenant,
          identifier(computer),
        ])
      ).rows[0];
      if (!comp || (i.kind === 'machine' && comp.principal !== i.principal))
        throw Error('artifact computer scope');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR SHARE',
        [i.tenant, comp.principal],
      );
      const entries = copied
        .map((f) => ({
          path: safeArtifactPath(f.path),
          digest: bytesHash(f.bytes),
          size: f.bytes.length,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (new Set(entries.map((f) => f.path)).size !== entries.length)
        throw Error('duplicate artifact path');
      const manifest = {
          tenant: i.tenant,
          id,
          computer,
          principal: comp.principal,
          generation: comp.generation,
          contractVersion: 1,
          files: entries,
        },
        digest = sha(canonical(manifest));
      await reserveResources(
        c,
        i.tenant,
        'artifact',
        id,
        comp.principal,
        { units: 0, jobs: 0, bytes: entries.reduce((n, f) => n + f.size, 0) },
        digest,
        manifest,
      );
      return { tenant: i.tenant, digest };
    });
    try {
      return await this.captureReserved(
        actor,
        id,
        computer,
        copied,
        reservation.digest,
      );
    } catch (e) {
      await tx(this.db, async (c) => {
        await c.query(
          "UPDATE ct.resource_reservations SET state='UNCERTAIN' WHERE tenant=$1 AND kind='artifact' AND id=$2 AND state<>'SETTLED'",
          [reservation.tenant, id],
        );
      });
      throw e;
    }
  }
  private async captureReserved(
    actor: VerifiedIdentity,
    id: string,
    computer: string,
    files: { path: string; bytes: Uint8Array }[],
    expectedDigest: string,
  ) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      identifier(id);
      const pre = (
        await c.query('SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2', [
          i.tenant,
          computer,
        ])
      ).rows[0];
      if (!pre) throw Error('computer scope');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR SHARE',
        [i.tenant, pre.principal],
      );
      await this.gcLock(c, i.tenant);
      const r = (
        await c.query(
          'SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2 FOR SHARE',
          [i.tenant, identifier(computer)],
        )
      ).rows[0];
      if (!r || (i.kind === 'machine' && r.principal !== i.principal))
        throw Error('artifact computer scope');
      if (
        !files.length ||
        files.length > 100 ||
        files.reduce((n, x) => n + x.bytes.byteLength, 0) > 8388608 ||
        new Set(files.map((x) => x.path)).size !== files.length
      )
        throw Error('artifact bounds');
      const entries = files
        .map((f) => ({
          path: safeArtifactPath(f.path),
          digest: bytesHash(f.bytes),
          size: f.bytes.byteLength,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const manifest: ArtifactManifest = {
          tenant: i.tenant,
          id,
          computer: r.id,
          principal: r.principal,
          generation: r.generation,
          contractVersion: 1,
          files: entries,
        },
        digest = sha(canonical(manifest));
      if (digest !== expectedDigest)
        throw Error('artifact placement changed after reservation');
      const old = (
        await c.query(
          'SELECT * FROM ct.artifact_manifests WHERE tenant=$1 AND id=$2',
          [i.tenant, id],
        )
      ).rows[0];
      if (old) {
        if (old.digest !== digest || old.status !== 'READY')
          throw Error('artifact identity/status conflict');
        return { id, digest, reused: true };
      }
      for (const f of files) {
        const key = blobKey(i.tenant, bytesHash(f.bytes));
        await this.objects.putIfAbsent(key, f.bytes);
        const observed = await this.objects.get(key);
        if (
          bytesHash(observed) !== bytesHash(f.bytes) ||
          observed.length !== f.bytes.length
        )
          throw Error('artifact upload read-back mismatch');
      }
      if (
        actor.expires <=
        +(await c.query('SELECT clock_timestamp() t')).rows[0].t
      )
        throw Error('identity expired during upload');
      await c.query(
        'INSERT INTO ct.artifact_manifests(tenant,id,computer,principal,generation,manifest,digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [i.tenant, id, r.id, r.principal, r.generation, manifest, digest],
      );
      await append(c, i.tenant, 'ARTIFACT_CAPTURED', {
        id,
        digest,
        computer: r.id,
        generation: r.generation,
        files: entries.length,
        bytes: entries.reduce((n, f) => n + f.size, 0),
      });
      return { id, digest, reused: false };
    });
  }
  private async authorized(actor: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      const row = (
        await c.query(
          'SELECT * FROM ct.artifact_manifests WHERE tenant=$1 AND id=$2',
          [i.tenant, identifier(id)],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== 'READY' ||
        (i.kind === 'machine' && row.principal !== i.principal)
      )
        throw Error('artifact scope/status');
      if (sha(canonical(row.manifest)) !== row.digest)
        throw Error('artifact manifest digest');
      return { i, row };
    });
  }
  async restore(
    actor: VerifiedIdentity,
    id: string,
    trustedPrivateParent: string,
  ) {
    const { i, row } = await this.authorized(actor, id),
      manifest = row.manifest as ArtifactManifest;
    await fs.mkdir(trustedPrivateParent, { recursive: true, mode: 0o700 });
    const parent = await fs.lstat(trustedPrivateParent);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      parent.uid !== process.getuid?.()
    )
      throw Error('private restore parent required');
    const root = await fs.mkdtemp(path.join(trustedPrivateParent, 'restore-'));
    await fs.chmod(root, 0o700);
    try {
      for (const f of manifest.files) {
        safeArtifactPath(f.path);
        if (
          !/^[0-9a-f]{64}$/.test(f.digest) ||
          !Number.isSafeInteger(f.size) ||
          f.size < 0
        )
          throw Error('invalid artifact manifest entry');
        const data = await this.objects.get(blobKey(i.tenant, f.digest));
        if (data.byteLength !== f.size || bytesHash(data) !== f.digest)
          throw Error('artifact blob corruption');
        const target = path.join(root, f.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const out = await fs.open(
          target,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await out.writeFile(data);
          await out.sync();
        } finally {
          await out.close();
        }
      }
      // Recheck enrollment after I/O; no disabled machine receives reconstructed data.
      await this.authorized(actor, id);
      return {
        root,
        manifestDigest: row.digest,
        sourceGeneration: manifest.generation,
        scope:
          'verified private scratch reconstruction, not placement activation',
      };
    } catch (e) {
      await fs.rm(root, { recursive: true, force: true });
      await tx(this.db, async (c) => {
        await c.query(
          "UPDATE ct.artifact_manifests SET status='QUARANTINED' WHERE tenant=$1 AND id=$2 AND status='READY'",
          [i.tenant, id],
        );
        await append(c, i.tenant, 'ARTIFACT_RESTORE_QUARANTINED', {
          id,
          reason: 'restore validation failed',
        });
      });
      throw e;
    }
  }
  async erase(actor: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      await this.gcLock(c, i.tenant);
      const row = (
        await c.query(
          'SELECT * FROM ct.artifact_manifests WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, identifier(id)],
        )
      ).rows[0];
      if (!row || row.status === 'DELETED') throw Error('artifact scope');
      const digests = (row.manifest as ArtifactManifest).files.map(
        (f) => f.digest,
      );
      await c.query(
        "UPDATE ct.artifact_manifests SET status='DELETED' WHERE tenant=$1 AND id=$2",
        [i.tenant, id],
      );
      await c.query(
        'INSERT INTO ct.artifact_deletions(tenant,id,digests) VALUES($1,$2,$3)',
        [i.tenant, id, JSON.stringify(digests)],
      );
      await append(c, i.tenant, 'ARTIFACT_ERASE_REQUESTED', {
        id,
        owner: i.id,
        cloudRetentionSeparate: true,
      });
      return { id, deleted: true };
    });
  }
  async collect(actor: VerifiedIdentity) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      await this.gcLock(c, i.tenant);
      const deletions = (
          await c.query(
            'SELECT * FROM ct.artifact_deletions WHERE tenant=$1 AND NOT done FOR UPDATE',
            [i.tenant],
          )
        ).rows,
        active = (
          await c.query(
            "SELECT manifest,digest FROM ct.artifact_manifests WHERE tenant=$1 AND status<>'DELETED'",
            [i.tenant],
          )
        ).rows;
      if (active.some((r) => sha(canonical(r.manifest)) !== r.digest))
        throw Error('GC manifest corruption');
      const referenced = new Set(
        active.flatMap((r) =>
          (r.manifest as ArtifactManifest).files.map((f) => f.digest),
        ),
      );
      let erased = 0;
      for (const d of deletions) {
        for (const digest of d.digests as string[])
          if (!referenced.has(digest)) {
            await this.objects.erase(blobKey(i.tenant, digest));
            erased++;
          }
        await settleResources(c, i.tenant, 'artifact', d.id, 0, true);
        await c.query(
          'UPDATE ct.artifact_deletions SET done=true WHERE tenant=$1 AND id=$2',
          [i.tenant, d.id],
        );
      }
      await append(c, i.tenant, 'ARTIFACT_GC', {
        erasedObjects: erased,
        backupRetentionSeparatelyRequired: true,
      });
      return erased;
    });
  }
}
