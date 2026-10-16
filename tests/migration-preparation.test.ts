import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrationDryRun,
  canaryEligibility,
  type LiveGate,
} from '../src/migration-preparation.js';
const mapping = [
    {
      sourceTenant: 'legacy-a',
      tenant: 'a',
      sourcePrincipal: 'old-worker',
      principal: 'new-worker',
      sourceComputer: 'old-computer',
      computer: 'logical-computer',
    },
  ],
  record = {
    tenantRef: 'legacy-a',
    principalRef: 'old-worker',
    computerRef: 'old-computer',
    operationId: 'stable-op',
    providerKey: 'stable-provider-key',
    state: 'dispatched',
    payload: { value: 'fixture' },
  };
test('Migration dry run preserves identities, treats partial effects as UNKNOWN and imports no authority', () => {
  const p = migrationDryRun([record], mapping);
  assert.equal(p.imports[0].operationId, record.operationId);
  assert.equal(p.imports[0].providerKey, record.providerKey);
  assert.equal(p.imports[0].proposedState, 'UNKNOWN');
  assert.equal(p.authorityWrites, 0);
  assert.equal(p.providerCalls, 0);
  assert.equal(p.activate, false);
});
test('Migration requires approved tenant/principal/computer mapping and rejects identity conflicts', () => {
  assert.throws(() => migrationDryRun([record], []));
  assert.throws(() =>
    migrationDryRun(
      [record, { ...record, payload: { value: 'changed' } }],
      mapping,
    ),
  );
  assert.equal(migrationDryRun([record, record], mapping).imports.length, 1);
});
test('Migration local green, PARTIAL or missing review cannot enable canary', () => {
  const ids = [
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'R1',
    'R2',
    'R3',
    'R4',
    'R5',
    'R6',
    'R7',
    'R8',
    'R9',
    'R10',
  ];
  const fixture: LiveGate[] = ids.map((id) => ({
    id,
    status: 'PASS',
    environment: 'fixture',
    evidenceReference: 'local',
  }));
  assert.equal(
    canaryEligibility(
      fixture,
      'temporal',
      { releaseHash: 'abc', approved: true },
      'abc',
    ).verdict,
    'NO-GO',
  );
  const partial: LiveGate[] = ids.map((id) => ({
    id,
    status: id === 'P1' ? 'PARTIAL' : 'PASS',
    environment: 'approved-staging',
    evidenceReference: 'ref',
  }));
  assert.equal(
    canaryEligibility(partial, 'HELD', undefined, 'abc').verdict,
    'NO-GO',
  );
});
test('Migration even eligible review never deploys or runs production by itself', () => {
  const ids = [
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'R1',
    'R2',
    'R3',
    'R4',
    'R5',
    'R6',
    'R7',
    'R8',
    'R9',
    'R10',
  ];
  const gates: LiveGate[] = ids.map((id) => ({
    id,
    status: 'PASS',
    environment: 'approved-staging',
    evidenceReference: 'fixture-logic-only',
  }));
  const r = canaryEligibility(
    gates,
    'pg-boss',
    { releaseHash: 'exact', approved: true },
    'exact',
  );
  assert.equal(r.verdict, 'ELIGIBLE_FOR_REVIEW');
  assert.equal(r.deploy, false);
  assert.equal(r.productionExecution, false);
  assert.equal(
    canaryEligibility(
      gates,
      'pg-boss',
      { releaseHash: 'wrong', approved: true },
      'exact',
    ).verdict,
    'NO-GO',
  );
});
