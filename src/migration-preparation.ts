import { canonical, sha } from './db.js';
export interface LegacySnapshot {
  tenantRef: string;
  principalRef: string;
  computerRef: string;
  operationId: string;
  providerKey: string;
  state: string;
  payload: unknown;
}
export interface ApprovedMapping {
  sourceTenant: string;
  tenant: string;
  sourcePrincipal: string;
  principal: string;
  sourceComputer: string;
  computer: string;
}
export function migrationDryRun(
  records: LegacySnapshot[],
  mapping: ApprovedMapping[],
) {
  const seen = new Map<string, string>(),
    imports: any[] = [];
  for (const r of records) {
    const m = mapping.find(
      (x) =>
        x.sourceTenant === r.tenantRef &&
        x.sourcePrincipal === r.principalRef &&
        x.sourceComputer === r.computerRef,
    );
    if (!m) throw Error('owner-approved identity mapping missing');
    if (!r.operationId || !r.providerKey)
      throw Error('stable operation/provider identity required');
    const key = m.tenant + '|' + r.operationId,
      digest = sha(canonical(r));
    if (seen.has(key) && seen.get(key) !== digest)
      throw Error('legacy identity conflict');
    if (seen.has(key)) continue;
    seen.set(key, digest);
    imports.push({
      tenant: m.tenant,
      principal: m.principal,
      computer: m.computer,
      operationId: r.operationId,
      providerKey: r.providerKey,
      sourceDigest: digest,
      sourceState: r.state,
      proposedState: [
        'SENDING',
        'RESERVED',
        'UNKNOWN',
        'dispatched',
        'running',
      ].includes(r.state)
        ? 'UNKNOWN'
        : 'HISTORICAL_UNVERIFIED',
      writeAuthorityImported: false,
    });
  }
  return {
    mode: 'DRY_RUN',
    imports,
    activate: false,
    authorityWrites: 0,
    providerCalls: 0,
    approvalRestored: false,
    sourceMutation: false,
  };
}
export interface LiveGate {
  id: string;
  status: 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT RUN';
  environment: 'approved-staging' | 'fixture' | 'none';
  evidenceReference: string;
}
const required = [
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
export function canaryEligibility(
  gates: LiveGate[],
  scheduler: string,
  ownerApproval: { releaseHash: string; approved: boolean } | undefined,
  releaseHash: string,
) {
  const missing = required.filter(
    (id) =>
      !gates.some(
        (g) =>
          g.id === id &&
          g.status === 'PASS' &&
          g.environment === 'approved-staging' &&
          g.evidenceReference,
      ),
  );
  if (!['temporal', 'pg-boss'].includes(scheduler))
    missing.push('FINAL_SCHEDULER');
  if (!ownerApproval?.approved || ownerApproval.releaseHash !== releaseHash)
    missing.push('EXPLICIT_OWNER_APPROVAL');
  return {
    verdict: missing.length ? 'NO-GO' : 'ELIGIBLE_FOR_REVIEW',
    missing,
    deploy: false,
    productionExecution: false,
  };
}
