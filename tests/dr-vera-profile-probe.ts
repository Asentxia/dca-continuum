// Unregistered, synthetic local CLI for the parent's profile-native-closed mode.
// No database/service/process orchestration, migration, restore or activation.
// Importing this module performs no filesystem/database work; pure checks may
// import its schemas and assertions without invoking runProfileNativeProbe().
// The parent launch identity and lease mirror below are cooperative attestations,
// NOT an acquired lock, independent proof of exclusivity or effect authority.
// The trusted parent must actually hold its shared Lease, perform ownership/
// quarantine preflight and launch this child directly for every invocation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { canonical, sha, tx } from '../src/db.js';
import { activeControl, enrolled, identifier } from '../src/service-auth.js';
import {
  LocalIndependentFenceStore,
  type IndependentFence,
} from '../src/fence-store.js';
import { RecoveryService, type RecoveryPolicy } from '../src/recovery.js';
import { VeraService } from '../src/regency/vera-service.js';
import type { VerifiedIdentity } from '../src/identity-provider.js';

const scope = 'LOCAL_PROFILE_NATIVE_FIXTURE_ONLY';
const probeMode = 'profile-native-closed/v0.1';
const issuer = 'https://profile-native-fixture.invalid';
const audience = 'urn:continuum:profile-native-fixture';
const emptyJournalDigest = sha(canonical([]));
const frozenVeraHash =
  '296b720552850723745420cde99c633a8cc88340843ea6915ecce60a4d183dec';
const frozenProfileSqlHash =
  '28ead8dbb329a2430ad430111f51a7d100d72c94df50e0dc9db4315a9a72e26a';
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => v === v.trim());
const positiveDecimal = decimal.refine((v) => BigInt(v) > 0n);
const safeFenceRevision = positiveDecimal.refine(
  (v) => BigInt(v) < BigInt(Number.MAX_SAFE_INTEGER),
);
const hash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const gitHash = z
  .string()
  .length(40)
  .regex(/^[a-f0-9]{40}$/);
export const RunIdSchema = z
  .string()
  .length(36)
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const fenceText = z
  .string()
  .max(128)
  .refine((v) => {
    try {
      return identifier(v) === v && v.trim() === v;
    } catch {
      return false;
    }
  });
const pgUtcTime = z
  .string()
  .regex(
    /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?\+00$/,
  )
  .refine((v) => v === v.trim());
const processId = positiveDecimal.refine((v) => BigInt(v) <= 2147483647n);

export const PhaseSchema = z.enum([
  'seed-s0',
  'source-s1',
  'source-s2',
  'read-s0',
  'read-s1',
  'read-s2',
  'close-s0',
  'close-s1',
  'close-s2',
]);
export type Phase = z.infer<typeof PhaseSchema>;
export const StateSchema = z.enum(['S0', 'S1', 'S2']);
export type State = z.infer<typeof StateSchema>;
const SourcePhaseSchema = z.enum(['seed-s0', 'source-s1', 'source-s2']);
const ReadPhaseSchema = z.enum(['read-s0', 'read-s1', 'read-s2']);
export function parseProfileNativeCli(args: string[]) {
  const [runId, phase] = z.tuple([RunIdSchema, PhaseSchema]).parse(args);
  return { runId, phase };
}
export function phaseBinding(phase: Phase) {
  PhaseSchema.parse(phase);
  const state = phase.endsWith('s0')
    ? 'S0'
    : phase.endsWith('s1')
      ? 'S1'
      : 'S2';
  const source = phase === 'seed-s0' || phase.startsWith('source-');
  const directory = source
    ? 'primary'
    : state === 'S2'
      ? 'standby'
      : 'restored';
  return {
    state: StateSchema.parse(state),
    source,
    directory,
    port:
      directory === 'primary' ? 55440 : directory === 'standby' ? 55441 : 55442,
  } as const;
}
const CodeSchema = z
  .object({
    commit: gitHash,
    tree: gitHash,
    probeSourceSha256: hash,
    probeRuntimeSha256: hash,
    nodeVersion: z.literal('24.14.1'),
    runtimeEnvironment: z.literal('local-test'),
    probeMode: z.literal(probeMode),
  })
  .strict();
export const FenceSchema = z
  .object({
    revision: safeFenceRevision,
    fence: fenceText,
    blocked: z.boolean(),
    authorityDigest: z.literal(emptyJournalDigest),
  })
  .strict();
type FenceRecord = z.infer<typeof FenceSchema>;
export const OrchestrationSchema = z
  .object({
    kind: z.literal('local-ha-pitr-lab/profile-native-closed/v0.1'),
    id: RunIdSchema,
    runId: RunIdSchema,
    launcherPid: processId.refine((v) => BigInt(v) > 1n),
    active: z.literal(true),
  })
  .strict();
export const LeaseAttestationSchema = z
  .object({
    kind: z.literal('profile-native-shared-lease/v0.1'),
    runId: RunIdSchema,
    leaseId: RunIdSchema,
    root: z.string().min(1),
    ownerUid: decimal,
    active: z.literal(true),
    database: z.literal('ct_dr'),
    ports: z.tuple([z.literal(55440), z.literal(55441), z.literal(55442)]),
    commit: gitHash,
    tree: gitHash,
    orchestration: OrchestrationSchema,
  })
  .strict();
type LeaseAttestation = z.infer<typeof LeaseAttestationSchema>;
const ReplicationClientSchema = z
  .object({
    pid: processId,
    backendStart: pgUtcTime,
  })
  .strict();
export const ManifestSchema = z
  .object({
    kind: z.literal('profile-native-manifest/v0.1'),
    runId: RunIdSchema,
    phase: PhaseSchema,
    orchestration: OrchestrationSchema,
    leaseSha256: hash,
    code: CodeSchema,
    cluster: z
      .object({
        systemIdentifier: positiveDecimal.refine(
          (v) => BigInt(v) <= 18446744073709551615n,
        ),
        postmasterStart: pgUtcTime,
      })
      .strict(),
    sourceFence: fenceText,
    independentFence: FenceSchema,
    expectedSnapshotSha256: hash.nullable(),
    readReceiptSha256: hash.nullable(),
    replicationClient: ReplicationClientSchema.nullable(),
  })
  .strict()
  .superRefine((m, c) => {
    const b = phaseBinding(m.phase);
    const close = m.phase.startsWith('close-');
    if (m.orchestration.runId !== m.runId)
      c.addIssue({
        code: 'custom',
        message: 'active orchestration run required',
      });
    if ((m.phase === 'seed-s0') !== (m.expectedSnapshotSha256 === null))
      c.addIssue({
        code: 'custom',
        message: 'exact snapshot dependency required',
      });
    if (close !== (m.readReceiptSha256 !== null))
      c.addIssue({
        code: 'custom',
        message: 'close requires a prior read receipt',
      });
    // begin advances once. Reject before phase work if its returned fence
    // would exceed the unchanged FenceSchema's accepted range.
    if (
      close &&
      BigInt(m.independentFence.revision) + 1n >=
        BigInt(Number.MAX_SAFE_INTEGER)
    )
      c.addIssue({
        code: 'custom',
        message: 'recovery fence headroom required',
      });
    if (b.source) {
      if (
        m.independentFence.blocked ||
        m.independentFence.fence !== m.sourceFence
      )
        c.addIssue({
          code: 'custom',
          message: 'source requires active parent F0',
        });
    } else if (
      !m.independentFence.blocked ||
      m.independentFence.fence === m.sourceFence
    ) {
      c.addIssue({
        code: 'custom',
        message: 'rotated blocked parent handoff required',
      });
    }
    if (!b.source && m.replicationClient !== null)
      c.addIssue({
        code: 'custom',
        message: 'recovered image cannot admit a sender',
      });
  });
type Manifest = z.infer<typeof ManifestSchema>;

export function assertParentLaunchIdentity(
  env: Record<string, string | undefined>,
  runId: string,
  lease: LeaseAttestation,
  manifest: Manifest,
  actualParentPid: string,
) {
  need(
    lease.runId === runId &&
      manifest.runId === runId &&
      lease.orchestration.runId === runId &&
      env.CT_PROFILE_NATIVE_PARENT_LAUNCH === 'yes' &&
      env.CT_PROFILE_NATIVE_RUN_ID === runId &&
      env.CT_PROFILE_NATIVE_LEASE_ID === lease.leaseId &&
      env.CT_PROFILE_NATIVE_ORCHESTRATION_ID === lease.orchestration.id &&
      lease.orchestration.launcherPid === actualParentPid,
    'ACTIVE_PARENT_ORCHESTRATION_REQUIRED',
  );
  same(
    lease.orchestration,
    manifest.orchestration,
    'PARENT_ORCHESTRATION_BINDING',
  );
}

