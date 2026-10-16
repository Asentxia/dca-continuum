import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { tx, canonical, sha, append } from './db.js';
import { enrolled } from './service-auth.js';
import { validateContextReference } from './restricted-memory-protocol.js';
import type { VerifiedIdentity } from './identity-provider.js';
import type { ContextReference } from './context-service.js';
import {
  E2_EXTRACTION_PROTOCOL,
  E2_RECORD_CLASS,
  resolveE2Admission,
  authenticatedE2Review,
  type E2AdmissionInput,
  type E2AdmissionReceipt,
} from './e2-ingress.js';
import type { E2RecoveryGate, E2Lease } from './e2-recovery.js';
type Row = Record<string, any>;
type Storage = {
  digest(row: Row): string;
  producer(row: Row): unknown;
  insert(c: pg.PoolClient, row: Row): Promise<string>;
};
const denied = () => Error('E2 unavailable');
export async function isE2(
  c: pg.PoolClient,
  tenant: string,
  id: string,
  source: any,
) {
  return (
    Boolean(source && Object.hasOwn(source, 'e2')) ||
    (
      await c.query(
        'SELECT 1 FROM ct.e2_derivation_receipts WHERE tenant=$1 AND result_id=$2 LIMIT 1',
        [tenant, id],
      )
    ).rowCount !== 0
  );
}
/** Head already held; receipt locks last, sorted. Never acquires another head.
 * This records terminal negative state, not external durable acknowledgement.
 * No physical purge/recovery completeness claim follows from this DB update. */
