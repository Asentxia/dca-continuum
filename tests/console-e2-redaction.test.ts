import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/console/redaction.js';

test('generic console redaction never forwards E2 lineage handles or nested receipt IDs', () => {
  const value = redact({
    kind: 'agent',
    reference: 'ordinary-attribution',
    e2: {
      recordClass: 'E2_DERIVED_UNVERIFIED_V1',
      receiptId: 'restricted-one',
    },
    event: { receiptId: 'restricted-two', receipt_id: 'restricted-three' },
  });
  const rendered = JSON.stringify(value);
  for (const hidden of ['restricted-one', 'restricted-two', 'restricted-three'])
    assert.equal(rendered.includes(hidden), false);
  assert.equal(rendered.includes('ordinary-attribution'), true);
});

test('ordinary provenance and existing sensitive credential redaction remain intact', () => {
  assert.deepEqual(
    redact({
      provenance: { upstreamOrigin: { status: 'UNVERIFIED' } },
      credential: 'do-not-forward',
      count: 3,
    }),
    {
      provenance: { upstreamOrigin: { status: 'UNVERIFIED' } },
      credential: '[Redacted]',
      count: 3,
    },
  );
});