export function assertProfileNativeEnvironment(
  env: Record<string, string | undefined>,
  phase: Phase,
) {
  const port = phaseBinding(phase).port;
  need(
    env.CT_LOCAL_DR_LAB === 'yes' &&
      env.CT_RUNTIME_ENV === 'local-test' &&
      env.CT_ALLOW_LOCAL_FIXTURES === 'yes' &&
      env.NODE_ENV !== 'production' &&
      (!env.CT_DEPLOYMENT_ENV || env.CT_DEPLOYMENT_ENV === 'local-test') &&
      (!env.CT_CONSOLE_MODE || env.CT_CONSOLE_MODE === 'LOCAL_FIXTURE'),
    'ISOLATED_FLAGS',
  );
  for (const key of [
    'WORKOS_API_KEY',
    'WORKOS_CLIENT_ID',
    'WORKOS_COOKIE_PASSWORD',
    'DATABASE_URL',
    'CT_DATABASE_URL',
    'CT_PRODUCTION_CONFIG',
    'CT_STAGING_CONFIG',
    'PGPASSWORD',
    'PGPASSFILE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGHOSTADDR',
    'PGOPTIONS',
    'PGSSLCERT',
    'PGSSLKEY',
    'PGSSLROOTCERT',
  ])
    need(!env[key], 'LIVE_OR_CONNECTION_OVERRIDE');
  need(!env.PGHOST || env.PGHOST === '127.0.0.1', 'PGHOST');
  need(!env.PGPORT || env.PGPORT === String(port), 'PGPORT');
  need(!env.PGDATABASE || env.PGDATABASE === 'ct_dr', 'PGDATABASE');
  need(!env.CT_DATABASE || env.CT_DATABASE === 'ct_dr', 'CT_DATABASE');
}
function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw Object.assign(Error(code), { probeCode: code });
}
function same(actual: unknown, expected: unknown, code: string) {
  need(canonical(actual) === canonical(expected), code);
}
function bytesHash(b: Uint8Array) {
  return createHash('sha256').update(b).digest('hex');
}
export function fixtureBindings(runId: string) {
  RunIdSchema.parse(runId);
  const prefix = 'vnp-' + runId.replaceAll('-', '');
  return {
    tenantA: prefix + '-a',
    tenantB: prefix + '-b',
    operatorTenant: prefix + '-operator-tenant',
    ownerA: prefix + '-owner-a',
    ownerB: prefix + '-owner-b',
    operator: prefix + '-operator',
    principal: prefix + '-vera',
    c: prefix + '-c',
    temporaryPrincipal: prefix + '-fk-witness',
    refusedPrincipal: prefix + '-must-not-create',
  };
}
export function namedRestorePoint(runId: string) {
  RunIdSchema.parse(runId);
  return 'ct_profile_native_s1_' + runId.replaceAll('-', '');
}
type Bindings = ReturnType<typeof fixtureBindings>;
function requests(ids: Bindings) {
  return {
    a: {
      id: ids.principal,
      name: 'Original fixture VERA α A',
      description: 'S0 A\nLocal fixture only',
    },
    b: {
      id: ids.principal,
      name: 'Original fixture VERA β B',
      description: 'S0 B\nDifferent tenant',
    },
    c: {
      id: ids.c,
      name: 'WAL-created fixture VERA C',
      description: 'Created after the physical image',
    },
    s1: {
      id: ids.principal,
      name: 'S1 renamed VERA α A',
      description: 'Named WAL target\nImmutable creation retained',
    },
    s2: {
      id: ids.principal,
      name: 'S2 later VERA α A',
      description: 'After named target\nMust not appear in S1',
    },
  };
}
function syntheticActor(
  ids: Bindings,
  which: 'a' | 'b' | 'operator',
): VerifiedIdentity {
  const subject =
    which === 'a' ? ids.ownerA : which === 'b' ? ids.ownerB : ids.operator;
  const now = Date.now();
  // Same synthetic lifetime pattern as the existing native CLI, not live auth.
  return {
    issuer,
    subject,
    audience,
    kind: 'user',
    expires: now + 3600000,
    authTime: now,
    methods: ['mfa'],
  };
}
export function assertFixtureOperator(
  ids: Bindings,
  actor: VerifiedIdentity,
  identity: Record<string, unknown>,
) {
  need(
    actor.issuer === issuer &&
      actor.subject === ids.operator &&
      actor.audience === audience &&
      actor.kind === 'user' &&
      identity.id === ids.operator &&
      identity.tenant === ids.operatorTenant &&
      identity.issuer === issuer &&
      identity.subject === ids.operator &&
      identity.audience === audience &&
      identity.kind === 'user' &&
      identity.domain_role === 'owner' &&
      identity.active === true &&
      identity.principal === null,
    'EXPLICIT_FIXTURE_OPERATOR',
  );
}

export const NamedRoles = [
  'ct_owner',
  'ct_governor',
  'ct_authority_api',
  'ct_cap_issuer',
  'ct_controller',
  'ct_provider',
  'ct_product_api',
  'ct_computer_broker',
  'ct_context_service',
  'ct_recovery',
  'ct_evidence_export',
  'ct_resource_service',
  'ct_console_reader',
  'ct_tenant_a',
  'ct_tenant_b',
] as const;
const ConnectRoles = [
  'localtest',
  'ct_governor',
  'ct_authority_api',
  'ct_recovery',
  'ct_console_reader',
  'ct_tenant_a',
  'ct_tenant_b',
] as const;
type ConnectRole = (typeof ConnectRoles)[number];
export const ConsequentialTables = [
  'ct.grants',
  'ct.approvals',
  'ct.approval_history',
  'ct.assignments',
  'ct.operations',
  'ct.tasks',
  'ct.task_operations',
  'ct.computers',
  'ct.computer_observations',
  'ct.cognition_bindings',
  'ct.resource_limits',
  'ct.resource_reservations',
  'ct.outbox',
  'ct.inbox',
  'ct.manual_leases',
  'ct.console_commands',
  'ct.projects',
  'ct.work_coordination',
  'ct.task_dependencies',
  'ct.handoffs',
  'ct.incidents',
  'ct.incident_tasks',
  'ct.notifications',
  'ct.context_items',
  'ct.context_heads',
  'ct.context_versions',
  'ct.artifact_manifests',
  'ct.artifact_gc_locks',
  'ct.artifact_deletions',
  'provider.effects',
] as const;
const TextRowSchema = z.record(z.union([z.string(), z.null()]));
const TextRowsSchema = z.array(TextRowSchema);
export type PgTextRow = z.infer<typeof TextRowSchema>;
export function losslessPgTextRows(rows: unknown): PgTextRow[] {
  return TextRowsSchema.parse(rows);
}
const MetadataSchema = z
  .object({
    tables: TextRowsSchema,
    columns: TextRowsSchema,
    constraints: TextRowsSchema,
    policies: TextRowsSchema,
    tableAcl: TextRowsSchema,
    columnAcl: TextRowsSchema,
    trigger: TextRowsSchema,
    guard: TextRowsSchema,
    roles: TextRowsSchema,
    memberships: TextRowsSchema,
    privileges: TextRowsSchema,
  })
  .strict();
export const SnapshotDataSchema = z
  .object({
    tenants: TextRowsSchema,
    mappings: TextRowsSchema,
    profiles: TextRowsSchema,
    principals: TextRowsSchema,
    creators: TextRowsSchema,
    profileAudit: TextRowsSchema,
    events: TextRowsSchema,
    heads: TextRowsSchema,
    control: TextRowsSchema,
    recoveryRuns: TextRowsSchema,
    consequential: TextRowsSchema,
    metadata: MetadataSchema,
  })
  .strict();
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;
const ServerSchema = z
  .object({
    database: z.literal('ct_dr'),
    actor: z.literal('localtest'),
    address: z.literal('127.0.0.1'),
    port: positiveDecimal,
    version: decimal,
    directory: z.string(),
    systemIdentifier: positiveDecimal,
    postmasterStart: pgUtcTime,
    inRecovery: z.enum(['true', 'false']),
    replayPaused: z.enum(['true', 'false']),
    replayPauseState: z.enum(['not paused', 'pause requested', 'paused']),
    recoveryTargetName: z.string().nullable(),
    transactionReadOnly: z.enum(['on', 'off']),
  })
  .strict();
type Server = z.infer<typeof ServerSchema>;
export const SnapshotSchema = z
  .object({
    kind: z.literal('profile-native-snapshot/v0.1'),
    scope: z.literal(scope),
    runId: RunIdSchema,
    phase: SourcePhaseSchema,
    state: StateSchema,
    leaseId: RunIdSchema,
    orchestrationId: RunIdSchema,
    leaseSha256: hash,
    code: CodeSchema,
    server: ServerSchema,
    sourceFence: fenceText,
    sourceIndependentFence: FenceSchema,
    data: SnapshotDataSchema,
  })
  .strict()
  .superRefine((s, c) => {
    if (phaseBinding(s.phase).state !== s.state)
      c.addIssue({ code: 'custom', message: 'exact source stage required' });
  });
type Snapshot = z.infer<typeof SnapshotSchema>;
export const ReadReceiptSchema = z
  .object({
    kind: z.literal('profile-native-read/v0.1'),
    scope: z.literal(scope),
    runId: RunIdSchema,
    phase: ReadPhaseSchema,
    state: StateSchema,
    leaseId: RunIdSchema,
    orchestrationId: RunIdSchema,
    code: CodeSchema,
    expectedSnapshotSha256: hash,
    dataSha256: hash,
    server: ServerSchema,
    leaseSha256: hash,
    independentFence: FenceSchema,
  })
  .strict()
  .superRefine((r, c) => {
    if (phaseBinding(r.phase).state !== r.state || !r.independentFence.blocked)
      c.addIssue({
        code: 'custom',
        message: 'exact blocked read stage required',
      });
  });
type ReadReceipt = z.infer<typeof ReadReceiptSchema>;
const noAuthority = {
  effectAuthority: false,
  workflowAdmitted: false,
  externalEffect: false,
} as const;