export async function withdrawE2(
  c: pg.PoolClient,
  tenant: string,
  id: string,
  version: number,
  sourceCode: string,
  resultCode = 'RESULT_ERASED',
) {
  const receipts = (
    await c.query(
      `SELECT receipt_id FROM ct.e2_derivation_receipts
    WHERE tenant=$1 AND withdrawn_at IS NULL AND ((source_id=$2 AND source_version=$3) OR (result_id=$2 AND result_version=$3))
    ORDER BY receipt_id FOR UPDATE`,
      [tenant, id, version],
    )
  ).rows;
  for (const r of receipts)
    await c.query(
      `UPDATE ct.e2_derivation_receipts SET withdrawn_at=clock_timestamp(),
    withdrawal_code=CASE WHEN result_id=$2 THEN $3 ELSE $4 END WHERE tenant=$1 AND receipt_id=$5`,
      [tenant, id, resultCode, sourceCode, r.receipt_id],
    );
}
export class E2Storage {
  constructor(
    private db: pg.Pool,
    private storage: Storage,
    private gate?: E2RecoveryGate,
  ) {}
  private async lease() {
    if (!this.gate) throw denied();
    return this.gate.lease(); // external work OUTSIDE DB transaction
  }
  private async control(c: pg.PoolClient, lease: E2Lease) {
    const control = (
      await c.query('SELECT * FROM ct.control WHERE singleton FOR SHARE')
    ).rows[0];
    if (!control || control.blocked || control.fence !== lease.fence)
      throw denied();
  }
  private async fresh(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    witness: Row,
    lease: E2Lease,
    owner = false,
  ) {
    const current = await enrolled(c, actor, owner); // same SHARE-locked identity, fresh token/MFA
    const now = +new Date(
      (await c.query('SELECT clock_timestamp() t')).rows[0].t,
    );
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(actor.expires) ||
      actor.expires <= now ||
      now >= lease.validUntil ||
      current.id !== witness.id ||
      String(current.version) !== String(witness.version) ||
      current.tenant !== witness.tenant ||
      current.principal !== witness.principal
    )
      throw denied();
    return now;
  }
  private async row(c: pg.PoolClient, tenant: string, id: string) {
    return (
      await c.query(
        `SELECT v.*,h.quarantined,h.visibility,h.deleted FROM ct.context_heads h
      JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version
      WHERE h.tenant=$1 AND h.id=$2`,
        [tenant, id],
      )
    ).rows[0] as Row | undefined;
  }
  /** Discover entire lock set before acquiring any principal/head. Recheck discovery.
   * Existing identities SHARE -> sorted principals UPDATE -> sorted heads UPDATE
   * -> dedup advisory -> sorted receipts -> evidence head. No late owner lock. */
  private async lock(
    c: pg.PoolClient,
    tenant: string,
    principal: string | null,
    ids: string[],
  ) {
    const unique = [...new Set(ids)].sort();
    const discovered = (
      await c.query(
        'SELECT id,principal FROM ct.context_heads WHERE tenant=$1 AND id=ANY($2::text[]) ORDER BY id',
        [tenant, unique],
      )
    ).rows;
    const principals = [
      ...new Set(
        [principal, ...discovered.map((r) => r.principal)].filter(
          (p): p is string => typeof p === 'string',
        ),
      ),
    ].sort();
    for (const id of principals) {
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [tenant, id],
        )
      ).rows[0];
      if (!p || !p.active) throw denied();
    }
    const locked = (
      await c.query(
        'SELECT id,principal FROM ct.context_heads WHERE tenant=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',
        [tenant, unique],
      )
    ).rows;
    if (canonical(locked) !== canonical(discovered)) throw denied();
  }
  private allowed(
    r: Row | undefined,
    ref: ContextReference,
    now: number,
    principal: string | null,
    owner: boolean,
    quarantined = false,
  ) {
    const expires = r ? +new Date(r.expires) : NaN;
    return (
      !!r &&
      !r.deleted &&
      !r.erased_at &&
      r.payload !== null &&
      r.version === ref.version &&
      r.digest === ref.digest &&
      Number.isFinite(expires) &&
      expires > now &&
      (quarantined
        ? r.quarantined && r.visibility === 'PRIVATE'
        : !r.quarantined) &&
      (owner ||
        r.principal === principal ||
        (!quarantined && r.visibility === 'TENANT'))
    );
  }
  private async integrity(c: pg.PoolClient, tenant: string, rows: Row[]) {
    for (const r of rows) {
      let good = false;
      try {
        good = this.storage.digest(r) === r.digest;
        if (good) JSON.parse(r.payload);
      } catch {
        good = false;
      }
      if (!good) {
        await c.query(
          "UPDATE ct.context_heads SET quarantined=true,visibility='PRIVATE',revision=revision+1 WHERE tenant=$1 AND id=$2",
          [tenant, r.id],
        );
        await append(c, tenant, 'CONTEXT_CORRUPTION_QUARANTINED', {
          id: r.id,
          version: r.version,
        });
        return false; // sentinel commits protective mutation; throw only after tx
      }
    }
    return true;
  }
  private coherent(receipt: Row, source: Row, result: Row) {
    return (
      receipt.source_id === source.id &&
      receipt.source_version === source.version &&
      receipt.source_digest === source.digest &&
      receipt.result_id === result.id &&
      receipt.result_version === result.version &&
      receipt.result_digest === result.digest &&
      receipt.principal === result.principal &&
      result.source?.e2?.recordClass === E2_RECORD_CLASS &&
      canonical(result.source.e2) ===
        canonical({
          recordClass: E2_RECORD_CLASS,
          receiptId: receipt.receipt_id,
        }) &&
      !Object.hasOwn(source.source, 'e2') &&
      receipt.extraction_protocol_version === E2_EXTRACTION_PROTOCOL &&
      +new Date(receipt.result_expires) === +new Date(result.expires) &&
      +new Date(receipt.recorded_at) === +new Date(result.observed_at) &&
      +new Date(result.expires) <= +new Date(source.expires) &&
      result.source?.provenance?.upstreamOrigin?.status === 'UNVERIFIED'
    );
  }
  private metadata(r: Row): E2AdmissionReceipt {
    return {
      receiptId: r.receipt_id,
      source: {
        id: r.source_id,
        version: r.source_version,
        digest: r.source_digest,
      },
      result: {
        id: r.result_id,
        version: r.result_version,
        digest: r.result_digest,
      },
      recordedAt: new Date(r.recorded_at).toISOString(),
      resultExpires: new Date(r.result_expires).toISOString(),
      status: 'PRIVATE_QUARANTINED_UNVERIFIED',
      authority: false,
      execution: 'NONE',
    };
  }
  async admit(
    actor: VerifiedIdentity,
    input: E2AdmissionInput,
    retry = 0,
  ): Promise<E2AdmissionReceipt> {
    try {
      const x = resolveE2Admission(actor, input); // immutable bounded proposal snapshot, before locks
      const lease = await this.lease();
      const outcome = await tx(this.db, async (c) => {
        await this.control(c, lease);
        const i = await enrolled(c, actor);
        if (i.kind !== 'machine' || i.domain_role !== 'worker' || !i.principal)
          throw denied();
        const key = [
          i.tenant,
          i.principal,
          x.source.id,
          x.source.version,
          x.source.digest,
          E2_EXTRACTION_PROTOCOL,
        ];
        const query =
          'SELECT * FROM ct.e2_derivation_receipts WHERE tenant=$1 AND principal=$2 AND source_id=$3 AND source_version=$4 AND source_digest=$5 AND extraction_protocol_version=$6';
        const peek = (await c.query(query, key)).rows[0];
        await this.lock(c, i.tenant, i.principal, [
          x.source.id,
          ...(peek ? [peek.result_id] : []),
        ]);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'e2-dedup|' + canonical(key),
        ]);
        const receipt = (await c.query(query + ' FOR UPDATE', key)).rows[0];
        // A concurrent first admission may have added a new head outside discovery.
        // Never acquire it late; deny/retry the whole call instead.
        if (
          !!receipt !== !!peek ||
          (receipt && receipt.result_id !== peek.result_id)
        )
          return 'RETRY' as const;
        const now = await this.fresh(c, actor, i, lease);
        const source = await this.row(c, i.tenant, x.source.id);
        if (!this.allowed(source, x.source, now, i.principal, false))
          throw denied();
        if (!(await this.integrity(c, i.tenant, [source!]))) return null;
        if (await isE2(c, i.tenant, source!.id, source!.source)) throw denied();
        const binding = sha(
          canonical({
            extractionProtocol: x.extractionProtocol,
            source: x.source,
            proposal: x.proposal,
            ttlSeconds: x.ttlSeconds,
          }),
        );
        if (receipt) {
          const result = await this.row(c, i.tenant, receipt.result_id);
          if (
            receipt.withdrawn_at ||
            receipt.binding_digest !== binding ||
            !this.allowed(
              result,
              this.metadata(receipt).result,
              now,
              i.principal,
              false,
              true,
            )
          )
            throw denied();
          if (!(await this.integrity(c, i.tenant, [result!]))) return null;
          if (!this.coherent(receipt, source!, result!)) throw denied();
          return this.metadata(receipt);
        }
        if (now + x.ttlSeconds * 1000 > +new Date(source!.expires))
          throw denied();
        const id = 'e2-' + randomUUID(),
          receiptId = randomUUID();
        // New head key collision is never an overwrite. Principal already locked.
        await c.query(
          'INSERT INTO ct.context_heads(tenant,id,principal) VALUES($1,$2,$3)',
          [i.tenant, id, i.principal],
        );
        const v = {
          tenant: i.tenant,
          id,
          principal: i.principal,
          version: 1,
          payload: canonical(x.proposal),
          source: {
            kind: 'agent',
            reference: 'e2:derived',
            e2: { recordClass: E2_RECORD_CLASS, receiptId },
            provenance: {
              version: 1,
              producer: this.storage.producer(i),
              upstreamOrigin: { status: 'UNVERIFIED' },
            },
          },
          observed_at: new Date(now),
          expires: new Date(now + x.ttlSeconds * 1000),
        };
        const digest = await this.storage.insert(c, v);
        const r = {
          tenant: i.tenant,
          receipt_id: receiptId,
          principal: i.principal,
          source_id: x.source.id,
          source_version: x.source.version,
          source_digest: x.source.digest,
          result_id: id,
          result_version: 1,
          result_digest: digest,
          binding_digest: binding,
          extraction_protocol_version: E2_EXTRACTION_PROTOCOL,
          recorded_at: v.observed_at,
          result_expires: v.expires,
        };
        await c.query(
          `INSERT INTO ct.e2_derivation_receipts(${Object.keys(r).join(',')}) VALUES(${Object.keys(
            r,
          )
            .map((_, n) => '$' + (n + 1))
            .join(',')})`,
          Object.values(r),
        );
        await append(c, i.tenant, 'E2_ADMITTED', {
          receiptId,
          authority: false,
          execution: 'NONE',
        });
        return this.metadata(r);
      });
      if (outcome === 'RETRY') {
        if (retry >= 2) throw denied();
        return this.admit(actor, input, retry + 1);
      }
      if (!outcome) throw denied();
      return outcome;
    } catch {
      throw denied();
    }
  }
  async inspect(actor: VerifiedIdentity, reference: ContextReference) {
    try {
      if (!authenticatedE2Review(actor)) throw denied();
      const ref = validateContextReference(reference),
        lease = await this.lease();
      const outcome = await tx(this.db, async (c) => {
        await this.control(c, lease);
        const i = await enrolled(c, actor, true);
        const peek = (
          await c.query(
            'SELECT * FROM ct.e2_derivation_receipts WHERE tenant=$1 AND result_id=$2 AND result_version=$3',
            [i.tenant, ref.id, ref.version],
          )
        ).rows[0];
        if (!peek) throw denied();
        await this.lock(c, i.tenant, null, [peek.source_id, ref.id]);
        const r = (
          await c.query(
            'SELECT * FROM ct.e2_derivation_receipts WHERE tenant=$1 AND receipt_id=$2 FOR UPDATE',
            [i.tenant, peek.receipt_id],
          )
        ).rows[0];
        const now = await this.fresh(c, actor, i, lease, true);
        if (!r || r.withdrawn_at || canonical(r) !== canonical(peek))
          throw denied();
        const s = await this.row(c, i.tenant, r.source_id),
          v = await this.row(c, i.tenant, ref.id);
        if (
          !this.allowed(s, this.metadata(r).source, now, null, true) ||
          !this.allowed(v, ref, now, null, true, true)
        )
          throw denied();
        if (!(await this.integrity(c, i.tenant, [s!, v!]))) return null;
        if (!this.coherent(r, s!, v!)) throw denied();
        return {
          ...this.metadata(r),
          payload: JSON.parse(v!.payload),
          quarantined: true,
        };
      });
      if (!outcome) throw denied();
      return outcome;
    } catch {
      throw denied();
    }
  }
}
