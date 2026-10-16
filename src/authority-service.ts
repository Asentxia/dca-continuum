import type pg from 'pg';
import {
  tx,
  append,
  eventOutbox,
  bindingDigest,
  placementAdmission,
  manifestAdmission,
} from './db.js';
import { lockBoundManifest } from './context-lock.js';
import type { VerifiedIdentity } from './identity-provider.js';
import type { CapabilitySigner } from './production-capability.js';
import { activeControl } from './service-auth.js';
export class AuthorityService {
  constructor(
    private governor: pg.Pool,
    private issuerDb: pg.Pool,
    private signer: CapabilitySigner | undefined,
    private fence: string,
  ) {}
  private unit<T>(
    c: pg.PoolClient | undefined,
    fn: (c: pg.PoolClient) => Promise<T>,
  ) {
    return c ? fn(c) : tx(this.governor, fn);
  }
  private async enrolled(c: pg.PoolClient, actor: VerifiedIdentity) {
    if (actor.expires <= Date.now()) throw Error('identity expired');
    const i = (
      await c.query(
        'SELECT * FROM ct.identities WHERE issuer=$1 AND subject=$2 AND audience=$3 AND kind=$4 AND active FOR SHARE',
        [actor.issuer, actor.subject, actor.audience, actor.kind],
      )
    ).rows[0];
    if (!i) throw Error('identity not enrolled');
    return i;
  }
  private owner(
    actor: VerifiedIdentity,
    i: Record<string, any>,
    now = Date.now(),
  ) {
    if (
      actor.expires <= now ||
      actor.kind !== 'user' ||
      i.domain_role !== 'owner' ||
      actor.authTime === undefined ||
      actor.authTime > now + 5000 ||
      now - actor.authTime > 300000 ||
      !actor.methods.includes('mfa')
    )
      throw Error('fresh independently enrolled owner MFA required');
  }
  async createGrant(
    actor: VerifiedIdentity,
    input: {
      id: string;
      principal: string;
      action: string;
      resource: string;
      expires: string;
      maxCost: number;
      budget: number;
    },
    client?: pg.PoolClient,
  ) {
    return this.unit(client, async (c) => {
      const i = await this.enrolled(c, actor);
      this.owner(actor, i);
      await activeControl(c, this.fence);
      const expiration = new Date(input.expires);
      if (
        !input.id ||
        !input.principal ||
        !['write', 'readCommit'].includes(input.action) ||
        !input.resource ||
        !Number.isSafeInteger(input.maxCost) ||
        !Number.isSafeInteger(input.budget) ||
        input.maxCost < 0 ||
        input.budget < input.maxCost ||
        !Number.isFinite(+expiration) ||
        +expiration <= Date.now() ||
        +expiration > Date.now() + 172800000
      )
        throw Error('invalid bounded grant');
      await c.query(
        'INSERT INTO ct.grants(tenant,id,principal,action,resource,expires,max_cost,budget,approval_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)',
        [
          i.tenant,
          input.id,
          input.principal,
          input.action,
          input.resource,
          expiration,
          input.maxCost,
          input.budget,
        ],
      );
      await append(c, i.tenant, 'GRANT_CREATED', {
        grant: input.id,
        ownerIdentity: i.id,
        action: input.action,
        resource: input.resource,
        expires: expiration.toISOString(),
        maxCost: input.maxCost,
        budget: input.budget,
      });
      return { id: input.id, tenant: i.tenant };
    });
  }
  async approve(
    actor: VerifiedIdentity,
    input: {
      operation: string;
      digest: string;
      expires: string;
      expectedOperationVersion?: number;
      expectedApprovalRevision?: number;
    },
    client?: pg.PoolClient,
  ) {
    return this.unit(client, async (c) => {
      const i = await this.enrolled(c, actor);
      this.owner(actor, i);
      const ctrl = (
        await c.query('SELECT * FROM ct.control WHERE singleton FOR SHARE')
      ).rows[0];
      if (!ctrl || ctrl.blocked || ctrl.fence !== this.fence)
        throw Error('recovery fence');
      const initial = (
        await c.query('SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2', [
          i.tenant,
          input.operation,
        ])
      ).rows[0];
      if (!initial) throw Error('operation not found');
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, initial.principal],
        )
      ).rows[0];
      const g = (
        await c.query(
          'SELECT * FROM ct.grants WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, initial.grant_id],
        )
      ).rows[0];
      const o = (
        await c.query(
          'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, input.operation],
        )
      ).rows[0];
      const currentApproval = (
        await c.query(
          'SELECT * FROM ct.approvals WHERE tenant=$1 AND operation=$2 FOR UPDATE',
          [i.tenant, o.id],
        )
      ).rows[0];
      if (
        input.expectedOperationVersion !== undefined &&
        Number(o.version) !== input.expectedOperationVersion
      )
        throw Error('operation version conflict');
      if (
        input.expectedApprovalRevision !== undefined &&
        Number(currentApproval?.revision ?? 0) !==
          input.expectedApprovalRevision
      )
        throw Error('approval decision version conflict');
      const now = new Date(
          (await c.query('SELECT clock_timestamp() t')).rows[0].t,
        ).getTime(),
        expiration = new Date(input.expires);
      const stillEnrolled = (
        await c.query(
          'SELECT * FROM ct.identities WHERE id=$1 AND tenant=$2 AND active FOR SHARE',
          [i.id, i.tenant],
        )
      ).rows[0];
      if (!stillEnrolled) throw Error('identity not enrolled');
      this.owner(actor, stillEnrolled, now);
      if (
        o.state !== 'REQUESTED' ||
        o.digest !== input.digest ||
        bindingDigest(o) !== o.digest ||
        o.fence !== this.fence ||
        !p.active ||
        p.epoch !== o.epoch ||
        p.generation !== o.generation ||
        g.revoked ||
        g.version !== o.grant_version ||
        g.principal !== o.principal ||
        g.action !== o.action ||
        g.resource !== o.resource ||
        +expiration <= now ||
        +expiration >
          Math.min(
            +new Date(g.expires),
            +new Date(o.deadline),
            now + 86400000,
          ) ||
        actor.expires <= now
      )
        throw Error('exact approval/current authority mismatch');
      await c.query(
        'INSERT INTO ct.approvals(tenant,operation,digest,grant_version,approved_by,expires) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant,operation) DO UPDATE SET digest=EXCLUDED.digest,grant_version=EXCLUDED.grant_version,approved_by=EXCLUDED.approved_by,expires=EXCLUDED.expires',
        [i.tenant, o.id, o.digest, g.version, i.id, expiration],
      );
      await eventOutbox(c, o, 'OWNER_APPROVED', {
        id: o.id,
        digest: o.digest,
        grantVersion: g.version,
        ownerIdentity: i.id,
        expires: expiration.toISOString(),
      });
      return { id: o.id, digest: o.digest };
    });
  }
  async assign(
    actor: VerifiedIdentity,
    input: { identity: string; operation: string; expires: string },
    client?: pg.PoolClient,
  ) {
    return this.unit(client, async (c) => {
      const i = await this.enrolled(c, actor);
      this.owner(actor, i);
      await activeControl(c, this.fence);
      const target = (
        await c.query(
          'SELECT * FROM ct.identities WHERE id=$1 AND tenant=$2 AND active',
          [input.identity, i.tenant],
        )
      ).rows[0];
      const o = (
        await c.query('SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2', [
          i.tenant,
          input.operation,
        ])
      ).rows[0];
      const expiry = new Date(input.expires);
      if (
        !target ||
        target.kind !== 'machine' ||
        !o ||
        target.principal !== o.principal ||
        !Number.isFinite(+expiry) ||
        +expiry <= Date.now() ||
        +expiry > +new Date(o.deadline)
      )
        throw Error('assignment mismatch');
      await c.query('INSERT INTO ct.assignments VALUES($1,$2,$3,$4,$5)', [
        target.id,
        i.tenant,
        o.id,
        o.digest,
        expiry,
      ]);
      await append(c, i.tenant, 'WORKLOAD_ASSIGNED', {
        identity: target.id,
        operation: o.id,
        digest: o.digest,
        expires: expiry.toISOString(),
      });
      return { operation: o.id };
    });
  }
  async revoke(actor: VerifiedIdentity, grant: string, client?: pg.PoolClient) {
    return this.unit(client, async (c) => {
      const i = await this.enrolled(c, actor);
      this.owner(actor, i);
      await c.query('SELECT * FROM ct.control FOR SHARE');
      const initial = (
        await c.query('SELECT * FROM ct.grants WHERE tenant=$1 AND id=$2', [
          i.tenant,
          grant,
        ])
      ).rows[0];
      if (!initial) throw Error('grant missing');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, initial.principal],
      );
      await c.query(
        'UPDATE ct.grants SET revoked=true,version=version+1 WHERE tenant=$1 AND id=$2',
        [i.tenant, grant],
      );
      await append(c, i.tenant, 'GRANT_REVOKED', {
        grant,
        ownerIdentity: i.id,
      });
      return { grant, revoked: true };
    });
  }
  async renew(actor: VerifiedIdentity, operation: string) {
    if (!this.signer)
      throw Error('Machine issuance is absent from the human console service');
    const signingAuthority = this.signer;
    return tx(this.issuerDb, async (c) => {
      const i = await this.enrolled(c, actor);
      if (actor.kind !== 'machine' || i.domain_role !== 'worker')
        throw Error('enrolled machine required');
      const ctrl = (
        await c.query('SELECT * FROM ct.control WHERE singleton FOR SHARE')
      ).rows[0];
      if (!ctrl || ctrl.blocked || ctrl.fence !== this.fence)
        throw Error('recovery fence');
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, i.principal],
        )
      ).rows[0];
      const computer =
        (
          await c.query(
            'SELECT * FROM ct.computers WHERE tenant=$1 AND principal=$2 FOR SHARE',
            [i.tenant, i.principal],
          )
        ).rows[0] ?? null;
      const initial = (
        await c.query('SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2', [
          i.tenant,
          operation,
        ])
      ).rows[0];
      if (!initial || initial.principal !== i.principal)
        throw Error('operation scope');
      const task = (
        await c.query(
          'SELECT t.* FROM ct.tasks t JOIN ct.task_operations m ON m.tenant=t.tenant AND m.task=t.id WHERE m.tenant=$1 AND m.operation=$2 FOR SHARE OF t',
          [i.tenant, operation],
        )
      ).rows[0];
      const g = (
        await c.query(
          'SELECT * FROM ct.grants WHERE tenant=$1 AND id=$2 FOR SHARE',
          [i.tenant, initial.grant_id],
        )
      ).rows[0];
      const o = (
        await c.query(
          'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2 FOR SHARE',
          [i.tenant, operation],
        )
      ).rows[0];
      const a = (
        await c.query(
          'SELECT * FROM ct.approvals WHERE tenant=$1 AND operation=$2 FOR SHARE',
          [i.tenant, operation],
        )
      ).rows[0];
      const assignment = (
        await c.query(
          'SELECT * FROM ct.assignments WHERE identity_id=$1 AND tenant=$2 AND operation=$3 FOR SHARE',
          [i.id, i.tenant, operation],
        )
      ).rows[0];
      const manifest = await lockBoundManifest(c, o);
      const now = new Date(
        (await c.query('SELECT clock_timestamp() t')).rows[0].t,
      ).getTime();
      if (
        (task &&
          (task.status === 'CANCELLED' ||
            task.plan_version !== o.plan_version)) ||
        !p.active ||
        p.epoch !== o.epoch ||
        p.generation !== o.generation ||
        o.fence !== this.fence ||
        o.digest !== bindingDigest(o) ||
        g.revoked ||
        g.version !== o.grant_version ||
        g.principal !== p.id ||
        g.action !== o.action ||
        g.resource !== o.resource ||
        !assignment ||
        assignment.digest !== o.digest ||
        (g.approval_required &&
          (!a || a.digest !== o.digest || a.grant_version !== g.version)) ||
        actor.credentialGeneration !== Number(p.generation) ||
        actor.credentialEpoch !== Number(p.epoch) ||
        placementAdmission(computer, o, actor.credentialPlacement) ||
        manifestAdmission(
          o,
          manifest.head,
          manifest.version,
          manifest.cognition,
          now,
          manifest.tool,
        )
      )
        throw Error('current authority/assignment denied');
      const expires = Math.min(
        now + 90000,
        actor.expires,
        +new Date(g.expires),
        +new Date(o.deadline),
        +new Date(assignment.expires),
        g.approval_required ? +new Date(a.expires) : Infinity,
      );
      if (!Number.isFinite(expires) || expires <= now + 2000)
        throw Error('expired or insufficient remaining authority');
      const cap = {
        deploymentFence: this.fence,
        tenant: i.tenant,
        principal: p.id,
        epoch: p.epoch,
        generation: p.generation,
        ...(computer
          ? { placementGeneration: Number(computer.generation) }
          : {}),
        operations: [o.id],
        expires,
      };
      const token = await signingAuthority.sign(cap, i.id, Number(i.version));
      await append(c, i.tenant, 'CAPABILITY_ISSUED', {
        identity: i.id,
        operation: o.id,
        digest: o.digest,
        expires,
      });
      return { token, expires };
    });
  }
}