function sortedRows(rows: PgTextRow[]) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows].sort(
    (a, b) =>
      compare(String(a.tenant ?? a.id), String(b.tenant ?? b.id)) ||
      compare(String(a.id ?? ''), String(b.id ?? '')),
  );
}
function expectedProfiles(ids: Bindings, state: State) {
  const x = requests(ids);
  const a = state === 'S0' ? x.a : state === 'S1' ? x.s1 : x.s2;
  const rows: PgTextRow[] = [
    {
      tenant: ids.tenantA,
      id: ids.principal,
      name: a.name,
      description: a.description,
      revision: state === 'S0' ? '1' : state === 'S1' ? '2' : '3',
      created_by: ids.ownerA,
      creation_digest: sha(canonical({ tenant: ids.tenantA, ...x.a })),
    },
    {
      tenant: ids.tenantB,
      id: ids.principal,
      name: x.b.name,
      description: x.b.description,
      revision: '1',
      created_by: ids.ownerB,
      creation_digest: sha(canonical({ tenant: ids.tenantB, ...x.b })),
    },
  ];
  if (state !== 'S0')
    rows.push({
      tenant: ids.tenantA,
      id: ids.c,
      name: x.c.name,
      description: x.c.description,
      revision: '1',
      created_by: ids.ownerA,
      creation_digest: sha(canonical({ tenant: ids.tenantA, ...x.c })),
    });
  return sortedRows(rows);
}
function expectedIdentities(ids: Bindings) {
  return sortedRows(
    [
      [ids.ownerA, ids.tenantA],
      [ids.ownerB, ids.tenantB],
      [ids.operator, ids.operatorTenant],
    ].map(([id, tenant]) => ({
      id,
      tenant,
      issuer,
      subject: id,
      audience,
      kind: 'user',
      principal: null,
      domain_role: 'owner',
      active: 'true',
      version: '1',
      lock_tag: '0',
    })),
  );
}
function eventSpec(ids: Bindings, state: State) {
  const x = requests(ids);
  const creation = (tenant: string, actor: string, input: typeof x.a) => ({
    tenant,
    kind: 'VERA_CREATED',
    payload: {
      id: input.id,
      actor,
      creationDigest: sha(canonical({ tenant, ...input })),
      profileRevision: 1,
      epoch: 1,
      generation: 1,
      active: true,
      executionMode: 'PAUSED',
      availability: 'requires_setup',
      ...noAuthority,
    },
  });
  const update = (input: typeof x.a, previousRevision: number) => ({
    tenant: ids.tenantA,
    kind: 'VERA_PROFILE_UPDATED',
    payload: {
      id: ids.principal,
      actor: ids.ownerA,
      previousRevision,
      revision: previousRevision + 1,
      profileDigest: sha(
        canonical({ name: input.name, description: input.description }),
      ),
      ...noAuthority,
    },
  });
  const a = [creation(ids.tenantA, ids.ownerA, x.a)];
  const specs: { tenant: string; kind: string; payload: unknown }[] = [...a];
  if (state !== 'S0')
    specs.push(update(x.s1, 1), creation(ids.tenantA, ids.ownerA, x.c));
  if (state === 'S2') specs.push(update(x.s2, 2));
  specs.push(creation(ids.tenantB, ids.ownerB, x.b));
  return specs;
}
export function verifyLedger(data: SnapshotData) {
  for (const head of data.heads) {
    need(
      head.tenant !== null && head.seq !== null && head.hash !== null,
      'HEAD_SHAPE',
    );
    let seq = 0n,
      previous = 'GENESIS';
    for (const event of data.events.filter(
      (row) => row.tenant === head.tenant,
    )) {
      need(
        event.seq !== null && event.kind !== null && event.payload !== null,
        'EVENT_SHAPE',
      );
      seq++;
      need(
        seq <= BigInt(Number.MAX_SAFE_INTEGER) && event.seq === String(seq),
        'FIXTURE_LEDGER_SEQUENCE',
      );
      same(event.prev_hash, previous, 'FIXTURE_LEDGER_PREVIOUS');
      previous = sha(
        canonical({
          tenant: head.tenant,
          seq: Number(seq),
          kind: event.kind,
          payload: event.payload,
          prev: previous,
        }),
      );
      same(event.hash, previous, 'FIXTURE_LEDGER_HASH');
    }
    same(head.seq, String(seq), 'FIXTURE_LEDGER_HEAD_SEQUENCE');
    same(head.hash, previous, 'FIXTURE_LEDGER_HEAD_HASH');
  }
  need(
    data.events.every((e) => data.heads.some((h) => h.tenant === e.tenant)),
    'ORPHAN_EVENT_TENANT',
  );
}
function assertZeroConsequences(data: SnapshotData) {
  same(
    data.consequential,
    [...ConsequentialTables].sort().map((table) => ({ table, rows: '0' })),
    'CONSEQUENTIAL_ROWS',
  );
}
function assertMetadata(data: SnapshotData) {
  const m = data.metadata;
  const table = m.tables.find((r) => r.table === 'vera_profiles');
  same(
    table,
    {
      table: 'vera_profiles',
      owner: 'ct_owner',
      rls: 'true',
      force_rls: 'true',
    },
    'PROFILE_TABLE_BOUNDARY',
  );
  const roles = m.roles.map((r) => r.role);
  same([...roles].sort(), [...NamedRoles].sort(), 'NAMED_ROLE_SET');
  for (const role of m.roles) {
    need(
      role.superuser === 'false' &&
        role.bypassrls === 'false' &&
        role.create_role === 'false' &&
        role.create_db === 'false' &&
        role.replication === 'false',
      'NON_OWNER_RUNTIME_ROLE',
    );
    if (role.role === 'ct_owner') same(role.login, 'false', 'OWNER_NOLOGIN');
  }
  const profileColumns = m.columns
    .filter((r) => r.table === 'vera_profiles')
    .map((r) => r.column);
  same(
    profileColumns,
    [
      'tenant',
      'id',
      'name',
      'description',
      'revision',
      'created_by',
      'creation_digest',
    ],
    'PROFILE_COLUMNS',
  );
  // Refuse an expanded identity/authority surface instead of silently omitting
  // newly introduced columns from the purported full row snapshots.
  same(
    m.columns.filter((r) => r.table === 'principals').map((r) => r.column),
    [
      'tenant',
      'id',
      'epoch',
      'generation',
      'active',
      'lock_tag',
      'execution_mode',
    ],
    'FULL_PINNED_PRINCIPAL_COLUMNS',
  );
  same(
    m.columns.filter((r) => r.table === 'identities').map((r) => r.column),
    [
      'id',
      'issuer',
      'subject',
      'audience',
      'kind',
      'tenant',
      'principal',
      'domain_role',
      'active',
      'version',
      'lock_tag',
    ],
    'FULL_PINNED_CREATOR_COLUMNS',
  );
  need(
    m.guard.length === 1 &&
      m.guard[0].owner === 'ct_owner' &&
      m.guard[0].security_definer === 'false',
    'PROFILE_INVOKER_GUARD',
  );
  need(
    m.trigger.length === 1 &&
      m.trigger[0].name === 'vera_profile_contract' &&
      m.trigger[0].enabled === 'O',
    'PROFILE_TRIGGER',
  );
  const fks = m.constraints.filter((r) => r.type === 'f');
  need(
    fks.length === 3 && fks.every((r) => r.validated === 'true'),
    'PROFILE_VALIDATED_FKS',
  );
  need(
    fks.some((r) =>
      /FOREIGN KEY \(tenant, id\).*principals\s*\(tenant, id\)/.test(
        r.definition ?? '',
      ),
    ),
    'PRINCIPAL_COMPOSITE_FK',
  );
  need(
    fks.some((r) =>
      /FOREIGN KEY \(tenant, created_by\).*identities\s*\(tenant, id\)/.test(
        r.definition ?? '',
      ),
    ),
    'CREATOR_COMPOSITE_FK',
  );
  for (const role of ['ct_governor', 'ct_authority_api'])
    for (const column of [
      'tenant',
      'id',
      'name',
      'description',
      'revision',
      'created_by',
      'creation_digest',
    ]) {
      const p = m.privileges.find(
        (r) => r.role === role && r.column === column,
      );
      need(
        p?.select === 'true' &&
          p.insert === 'true' &&
          p.delete === 'false' &&
          p.guard_execute === 'true',
        'TRUSTED_PROFILE_COLUMN_PRIVILEGES',
      );
      same(
        p.update,
        ['name', 'description', 'revision'].includes(column) ? 'true' : 'false',
        'COLUMN_UPDATE_PRIVILEGE',
      );
    }
  for (const role of NamedRoles.filter(
    (r) => !['ct_owner', 'ct_governor', 'ct_authority_api'].includes(r),
  )) {
    const read = ['ct_console_reader', 'ct_tenant_a', 'ct_tenant_b'].includes(
      role,
    );
    need(
      m.privileges.filter((r) => r.role === role).length === 7 &&
        m.privileges
          .filter((r) => r.role === role)
          .every(
            (r) =>
              r.select === (read ? 'true' : 'false') &&
              r.insert === 'false' &&
              r.update === 'false' &&
              r.delete === 'false' &&
              r.guard_execute === 'false',
          ),
      'NO_WORKER_PROFILE_WRITES',
    );
  }
}
export function assertSourceSnapshot(
  data: SnapshotData,
  ids: Bindings,
  state: State,
  sourceFence: string,
) {
  SnapshotDataSchema.parse(data);
  const tenants = [ids.tenantA, ids.tenantB, ids.operatorTenant].sort();
  same(
    data.tenants,
    tenants.map((id) => ({ id })),
    'OWNED_TENANTS',
  );
  same(
    data.mappings,
    [
      { db_role: 'ct_tenant_a', tenant: ids.tenantA },
      { db_role: 'ct_tenant_b', tenant: ids.tenantB },
    ],
    'OWNED_ROLE_MAPPINGS',
  );
  const profiles = expectedProfiles(ids, state);
  same(data.profiles, profiles, 'EXACT_PROFILE_STATE');
  same(
    data.principals,
    profiles.map((r) => ({
      tenant: r.tenant,
      id: r.id,
      epoch: '1',
      generation: '1',
      active: 'true',
      lock_tag: '0',
      execution_mode: 'PAUSED',
    })),
    'EXACT_PAUSED_PRINCIPALS',
  );
  same(data.creators, expectedIdentities(ids), 'EXACT_CREATOR_ENROLLMENTS');
  same(
    data.control,
    [
      {
        singleton: 'true',
        blocked: 'false',
        fence: sourceFence,
        lock_tag: '0',
      },
    ],
    'SOURCE_CONTROL_F0',
  );
  same(data.recoveryRuns, [], 'SOURCE_NO_RECOVERY_RUNS');
  const specs = eventSpec(ids, state);
  same(
    data.events.map((e) => ({
      tenant: e.tenant,
      kind: e.kind,
      payload: e.payload,
    })),
    specs.map((e) => ({
      tenant: e.tenant,
      kind: e.kind,
      payload: canonical(e.payload),
    })),
    'EXACT_PROFILE_AUDIT',
  );
  same(data.profileAudit, data.events, 'SOURCE_PROFILE_AUDIT_ONLY');
  same(
    data.heads.map((h) => h.tenant),
    tenants,
    'EXACT_HEAD_TENANTS',
  );
  assertZeroConsequences(data);
  assertMetadata(data);
  verifyLedger(data);
}
export function assertClosureDelta(
  before: SnapshotData,
  after: SnapshotData,
  ids: Bindings,
  previous: FenceRecord,
  current: FenceRecord,
  run: string,
) {
  RunIdSchema.parse(run);
  for (const key of [
    'tenants',
    'mappings',
    'profiles',
    'principals',
    'creators',
    'profileAudit',
    'consequential',
    'metadata',
  ] as const)
    same(after[key], before[key], 'CLOSURE_PRESERVED_' + key);
  need(before.control.length === 1, 'PRE_CLOSURE_CONTROL');
  same(
    after.control,
    [{ ...before.control[0], blocked: 'true', fence: current.fence }],
    'CLOSED_DB_CURRENT_FENCE',
  );
  need(
    current.blocked &&
      current.fence !== previous.fence &&
      BigInt(current.revision) === BigInt(previous.revision) + 1n &&
      current.authorityDigest === previous.authorityDigest,
    'ONE_CLOSED_FENCE_ADVANCE',
  );
  same(
    after.recoveryRuns,
    before.tenants.map(({ id: tenant }) => ({
      tenant,
      id: run,
      old_fence: previous.fence,
      new_fence: current.fence,
      external_revision: current.revision,
      state: 'BLOCKED',
      authority_digest: emptyJournalDigest,
      authority_checked: 'false',
      inventory_checked: 'false',
      inventory_digest: '',
      started_by: ids.operator,
    })),
    'ONLY_BLOCKED_RECOVERY_RUNS',
  );
  for (const h of before.heads) {
    const oldEvents = before.events.filter((r) => r.tenant === h.tenant);
    const events = after.events.filter((r) => r.tenant === h.tenant);
    same(events.slice(0, -1), oldEvents, 'CLOSURE_AUDIT_PREFIX');
    need(events.length === oldEvents.length + 1, 'ONE_BLOCK_EVENT_PER_TENANT');
    const last = events.at(-1)!;
    same(last.kind, 'RECOVERY_BLOCKED', 'BLOCK_EVENT_KIND');
    same(
      last.payload,
      canonical({
        run,
        newFence: current.fence,
        independentRevision: Number(current.revision),
        scope: 'cluster operator',
      }),
      'BLOCK_EVENT_PAYLOAD',
    );
    same(last.seq, String(BigInt(h.seq!) + 1n), 'BLOCK_EVENT_SEQUENCE');
  }
  same(
    after.heads.map((h) => h.tenant),
    before.heads.map((h) => h.tenant),
    'CLOSURE_HEAD_SCOPE',
  );
  assertZeroConsequences(after);
  verifyLedger(after);
}

