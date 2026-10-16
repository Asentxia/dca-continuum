import type pg from 'pg';
import { append, canonical, sha } from './db.js';

// Record, apply, and rebuild are separate transactions. Call each function
// inside its own BEGIN/COMMIT. Rollback undoes only that transaction.

type Head = { seq: number; hash: string };
type EvidenceRow = {
  seq: string | number;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
};
export type TenantNotice = {
  seq: number;
  hash: string;
  subjectId: string;
  text: string;
  source: 'governor';
};

function keys(value: object) {
  return Object.keys(value).sort().join(',');
}

function assertInput(tenant: string, subjectId: string, text: string) {
  if (typeof tenant !== 'string' || tenant.length < 1)
    throw Error('malformed tenant notice');
  if (
    typeof subjectId !== 'string' ||
    subjectId.length < 1 ||
    subjectId.length > 200
  )
    throw Error('malformed tenant notice');
  if (typeof text !== 'string' || text.length < 1 || text.length > 500)
    throw Error('malformed tenant notice');
}

function requireTenantNotice(tenant: string, kind: string, payload: string) {
  if (kind !== 'TENANT_NOTICE') throw Error('not a tenant notice');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw Error('malformed tenant notice');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('malformed tenant notice');
  const envelope = parsed as Record<string, unknown>;
  if (keys(envelope) !== 'body,envelope,source,subject,tenant')
    throw Error('malformed tenant notice');
  if (
    typeof envelope.envelope !== 'number' ||
    !Number.isInteger(envelope.envelope)
  )
    throw Error('malformed tenant notice');
  if (envelope.envelope !== 1) throw Error('unsupported tenant notice');
  if (envelope.tenant !== tenant || envelope.source !== 'governor')
    throw Error('malformed tenant notice');
  const subject = envelope.subject;
  const body = envelope.body;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject))
    throw Error('malformed tenant notice');
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Error('malformed tenant notice');
  const subjectRecord = subject as Record<string, unknown>;
  const bodyRecord = body as Record<string, unknown>;
  if (keys(subjectRecord) !== 'id,kind' || keys(bodyRecord) !== 'text')
    throw Error('malformed tenant notice');
  if (subjectRecord.kind !== 'notice') throw Error('malformed tenant notice');
  if (
    typeof subjectRecord.id !== 'string' ||
    subjectRecord.id.length < 1 ||
    subjectRecord.id.length > 200
  )
    throw Error('malformed tenant notice');
  if (
    typeof bodyRecord.text !== 'string' ||
    bodyRecord.text.length < 1 ||
    bodyRecord.text.length > 500
  )
    throw Error('malformed tenant notice');
  return {
    subjectId: subjectRecord.id,
    text: bodyRecord.text,
    source: 'governor' as const,
  };
}

async function lockHead(c: pg.PoolClient, tenant: string): Promise<Head> {
  const head = (
    await c.query(
      'SELECT seq, hash FROM ct.evidence_heads WHERE tenant=$1 FOR UPDATE',
      [tenant],
    )
  ).rows[0];
  if (!head) throw Error('missing evidence head');
  const seq = Number(head.seq);
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw Error('evidence chain does not match head');
  return { seq, hash: String(head.hash) };
}

async function events(c: pg.PoolClient, tenant: string) {
  return (
    await c.query(
      'SELECT seq, kind, payload, prev_hash, hash FROM ct.evidence_events WHERE tenant=$1 ORDER BY seq',
      [tenant],
    )
  ).rows as EvidenceRow[];
}

function assertChain(tenant: string, head: Head, rows: EvidenceRow[]) {
  if (head.seq === 0) {
    if (rows.length !== 0 || head.hash !== 'GENESIS')
      throw Error('evidence chain does not match head');
    return;
  }
  if (rows.length !== head.seq)
    throw Error('evidence chain does not match head');
  let prev = 'GENESIS';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seq = Number(row.seq);
    if (seq !== i + 1 || row.prev_hash !== prev)
      throw Error('evidence chain does not match head');
    const hash = sha(
      canonical({ tenant, seq, kind: row.kind, payload: row.payload, prev }),
    );
    if (row.hash !== hash) throw Error('evidence chain does not match head');
    prev = row.hash;
  }
  const last = rows[rows.length - 1];
  if (Number(last.seq) !== head.seq || last.hash !== head.hash)
    throw Error('evidence chain does not match head');
}

