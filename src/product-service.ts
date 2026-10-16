import type pg from 'pg';
import { tx, canonical, bindingDigest, append, eventOutbox } from './db.js';
import { lockContextHead } from './context-lock.js';
import type { VerifiedIdentity } from './identity-provider.js';
import { reserveResources } from './resource-controls.js';
import {
  enrolled,
  samePrincipal,
  identifier,
  activeControl,
} from './service-auth.js';
import { GITHUB_PUBLIC_READONLY_PROVIDER } from './providers/github-readonly.js';
export interface TaskInput {
  id: string;
  principal: string;
  objective: string;
  deadline: string;
  organization: string;
  mandate: string;
  mandateVersion: number;
}
export interface OperationInput {
  id: string;
  task: string;
  grant: string;
  provider: string;
  action: string;
  resource: string;
  params: unknown;
  cost: number;
  deadline: string;
  context?: string;
  tool?: string;
}
export class ProductService {
  constructor(
    private db: pg.Pool,
    private fence: string,
  ) {}
  private unit<T>(
    c: pg.PoolClient | undefined,
    fn: (c: pg.PoolClient) => Promise<T>,
  ) {
    return c ? fn(c) : tx(this.db, fn);
  }
  async createTask(
    actor: VerifiedIdentity,
    x: TaskInput,
    client?: pg.PoolClient,
  ) {
    return this.unit(client, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor);
      samePrincipal(i, x.principal);
      identifier(x.id);
      identifier(x.principal);
      identifier(x.organization);
      identifier(x.mandate);
      if (!Number.isSafeInteger(x.mandateVersion) || x.mandateVersion < 1)
        throw Error('invalid task');
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, x.principal],
        )
      ).rows[0];
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      const deadline = new Date(x.deadline);
      if (
        !p?.active ||
        typeof x.objective !== 'string' ||
        !x.objective.trim() ||
        x.objective.length > 8000 ||
        !Number.isFinite(+deadline) ||
        +deadline <= now ||
        +deadline > now + 172800000 ||
        actor.expires <= now
      )
        throw Error('invalid task');
      const same = (old: Record<string, any>) =>
        old.principal === x.principal &&
        old.objective === x.objective &&
        +old.deadline === +deadline &&
        old.organization === x.organization &&
        old.mandate === x.mandate &&
        Number(old.mandate_version) === x.mandateVersion;
      const reused = (old: Record<string, any>) => ({
        id: old.id,
        reused: true,
        organization: old.organization,
        mandate: old.mandate,
        mandateVersion: Number(old.mandate_version),
      });
      const existing = (
        await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
          i.tenant,
          x.id,
        ])
      ).rows[0];
      if (existing) {
        if (!same(existing)) throw Error('task identity conflict');
        return reused(existing);
      }
      // FOR SHARE conflicts with a mandate update and a membership delete.
      // The product role has SELECT only, so ct.share_mandate takes that lock.
      const mandate = (
        await c.query(
          'SELECT ct.share_mandate($1, $2, $3) AS current_version',
          [i.tenant, x.organization, x.mandate],
        )
      ).rows[0];
      if (!mandate || Number(mandate.current_version) !== x.mandateVersion)
        throw Error('current mandate required');
      const version = (
        await c.query(
          'SELECT version FROM ct.mandate_versions WHERE tenant=$1 AND organization=$2 AND mandate=$3 AND version=$4',
          [i.tenant, x.organization, x.mandate, x.mandateVersion],
        )
      ).rows[0];
      if (!version) throw Error('current mandate required');
      const member = (
        await c.query(
          'SELECT ct.share_vera_membership($1, $2, $3) AS subject_id',
          [i.tenant, x.organization, x.principal],
        )
      ).rows[0];
      if (!member?.subject_id) throw Error('vera membership required');
      const raced = (
        await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
          i.tenant,
          x.id,
        ])
      ).rows[0];
      if (raced) {
        if (!same(raced)) throw Error('task identity conflict');
        return reused(raced);
      }
      await c.query('SAVEPOINT task_insert');
      try {
        await reserveResources(c, i.tenant, 'task', x.id, p.id, {
          units: 1,
          jobs: 1,
          bytes: 0,
        });
        await c.query(
          'INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            i.tenant,
            x.id,
            x.principal,
            x.objective,
            deadline,
            i.id,
            x.organization,
            x.mandate,
            x.mandateVersion,
          ],
        );
        await append(c, i.tenant, 'TASK_CREATED', {
          task: x.id,
          principal: x.principal,
          identity: i.id,
          deadline: deadline.toISOString(),
        });
        await c.query('RELEASE SAVEPOINT task_insert');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT task_insert');
        const code =
          e && typeof e === 'object' && 'code' in e
            ? String((e as { code?: string }).code)
            : '';
        if (code !== '23505') throw e;
        const winner = (
          await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
            i.tenant,
            x.id,
          ])
        ).rows[0];
        if (!winner || !same(winner)) throw Error('task identity conflict');
        return reused(winner);
      }
      return {
        id: x.id,
        reused: false,
        organization: x.organization,
        mandate: x.mandate,
        mandateVersion: x.mandateVersion,
      };
    });
  }
  async propose(actor: VerifiedIdentity, x: OperationInput) {
    return tx(this.db, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor);
      identifier(x.id);
      identifier(x.task);
      identifier(x.grant);
      const initial = (
        await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
          i.tenant,
          x.task,
        ])
      ).rows[0];
      if (!initial) throw Error('task scope');
      samePrincipal(i, initial.principal);
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, initial.principal],
        )
      ).rows[0];
      const computer =
        (
          await c.query(
            'SELECT * FROM ct.computers WHERE tenant=$1 AND principal=$2 FOR SHARE',
            [i.tenant, initial.principal],
          )
        ).rows[0] ?? null;
      const t = (
        await c.query(
          'SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, x.task],
        )
      ).rows[0];
      const g = (
        await c.query(
          'SELECT * FROM ct.grants WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, x.grant],
        )
      ).rows[0];
      if (
        (
          await c.query(
            "SELECT 1 FROM ct.task_operations m JOIN ct.operations o ON o.tenant=m.tenant AND o.id=m.operation WHERE m.tenant=$1 AND m.task=$2 AND o.state='UNKNOWN'",
            [i.tenant, t.id],
          )
        ).rowCount
      )
        throw Error(
          'task blocked on unresolved effect; no substitute operation',
        );
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t,
        deadline = new Date(x.deadline);
      if (
        !p?.active ||
        t.status !== 'PLANNED' ||
        !g ||
        g.revoked ||
        g.principal !== p.id ||
        g.action !== x.action ||
        g.resource !== x.resource ||
        +g.expires <= now ||
        !Number.isSafeInteger(x.cost) ||
        x.cost < 0 ||
        x.cost > Number(g.max_cost) ||
        !Number.isFinite(+deadline) ||
        +deadline <= now ||
        +deadline > Math.min(+g.expires, +t.deadline) ||
        actor.expires <= now ||
        !['fixture', GITHUB_PUBLIC_READONLY_PROVIDER].includes(x.provider) ||
        Buffer.byteLength(canonical(x.params)) > 16384
      )
        throw Error('proposal outside current grant/task');
      const o = {
        tenant: i.tenant,
        id: x.id,
        principal: p.id,
        grant_id: g.id,
        epoch: p.epoch,
        generation: p.generation,
        fence: this.fence,
        grant_version: g.version,
        task_id: t.id,
        plan_version: t.plan_version,
        provider: x.provider,
        action: x.action,
        resource: x.resource,
        params: x.params,
        idempotency_key: x.id,
        cost: x.cost,
        deadline,
        contract_version: 1 as 1 | 2 | 3 | 4,
        computer_id: null as string | null,
        placement_generation: null as number | null,
        context_id: null as string | null,
        context_version: null as number | null,
        cognition_revision: null as number | null,
        tool_id: null as string | null,
        tool_revision: null as number | null,
      };
      if (!computer) {
        if (actor.credentialPlacement !== undefined)
          throw Error('placement claim without computer');
      } else if (
        actor.credentialPlacement === undefined ||
        actor.credentialPlacement !== Number(computer.generation)
      )
        throw Error('stale placement claim');
      else {
        o.contract_version = 2;
        o.computer_id = computer.id;
        o.placement_generation = Number(computer.generation);
      }
      const cognitionTable = (
        await c.query(
          "SELECT to_regclass('ct.cognition_bindings') IS NOT NULL AS present",
        )
      ).rows[0].present;
      if (cognitionTable) {
        const cognition = (
          await c.query(
            'SELECT MAX(revision) AS r FROM ct.cognition_bindings WHERE tenant=$1 AND principal=$2',
            [i.tenant, p.id],
          )
        ).rows[0];
        if (cognition?.r != null) o.cognition_revision = Number(cognition.r);
      }
      if (x.context) {
        const head = await lockContextHead(
          c,
          i.tenant,
          identifier(x.context),
          false,
        );
        const version = head
          ? ((
              await c.query(
                'SELECT erased_at,expires FROM ct.context_versions WHERE tenant=$1 AND id=$2 AND version=$3',
                [i.tenant, head.id, head.version],
              )
            ).rows[0] ?? null)
          : null;
        const allowed =
          !!head &&
          Number(head.version) > 0 &&
          !head.deleted &&
          version &&
          !version.erased_at &&
          +new Date(version.expires) > now &&
          (head.visibility === 'TENANT' ||
            (head.visibility === 'PRIVATE' && head.principal === p.id));
        if (!head || !allowed) throw Error('context binding unavailable');
        o.context_id = head.id;
        o.context_version = Number(head.version);
      }
      if (o.context_id || o.cognition_revision != null) o.contract_version = 3;
      if (x.tool !== undefined) {
        const toolId = identifier(x.tool);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'tool-manifest|' + i.tenant + '|' + toolId,
        ]);
        const current = (
          await c.query(
            'SELECT revision FROM ct.tool_manifests WHERE tenant=$1 AND tool_id=$2 ORDER BY revision DESC LIMIT 1',
            [i.tenant, toolId],
          )
        ).rows[0];
        if (!current) throw Error('tool binding unavailable');
        o.tool_id = toolId;
        o.tool_revision = Number(current.revision);
        o.contract_version = 4;
      }
      const digest = bindingDigest(o);
      const old = (
        await c.query('SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2', [
          i.tenant,
          x.id,
        ])
      ).rows[0];
      if (old) {
        if (old.digest !== digest) throw Error('operation identity conflict');
        return { id: old.id, digest, reused: true, state: old.state };
      }
      await c.query(
        'INSERT INTO ct.operations(tenant,id,principal,grant_id,epoch,generation,fence,grant_version,task_id,plan_version,provider,action,resource,params,digest,idempotency_key,cost,deadline,computer_id,placement_generation,contract_version,context_id,context_version,cognition_revision,tool_id,tool_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)',
        [
          o.tenant,
          o.id,
          o.principal,
          o.grant_id,
          o.epoch,
          o.generation,
          o.fence,
          o.grant_version,
          o.task_id,
          o.plan_version,
          o.provider,
          o.action,
          o.resource,
          o.params,
          digest,
          o.idempotency_key,
          o.cost,
          o.deadline,
          o.computer_id ?? null,
          o.placement_generation ?? null,
          o.contract_version,
          o.context_id,
          o.context_version,
          o.cognition_revision,
          o.tool_id,
          o.tool_revision,
        ],
      );
      await c.query('INSERT INTO ct.task_operations VALUES($1,$2,$3)', [
        i.tenant,
        t.id,
        o.id,
      ]);
      await eventOutbox(c, o, 'OPERATION_PROPOSED', {
        id: o.id,
        task: t.id,
        digest,
        identity: i.id,
        requiresIndependentApproval: true,
      });
      return { id: o.id, digest, state: 'REQUESTED', reused: false };
    });
  }
  async status(actor: VerifiedIdentity, task: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor),
        t = (
          await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
            i.tenant,
            identifier(task),
          ])
        ).rows[0];
      if (!t) throw Error('task scope');
      samePrincipal(i, t.principal);
      const operations = (
        await c.query(
          'SELECT o.id,o.digest,o.provider,o.action,o.resource,o.params,o.cost,o.deadline,o.state,o.version,a.expires AS approval_expires FROM ct.task_operations m JOIN ct.operations o ON o.tenant=m.tenant AND o.id=m.operation LEFT JOIN ct.approvals a ON a.tenant=o.tenant AND a.operation=o.id AND a.digest=o.digest AND a.grant_version=o.grant_version WHERE m.tenant=$1 AND m.task=$2 ORDER BY o.id',
          [i.tenant, t.id],
        )
      ).rows;
      const states = operations.map((o) => o.state);
      const phase =
        t.status === 'CANCELLED'
          ? 'CANCELLED'
          : states.some((s) =>
                ['UNKNOWN', 'DENIED', 'FAILED_KNOWN_NO_EFFECT'].includes(s),
              )
            ? 'BLOCKED'
            : states.length > 0 && states.every((s) => s === 'COMMITTED')
              ? 'VERIFIED_COMPLETE'
              : operations.some(
                    (o) =>
                      o.state === 'REQUESTED' &&
                      (!o.approval_expires ||
                        +o.approval_expires <= Date.now()),
                  )
                ? 'AWAITING_APPROVAL'
                : states.some((s) => ['RESERVED', 'SENDING'].includes(s))
                  ? 'RUNNING'
                  : 'PLANNED';
      return {
        id: t.id,
        principal: t.principal,
        objective: t.objective,
        revision: Number(t.revision),
        phase,
        operations,
        organization: t.organization ?? null,
        mandate: t.mandate ?? null,
        mandateVersion:
          t.mandate_version == null ? null : Number(t.mandate_version),
      };
    });
  }
  async list(actor: VerifiedIdentity) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      return (
        await c.query(
          'SELECT id,principal,objective,status,revision,organization,mandate,mandate_version FROM ct.tasks WHERE tenant=$1 AND ($2::text IS NULL OR principal=$2) ORDER BY id LIMIT 100',
          [i.tenant, i.kind === 'machine' ? i.principal : null],
        )
      ).rows.map((t) => ({
        id: t.id,
        principal: t.principal,
        objective: t.objective,
        status: t.status,
        revision: t.revision,
        organization: t.organization ?? null,
        mandate: t.mandate ?? null,
        mandateVersion:
          t.mandate_version == null ? null : Number(t.mandate_version),
      }));
    });
  }
  async cancel(actor: VerifiedIdentity, task: string, revision: number) {
    return tx(this.db, async (c) => {
      await c.query('SELECT * FROM ct.control WHERE singleton FOR SHARE');
      const i = await enrolled(c, actor, true);
      const t = (
        await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
          i.tenant,
          identifier(task),
        ])
      ).rows[0];
      if (!t) throw Error('task scope');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, t.principal],
      );
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      const still = (
        await c.query(
          'SELECT active,domain_role FROM ct.identities WHERE id=$1 AND tenant=$2 AND active',
          [i.id, i.tenant],
        )
      ).rows[0];
      if (
        !still ||
        still.domain_role !== 'owner' ||
        actor.authTime === undefined ||
        actor.expires <= now ||
        actor.authTime > now + 5000 ||
        now - actor.authTime > 300000 ||
        !actor.methods.includes('mfa')
      )
        throw Error('fresh owner MFA required');
      const changed = await c.query(
        "UPDATE ct.tasks SET status='CANCELLED',revision=revision+1 WHERE tenant=$1 AND id=$2 AND revision=$3 AND status='PLANNED' RETURNING revision",
        [i.tenant, t.id, revision],
      );
      if (!changed.rowCount) throw Error('task CAS conflict');
      await append(c, i.tenant, 'TASK_CANCELLED', {
        task: t.id,
        ownerIdentity: i.id,
        alreadyInFlightMayFinish: true,
      });
      return {
        id: t.id,
        revision: Number(changed.rows[0].revision),
        status: 'CANCELLED',
      };
    });
  }
  async disableMachine(actor: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      await c.query('SELECT * FROM ct.control WHERE singleton FOR SHARE');
      const i = await enrolled(c, actor, true);
      const machine = (
        await c.query(
          'SELECT * FROM ct.identities WHERE tenant=$1 AND id=$2 AND kind=$3 FOR UPDATE',
          [i.tenant, identifier(id), 'machine'],
        )
      ).rows[0];
      if (!machine?.active || !machine.principal) throw Error('machine scope');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, machine.principal],
      );
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      if (
        actor.authTime === undefined ||
        actor.expires <= now ||
        actor.authTime > now + 5000 ||
        now - actor.authTime > 300000 ||
        !actor.methods.includes('mfa')
      )
        throw Error('fresh owner MFA required');
      const r = await c.query(
        "UPDATE ct.identities SET active=false,version=version+1 WHERE tenant=$1 AND id=$2 AND kind='machine' AND active RETURNING id,version",
        [i.tenant, machine.id],
      );
      if (!r.rowCount) throw Error('machine scope');
      await append(c, i.tenant, 'MACHINE_DISABLED', {
        identity: id,
        version: Number(r.rows[0].version),
        ownerIdentity: i.id,
      });
      return { id, disabled: true };
    });
  }
}