type Reader = Pick<pg.PoolClient, 'query'>;
async function rows(c: Reader, sql: string, values: unknown[] = []) {
  return losslessPgTextRows((await c.query(sql, values)).rows);
}
const ProfileSelect =
  'SELECT tenant::text,id::text,name::text,description::text,revision::text,created_by::text,creation_digest::text FROM ct.vera_profiles ORDER BY tenant,id';
const EventsSelect =
  'SELECT tenant::text,seq::text,kind::text,payload::text,prev_hash::text,hash::text FROM ct.evidence_events';
async function capture(c: pg.PoolClient): Promise<SnapshotData> {
  const consequential: PgTextRow[] = [];
  for (const table of [...ConsequentialTables].sort())
    consequential.push({
      table,
      rows: (await rows(c, `SELECT count(*)::text AS rows FROM ${table}`))[0]
        .rows,
    });
  const privileges: PgTextRow[] = [];
  for (const role of NamedRoles)
    for (const column of [
      'tenant',
      'id',
      'name',
      'description',
      'revision',
      'created_by',
      'creation_digest',
    ])
      privileges.push(
        (
          await rows(
            c,
            `SELECT $1::text AS "role",$2::text AS "column",has_column_privilege($1::name,'ct.vera_profiles',$2,'SELECT')::text AS "select",has_column_privilege($1::name,'ct.vera_profiles',$2,'INSERT')::text AS "insert",has_column_privilege($1::name,'ct.vera_profiles',$2,'UPDATE')::text AS "update",has_table_privilege($1::name,'ct.vera_profiles','DELETE')::text AS "delete",has_function_privilege($1::name,'ct.guard_vera_profile()','EXECUTE')::text AS guard_execute`,
            [role, column],
          )
        )[0],
      );
  return SnapshotDataSchema.parse({
    tenants: await rows(c, 'SELECT id::text FROM ct.tenants ORDER BY id'),
    mappings: await rows(
      c,
      'SELECT db_role::text,tenant::text FROM ct.role_tenants ORDER BY db_role',
    ),
    profiles: await rows(c, ProfileSelect),
    principals: await rows(
      c,
      'SELECT tenant::text,id::text,epoch::text,generation::text,active::text,lock_tag::text,execution_mode::text FROM ct.principals ORDER BY tenant,id',
    ),
    creators: await rows(
      c,
      'SELECT id::text,tenant::text,issuer::text,subject::text,audience::text,kind::text,principal::text,domain_role::text,active::text,version::text,lock_tag::text FROM ct.identities ORDER BY tenant,id',
    ),
    profileAudit: await rows(
      c,
      EventsSelect +
        " WHERE kind IN('VERA_CREATED','VERA_PROFILE_UPDATED') ORDER BY tenant,seq",
    ),
    events: await rows(c, EventsSelect + ' ORDER BY tenant,seq'),
    heads: await rows(
      c,
      'SELECT tenant::text,seq::text,hash::text FROM ct.evidence_heads ORDER BY tenant',
    ),
    control: await rows(
      c,
      'SELECT singleton::text,blocked::text,fence::text,lock_tag::text FROM ct.control ORDER BY singleton',
    ),
    recoveryRuns: await rows(
      c,
      'SELECT tenant::text,id::text,old_fence::text,new_fence::text,external_revision::text,state::text,authority_digest::text,authority_checked::text,inventory_checked::text,inventory_digest::text,started_by::text FROM ct.recovery_runs ORDER BY tenant,id',
    ),
    consequential,
    metadata: {
      tables: await rows(
        c,
        `SELECT c.relname::text AS "table",r.rolname::text AS owner,c.relrowsecurity::text AS rls,c.relforcerowsecurity::text AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='ct' AND c.relname IN('vera_profiles','principals','identities') ORDER BY c.relname`,
      ),
      columns: await rows(
        c,
        `SELECT c.relname::text AS "table",a.attname::text AS "column",format_type(a.atttypid,a.atttypmod)::text AS type,a.attnotnull::text AS not_null,pg_get_expr(d.adbin,d.adrelid)::text AS "default" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='ct' AND c.relname IN('vera_profiles','principals','identities') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
      ),
      constraints: await rows(
        c,
        "SELECT conname::text AS name,contype::text AS type,convalidated::text AS validated,pg_get_constraintdef(oid,true)::text AS definition FROM pg_constraint WHERE conrelid='ct.vera_profiles'::regclass ORDER BY conname",
      ),
      policies: await rows(
        c,
        "SELECT policyname::text AS name,permissive::text,roles::text,cmd::text,qual::text,with_check::text FROM pg_policies WHERE schemaname='ct' AND tablename='vera_profiles' ORDER BY policyname",
      ),
      tableAcl: await rows(
        c,
        "SELECT COALESCE(g.rolname,'PUBLIC')::text AS grantee,r.rolname::text AS grantor,x.privilege_type::text,x.is_grantable::text FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles g ON g.oid=x.grantee JOIN pg_roles r ON r.oid=x.grantor WHERE c.oid='ct.vera_profiles'::regclass ORDER BY grantee,grantor,x.privilege_type",
      ),
      columnAcl: await rows(
        c,
        `SELECT a.attname::text AS "column",COALESCE(g.rolname,'PUBLIC')::text AS grantee,r.rolname::text AS grantor,x.privilege_type::text,x.is_grantable::text FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x LEFT JOIN pg_roles g ON g.oid=x.grantee JOIN pg_roles r ON r.oid=x.grantor WHERE a.attrelid='ct.vera_profiles'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname,grantee,grantor,x.privilege_type`,
      ),
      trigger: await rows(
        c,
        "SELECT tgname::text AS name,tgenabled::text AS enabled,pg_get_triggerdef(oid,true)::text AS definition FROM pg_trigger WHERE tgrelid='ct.vera_profiles'::regclass AND NOT tgisinternal ORDER BY tgname",
      ),
      guard: await rows(
        c,
        "SELECT p.prosrc::text AS source,p.prosecdef::text AS security_definer,r.rolname::text AS owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='ct.guard_vera_profile()'::regprocedure",
      ),
      roles: await rows(
        c,
        'SELECT rolname::text AS "role",rolsuper::text AS superuser,rolbypassrls::text AS bypassrls,rolcanlogin::text AS login,rolinherit::text AS inherit,rolcreaterole::text AS create_role,rolcreatedb::text AS create_db,rolreplication::text AS replication FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',
        [[...NamedRoles]],
      ),
      memberships: await rows(
        c,
        'SELECT r.rolname::text AS "role",u.rolname::text AS member,g.rolname::text AS grantor,m.admin_option::text,m.inherit_option::text,m.set_option::text FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member JOIN pg_roles g ON g.oid=m.grantor WHERE r.rolname=ANY($1::text[]) OR u.rolname=ANY($1::text[]) ORDER BY r.rolname,u.rolname,g.rolname',
        [[...NamedRoles]],
      ),
      privileges,
    },
  });
}

export function fixedProbePaths(root: string, runId: string, phase: Phase) {
  RunIdSchema.parse(runId);
  need(
    path.isAbsolute(root) && path.normalize(root) === root,
    'CANONICAL_ROOT',
  );
  const base = path.join(root, '.local', 'dr-lab');
  const evidence = path.join(
    root,
    '.artifacts',
    'implementation',
    'dr-lab',
    'profile-native',
    runId,
  );
  return {
    root,
    base,
    evidence,
    manifest: path.join(base, 'profile-native-manifest.json'),
    lease: path.join(base, 'profile-native-lease.json'),
    directory: path.join(base, phaseBinding(phase).directory),
    fence: path.join(base, 'independent', 'fence'),
    journal: path.join(base, 'independent', 'authority-journal.json'),
    source: path.join(root, 'tests', 'dr-vera-profile-probe.ts'),
    runtime: path.join(root, 'dist', 'tests', 'dr-vera-profile-probe.js'),
  };
}
async function directory(p: string) {
  const st = await fs.lstat(p);
  need(
    st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o022) === 0,
    'OWNED_ORDINARY_DIRECTORY',
  );
  need(
    st.uid === process.getuid!() && (await fs.realpath(p)) === p,
    'DIRECTORY_OWNERSHIP',
  );
}
async function descendants(root: string, p: string) {
  need(p === root || p.startsWith(root + path.sep), 'PATH_ESCAPE');
  await directory(root);
  let current = root;
  for (const part of path.relative(root, p).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await directory(current);
  }
}
async function ownedBytes(root: string, p: string) {
  await descendants(root, path.dirname(p));
  const handle = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    need(
      st.isFile() && st.uid === process.getuid!() && (st.mode & 0o022) === 0,
      'OWNED_ORDINARY_FILE',
    );
    const bytes = await handle.readFile();
    const named = await fs.lstat(p);
    need(
      !named.isSymbolicLink() && named.dev === st.dev && named.ino === st.ino,
      'FILE_REPLACED',
    );
    return bytes;
  } finally {
    await handle.close();
  }
}
function decode<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}
function fenceRecord(x: IndependentFence): FenceRecord {
  return FenceSchema.parse({
    revision: String(x.revision),
    fence: x.fence,
    blocked: x.blocked,
    authorityDigest: x.authorityDigest,
  });
}

class ProbeContext {
  readonly ids: Bindings;
  readonly binding: ReturnType<typeof phaseBinding>;
  readonly paths: ReturnType<typeof fixedProbePaths>;
  readonly pools = new Map<ConnectRole, pg.Pool>();
  readonly ownedPids = new Set<string>();
  readonly clientPids = new WeakMap<pg.PoolClient, string>();
  connectionFailure = false;
  readonly applicationName: string;
  readonly store: LocalIndependentFenceStore;
  manifest!: Manifest;
  manifestBytes!: Buffer;
  leaseBytes!: Buffer;
  parentLease!: LeaseAttestation;
  constructor(
    readonly root: string,
    readonly runId: string,
    readonly phase: Phase,
  ) {
    this.ids = fixtureBindings(runId);
    this.binding = phaseBinding(phase);
    this.paths = fixedProbePaths(root, runId, phase);
    this.applicationName = 'vnp_' + runId.slice(0, 8) + '_' + phase;
    this.store = new LocalIndependentFenceStore(this.paths.fence);
  }
  async initialize() {
    assertProfileNativeEnvironment(process.env, this.phase);
    need(process.versions.node === '24.14.1', 'APPROVED_NODE24');
    await descendants(this.root, this.paths.directory);
    await descendants(this.root, this.paths.fence);
    await descendants(this.root, this.paths.evidence);
    this.manifestBytes = await ownedBytes(this.root, this.paths.manifest);
    this.manifest = decode(this.manifestBytes, ManifestSchema);
    need(
      this.manifest.runId === this.runId && this.manifest.phase === this.phase,
      'CLI_MANIFEST_BINDING',
    );
    this.leaseBytes = await ownedBytes(this.root, this.paths.lease);
    const lease = (this.parentLease = decode(
      this.leaseBytes,
      LeaseAttestationSchema,
    ));
    need(
      lease.runId === this.runId &&
        lease.root === this.root &&
        lease.ownerUid === String(process.getuid!()) &&
        lease.commit === this.manifest.code.commit &&
        lease.tree === this.manifest.code.tree,
      'PARENT_SHARED_LEASE_BINDING',
    );
    assertParentLaunchIdentity(
      process.env,
      this.runId,
      lease,
      this.manifest,
      String(process.ppid),
    );
    same(
      bytesHash(this.leaseBytes),
      this.manifest.leaseSha256,
      'LEASE_ATTESTATION_HASH',
    );
    same(
      await fs.realpath(this.paths.runtime),
      fileURLToPath(import.meta.url),
      'FIXED_COMPILED_ENTRY',
    );
    await this.codeSeal();
    await this.journal();
    await this.fence(this.manifest.independentFence);
  }
  async codeSeal() {
    same(
      bytesHash(await ownedBytes(this.root, this.paths.source)),
      this.manifest.code.probeSourceSha256,
      'PROBE_SOURCE_SEAL',
    );
    same(
      bytesHash(await ownedBytes(this.root, this.paths.runtime)),
      this.manifest.code.probeRuntimeSha256,
      'PROBE_RUNTIME_SEAL',
    );
    same(
      bytesHash(
        await ownedBytes(
          this.root,
          path.join(this.root, 'src', 'regency', 'vera-service.ts'),
        ),
      ),
      frozenVeraHash,
      'FROZEN_VERA_SOURCE',
    );
    same(
      bytesHash(
        await ownedBytes(
          this.root,
          path.join(this.root, 'migrations', '021-vera-profiles.sql'),
        ),
      ),
      frozenProfileSqlHash,
      'FROZEN_PROFILE_SQL',
    );
  }
  async lease() {
    assertParentLaunchIdentity(
      process.env,
      this.runId,
      this.parentLease,
      this.manifest,
      String(process.ppid),
    );
    need(!this.connectionFailure, 'OWNED_CONNECTION_LOST_NO_RECONNECT');
    same(
      bytesHash(await ownedBytes(this.root, this.paths.manifest)),
      bytesHash(this.manifestBytes),
      'PHASE_MANIFEST_CHANGED',
    );
    same(
      bytesHash(await ownedBytes(this.root, this.paths.lease)),
      bytesHash(this.leaseBytes),
      'LEASE_ATTESTATION_CHANGED',
    );
    await this.codeSeal();
    await descendants(this.root, this.paths.directory);
    await descendants(this.root, this.paths.fence);
    await descendants(this.root, this.paths.evidence);
  }
  async journal() {
    const bytes = await ownedBytes(this.root, this.paths.journal);
    const records = decode(bytes, z.array(z.never()).length(0));
    same(
      sha(canonical(records)),
      emptyJournalDigest,
      'EXPLICIT_EMPTY_FIXTURE_JOURNAL',
    );
    return { records, digest: emptyJournalDigest };
  }
  async fence(expected?: FenceRecord) {
    await ownedBytes(this.root, path.join(this.paths.fence, 'fence.json'));
    const actual = fenceRecord(await this.store.read());
    if (expected) same(actual, expected, 'INDEPENDENT_FENCE_HANDOFF');
    return actual;
  }
  async db(role: ConnectRole) {
    need(ConnectRoles.includes(role), 'ALLOWLISTED_DB_ROLE');
    need(!this.connectionFailure, 'OWNED_CONNECTION_LOST_NO_RECONNECT');
    let pool = this.pools.get(role);
    if (!pool) {
      pool = new pg.Pool({
        host: '127.0.0.1',
        port: this.binding.port,
        database: 'ct_dr',
        user: role,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 2500,
        idleTimeoutMillis: 0,
        // Trust-only synthetic local transport. Never consult a password file
        // or accept credential-based authentication if ownership is wrong.
        password: () => {
          throw Object.assign(Error('CREDENTIAL_AUTH_FORBIDDEN'), {
            probeCode: 'CREDENTIAL_AUTH_FORBIDDEN',
          });
        },
        application_name: this.applicationName,
      });
      let connections = 0;
      pool.on('connect', () => {
        connections++;
        if (connections !== 1) this.connectionFailure = true;
      });
      pool.on('remove', (client) => {
        const pid = this.clientPids.get(client);
        if (pid) this.ownedPids.delete(pid);
        this.connectionFailure = true;
      });
      pool.on('error', () => {
        this.connectionFailure = true;
      });
      this.pools.set(role, pool);
      const c = await pool.connect();
      try {
        await c.query("SET TIME ZONE 'UTC'");
        await c.query("SET DateStyle='ISO, YMD'");
        await c.query('SET search_path=pg_catalog,ct');
        const r = (
          await rows(
            c,
            'SELECT current_database()::text AS database,session_user::text AS actor,host(inet_server_addr())::text AS address,inet_server_port()::text AS port,pg_postmaster_start_time()::text AS postmaster_start,pg_backend_pid()::text AS pid',
          )
        )[0];
        need(
          r.database === 'ct_dr' &&
            r.actor === role &&
            r.address === '127.0.0.1' &&
            r.port === String(this.binding.port) &&
            r.postmaster_start === this.manifest.cluster.postmasterStart,
          'ROLE_CONNECTION_FINGERPRINT',
        );
        const pid = processId.parse(r.pid);
        this.clientPids.set(c, pid);
        this.ownedPids.add(pid);
      } finally {
        c.release();
      }
    }
    return pool;
  }
  async server(c?: pg.PoolClient): Promise<Server> {
    const pool = await this.db('localtest');
    const result = await rows(
      c ?? pool,
      `SELECT current_database()::text AS database,session_user::text AS actor,host(inet_server_addr())::text AS address,inet_server_port()::text AS port,current_setting('server_version_num')::text AS version,current_setting('data_directory')::text AS directory,(pg_control_system()).system_identifier::text AS "systemIdentifier",pg_postmaster_start_time()::text AS "postmasterStart",pg_is_in_recovery()::text AS "inRecovery",CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused()::text ELSE 'false' END AS "replayPaused",CASE WHEN pg_is_in_recovery() THEN pg_get_wal_replay_pause_state()::text ELSE 'not paused' END AS "replayPauseState",current_setting('recovery_target_name',true)::text AS "recoveryTargetName",current_setting('transaction_read_only')::text AS "transactionReadOnly"`,
    );
    const r = ServerSchema.parse(result[0]);
    need(
      r.port === String(this.binding.port) &&
        BigInt(r.version) >= 170000n &&
        BigInt(r.version) < 180000n &&
        r.directory === this.paths.directory &&
        r.systemIdentifier === this.manifest.cluster.systemIdentifier &&
        r.postmasterStart === this.manifest.cluster.postmasterStart,
      'ACTUAL_OWNED_PG17',
    );
    await descendants(this.root, r.directory);
    return r;
  }
  async clients(c?: pg.PoolClient) {
    const pool = await this.db('localtest');
    const clients = await rows(
      c ?? pool,
      "SELECT pid::text,backend_start::text,backend_type::text,datname::text,usename::text,application_name::text,host(client_addr)::text AS address FROM pg_stat_activity WHERE backend_type IN('client backend','walsender') ORDER BY pid",
    );
    let senderSeen = false;
    for (const row of clients) {
      if (
        this.ownedPids.has(row.pid!) &&
        row.backend_type === 'client backend' &&
        row.datname === 'ct_dr' &&
        ConnectRoles.includes(row.usename as ConnectRole) &&
        row.application_name === this.applicationName &&
        row.address === '127.0.0.1'
      )
        continue;
      const declared = this.manifest.replicationClient;
      if (
        this.binding.source &&
        declared &&
        row.backend_type === 'walsender' &&
        row.datname === null &&
        row.usename === 'localtest' &&
        row.application_name === 'ct_local_standby' &&
        row.address === '127.0.0.1' &&
        row.pid === declared.pid &&
        row.backend_start === declared.backendStart
      ) {
        senderSeen = true;
        continue;
      }
      need(false, 'UNKNOWN_NATIVE_CLIENT');
    }
    need(
      !this.manifest.replicationClient || senderSeen,
      'DECLARED_SENDER_MISSING',
    );
  }
  async guard(expected: FenceRecord, c?: pg.PoolClient) {
    await this.lease();
    await this.journal();
    await this.fence(expected);
    const server = await this.server(c);
    await this.clients(c);
    return server;
  }
  async snapshot(expected: FenceRecord) {
    const pool = await this.db('localtest');
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.guard(expected, c);
      const data = await capture(c);
      await this.guard(expected, c);
      await c.query('COMMIT');
      return data;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  artifact(name: string) {
    need(
      /^(snapshot-s[012]|read-s[012]|close-s[012]|source-s[12]|seed-s0|failure-(seed-s0|source-s[12]|read-s[012]|close-s[012]))\.json$/.test(
        name,
      ),
      'FIXED_ARTIFACT_NAME',
    );
    return path.join(this.paths.evidence, name);
  }
  async unused(name: string) {
    try {
      await fs.lstat(this.artifact(name));
    } catch (e) {
      need((e as NodeJS.ErrnoException).code === 'ENOENT', 'ARTIFACT_STAT');
      return;
    }
    need(false, 'EXISTING_PHASE_ARTIFACT');
  }
  async write(name: string, data: unknown) {
    await descendants(this.root, this.paths.evidence);
    const h = await fs.open(
      this.artifact(name),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await h.writeFile(canonical(data) + '\n');
      await h.sync();
    } finally {
      await h.close();
    }
  }
  async expected(state: State): Promise<Snapshot> {
    const bytes = await ownedBytes(
      this.root,
      this.artifact('snapshot-' + state.toLowerCase() + '.json'),
    );
    same(
      bytesHash(bytes),
      this.manifest.expectedSnapshotSha256,
      'SOURCE_SNAPSHOT_DEPENDENCY',
    );
    const s = decode(bytes, SnapshotSchema);
    need(
      s.runId === this.runId &&
        s.state === state &&
        s.sourceFence === this.manifest.sourceFence,
      'SOURCE_SNAPSHOT_BINDING',
    );
    need(
      s.leaseId === this.parentLease.leaseId &&
        s.orchestrationId === this.parentLease.orchestration.id,
      'SOURCE_SNAPSHOT_PARENT_BINDING',
    );
    same(
      s.leaseSha256,
      this.manifest.leaseSha256,
      'SOURCE_SNAPSHOT_LEASE_HASH',
    );
    same(s.code, this.manifest.code, 'SOURCE_SNAPSHOT_CODE');
    need(
      s.server.port === '55440' &&
        s.server.directory === path.join(this.paths.base, 'primary') &&
        s.server.systemIdentifier === this.manifest.cluster.systemIdentifier &&
        BigInt(s.server.version) >= 170000n &&
        BigInt(s.server.version) < 180000n &&
        s.server.inRecovery === 'false' &&
        s.server.replayPaused === 'false' &&
        s.server.replayPauseState === 'not paused' &&
        s.server.transactionReadOnly === 'off' &&
        !s.sourceIndependentFence.blocked &&
        s.sourceIndependentFence.fence === s.sourceFence,
      'SOURCE_SNAPSHOT_FIXED_SERVER_F0',
    );
    if (this.binding.source)
      same(
        s.server.postmasterStart,
        this.manifest.cluster.postmasterStart,
        'UNCHANGED_SOURCE_SERVER',
      );
    assertSourceSnapshot(s.data, this.ids, state, this.manifest.sourceFence);
    return s;
  }
  async close() {
    const results = await Promise.allSettled(
      [...this.pools.values()].map((p) => p.end()),
    );
    need(
      results.every((r) => r.status === 'fulfilled'),
      'OWNED_POOL_CLOSE',
    );
  }
}

async function sourcePhase(c: ProbeContext) {
  const expectedFence = c.manifest.independentFence;
  const initialServer = await c.guard(expectedFence);
  need(
    initialServer.inRecovery === 'false' &&
      initialServer.transactionReadOnly === 'off',
    'SOURCE_WRITABLE_PRIMARY',
  );
  const before = await c.snapshot(expectedFence);
  const x = requests(c.ids);
  const state = c.binding.state;
  if (state === 'S0') {
    for (const key of [
      'tenants',
      'mappings',
      'profiles',
      'principals',
      'creators',
      'profileAudit',
      'events',
      'heads',
      'recoveryRuns',
    ] as const)
      same(before[key], [], 'FRESH_SOURCE_' + key);
    same(
      before.control,
      [
        {
          singleton: 'true',
          blocked: 'false',
          fence: c.manifest.sourceFence,
          lock_tag: '0',
        },
      ],
      'PARENT_SOURCE_READY',
    );
    assertZeroConsequences(before);
    assertMetadata(before);
    // Source-only explicit fixture enrollment. No historical identity adoption.
    const governor = await c.db('ct_governor');
    await c.guard(expectedFence);
    await tx(governor, async (client) => {
      await activeControl(client, c.manifest.sourceFence);
      for (const tenant of [
        c.ids.tenantA,
        c.ids.tenantB,
        c.ids.operatorTenant,
      ]) {
        await client.query('INSERT INTO ct.tenants(id) VALUES($1)', [tenant]);
        await client.query('INSERT INTO ct.evidence_heads(tenant) VALUES($1)', [
          tenant,
        ]);
      }
      await client.query(
        'INSERT INTO ct.role_tenants(db_role,tenant) VALUES($1,$2),($3,$4)',
        ['ct_tenant_a', c.ids.tenantA, 'ct_tenant_b', c.ids.tenantB],
      );
      for (const [id, tenant] of [
        [c.ids.ownerA, c.ids.tenantA],
        [c.ids.ownerB, c.ids.tenantB],
        [c.ids.operator, c.ids.operatorTenant],
      ])
        await client.query(
          "INSERT INTO ct.identities(id,issuer,subject,audience,kind,tenant,domain_role) VALUES($1,$2,$1,$3,'user',$4,'owner')",
          [id, issuer, audience, tenant],
        );
      await c.guard(expectedFence);
    });
  } else {
    const prior = await c.expected(state === 'S1' ? 'S0' : 'S1');
    same(before, prior.data, 'SOURCE_EXACT_PRIOR_STATE');
    same(expectedFence, prior.sourceIndependentFence, 'SOURCE_F0_UNCHANGED');
  }
  const db = await c.db('ct_authority_api');
  const service = new VeraService(db, c.manifest.sourceFence);
  const ownerA = syntheticActor(c.ids, 'a');
  const ownerB = syntheticActor(c.ids, 'b');
  await c.guard(expectedFence);
  await tx(db, async (client) => {
    if (state === 'S0') {
      const a = await service.create(ownerA, x.a, client);
      const b = await service.create(ownerB, x.b, client);
      need(!a.reused && !b.reused, 'SOURCE_CREATED_NOT_ADOPTED');
      same(
        {
          effectAuthority: a.effectAuthority,
          workflowAdmitted: a.workflowAdmitted,
          externalEffect: a.externalEffect,
        },
        noAuthority,
        'SOURCE_NO_AUTHORITY',
      );
    } else {
      const update = await service.updateProfile(
        ownerA,
        {
          ...(state === 'S1' ? x.s1 : x.s2),
          expectedRevision: state === 'S1' ? 1 : 2,
        },
        client,
      );
      same(update.revision, state === 'S1' ? 2 : 3, 'SOURCE_EXACT_CAS');
      if (state === 'S1')
        need(
          !(await service.create(ownerA, x.c, client)).reused,
          'WAL_NEW_PROFILE',
        );
    }
    await c.guard(expectedFence);
    // Caller-owned transaction boundary: recheck original actors, never mint a
    // replacement freshness assertion to hide a wait inside the service unit.
    await activeControl(client, c.manifest.sourceFence);
    await enrolled(client, ownerA, true);
    if (state === 'S0') await enrolled(client, ownerB, true);
  });
  const data = await c.snapshot(expectedFence);
  assertSourceSnapshot(data, c.ids, state, c.manifest.sourceFence);
  const server = await c.guard(expectedFence);
  need(
    server.inRecovery === 'false' && server.transactionReadOnly === 'off',
    'SOURCE_WRITABLE_PRIMARY',
  );
  const snapshot: Snapshot = {
    kind: 'profile-native-snapshot/v0.1',
    scope,
    runId: c.runId,
    state,
    phase: SourcePhaseSchema.parse(c.phase),
    leaseId: c.parentLease.leaseId,
    orchestrationId: c.parentLease.orchestration.id,
    leaseSha256: c.manifest.leaseSha256,
    server,
    code: c.manifest.code,
    sourceFence: c.manifest.sourceFence,
    sourceIndependentFence: expectedFence,
    data,
  };
  const name = 'snapshot-' + state.toLowerCase() + '.json';
  await c.write(name, snapshot);
  return {
    scope,
    phase: c.phase,
    state,
    snapshotSha256: bytesHash(Buffer.from(canonical(snapshot) + '\n')),
    dataSha256: sha(canonical(data)),
    noAuthority,
    nativeQualification: 'NOT CLAIMED',
  };
}
async function readPhase(c: ProbeContext) {
  const source = await c.expected(c.binding.state);
  const parentFence = c.manifest.independentFence;
  need(
    BigInt(parentFence.revision) >
      BigInt(source.sourceIndependentFence.revision),
    'PARENT_FENCE_ADVANCED',
  );
  const server = await c.guard(parentFence);
  if (c.binding.state === 'S1')
    need(
      server.inRecovery === 'true' &&
        server.replayPaused === 'true' &&
        server.replayPauseState === 'paused' &&
        server.recoveryTargetName === namedRestorePoint(c.runId),
      'NAMED_PITR_PAUSED',
    );
  if (c.binding.state === 'S0')
    need(server.inRecovery === 'false', 'CONSISTENT_PHYSICAL_IMAGE');
  const data = await c.snapshot(parentFence);
  same(data, source.data, 'EXACT_RESTORED_PRE_CLOSURE_DATA');
  const receipt: ReadReceipt = {
    kind: 'profile-native-read/v0.1',
    scope,
    runId: c.runId,
    phase: ReadPhaseSchema.parse(c.phase),
    state: c.binding.state,
    code: c.manifest.code,
    leaseId: c.parentLease.leaseId,
    orchestrationId: c.parentLease.orchestration.id,
    expectedSnapshotSha256: c.manifest.expectedSnapshotSha256!,
    dataSha256: sha(canonical(data)),
    server,
    leaseSha256: c.manifest.leaseSha256,
    independentFence: parentFence,
  };
  await c.write(c.phase + '.json', receipt);
  return {
    scope,
    phase: c.phase,
    state: c.binding.state,
    exactPreClosureData: true,
    mutatorsAdmitted: false,
    readReceiptSha256: bytesHash(Buffer.from(canonical(receipt) + '\n')),
    nativeQualification: 'NOT CLAIMED',
  };
}

async function rejectedSql(
  client: pg.PoolClient,
  sql: string,
  values: unknown[],
  code: string,
) {
  await client.query('SAVEPOINT vnp_negative');
  try {
    await assert.rejects(
      client.query(sql, values),
      (e: unknown) => (e as { code?: string }).code === code,
    );
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT vnp_negative');
    await client.query('RELEASE SAVEPOINT vnp_negative');
  }
}
async function rollbackOnly(
  pool: pg.Pool,
  body: (c: pg.PoolClient) => Promise<void>,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ WRITE');
    await body(c);
  } finally {
    try {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
}
async function rightsChecks(
  c: ProbeContext,
  expected: SnapshotData,
  fence: FenceRecord,
) {
  for (const [role, tenant] of [
    ['ct_tenant_a', c.ids.tenantA],
    ['ct_tenant_b', c.ids.tenantB],
  ] as const) {
    const pool = await c.db(role);
    await c.guard(fence);
    await rollbackOnly(pool, async (client) => {
      same(
        await rows(client, ProfileSelect),
        expected.profiles.filter((r) => r.tenant === tenant),
        'ACTUAL_TENANT_RLS',
      );
      await client.query("SELECT set_config('ct.tenant',$1,true)", [
        tenant === c.ids.tenantA ? c.ids.tenantB : c.ids.tenantA,
      ]);
      same(
        await rows(client, ProfileSelect),
        expected.profiles.filter((r) => r.tenant === tenant),
        'GUC_CANNOT_CHANGE_TENANT',
      );
      await rejectedSql(
        client,
        'UPDATE ct.vera_profiles SET name=$1,revision=revision+1 WHERE id=$2',
        ['Forbidden reader edit', c.ids.principal],
        '42501',
      );
    });
  }
  const reader = await c.db('ct_console_reader');
  await c.guard(fence);
  await rollbackOnly(reader, async (client) => {
    same(
      await rows(client, ProfileSelect),
      expected.profiles,
      'ACTUAL_CONSOLE_READ_RIGHTS',
    );
    await rejectedSql(
      client,
      'UPDATE ct.vera_profiles SET name=$1,revision=revision+1 WHERE id=$2',
      ['Forbidden console edit', c.ids.principal],
      '42501',
    );
  });
  const admin = await c.db('localtest');
  await c.guard(fence);
  await rollbackOnly(admin, async (client) => {
    for (const [column, value] of [
      ['creation_digest', 'f'.repeat(64)],
      ['created_by', c.ids.ownerB],
      ['tenant', c.ids.tenantB],
      ['id', c.ids.refusedPrincipal],
    ])
      await rejectedSql(
        client,
        `UPDATE ct.vera_profiles SET ${column}=$3,revision=revision+1 WHERE tenant=$1 AND id=$2`,
        [c.ids.tenantA, c.ids.principal, value],
        'P0001',
      );
    await rejectedSql(
      client,
      'UPDATE ct.vera_profiles SET revision=revision+2 WHERE tenant=$1 AND id=$2',
      [c.ids.tenantA, c.ids.principal],
      'P0001',
    );
    await rejectedSql(
      client,
      "UPDATE ct.vera_profiles SET name='No CAS' WHERE tenant=$1 AND id=$2",
      [c.ids.tenantA, c.ids.principal],
      'P0001',
    );
    await client.query(
      "INSERT INTO ct.principals(tenant,id,epoch,generation,active,execution_mode) VALUES($1,$2,1,1,true,'PAUSED')",
      [c.ids.tenantA, c.ids.temporaryPrincipal],
    );
    await rejectedSql(
      client,
      "INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES($1,$2,'FK witness','',1,$3,$4)",
      [c.ids.tenantA, c.ids.temporaryPrincipal, c.ids.ownerB, 'f'.repeat(64)],
      '23503',
    );
    await rejectedSql(
      client,
      "INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES($1,$2,'FK witness','',1,$3,$4)",
      [c.ids.tenantB, c.ids.temporaryPrincipal, c.ids.ownerB, 'f'.repeat(64)],
      '23503',
    );
    await client.query('SET LOCAL ROLE ct_owner');
    same(
      (
        await rows(
          client,
          'SELECT count(*)::text AS rows FROM ct.vera_profiles',
        )
      )[0].rows,
      '0',
      'ACTUAL_FORCE_RLS_OWNER',
    );
  });
}
async function closePhase(c: ProbeContext) {
  const source = await c.expected(c.binding.state);
  const receiptBytes = await ownedBytes(
    c.root,
    c.artifact('read-' + c.binding.state.toLowerCase() + '.json'),
  );
  same(
    bytesHash(receiptBytes),
    c.manifest.readReceiptSha256,
    'PRIOR_READ_RECEIPT_HASH',
  );
  const receipt = decode(receiptBytes, ReadReceiptSchema);
  need(
    receipt.runId === c.runId &&
      receipt.state === c.binding.state &&
      receipt.expectedSnapshotSha256 === c.manifest.expectedSnapshotSha256,
    'PRIOR_READ_RECEIPT_BINDING',
  );
  need(
    receipt.leaseId === c.parentLease.leaseId &&
      receipt.orchestrationId === c.parentLease.orchestration.id &&
      receipt.leaseSha256 === c.manifest.leaseSha256,
    'PRIOR_READ_PARENT_BINDING',
  );
  same(receipt.code, c.manifest.code, 'PRIOR_READ_CODE');
  const parentFence = c.manifest.independentFence;
  need(
    BigInt(parentFence.revision) >= BigInt(receipt.independentFence.revision) &&
      (parentFence.revision !== receipt.independentFence.revision ||
        parentFence.fence === receipt.independentFence.fence),
    'READ_HANDOFF_NOT_REGRESSED',
  );
  need(
    BigInt(parentFence.revision) >
      BigInt(source.sourceIndependentFence.revision),
    'PARENT_PREADVANCED_FENCE',
  );
  const server = await c.guard(parentFence);
  need(
    server.inRecovery === 'false' && server.transactionReadOnly === 'off',
    'WRITABLE_PROMOTED_TARGET_REQUIRED',
  );
  for (const key of [
    'database',
    'address',
    'port',
    'directory',
    'systemIdentifier',
    'postmasterStart',
    'recoveryTargetName',
  ] as const)
    same(server[key], receipt.server[key], 'SAME_PRE_READ_IMAGE');
  const before = await c.snapshot(parentFence);
  same(before, source.data, 'PRE_BEGIN_IMAGE_UNCHANGED');
  same(sha(canonical(before)), receipt.dataSha256, 'PRE_BEGIN_READ_DATA');
  const recoveryDb = await c.db('ct_recovery');
  const policy: RecoveryPolicy = {
    authorizeOperator: async (actor) => {
      await c.lease();
      const identity = await tx(recoveryDb, (client) =>
        enrolled(client, actor, true),
      );
      assertFixtureOperator(c.ids, actor, identity);
    },
    readAuthorityJournal: () => c.journal(),
    readOperationInventory: async () => {
      throw Error('INVENTORY_IMPORT_FORBIDDEN');
    },
    verifyActivationApproval: async () => {
      throw Error('ACTIVATION_FORBIDDEN');
    },
  };
  const recovery = new RecoveryService(
    recoveryDb,
    c.store,
    {
      supports: () => false,
      lookup: async () => {
        throw Error('PROVIDER_OBSERVATION_FORBIDDEN');
      },
    },
    policy,
  );
  await assert.rejects(
    policy.authorizeOperator(syntheticActor(c.ids, 'a')),
    (e: unknown) =>
      (e as { probeCode?: string }).probeCode === 'EXPLICIT_FIXTURE_OPERATOR',
  );
  await c.guard(parentFence);
  const run = await recovery.begin(syntheticActor(c.ids, 'operator'));
  const current = await c.fence();
  same(run.fence, current.fence, 'BEGIN_CURRENT_FENCE_RETURN');
  same(
    run.tenant,
    c.ids.operatorTenant,
    'BEGIN_EXPLICIT_OPERATOR_SCOPE_RETURN',
  );
  need(
    current.blocked &&
      current.fence !== parentFence.fence &&
      BigInt(current.revision) === BigInt(parentFence.revision) + 1n,
    'BEGIN_STAYS_CLOSED',
  );
  await c.guard(current);
  const closed = await c.snapshot(current);
  assertClosureDelta(before, closed, c.ids, parentFence, current, run.id);
  // A native read-only/PITR error cannot satisfy this check: prove a writable
  // authority session and fresh eligible human separately before gate denials.
  const auth = await c.db('ct_authority_api');
  await tx(auth, async (client) => {
    same(
      (
        await rows(
          client,
          "SELECT current_setting('transaction_read_only')::text AS read_only,pg_is_in_recovery()::text AS recovering",
        )
      )[0],
      { read_only: 'off', recovering: 'false' },
      'AUTHORITY_WRITABLE_NOT_READONLY_PROOF',
    );
    const identity = await enrolled(client, syntheticActor(c.ids, 'a'), true);
    need(
      identity.id === c.ids.ownerA && identity.tenant === c.ids.tenantA,
      'FRESH_ENROLLED_HUMAN_SEPARATE',
    );
  });
  const x = requests(c.ids);
  for (const fence of [c.manifest.sourceFence, current.fence]) {
    const service = new VeraService(auth, fence);
    for (const attempt of [
      () =>
        service.create(syntheticActor(c.ids, 'a'), {
          id: c.ids.refusedPrincipal,
          name: 'Must not create',
          description: '',
        }),
      () => service.create(syntheticActor(c.ids, 'a'), x.a),
      () =>
        service.updateProfile(syntheticActor(c.ids, 'a'), {
          ...x.s2,
          expectedRevision:
            c.binding.state === 'S0' ? 1 : c.binding.state === 'S1' ? 2 : 3,
        }),
    ]) {
      await c.guard(current);
      await assert.rejects(
        attempt,
        (e: unknown) =>
          e instanceof Error &&
          e.message === 'recovery fence' &&
          !['25006', '25P02'].includes((e as { code?: string }).code ?? ''),
      );
    }
  }
  await rightsChecks(c, closed, current);
  await c.guard(current);
  const after = await c.snapshot(current);
  same(after, closed, 'DENIAL_AND_NEGATIVE_SQL_NO_PERSISTENT_DELTA');
  assertClosureDelta(before, after, c.ids, parentFence, current, run.id);
  const result = {
    kind: 'profile-native-closed/v0.1',
    scope,
    phase: c.phase,
    state: c.binding.state,
    runId: c.runId,
    code: c.manifest.code,
    server,
    recoveryRun: run.id,
    leaseId: c.parentLease.leaseId,
    orchestrationId: c.parentLease.orchestration.id,
    expectedSnapshotSha256: c.manifest.expectedSnapshotSha256,
    readReceiptSha256: c.manifest.readReceiptSha256,
    blocked: true,
    independentFence: current,
    closureData: after,
    exactPreClosureDataSha256: sha(canonical(before)),
    freshHumanVerifiedSeparately: true,
    historicalAndCurrentFenceDenials: true,
    writableApplicationFenceProof: true,
    rolledBackRightsChecks: true,
    activated: false,
    newOperations: '0',
    nativeQualification: 'NOT CLAIMED',
  };
  await c.write(c.phase + '.json', result);
  return {
    scope,
    phase: c.phase,
    state: c.binding.state,
    recoveryRun: run.id,
    independentFence: current,
    blocked: true,
    newOperations: '0',
    activated: false,
    nativeQualification: 'NOT CLAIMED',
  };
}

export async function runProfileNativeProbe(args: string[]) {
  const { runId, phase } = parseProfileNativeCli(args);
  const root = path.resolve(process.cwd());
  const context = new ProbeContext(root, runId, phase);
  let initialized = false;
  try {
    await context.initialize();
    initialized = true;
    await context.unused(phase + '.json');
    if (context.binding.source)
      await context.unused(
        'snapshot-' + context.binding.state.toLowerCase() + '.json',
      );
    const result = context.binding.source
      ? await sourcePhase(context)
      : phase.startsWith('read-')
        ? await readPhase(context)
        : await closePhase(context);
    if (context.binding.source) await context.write(phase + '.json', result);
    return result;
  } catch (error) {
    if (initialized) {
      try {
        await context.write('failure-' + phase + '.json', {
          scope,
          runId,
          phase,
          status: 'FAIL',
          code: (error as { probeCode?: string }).probeCode ?? 'PROBE_FAILED',
          sqlstate: /^[A-Z0-9]{5}$/.test(
            (error as { code?: string }).code ?? '',
          )
            ? (error as { code: string }).code
            : null,
          nativeQualification: 'NOT CLAIMED',
        });
      } catch {
        /* Never overwrite a prior failure or weaken a guard for logging. */
      }
    }
    throw error;
  } finally {
    await context.close();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runProfileNativeProbe(process.argv.slice(2)).then(
    (result) => console.log(canonical(result)),
    (error: unknown) => {
      console.error(
        canonical({
          scope,
          status: 'FAIL',
          code: (error as { probeCode?: string }).probeCode ?? 'PROBE_FAILED',
          nativeQualification: 'NOT CLAIMED',
        }),
      );
      process.exitCode = 1;
    },
  );
}