async function assertTail(c: pg.PoolClient, tenant: string) {
  const head = await lockHead(c, tenant);
  const latest = (
    await c.query(
      'SELECT seq, hash FROM ct.evidence_events WHERE tenant=$1 ORDER BY seq DESC LIMIT 1',
      [tenant],
    )
  ).rows[0] as { seq: string | number; hash: string } | undefined;
  if (!latest) {
    if (head.seq !== 0 || head.hash !== 'GENESIS')
      throw Error('evidence chain does not match head');
    return;
  }
  if (Number(latest.seq) !== head.seq || latest.hash !== head.hash)
    throw Error('evidence chain does not match head');
}

async function readEvent(c: pg.PoolClient, tenant: string, seq: number) {
  return (
    await c.query(
      'SELECT seq, kind, payload, prev_hash, hash FROM ct.evidence_events WHERE tenant=$1 AND seq=$2',
      [tenant, seq],
    )
  ).rows[0] as EvidenceRow | undefined;
}

async function writeNotice(
  c: pg.PoolClient,
  tenant: string,
  seq: number,
  notice: { subjectId: string; text: string; source: 'governor' },
) {
  await c.query('INSERT INTO ct.notice_deliveries(tenant, seq) VALUES($1,$2)', [
    tenant,
    seq,
  ]);
  await c.query(
    'INSERT INTO ct.notice_projection(tenant, seq, subject_id, body, source) VALUES($1,$2,$3,$4,$5)',
    [tenant, seq, notice.subjectId, notice.text, notice.source],
  );
}

// Recording checks the locked tail. Rehashing every earlier event would hold
// the shared evidence-head lock, which other appends use too. Apply and
// rebuild rehash the chain before they publish a projection.
export async function recordTenantNotice(
  c: pg.PoolClient,
  tenant: string,
  subjectId: string,
  text: string,
): Promise<TenantNotice> {
  assertInput(tenant, subjectId, text);
  await assertTail(c, tenant);
  const saved = await append(c, tenant, 'TENANT_NOTICE', {
    body: { text },
    envelope: 1,
    source: 'governor',
    subject: { id: subjectId, kind: 'notice' },
    tenant,
  });
  return {
    seq: saved.seq,
    hash: saved.hash,
    subjectId,
    text,
    source: 'governor',
  };
}

export async function applyTenantNotice(
  c: pg.PoolClient,
  tenant: string,
  seq: number,
) {
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw Error('missing evidence event');
  const head = await lockHead(c, tenant);
  assertChain(tenant, head, await events(c, tenant));
  const row = await readEvent(c, tenant, seq);
  if (!row) throw Error('missing evidence event');
  const notice = requireTenantNotice(tenant, row.kind, row.payload);
  const existing = await c.query(
    'SELECT 1 FROM ct.notice_deliveries WHERE tenant=$1 AND seq=$2',
    [tenant, seq],
  );
  if ((existing.rowCount ?? 0) > 0) return 'duplicate' as const;
  await writeNotice(c, tenant, seq, notice);
  return 'applied' as const;
}

export async function rebuildTenantNotices(c: pg.PoolClient, tenant: string) {
  const head = await lockHead(c, tenant);
  const rows = await events(c, tenant);
  assertChain(tenant, head, rows);
  await c.query('DELETE FROM ct.notice_projection WHERE tenant=$1', [tenant]);
  await c.query('DELETE FROM ct.notice_deliveries WHERE tenant=$1', [tenant]);
  let notices = 0;
  for (const row of rows) {
    if (row.kind !== 'TENANT_NOTICE') continue;
    const notice = requireTenantNotice(tenant, row.kind, row.payload);
    await writeNotice(c, tenant, Number(row.seq), notice);
    notices += 1;
  }
  return { notices };
}
