import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  operationTruth,
  computerTruth,
  groupFocus,
} from '../src/console/semantics.js';
test('A22/A24 COMMITTED without matching provider observation is never verified success', () => {
  assert.equal(
    operationTruth({
      state: 'COMMITTED',
      hash: 'valid-chain',
      provider: 'fixture',
    }).verified,
    false,
  );
});
test('A26 unknown Computer raw state remains unknown and LOST never becomes stopped', () => {
  assert.equal(computerTruth('LOST').domain, 'LOST');
  assert.equal(computerTruth('LOST').raw, 'unknown');
});
test('A03 shared root counts distinct tasks and never merges unrelated provider symptoms', () => {
  const x = groupFocus([
    {
      id: '1',
      root: 'incident:one',
      cause: 'OUTAGE',
      sourceVersion: 1,
      tasks: ['a', 'b'],
      severity: 1,
    },
    {
      id: '2',
      root: 'incident:one',
      cause: 'OUTAGE',
      sourceVersion: 1,
      tasks: ['a'],
      severity: 1,
    },
    {
      id: '3',
      root: 'incident:two',
      cause: 'AUTH',
      sourceVersion: 1,
      tasks: ['a'],
      severity: 0,
    },
  ]);
  assert.equal(x.length, 2);
  assert.equal(x.find((x: any) => x.root === 'incident:one')!.affectedCount, 2);
});

test('A23 public-read interpretation uses the actual imported adapter name and exact immutable selector', () => {
  const o = {
    state: 'COMMITTED',
    provider: 'github-public-readonly',
    action: 'readCommit',
    resource:
      'repo:Adaptive-Liquidity/Continuum@9ac4723b5390d22ed2d6aed9cf984cb0a32731ca',
    tenant: 'a',
    id: 'public-read',
    digest: 'a'.repeat(64),
    idempotency_key: 'public-read',
    params: {
      owner: 'Adaptive-Liquidity',
      repo: 'Continuum',
      commit: '9ac4723b5390d22ed2d6aed9cf984cb0a32731ca',
    },
  };
  const observation = {
    tenant: o.tenant,
    operation: o.id,
    digest: o.digest,
    idempotency_key: o.idempotency_key,
    payload: o.params,
  };
  assert.equal(
    operationTruth({ ...o, observation }).label,
    'Verified intended read',
  );
  assert.equal(
    operationTruth({ ...o, resource: 'arbitrary', observation }).verified,
    false,
  );
  assert.equal(
    operationTruth({ ...o, provider: 'github-readonly', observation }).verified,
    false,
  );
});
test('A26 all fifteen raw Computer states remain distinct; future states do not become stopped', () => {
  const raw = [
    'requested',
    'provisioning',
    'ready',
    'running',
    'paused',
    'stopped',
    'waking',
    'checkpointing',
    'recovering',
    'restore_failed',
    'recovery_failed',
    'cleanup_needed',
    'error',
    'deleting',
    'deleted',
  ];
  for (const value of raw) {
    const x = computerTruth('LOST', value);
    assert.equal(x.raw, value);
    assert.equal(x.knownRaw, true);
  }
  assert.equal(computerTruth('LOST', 'future-state').knownRaw, false);
});
