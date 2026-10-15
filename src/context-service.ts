import type pg from 'pg';
import { tx, canonical, sha, append } from './db.js';
import { lockContextHead } from './context-lock.js';
import { enrolled, identifier } from './service-auth.js';
import type { VerifiedIdentity } from './identity-provider.js';
export interface ContextInput {
  id: string;
  expectedVersion: number;
  payload: unknown;
  source: { kind: 'agent' | 'document' | 'provider'; reference: string };
  ttlSeconds: number;
}
export type ContextReference = Readonly<{
  id: string;
  version: number;
  digest: string;
}>;
export type EnrolledProducerWitness = Readonly<{
  status: 'ENROLLED_PRODUCER';
  identityId: string;
  identityVersion: string;
  identityKind: 'user' | 'machine';
  tenant: string;
  principal: string | null;
}>;
export type ContextProvenance = Readonly<{
  version: 1;
  producer: EnrolledProducerWitness | Readonly<{ status: 'UNKNOWN' }>;
  upstreamOrigin: Readonly<{ status: 'UNVERIFIED' }>;
}>;
export type ContextResolution = Readonly<{
  id: string;
  version: number;
  digest: string;
  payload: unknown;
  source: unknown;
  provenance: ContextProvenance;
  authority: false;
}>;
function currentActor(actor: VerifiedIdentity, now: number) {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(actor.expires) ||
    actor.expires <= now
  )
    throw Error('identity denied');
}
function recordedProducer(i: Record<string, any>): EnrolledProducerWitness {
  const identityVersion = String(i.version);
  if (
    typeof i.id !== 'string' ||
    !i.id ||
    !/^-?(0|[1-9][0-9]*)$/.test(identityVersion) ||
    !['user', 'machine'].includes(i.kind) ||
    typeof i.tenant !== 'string' ||
    !i.tenant ||
    (i.principal != null && typeof i.principal !== 'string')
  )
    throw Error('producer enrollment unavailable');
  return {
    status: 'ENROLLED_PRODUCER',
    identityId: i.id,
    identityVersion,
    identityKind: i.kind,
    tenant: i.tenant,
    principal: i.principal ?? null,
  };
}
function provenanceView(source: unknown, tenant: string): ContextProvenance {
  // Historical source is returned unchanged. This UNKNOWN view is never persisted
  // or inferred from the current reader, a source attribution, or today's identity row.
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !Object.hasOwn(source, 'provenance')
  )
    return {
      version: 1,
      producer: { status: 'UNKNOWN' },
      upstreamOrigin: { status: 'UNVERIFIED' },
    };
  const p = (source as Record<string, any>).provenance;
  const producer = p?.producer;
  if (
    p?.version !== 1 ||
    p?.upstreamOrigin?.status !== 'UNVERIFIED' ||
    producer?.status !== 'ENROLLED_PRODUCER' ||
    typeof producer.identityId !== 'string' ||
    !producer.identityId ||
    typeof producer.identityVersion !== 'string' ||
    !/^-?(0|[1-9][0-9]*)$/.test(producer.identityVersion) ||
    !['user', 'machine'].includes(producer.identityKind) ||
    producer.tenant !== tenant ||
    (producer.principal !== null && typeof producer.principal !== 'string')
  )
    throw Error('context provenance unsupported/corrupt');
  return {
    version: 1,
    producer: {
      status: 'ENROLLED_PRODUCER',
      identityId: producer.identityId,
      identityVersion: producer.identityVersion,
      identityKind: producer.identityKind,
      tenant: producer.tenant,
      principal: producer.principal,
    },
    upstreamOrigin: { status: 'UNVERIFIED' },
  };
}
function contextDigest(x: Record<string, any>) {
  return sha(
    canonical({
      tenant: x.tenant,
      id: x.id,
      version: Number(x.version),
      principal: x.principal,
      payload: x.payload,
      source: x.source,
      observedAt: new Date(x.observed_at).toISOString(),
      expires: new Date(x.expires).toISOString(),
    }),
  );
}
export class ContextService {
  constructor(private db: pg.Pool) {}
  async ingest(actor: VerifiedIdentity, x: ContextInput) {
    // actor must come from the existing trusted verifier ingress. Its TypeScript
    // shape is not authentication of a deserialized or caller-constructed object.
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      identifier(x.id);
      if (
        !Number.isSafeInteger(x.expectedVersion) ||
        x.expectedVersion < 0 ||
        !Number.isSafeInteger(x.ttlSeconds) ||
        x.ttlSeconds < 1 ||
        x.ttlSeconds > 604800 ||
        Buffer.byteLength(canonical(x.payload)) > 131072 ||
        !x.source ||
        Object.keys(x.source).sort().join(',') !== 'kind,reference' ||
        !['agent', 'document', 'provider'].includes(x.source.kind) ||
        typeof x.source.reference !== 'string' ||
        x.source.reference.length > 256
      )
        throw Error('context bounds');
      const attribution = {
        kind: x.source.kind,
        reference: x.source.reference,
      };
      const peeked = (
        await c.query(
          'SELECT principal FROM ct.context_heads WHERE tenant=$1 AND id=$2',
          [i.tenant, x.id],
        )
      ).rows[0];
      let old: Record<string, any> | undefined;
      if (!peeked && i.principal)
        await c.query(
          'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, i.principal],
        );
      const current = peeked
        ? await lockContextHead(c, i.tenant, x.id)
        : (
            await c.query(
              'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
              [i.tenant, x.id],
            )
          ).rows[0];
      if (!current) {
        await c.query(
          'INSERT INTO ct.context_heads(tenant,id,principal) VALUES($1,$2,$3)',
          [i.tenant, x.id, i.principal],
        );
        old = (
          await c.query(
            'SELECT * FROM ct.context_heads WHERE tenant=$1 AND id=$2 FOR UPDATE',
            [i.tenant, x.id],
          )
        ).rows[0];
      } else old = current;
      if (old && i.kind === 'machine' && old.principal !== i.principal)
        throw Error('context principal scope');
      if ((old?.version ?? 0) !== x.expectedVersion || old?.deleted)
        throw Error('context version/tombstone conflict');
      const now = new Date(
        (await c.query('SELECT clock_timestamp() t')).rows[0].t,
      );
      // Enrollment stays share-locked; token validity must also survive head waits.
      currentActor(actor, +now);
      const v = {
        tenant: i.tenant,
        id: x.id,
        principal: old?.principal ?? i.principal ?? null,
        version: x.expectedVersion + 1,
        payload: canonical(x.payload),
        source: {
          ...attribution,
          provenance: {
            version: 1,
            producer: recordedProducer(i),
            upstreamOrigin: { status: 'UNVERIFIED' },
          } satisfies ContextProvenance,
        },
        observed_at: now,
        expires: new Date(+now + x.ttlSeconds * 1000),
      };
      const digest = contextDigest(v);
      await c.query(
        'INSERT INTO ct.context_versions(tenant,id,principal,version,payload,digest,source,observed_at,expires) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          v.tenant,
          v.id,
          v.principal,
          v.version,
          v.payload,
          digest,
          v.source,
          v.observed_at,
          v.expires,
        ],
      );
      await c.query(
        'UPDATE ct.context_heads SET version=$3,quarantined=true,revision=revision+1 WHERE tenant=$1 AND id=$2',
        [i.tenant, x.id, v.version],
      );
      await append(c, i.tenant, 'CONTEXT_INGESTED', {
        id: x.id,
        version: v.version,
        digest,
        quarantined: true,
        sourceKind: attribution.kind,
      });
      return { id: x.id, version: v.version, digest, quarantined: true };
    });
  }
  async approve(
    actor: VerifiedIdentity,
    id: string,
    version: number,
    digest: string,
    shareTenant = false,
  ) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      const headId = identifier(id);
      await lockContextHead(c, i.tenant, headId);
      const r = (
        await c.query(
          'SELECT h.*,v.digest,v.expires FROM ct.context_heads h JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version WHERE h.tenant=$1 AND h.id=$2',
          [i.tenant, headId],
        )
      ).rows[0];
      if (
        !r ||
        r.deleted ||
        r.version !== version ||
        r.digest !== digest ||
        +r.expires <= +(await c.query('SELECT clock_timestamp() t')).rows[0].t
      )
        throw Error('exact context review');
      await c.query(
        'UPDATE ct.context_heads SET quarantined=false,visibility=$3,revision=revision+1 WHERE tenant=$1 AND id=$2',
        [i.tenant, id, shareTenant ? 'TENANT' : 'PRIVATE'],
      );
      await append(c, i.tenant, 'CONTEXT_REVIEWED', {
        id,
        version,
        digest,
        owner: i.id,
        visibility: shareTenant ? 'TENANT' : 'PRIVATE',
        dataIsNotAuthority: true,
      });
      return { id, version };
    });
  }
  async get(actor: VerifiedIdentity, id: string, expectedVersion: number) {
    return this.readEligible(actor, id, expectedVersion);
  }
  async resolve(
    actor: VerifiedIdentity,
    reference: ContextReference,
  ): Promise<ContextResolution> {
    if (
      !reference ||
      typeof reference !== 'object' ||
      Array.isArray(reference) ||
      Object.keys(reference).sort().join(',') !== 'digest,id,version' ||
      !Number.isSafeInteger(reference.version) ||
      reference.version < 1 ||
      typeof reference.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(reference.digest)
    )
      throw Error('exact context reference required');
    identifier(reference.id);
    const result = await this.readEligible(
      actor,
      reference.id,
      reference.version,
      reference.digest,
    );
    if (!result.provenance) throw Error('context provenance unavailable');
    return { ...result, provenance: result.provenance };
  }
  private async readEligible(
    actor: VerifiedIdentity,
    id: string,
    expectedVersion: number,
    expectedDigest?: string,
  ) {
    const result = await tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      const headId = identifier(id);
      await lockContextHead(c, i.tenant, headId);
      const r = (
        await c.query(
          'SELECT v.*,h.quarantined,h.visibility,h.deleted FROM ct.context_heads h JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version WHERE h.tenant=$1 AND h.id=$2',
          [i.tenant, headId],
        )
      ).rows[0];
      const now = +new Date(
        (await c.query('SELECT clock_timestamp() t')).rows[0].t,
      );
      currentActor(actor, now);
      const expires = r ? +new Date(r.expires) : NaN;
      if (
        !r ||
        r.deleted ||
        r.erased_at ||
        r.quarantined ||
        r.version !== expectedVersion ||
        !Number.isFinite(expires) ||
        expires <= now ||
        (i.kind === 'machine' &&
          r.principal !== i.principal &&
          r.visibility !== 'TENANT')
      )
        return { error: 'context unavailable/stale/quarantined' };
      let decoded:
        | {
            payload: ReturnType<typeof JSON.parse>;
            provenance?: ContextProvenance;
          }
        | undefined;
      try {
        // Only pure stored-row integrity/decoding runs in this catch boundary.
        // Authorization, queries and caller-reference validation stay outside it.
        if (contextDigest(r) === r.digest)
          decoded = {
            payload: JSON.parse(r.payload),
            ...(expectedDigest === undefined
              ? {}
              : { provenance: provenanceView(r.source, i.tenant) }),
          };
      } catch {
        // A malformed persisted value is corruption, including invalid ISO dates.
        // Quarantine commits below; the public exception is raised after commit.
      }
      if (!decoded) {
        await c.query(
          'UPDATE ct.context_heads SET quarantined=true,revision=revision+1 WHERE tenant=$1 AND id=$2',
          [i.tenant, id],
        );
        await append(c, i.tenant, 'CONTEXT_CORRUPTION_QUARANTINED', {
          id,
          version: r.version,
        });
        return { error: 'context digest corruption' };
      }
      // A caller's wrong reference is not evidence that healthy stored data is corrupt.
      if (expectedDigest !== undefined && r.digest !== expectedDigest)
        return { error: 'context reference digest mismatch' };
      return {
        id: r.id,
        version: r.version,
        payload: decoded.payload,
        digest: r.digest,
        source: r.source,
        authority: false as const,
        ...(decoded.provenance ? { provenance: decoded.provenance } : {}),
      };
    });
    if ('error' in result) throw Error(result.error);
    return result;
  }
  async inspectQuarantine(actor: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      const r = (
        await c.query(
          'SELECT v.*,h.quarantined,h.deleted FROM ct.context_heads h JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version WHERE h.tenant=$1 AND h.id=$2',
          [i.tenant, identifier(id)],
        )
      ).rows[0];
      if (!r || r.deleted || r.erased_at || contextDigest(r) !== r.digest)
        throw Error('review data unavailable/corrupt');
      return {
        id: r.id,
        version: r.version,
        digest: r.digest,
        source: r.source,
        payload: JSON.parse(r.payload),
        quarantined: r.quarantined,
        authority: false,
      };
    });
  }
  async erase(actor: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      const headId = identifier(id);
      const r = await lockContextHead(c, i.tenant, headId);
      if (!r || r.deleted) throw Error('context scope');
      return this.eraseLocked(c, i.tenant, headId, i.id);
    });
  }
  private async eraseLocked(
    c: pg.PoolClient,
    tenant: string,
    id: string,
    owner: string,
  ) {
    await c.query(
      'UPDATE ct.context_versions SET payload=NULL,erased_at=clock_timestamp() WHERE tenant=$1 AND id=$2 AND erased_at IS NULL',
      [tenant, id],
    );
    await c.query(
      'UPDATE ct.context_heads SET deleted=true,quarantined=true,revision=revision+1 WHERE tenant=$1 AND id=$2',
      [tenant, id],
    );
    await append(c, tenant, 'CONTEXT_ERASED', {
      id,
      owner,
      payloadIncluded: false,
      backupRetentionSeparatelyRequired: true,
    });
    return { id, deleted: true };
  }
  async expire(actor: VerifiedIdentity) {
    const candidates = await tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      return (
        await c.query(
          'SELECT h.id,h.version FROM ct.context_heads h JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version WHERE h.tenant=$1 AND NOT h.deleted AND v.expires<=clock_timestamp()',
          [i.tenant],
        )
      ).rows.map((x) => ({ id: x.id as string, version: Number(x.version) }));
    });
    let erased = 0;
    for (const candidate of candidates) {
      const didErase = await tx(this.db, async (c) => {
        const i = await enrolled(c, actor, true);
        const head = await lockContextHead(c, i.tenant, candidate.id);
        if (!head || head.deleted || Number(head.version) !== candidate.version)
          return false;
        // Recheck fresh owner validity and current DB expiry after acquiring the lock.
        await enrolled(c, actor, true);
        const version = (
          await c.query(
            'SELECT erased_at,expires<=clock_timestamp() AS expired FROM ct.context_versions WHERE tenant=$1 AND id=$2 AND version=$3',
            [i.tenant, candidate.id, candidate.version],
          )
        ).rows[0];
        if (!version || version.erased_at || version.expired !== true)
          return false;
        await this.eraseLocked(c, i.tenant, candidate.id, i.id);
        return true;
      });
      if (didErase) erased++;
    }
    return erased;
  }
}
