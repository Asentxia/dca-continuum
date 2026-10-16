import type pg from 'pg';
import type { VerifiedIdentity } from './identity-provider.js';
export async function enrolled(
  c: pg.PoolClient,
  a: VerifiedIdentity,
  requireOwner = false,
) {
  const i = (
    await c.query(
      'SELECT * FROM ct.identities WHERE issuer=$1 AND subject=$2 AND audience=$3 AND kind=$4 FOR SHARE',
      [a.issuer, a.subject, a.audience, a.kind],
    )
  ).rows[0];
  const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
  if (!i || !i.active || a.expires <= now) throw Error('identity denied');
  if (
    requireOwner &&
    (a.kind !== 'user' ||
      i.domain_role !== 'owner' ||
      !a.methods.includes('mfa') ||
      a.authTime === undefined ||
      a.authTime > now + 5000 ||
      now - a.authTime > 300000)
  )
    throw Error('fresh owner MFA required');
  return i;
}
export function samePrincipal(i: Record<string, any>, principal: string) {
  if (
    i.kind === 'machine' &&
    (i.domain_role !== 'worker' || i.principal !== principal)
  )
    throw Error('principal scope');
}
export function identifier(s: string) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s))
    throw Error('invalid identifier');
  return s;
}
export async function activeControl(c: pg.PoolClient, fence: string) {
  const r = (
    await c.query('SELECT * FROM ct.control WHERE singleton FOR SHARE')
  ).rows[0];
  if (!r || r.blocked || r.fence !== fence) throw Error('recovery fence');
  return r;
}
