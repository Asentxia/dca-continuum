import { safeError } from './operational-controls.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  tx,
  eventOutbox,
  bindingDigest,
  canonical,
  placementAdmission,
  manifestAdmission,
} from './db.js';
import { lockBoundManifest } from './context-lock.js';
import type { Capability } from './capability.js';
import type { ProviderAdapter } from './provider-adapter.js';
export interface Hooks {
  afterReservation?: () => Promise<void>;
  beforeSend?: () => Promise<void>;
  afterSend?: () => Promise<void>;
}
export class EffectController {
  constructor(
    private db: pg.Pool,
    private adapter: ProviderAdapter,
    private deploymentFence: string,
    private leaseMs = 30000,
    private hooks: Hooks = {},
    private externalFenceGuard?: (expected: string) => Promise<void>,
  ) {}
  private async locked(
    c: pg.PoolClient,
    tenant: string,
    id: string,
    actor?: Capability,
  ) {
    const control = (
      await c.query(
        'SELECT *,clock_timestamp() AS db_now FROM ct.control WHERE singleton FOR SHARE',
      )
    ).rows[0];
    const identity = actor?.identityId
      ? (
          await c.query('SELECT * FROM ct.identities WHERE id=$1 FOR SHARE', [
            actor.identityId,
          ])
        ).rows[0]
      : null;
    const initial = (
      await c.query('SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2', [
        tenant,
        id,
      ])
    ).rows[0];
    if (!initial) throw Error('operation not found');
    const p = (
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, initial.principal],
      )
    ).rows[0];
    const computer =
      (
        await c.query(
          'SELECT * FROM ct.computers WHERE tenant=$1 AND principal=$2 FOR SHARE',
          [tenant, initial.principal],
        )
      ).rows[0] ?? null;
    const task = (
      await c.query(
        'SELECT t.* FROM ct.tasks t JOIN ct.task_operations m ON m.tenant=t.tenant AND m.task=t.id WHERE m.tenant=$1 AND m.operation=$2 FOR SHARE OF t',
        [tenant, id],
      )
    ).rows[0];
    const g = (
      await c.query(
        'SELECT * FROM ct.grants WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, initial.grant_id],
      )
    ).rows[0];
    const o = (
      await c.query(
        'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, id],
      )
    ).rows[0];
    const manifest = await lockBoundManifest(c, o);
    return { control, p, g, o, identity, task, computer, manifest };
  }
  private async authority(
    c: pg.PoolClient,
    l: Awaited<ReturnType<EffectController['locked']>>,
    actor: Capability,
    budget: boolean,
  ) {
    const { control, p, g, o, identity, task, computer } = l;
    try {
      await this.externalFenceGuard?.(this.deploymentFence);
    } catch {
      return 'EXTERNAL_RECOVERY_FENCE';
    }
    const a = g.approval_required
      ? (
          await c.query(
            'SELECT * FROM ct.approvals WHERE tenant=$1 AND operation=$2 FOR SHARE',
            [o.tenant, o.id],
          )
        ).rows[0]
      : null;
    // Evaluate time AFTER all contended authority locks, especially at final send.
    const dbNow = new Date(
        (await c.query('SELECT clock_timestamp() AS t')).rows[0].t,
      ).getTime(),
      now = Date.now();
    if (
      !control ||
      control.blocked ||
      control.fence !== this.deploymentFence ||
      o.fence !== this.deploymentFence ||
      actor.deploymentFence !== this.deploymentFence
    )
      return 'RECOVERY_FENCE';
    if (
      actor.identityId &&
      (!identity ||
        !identity.active ||
        Number(identity.version) !== actor.identityVersion ||
        identity.kind !== 'machine' ||
        identity.tenant !== o.tenant ||
        identity.principal !== o.principal)
    )
      return 'IDENTITY_REVOKED';
    if (
      actor.expires <= now ||
      actor.tenant !== o.tenant ||
      actor.principal !== o.principal ||
      !actor.operations.includes(o.id)
    )
      return 'CAPABILITY_SCOPE';
    if (
      !p.active ||
      p.epoch !== o.epoch ||
      p.generation !== o.generation ||
      actor.epoch !== p.epoch ||
      actor.generation !== p.generation
    )
      return 'PRINCIPAL_FENCE';
    if (p.execution_mode && p.execution_mode !== 'AGENT')
      return 'HUMAN_OR_PAUSED_EXECUTION_MODE';
    const placement = placementAdmission(
      computer,
      o,
      actor.placementGeneration,
    );
    if (placement) return placement;
    const manifest = manifestAdmission(
      o,
      l.manifest.head,
      l.manifest.version,
      l.manifest.cognition,
      dbNow,
      l.manifest.tool,
    );
    if (manifest) return manifest;
    if (
      task &&
      (task.status === 'CANCELLED' || task.plan_version !== o.plan_version)
    )
      return 'TASK_CANCELLED_OR_STALE';
    if (bindingDigest(o) !== o.digest) return 'BINDING_CORRUPT';
    if (
      g.revoked ||
      g.version !== o.grant_version ||
      new Date(g.expires).getTime() <= dbNow
    )
      return 'GRANT_STALE';
    if (
      g.principal !== o.principal ||
      g.action !== o.action ||
      g.resource !== o.resource ||
      !this.adapter.supports(o)
    )
      return 'GRANT_SCOPE';
    if (new Date(o.deadline).getTime() <= dbNow) return 'DEADLINE';
    if (
      ![o.cost, g.max_cost, g.budget, g.reserved].every((v) =>
        Number.isSafeInteger(Number(v)),
      )
    )
      return 'BUDGET_RANGE';
    if (
      Number(o.cost) > Number(g.max_cost) ||
      (budget && Number(g.reserved) + Number(o.cost) > Number(g.budget))
    )
      return 'BUDGET';
    if (g.approval_required) {
      if (
        !a ||
        a.digest !== o.digest ||
        a.grant_version !== g.version ||
        new Date(a.expires).getTime() <= dbNow ||
        a.approved_by === o.principal
      )
        return 'APPROVAL';
    }
    return null;
  }
  private async transition(
    c: pg.PoolClient,
    o: Record<string, any>,
    state: string,
    detail: unknown,
    observation?: unknown,
  ) {
    const r = await c.query(
      'UPDATE ct.operations SET state=$3,version=version+1,observation=COALESCE($4::jsonb,observation) WHERE tenant=$1 AND id=$2 AND version=$5 RETURNING *',
      [
        o.tenant,
        o.id,
        state,
        observation ? JSON.stringify(observation) : null,
        o.version,
      ],
    );
    if (!r.rowCount) throw Error('CAS conflict');
    await eventOutbox(c, { tenant: o.tenant, id: o.id }, 'EFFECT_' + state, {
      id: o.id,
      attempt: o.attempt ?? null,
      detail,
    });
    return r.rows[0];
  }
  async dispatch(actor: Capability, id: string) {
    if (actor.expires <= Date.now() || !actor.operations.includes(id))
      throw Error('capability scope');
    const admitted = await tx(this.db, async (c) => {
      const l = await this.locked(c, actor.tenant, id, actor),
        o = l.o;
      if (o.principal !== actor.principal) throw Error('principal mismatch');
      if (o.state !== 'REQUESTED') {
        if (
          ['RESERVED', 'SENDING'].includes(o.state) &&
          new Date(o.lease_until).getTime() <= Date.now()
        )
          return {
            o: await this.transition(c, o, 'UNKNOWN', {
              reason: 'expired uncertain attempt',
            }),
            sender: false,
          };
        return { o, sender: false };
      }
      await this.externalFenceGuard?.(this.deploymentFence);
      const reason = await this.authority(c, l, actor, true);
      if (reason)
        return {
          o: await this.transition(c, o, 'DENIED', { reason }),
          sender: false,
        };
      const attempt = randomUUID();
      await c.query(
        'UPDATE ct.grants SET reserved=reserved+$3 WHERE tenant=$1 AND id=$2',
        [o.tenant, o.grant_id, o.cost],
      );
      const r = await c.query(
        "UPDATE ct.operations SET state='RESERVED',version=version+1,attempt=$3,lease_until=clock_timestamp()+($4::int*interval '1 millisecond') WHERE tenant=$1 AND id=$2 AND version=$5 RETURNING *",
        [o.tenant, o.id, attempt, this.leaseMs, o.version],
      );
      if (!r.rowCount) throw Error('CAS');
      await eventOutbox(c, o, 'EFFECT_RESERVED', { id, attempt });
      return { o: r.rows[0], sender: true };
    });
    if (!admitted.sender) return admitted.o;
    await this.hooks.afterReservation?.();
    const sending = await tx(this.db, async (c) => {
      const l = await this.locked(c, actor.tenant, id, actor),
        o = l.o;
      if (o.state !== 'RESERVED' || o.attempt !== admitted.o.attempt) return o;
      const reason = await this.authority(c, l, actor, false);
      if (reason) {
        await c.query(
          'UPDATE ct.grants SET reserved=reserved-$3 WHERE tenant=$1 AND id=$2',
          [o.tenant, o.grant_id, o.cost],
        );
        return this.transition(c, o, 'DENIED', { reason });
      }
      return this.transition(c, o, 'SENDING', { attempt: o.attempt });
    });
    if (sending.state !== 'SENDING' || sending.attempt !== admitted.o.attempt)
      return sending;
    await this.hooks.beforeSend?.();
    try {
      await this.adapter.send(sending);
      await this.hooks.afterSend?.();
    } catch (e) {
      return tx(this.db, async (c) => {
        const o = (
          await c.query(
            'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2 FOR UPDATE',
            [actor.tenant, id],
          )
        ).rows[0];
        if (o.state === 'COMMITTED') return o;
        return this.transition(c, o, 'UNKNOWN', {
          reason: 'transport uncertainty',
          error: safeError(e),
        });
      });
    }
    return this.reconcile(actor, id);
  }
  async reconcile(actor: Capability, id: string) {
    if (actor.expires <= Date.now() || !actor.operations.includes(id))
      throw Error('capability scope');
    const o = (
      await this.db.query(
        'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2',
        [actor.tenant, id],
      )
    ).rows[0];
    if (!o || o.principal !== actor.principal) throw Error('operation scope');
    if (['COMMITTED', 'DENIED', 'FAILED_KNOWN_NO_EFFECT'].includes(o.state))
      return o;
    if (o.state === 'REQUESTED') return o;
    let observations: Awaited<ReturnType<ProviderAdapter['lookup']>> = [];
    let unavailable = false;
    try {
      observations = await this.adapter.lookup(o);
    } catch {
      unavailable = true;
    }
    const match =
      observations.length === 1 &&
      observations[0].tenant === o.tenant &&
      observations[0].operation === o.id &&
      observations[0].digest === o.digest &&
      observations[0].idempotency_key === o.idempotency_key &&
      canonical(observations[0].payload) === canonical(o.params);
    return tx(this.db, async (c) => {
      let current = (
        await c.query(
          'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [actor.tenant, id],
        )
      ).rows[0];
      if (current.state === 'COMMITTED' || current.state === 'DENIED')
        return current;
      if (
        current.state === 'RESERVED' &&
        new Date(current.lease_until).getTime() > Date.now()
      )
        return current;
      if (current.state === 'RESERVED')
        current = await this.transition(c, current, 'UNKNOWN', {
          reason: 'reservation expired',
        });
      if (match)
        return this.transition(
          c,
          current,
          'COMMITTED',
          { verification: 'authoritative fixture read-back' },
          observations[0],
        );
      if (current.state === 'UNKNOWN') return current;
      return this.transition(
        c,
        current,
        'UNKNOWN',
        {
          reason: unavailable
            ? 'readback unavailable'
            : 'missing/mismatched/duplicate observation',
        },
        observations,
      );
    });
  }
}
