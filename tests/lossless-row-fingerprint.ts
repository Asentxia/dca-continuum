import assert from 'node:assert/strict';
import { canonical, sha } from '../src/db.js';

// Callers order rows in PostgreSQL and select to_jsonb(x)::text. Never hash
// JSONB decoded into JavaScript numbers: that can erase bigint differences.
export function losslessRowFingerprint(rows: readonly { row: unknown }[]) {
  assert.ok(
    rows.every((entry) => typeof entry.row === 'string'),
    'row fingerprints require lossless PostgreSQL text',
  );
  return {
    count: rows.length,
    sha256: sha(canonical(rows.map((entry) => entry.row))),
  };
}
