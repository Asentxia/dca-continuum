import type pg from 'pg';
import { sha } from '../../src/db.js';
import { assertLocalFixtures } from '../../src/runtime-profile.js';

// Retained M3 negative probe only. Not a product memory reader or an admission path.
export async function readLegacyM3Context(
  db: pg.Pool,
  id: string,
  expectedVersion: number,
) {
  assertLocalFixtures('legacy M3 memory probe');
  const o = (await db.query('SELECT * FROM ct.context_items WHERE id=$1', [id]))
    .rows[0];
  if (
    !o ||
    o.quarantined ||
    o.version !== expectedVersion ||
    sha(o.payload) !== o.digest
  )
    throw Error('context missing/stale/corrupt');
  return { id: o.id, version: o.version, payload: o.payload, digest: o.digest };
}
