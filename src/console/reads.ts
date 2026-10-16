import { assertLocalFixtures } from '../runtime-profile.js';
import type pg from 'pg';
import { tx, bindingDigest, actionBinding } from '../db.js';
import type { VerifiedIdentity } from '../identity-provider.js';
import { enrolled, identifier } from '../service-auth.js';
import {
  EnvelopeSchema,
  SECTIONS,
  PUBLIC_GITHUB_PROVIDER,
  PUBLIC_GITHUB_RESOURCE,
  type ReadEnvelope,
  type ConsoleItem,
} from './contracts.js';
import {
  operationTruth,
  computerTruth,
  workPhase,
  groupFocus,
} from './semantics.js';
import { CursorCodec } from './pagination.js';
import {
  featureCatalogue,
  freshHumanMfa,
  type ConsoleMode,
} from './features.js';
import { redact, requiresRedaction } from './redaction.js';
export class ConsoleReads {
  constructor(
    private db: pg.Pool,
    private cursors: CursorCodec,
    readonly mode: ConsoleMode,
    private sourceRevision: string,
    private fence: string,
  ) {
    if (this.mode === 'LOCAL_FIXTURE')
      assertLocalFixtures('local console reads profile');
  }
  async read(
    actor: VerifiedIdentity,
    section: string,
    options: { id?: string; q?: string; cursor?: string } = {},
  ): Promise<ReadEnvelope> {
    if (actor.kind !== 'user') throw Error('human read only');
    if (
      ![...SECTIONS, 'session', 'focus', 'operation'].includes(section as any)
    )
      throw Error('unsupported read');
    if ((options.q ?? '').length > 128) throw Error('search bound');
    return tx(this.db, async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const i = await enrolled(c, actor),
        now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      const head = (
          await c.query('SELECT seq FROM ct.evidence_heads WHERE tenant=$1', [
            i.tenant,
          ])
        ).rows[0],
        version = Number(head?.seq ?? 0),
        ctrl = (await c.query('SELECT * FROM ct.control WHERE singleton'))
          .rows[0];
      const features = featureCatalogue(
          this.mode,
          actor,
          !ctrl || ctrl.blocked || ctrl.fence !== this.fence,
          now,
        ),
        fresh = features.commands.state === 'available';
      const q = options.q ?? '';
      const after = options.cursor
        ? this.cursors.decode(options.cursor, {
            tenant: i.tenant,
            section,
            query: q,
            version,
          }).after
        : '';
      let records: ConsoleItem[] = [],
        total: number | null = null,
        complete = true;
      if (section === 'session')
        records = [
          item(
            i.id,
            'human',
            'Enrolled human account',
            Number(i.version),
            i.active ? 'Active' : 'Disabled',
            {
              tenant: i.tenant,
              identity: i.id,
              kind: i.kind,
              role: i.domain_role,
              VERA: i.principal ?? 'Not a VERA',
              issuer: i.issuer,
              audience: i.audience,
              tokenExpires: new Date(actor.expires).toISOString(),
              freshMfa: freshHumanMfa(actor, now),
              identitySource:
                this.mode === 'LOCAL_FIXTURE'
                  ? 'LOCAL TEST ISSUER — not production sign-in'
                  : 'Pinned external issuer; live P1 status independent',
            },
          ),
        ];
      else if (
        [
          'work',
          'projects',
          'governance',
          'agents',
          'computers',
          'approvals',
          'authority',
          'context',
          'evidence',
          'recovery',
          'incidents',
          'notifications',
          'security',
          'operation',
        ].includes(section)
      ) {
        const rows = await this.rows(
          c,
          i.tenant,
          section,
          options.id,
          q,
          after,
        );
        total = rows.total;
        records = rows.data.map((x) =>
          this.project(section, x, now, fresh, ctrl),
        );
      } else if (section === 'focus') {
        const w = await this.rows(c, i.tenant, 'work', undefined, q, '', 500),
          inc = await this.rows(
            c,
            i.tenant,
            'incidents',
            undefined,
            '',
            '',
            200,
          );
        complete = w.total <= 500 && inc.total <= 200;
        const conditions: any[] = inc.data
          .filter((x) => x.status !== 'RESOLVED')
          .map((x) => ({
            id: 'incident:' + x.id,
            root: x.root_id,
            cause: x.cause,
            sourceVersion: Number(x.source_version),
            tasks: x.tasks ?? [],
            severity: x.severity,
            title: x.title,
            observedAt: x.observed_at,
          }));
        const covered = new Set(conditions.flatMap((x) => x.tasks));
        for (const t of w.data) {
          const ops = t.ops ?? [],
            phase = workPhase(
              t.status,
              ops.map((o: any) => o.state),
              ops.filter((o: any) => operationTruth(o).verified).length,
            );
          const sev =
            phase === 'Outcome uncertain'
              ? 0
              : phase === 'Blocked'
                ? 1
                : phase === 'Pending exact review'
                  ? 2
                  : 3;
          if (covered.has(t.id) && sev < 2) continue;
          conditions.push({
            id: 'task:' + t.id,
            root: 'task:' + t.id,
            cause: phase,
            sourceVersion: Number(t.revision),
            tasks: [t.id],
            severity: sev,
            title: t.objective,
            deadline: t.deadline,
            observedAt: t.created_at
              ? new Date(t.created_at).toISOString()
              : undefined,
          });
        }
        const grouped = groupFocus(conditions);
        total = grouped.length;
        records = grouped.slice(0, 60).map((x) =>
          item(
            x.id,
            'focus',
            x.title ?? x.cause,
            x.sourceVersion,
            x.cause === 'LOST_ACK' ? 'Outcome uncertain' : x.cause,
            {
              ...x,
              why: `${x.cause}; ${x.affectedCount} distinct affected task(s).`,
              target: x.tasks[0] ?? null,
            },
          ),
        );
      } else if (section === 'usage') {
        const l = (
          await c.query('SELECT * FROM ct.resource_limits WHERE tenant=$1', [
            i.tenant,
          ])
        ).rows[0];
        records = l
          ? [
              item(
                'limits',
                'usage',
                'Enforced resource reservations',
                version,
                'Reservation ≠ spend',
                {
                  jobsReserved: Number(l.active_jobs),
                  jobsLimit: Number(l.max_jobs),
                  storageReservedBytes: Number(l.reserved_storage),
                  storageLimitBytes: Number(l.max_storage),
                  unitsReservedOrSettled: Number(l.spent_or_reserved_units),
                  unit:
                    this.mode === 'LOCAL_FIXTURE'
                      ? 'test units'
                      : 'unspecified domain unit',
                  unitLimit: Number(l.max_units),
                  measuredMoneySpent: 'unknown — no billing meter',
                  estimatedSpend: 'unknown',
                  source: 'ct.resource_limits',
                  observed_at: new Date(now).toISOString(),
                  meterFreshness:
                    'Domain reservation snapshot only; external billing freshness unknown',
                },
              ),
            ]
          : [];
      } else if (section === 'integrations') {
        records = [
          item(
            'fixture',
            'integration',
            'Local verification fixture',
            1,
            this.mode === 'LOCAL_FIXTURE' ? 'LOCAL TEST ONLY' : 'Unavailable',
            {
              provider: 'fixture',
              action: 'write',
              resource: 'fixture-object',
              protectedProductionWrite: false,
              verification: 'Separate matching test-provider observation',
              qualification: 'P2 PARTIAL; not a live protected provider',
            },
          ),
          item(
            PUBLIC_GITHUB_PROVIDER,
            'integration',
            'GitHub immutable public read',
            1,
            'Adapter implemented; execution not inferred',
            {
              provider: PUBLIC_GITHUB_PROVIDER,
              resource: PUBLIC_GITHUB_RESOURCE,
              repository: 'Adaptive-Liquidity/Continuum',
              commit: '9ac4723b5390d22ed2d6aed9cf984cb0a32731ca',
              tree: 'dcd778fa3a539de0132c2a7ec32c36aaf876f94d',
              action: 'readCommit',
              verification:
                'Matching pinned commit/tree at two documented endpoints',
              currentObservation:
                'Not observed by this request; qualification evidence remains separate',
              protectedProductionWrite: false,
              mutationIdempotencyWindow: 'NOT RUN — GET is not a mutation',
            },
          ),
        ];
      } else if (section === 'setup') {
        const principals = Number(
            (
              await c.query(
                'SELECT count(*) n FROM ct.principals WHERE tenant=$1 AND active',
                [i.tenant],
              )
            ).rows[0].n,
          ),
          machines = Number(
            (
              await c.query(
                "SELECT count(*) n FROM ct.identities WHERE tenant=$1 AND kind='machine' AND active",
                [i.tenant],
              )
            ).rows[0].n,
          );
        records = [
          item(
            'human',
            'prerequisite',
            'Human sign-in',
            version,
            this.mode === 'LOCAL_FIXTURE'
              ? 'Local fixture authenticated — P1 PARTIAL'
              : 'Authenticated; live qualification independent',
            { dependsOn: [], liveIdentityTests: 'NOT RUN' },
          ),
          item(
            'vera',
            'prerequisite',
            'Accountable VERA',
            version,
            principals ? 'Enrolled domain principal' : 'Requires setup',
            { dependsOn: ['human'], count: principals },
          ),
          item(
            'machine',
            'prerequisite',
            'Renewable machine identity',
            version,
            machines
              ? 'Enrolled test workload — live renewal NOT RUN'
              : 'Requires setup',
            {
              dependsOn: ['vera'],
              count: machines,
              maxPerOperationLifetimeMs: 90000,
            },
          ),
          item(
            'computer',
            'prerequisite',
            'Managed Computer isolation',
            version,
            'Qualification pending',
            {
              dependsOn: ['vera'],
              P3: 'NOT RUN',
              requiredForPublicRead: false,
            },
          ),
          item(
            'provider',
            'prerequisite',
            'Protected provider and verification',
            version,
            'Qualification pending',
            { dependsOn: ['machine'], P2: 'PARTIAL' },
          ),
          item(
            'qualification',
            'prerequisite',
            'Production release',
            version,
            'Blocked',
            {
              dependsOn: ['provider', 'computer'],
              P4: 'NOT RUN',
              P5: 'NOT RUN',
              scheduler: 'HELD',
              canary: 'NO-GO',
              independentReview: 'NOT RUN',
            },
          ),
        ];
      } else
        records = [
          item(
            'deployment',
            'settings',
            'Canonical local release candidate',
            version,
            'Production BLOCKED',
            {
              Asentxia: 'Institution',
              Continuum: 'Persistent governed operating environment',
              VERA: 'Durable accountable principal',
              repository: 'Adaptive-Liquidity/notion-continuum',
              backendRuntime: 'Node 24',
              frontendRuntime: 'Node 22 / Next.js 16 / React 19',
              P1: 'PARTIAL',
              P2: 'PARTIAL',
              P3: 'NOT RUN',
              P4: 'NOT RUN',
              P5: 'NOT RUN',
              scheduler: 'HELD',
              canary: 'NO-GO',
              independentReview: 'NOT RUN',
              RPO: 'not qualified',
              RTO: 'not qualified',
              dataResidency: 'not qualified',
              commercialBilling: 'not configured',
            },
          ),
        ];
      const more = records.length > 60;
      if (more) records = records.slice(0, 60);
      if (total === null) total = records.length;
      const cursor = more
        ? this.cursors.encode({
            tenant: i.tenant,
            section,
            query: q,
            version,
            after: records[records.length - 1].id,
          })
        : null;
      return EnvelopeSchema.parse({
        schema_version: 1,
        server_time: new Date(now).toISOString(),
        observed_at: new Date(now).toISOString(),
        fresh_until: new Date(
          Math.min(now + 30000, actor.expires),
        ).toISOString(),
        projection_version: version,
        source_revision: this.sourceRevision,
        completeness: complete ? 'complete' : 'partial',
        cursor,
        total,
        items: records,
        features,
        scope: this.mode,
        session: {
          identity: i.id,
          tenant: i.tenant,
          principal: i.principal ?? null,
          expires: actor.expires,
          fresh_mfa: freshHumanMfa(actor, now),
        },
      });
    });
  }
  private async rows(
    c: pg.PoolClient,
    tenant: string,
    section: string,
    id?: string,
    q = '',
    after = '',
    limit = 60,
  ) {
    if (id) identifier(id);
    const search = '%' + q + '%';
    let sql = '';
    let idcol = 'id';
    if (section === 'work')
      sql = `SELECT t.*,w.project,w.accountable_vera,w.waiting_reason,w.revision AS coordination_revision,COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM ct.task_operations m JOIN ct.operations o ON o.tenant=m.tenant AND o.id=m.operation WHERE m.tenant=t.tenant AND m.task=t.id),'[]') ops,COALESCE((SELECT jsonb_agg(d.depends_on ORDER BY d.depends_on) FROM ct.task_dependencies d WHERE d.tenant=t.tenant AND d.task=t.id),'[]') dependencies FROM ct.tasks t LEFT JOIN ct.work_coordination w ON w.tenant=t.tenant AND w.task=t.id WHERE t.tenant=$1`;
    else if (section === 'projects')
      sql = `SELECT p.*,COALESCE((SELECT jsonb_agg(w.task ORDER BY w.task) FROM ct.work_coordination w WHERE w.tenant=p.tenant AND w.project=p.id),'[]') tasks FROM ct.projects p WHERE p.tenant=$1`;
    else if (section === 'governance')
      sql = `SELECT o.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'revision',r.revision) ORDER BY r.id) FROM ct.role_definitions r WHERE r.tenant=o.tenant AND r.organization=o.id),'[]') roles,COALESCE((SELECT jsonb_agg(jsonb_build_object('subjectKind',m.subject_kind,'subjectId',m.subject_id,'roleId',m.role_id,'ownerSeat',m.owner_seat,'revision',m.revision) ORDER BY m.subject_kind,m.subject_id) FROM ct.memberships m WHERE m.tenant=o.tenant AND m.organization=o.id),'[]') memberships,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'revision',d.revision,'version',d.current_version,'title',v.title,'body',v.body) ORDER BY d.id) FROM ct.mandates d JOIN ct.mandate_versions v ON v.tenant=d.tenant AND v.organization=d.organization AND v.mandate=d.id AND v.version=d.current_version WHERE d.tenant=o.tenant AND d.organization=o.id),'[]') mandates FROM ct.organizations o WHERE o.tenant=$1`;
    else if (section === 'agents')
      sql = `SELECT p.*,v.name AS profile_name,v.description AS profile_description,v.revision AS profile_revision,v.created_by AS profile_created_by,c.id AS computer_id,c.generation AS computer_generation,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'active',i.active,'version',i.version)) FROM ct.identities i WHERE i.tenant=p.tenant AND i.principal=p.id),'[]') workload_identities,(SELECT to_jsonb(b) FROM ct.cognition_bindings b WHERE b.tenant=p.tenant AND b.principal=p.id ORDER BY b.revision DESC LIMIT 1) cognition FROM ct.principals p LEFT JOIN ct.vera_profiles v ON v.tenant=p.tenant AND v.id=p.id LEFT JOIN ct.computers c ON c.tenant=p.tenant AND c.principal=p.id WHERE p.tenant=$1`;
    else if (section === 'computers')
      sql = `SELECT x.*,v.raw_state,v.provider_class,v.health,v.qualification_scope,v.observed_at,v.fresh_until,v.checkpoint_status,p.execution_mode FROM ct.computers x JOIN ct.principals p ON p.tenant=x.tenant AND p.id=x.principal LEFT JOIN ct.computer_observations v ON v.tenant=x.tenant AND v.computer=x.id AND v.generation=x.generation WHERE x.tenant=$1`;
    else if (['approvals', 'recovery', 'operation'].includes(section))
      sql = `SELECT o.*,ch.quarantined AS context_quarantined,a.expires approval_expires,a.revision approval_revision,a.approved_by,g.revoked,g.version current_grant_version,g.expires grant_expires,g.max_cost,g.budget,g.reserved,p.active principal_active,p.epoch current_epoch,p.generation current_generation,COALESCE((SELECT jsonb_agg(jsonb_build_object('identity',s.identity_id,'digest',s.digest,'expires',s.expires)) FROM ct.assignments s WHERE s.tenant=o.tenant AND s.operation=o.id),'[]') machine_assignments FROM ct.operations o JOIN ct.grants g ON g.tenant=o.tenant AND g.id=o.grant_id JOIN ct.principals p ON p.tenant=o.tenant AND p.id=o.principal LEFT JOIN ct.approvals a ON a.tenant=o.tenant AND a.operation=o.id LEFT JOIN ct.context_heads ch ON ch.tenant=o.tenant AND ch.id=o.context_id WHERE o.tenant=$1${section === 'operation' ? '' : ` AND o.state='${section === 'approvals' ? 'REQUESTED' : 'UNKNOWN'}'`}`;
    else if (section === 'authority')
      sql = `SELECT * FROM ct.grants WHERE tenant=$1`;
    else if (section === 'context')
      sql = `SELECT h.*,v.digest,v.source,v.observed_at,v.expires,v.erased_at FROM ct.context_heads h JOIN ct.context_versions v ON v.tenant=h.tenant AND v.id=h.id AND v.version=h.version WHERE h.tenant=$1 AND NOT(v.source ? 'e2')`;
    else if (section === 'evidence') {
      idcol = 'id';
      sql = `SELECT lpad(e.seq::text,16,'0') id,e.seq,e.kind,e.payload,e.prev_hash,e.hash FROM ct.evidence_events e WHERE e.tenant=$1`;
    } else if (section === 'incidents')
      sql = `SELECT x.*,COALESCE((SELECT jsonb_agg(t.task ORDER BY t.task) FROM ct.incident_tasks t WHERE t.tenant=x.tenant AND t.incident=x.id),'[]') tasks FROM ct.incidents x WHERE x.tenant=$1`;
    else if (section === 'notifications')
      sql = `SELECT * FROM ct.notifications WHERE tenant=$1`;
    else if (section === 'security')
      sql = `SELECT id,kind,tenant,principal,domain_role,active,version,issuer,audience FROM ct.identities WHERE tenant=$1`;
    if (!sql) throw Error('unknown source');
    const base = `SELECT * FROM (${sql}) allowed WHERE ($2::text IS NULL OR ${idcol}=$2) AND ($3::text='%%' OR concat_ws(' ',id::text,to_jsonb(allowed)->>'profile_name',to_jsonb(allowed)->>'objective',to_jsonb(allowed)->>'name',to_jsonb(allowed)->>'title',to_jsonb(allowed)->>'kind',to_jsonb(allowed)->>'action') ILIKE $3)`;
    const total = Number(
      (
        await c.query(`SELECT count(*) n FROM (${base}) bounded`, [
          tenant,
          id ?? null,
          search,
        ])
      ).rows[0].n,
    );
    const sort =
      section === 'work' && limit === 500
        ? "CASE WHEN EXISTS(SELECT 1 FROM ct.task_operations m JOIN ct.operations o ON o.tenant=m.tenant AND o.id=m.operation WHERE m.tenant=$1 AND m.task=allowed.id AND o.state='UNKNOWN') THEN 0 WHEN EXISTS(SELECT 1 FROM ct.task_operations m JOIN ct.operations o ON o.tenant=m.tenant AND o.id=m.operation WHERE m.tenant=$1 AND m.task=allowed.id AND o.state IN('DENIED','FAILED_KNOWN_NO_EFFECT')) THEN 1 WHEN EXISTS(SELECT 1 FROM ct.task_operations m JOIN ct.operations o ON o.tenant=m.tenant AND o.id=m.operation WHERE m.tenant=$1 AND m.task=allowed.id AND o.state='REQUESTED') THEN 2 ELSE 3 END, created_at NULLS LAST, id"
        : section === 'incidents' && limit === 200
          ? 'severity, observed_at, id'
          : idcol;
    const data = (
      await c.query(`${base} AND ${idcol}>$4 ORDER BY ${sort} LIMIT $5`, [
        tenant,
        id ?? null,
        search,
        after,
        limit + 1,
      ])
    ).rows;
    return { total, data };
  }
  private project(
    section: string,
    x: any,
    now: number,
    ownerFresh: boolean,
    ctrl: any,
  ): ConsoleItem {
    if (section === 'work') {
      const ops = x.ops ?? [],
        v = ops.filter((o: any) => operationTruth(o).verified).length;
      return item(
        x.id,
        'task',
        x.objective,
        Number(x.revision),
        workPhase(
          x.status,
          ops.map((o: any) => o.state),
          v,
        ),
        {
          accountableVERA: x.accountable_vera ?? x.principal,
          originalPrincipal: x.principal,
          project: x.project ?? null,
          deadline: x.deadline,
          planVersion: x.plan_version,
          dependencies: x.dependencies,
          waitingOn: x.waiting_reason ?? null,
          coordinationRevision: Number(x.coordination_revision ?? 0),
          operations: ops.map((o: any) => ({
            id: o.id,
            state: o.state,
            digest: o.digest,
            ...operationTruth(o),
          })),
          businessGoal: 'Not automatically proven by effects',
          workflow: 'No workflow admission inferred from task creation',
          organization: x.organization ?? null,
          mandate: x.mandate ?? null,
          acceptedMandateVersion:
            x.mandate_version == null ? null : Number(x.mandate_version),
        },
      );
    }
    if (section === 'governance')
      return item(
        x.id,
        'organization',
        x.name,
        Number(x.revision),
        'Governance record',
        {
          roles: x.roles ?? [],
          memberships: x.memberships ?? [],
          mandates: x.mandates ?? [],
          effectAuthority: false,
          note: 'A role, membership, or mandate does not authorize an effect.',
        },
      );
    if (section === 'projects')
      return item(
        x.id,
        'project',
        x.name,
        Number(x.revision),
        'Project registry · organizing work does not authorize effects',
        {
          objective: x.objective,
          tasks: x.tasks,
          taskCount: x.tasks.length,
          archiveAndBoardDrag: 'Unavailable — no reviewed human command',
        },
      );
    if (section === 'agents')
      return item(
        x.id,
        'vera',
        x.profile_name ?? x.id,
        Number(x.epoch),
        !x.active
          ? 'Inactive VERA'
          : x.execution_mode === 'PAUSED'
            ? 'Paused VERA'
            : x.execution_mode === 'HUMAN'
              ? 'Human control'
              : 'Agent mode — execution is not verified here',
        {
          VERA: x.id,
          principalEpoch: x.epoch,
          principalGeneration: Number(x.generation),
          profileRevision:
            x.profile_revision == null ? null : Number(x.profile_revision),
          profileName: x.profile_name ?? null,
          description: x.profile_description ?? null,
          profileCreatedBy: x.profile_created_by ?? null,
          profileAuthority:
            'Profile text is not a grant, approval, workflow admission or execution result',
          ...(x.computer_id
            ? {
                logicalComputer: x.computer_id,
                placementGeneration: Number(x.computer_generation),
              }
            : {}),
          executionMode: x.execution_mode,
          workloadIdentities: x.workload_identities,
          cognition: x.cognition
            ? redact(x.cognition)
            : 'Model binding not configured',
          humanAccount: 'Separate enrolled human; not this principal',
          continuity:
            'Logical principal survives model/session/placement replacement',
        },
      );
    if (section === 'computers') {
      const raw = computerTruth(x.state, x.raw_state);
      return item(x.id, 'computer', x.id, Number(x.revision), raw.domain, {
        logicalComputer: x.id,
        VERA: x.principal,
        domainLifecycle: raw.domain,
        rawProviderState: raw.raw,
        knownProviderState: raw.knownRaw,
        placementAlias: x.placement
          ? 'placement-generation-' + x.generation
          : 'No current placement',
        generation: x.generation,
        executionMode: x.execution_mode,
        providerClass: x.provider_class ?? 'unknown',
        health: x.health ?? 'unknown',
        observationFresh: x.fresh_until
          ? +new Date(x.fresh_until) > now
          : false,
        lastObservedAt: x.observed_at ?? 'unknown',
        checkpointStatus: x.checkpoint_status ?? 'unknown',
        manifestDigest: x.manifest_digest ?? 'unknown',
        isolationQualification: x.qualification_scope ?? 'NOT_RUN',
        managedHostLoss: 'NOT RUN',
        manualControl:
          'Unavailable — durable lease code is not managed-browser isolation qualification',
      });
    }
    if (['approvals', 'recovery', 'operation'].includes(section)) {
      const truth = operationTruth(x);
      const valid =
        ownerFresh &&
        x.state === 'REQUESTED' &&
        !x.revoked &&
        x.current_grant_version === x.grant_version &&
        x.current_epoch === x.epoch &&
        x.current_generation === x.generation &&
        x.principal_active &&
        x.fence === ctrl?.fence &&
        !ctrl?.blocked &&
        +new Date(x.deadline) > now &&
        +new Date(x.grant_expires) > now &&
        bindingDigest(x) === x.digest &&
        !requiresRedaction(x.params);
      const max = Math.min(
        +new Date(x.deadline),
        +new Date(x.grant_expires),
        now + 86400000,
      );
      return {
        ...item(
          x.id,
          'operation',
          x.action + ' · ' + x.resource,
          Number(x.version),
          truth.label,
          {
            operation: x.id,
            task: x.task_id,
            principal: x.principal,
            provider: x.provider,
            action: x.action,
            resource: x.resource,
            parameters: redact(x.params),
            canonicalBinding: redact(actionBinding(x)),
            digest: x.digest,
            grant: x.grant_id,
            grantVersion: x.grant_version,
            principalEpoch: x.epoch,
            principalGeneration: Number(x.generation),
            ...(Number(x.contract_version) >= 2 && x.computer_id
              ? {
                  computerId: x.computer_id,
                  placementGeneration: Number(x.placement_generation),
                }
              : {}),
            ...(Number(x.contract_version) === 3 ||
            Number(x.contract_version) === 4
              ? {
                  ...(x.context_id
                    ? {
                        contextId: x.context_id,
                        contextVersion: Number(x.context_version),
                        contextQuarantined: x.context_quarantined === true,
                        contextNote: x.context_quarantined
                          ? 'Quarantined context is not an admitted fact and is not effect authority.'
                          : 'Bound context is not effect authority.',
                      }
                    : {}),
                  ...(x.cognition_revision != null
                    ? { cognitionRevision: Number(x.cognition_revision) }
                    : {}),
                }
              : {}),
            ...(Number(x.contract_version) === 4 && x.tool_id
              ? {
                  toolId: x.tool_id,
                  toolRevision: Number(x.tool_revision),
                }
              : {}),
            deadline: new Date(x.deadline).toISOString(),
            costCeiling: Number(x.cost),
            unit:
              this.mode === 'LOCAL_FIXTURE'
                ? 'test units'
                : 'unspecified domain unit',
            workloadAssignments: x.machine_assignments ?? [],
            approvalRevision: Number(x.approval_revision ?? 0),
            approvalExpires: x.approval_expires ?? null,
            approvalStatus: x.approval_expires
              ? +new Date(x.approval_expires) > now
                ? 'Recorded exact approval — not execution'
                : 'Expired decision retained'
              : 'Awaiting exact approval',
            maximumApprovalExpiry: new Date(max).toISOString(),
            reason:
              'Recorded immutable proposal; model explanation is not authority',
            verificationMethod:
              x.provider === 'fixture'
                ? 'Matching LOCAL test-provider read-back'
                : x.provider === PUBLIC_GITHUB_PROVIDER
                  ? 'Pinned public immutable commit/tree read-back'
                  : 'Unknown verifier',
            effectState: x.state,
            verification: truth,
            providerObservation: redact(x.observation),
            recoveryOwner: x.principal,
            reconciliationStatus:
              x.state === 'UNKNOWN'
                ? 'Awaiting separately authorized trusted observation'
                : 'Not required',
            nextAction:
              x.state === 'UNKNOWN'
                ? 'Inspect original evidence; no resend/regrant/resume'
                : 'Approval records permission only',
          },
        ),
        eligibility: {
          allowed: valid,
          reason: valid
            ? 'Exact immutable proposal and fresh enrolled owner; local test scope only'
            : 'Stale authority/preview, insufficient fresh MFA, unsupported/redacted content or qualification pending',
        },
      };
    }
    if (section === 'authority')
      return item(
        x.id,
        'grant',
        x.action + ' · ' + x.resource,
        Number(x.version),
        x.revoked
          ? 'Grant revoked'
          : +new Date(x.expires) <= now
            ? 'Grant expired'
            : 'Bounded grant',
        {
          id: x.id,
          principal: x.principal,
          scope: { action: x.action, resource: x.resource },
          expires: x.expires,
          version: x.version,
          maxCost: Number(x.max_cost),
          budget: Number(x.budget),
          reserved: Number(x.reserved),
          measuredSpend: 'unknown',
          unit: this.mode === 'LOCAL_FIXTURE' ? 'test units' : 'unspecified',
          policyVersion: 'unknown — no policy-version column',
          inFlight: 'Previously admitted effects may still finish',
          revoked: x.revoked,
        },
      );
    if (section === 'context')
      return item(
        x.id,
        'context',
        x.id,
        Number(x.version),
        x.deleted
          ? 'Erased tombstone'
          : x.quarantined
            ? 'Quarantined'
            : +new Date(x.expires) <= now
              ? 'Expired context'
              : 'Versioned context',
        {
          principal: x.principal,
          version: x.version,
          digest: x.digest,
          source: redact(x.source),
          observed_at: x.observed_at,
          expires: x.expires,
          quarantined: x.quarantined,
          visibility: x.visibility,
          erased_at: x.erased_at ?? null,
          authority: 'Context is data, never a grant',
        },
      );
    if (section === 'evidence') {
      let payload: unknown;
      try {
        payload = JSON.parse(x.payload);
      } catch {
        payload = 'Invalid source payload — inspect internally';
      }
      return item(
        x.id,
        'evidence',
        x.kind,
        Number(x.seq),
        'Tamper-evident record — not provider truth',
        {
          sequence: Number(x.seq),
          kind: x.kind,
          payload: redact(payload),
          hash: x.hash,
          previousHash: x.prev_hash,
          integrity:
            'Source hash link; external truth requires supported provider observation',
        },
      );
    }
    if (section === 'incidents')
      return item(x.id, 'incident', x.title, Number(x.revision), x.status, {
        root: x.root_id,
        cause: x.cause,
        severity: x.severity,
        sourceVersion: Number(x.source_version),
        affectedTasks: x.tasks,
        ownerVERA: x.owner_vera ?? 'unknown',
        acknowledgedBy: x.acknowledged_by ?? null,
        resolutionBasis: redact(x.resolution_basis),
        acknowledgement:
          'Administrative acknowledgement does not resolve an uncertain effect',
      });
    if (section === 'notifications')
      return item(
        x.id,
        'notification',
        'Notice for ' + x.incident,
        Number(x.revision),
        x.read_at ? 'Read — incident status unchanged' : 'Unread',
        {
          incident: x.incident,
          deliveryState: x.delivery_state,
          channel: x.channel,
          attempts: x.attempts,
          readAt: x.read_at ?? null,
          externalDelivery:
            'Delivery accepted/sent/read never resolves the incident',
        },
      );
    return item(
      x.id,
      'identity',
      x.id,
      Number(x.version),
      x.active ? 'Enrolled ' + x.kind : 'Disabled ' + x.kind,
      {
        identity: x.id,
        kind: x.kind,
        VERA: x.principal ?? 'Not a VERA',
        role: x.domain_role,
        version: Number(x.version),
        active: x.active,
        issuer: x.issuer,
        audience: x.audience,
        scope: this.mode,
        maximumCapabilityMs: x.kind === 'machine' ? 90000 : null,
        lastIssuance: 'unknown unless separately observed',
        renewal: 'Machine-only; browser has no renewal action',
      },
    );
  }
}
export function item(
  id: string,
  kind: string,
  title: string,
  version: number,
  status: string,
  fields: Record<string, unknown>,
): ConsoleItem {
  return { id, kind, title, version: Number(version), status, fields };
}
