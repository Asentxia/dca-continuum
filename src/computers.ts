import type pg from 'pg';
import type { VerifiedIdentity } from './identity-provider.js';
import { tx, append } from './db.js';
import { reserveResources } from './resource-controls.js';
import { enrolled, identifier, activeControl } from './service-auth.js';
export interface PlacementSpec {
  tenant: string;
  computer: string;
  principal: string;
  generation: number;
  requestId: string;
}
export interface Placement {
  id: string;
  tenant: string;
  computer: string;
  generation: number;
  status: 'STARTING' | 'RUNNING' | 'STOPPED';
}
export interface ComputerDriver {
  start(spec: PlacementSpec): Promise<Placement>;
  inspect(id: string): Promise<Placement>;
  stop(id: string): Promise<void>;
}
export class ComputerService {
  constructor(
    private db: pg.Pool,
    private driver: ComputerDriver,
    private fence: string,
  ) {}
  async register(actor: VerifiedIdentity, id: string, principal: string) {
    return tx(this.db, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor, true);
      identifier(id);
      identifier(principal);
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, principal],
        )
      ).rows[0];
      if (!p?.active) throw Error('principal scope');
      await c.query(
        "INSERT INTO ct.computers(tenant,id,principal,generation,state) VALUES($1,$2,$3,1,'STOPPED')",
        [i.tenant, id, principal],
      );
      await append(c, i.tenant, 'COMPUTER_REGISTERED', {
        id,
        principal,
        generation: 1,
        owner: i.id,
      });
      return { id, generation: 1 };
    });
  }
  private async lock(c: pg.PoolClient, a: VerifiedIdentity, id: string) {
    await activeControl(c, this.fence);
    const i = await enrolled(c, a, true);
    const old = (
      await c.query('SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2', [
        i.tenant,
        identifier(id),
      ])
    ).rows[0];
    if (!old) throw Error('computer scope');
    const p = (
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, old.principal],
      )
    ).rows[0];
    const r = (
      await c.query(
        'SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, id],
      )
    ).rows[0];
    if (
      !p?.active ||
      a.expires <= +(await c.query('SELECT clock_timestamp() t')).rows[0].t
    )
      throw Error('computer/identity fence');
    return { i, p, r };
  }
  async start(actor: VerifiedIdentity, id: string) {
    const reserved = await tx(this.db, async (c) => {
      const { i, r } = await this.lock(c, actor, id);
      if (!['STOPPED', 'LOST'].includes(r.state))
        throw Error('start already pending or active; inspect before retry');
      const row = (
        await c.query(
          "UPDATE ct.computers SET state='STARTING',placement=NULL,revision=revision+1 WHERE tenant=$1 AND id=$2 RETURNING *",
          [i.tenant, id],
        )
      ).rows[0];
      await reserveResources(
        c,
        i.tenant,
        'computer',
        `${id}:${row.generation}:${row.revision}`,
        r.principal,
        { units: 1, jobs: 1, bytes: 0 },
      );
      await append(c, i.tenant, 'COMPUTER_START_RESERVED', {
        id,
        generation: row.generation,
      });
      return row;
    });
    let placement: Placement;
    try {
      placement = await this.driver.start({
        tenant: reserved.tenant,
        computer: id,
        principal: reserved.principal,
        generation: reserved.generation,
        requestId: `${id}:${reserved.generation}:${reserved.revision}`,
      });
    } catch {
      await tx(this.db, async (c) => {
        await append(c, reserved.tenant, 'COMPUTER_START_UNCERTAIN', {
          id,
          generation: reserved.generation,
          noAutomaticRetry: true,
        });
      });
      throw Error('computer start uncertain; operator reconciliation required');
    }
    return tx(this.db, async (c) => {
      const { i, r } = await this.lock(c, actor, id);
      if (
        r.state !== 'STARTING' ||
        r.generation !== placement.generation ||
        placement.tenant !== i.tenant ||
        placement.computer !== id
      )
        throw Error('placement binding');
      const row = (
        await c.query(
          'UPDATE ct.computers SET placement=$3,state=$4,revision=revision+1 WHERE tenant=$1 AND id=$2 RETURNING *',
          [i.tenant, id, placement.id, placement.status],
        )
      ).rows[0];
      await append(c, i.tenant, 'COMPUTER_PLACED', {
        id,
        placement: placement.id,
        generation: r.generation,
        state: row.state,
      });
      return row;
    });
  }
  async observe(actor: VerifiedIdentity, id: string) {
    const r = await tx(this.db, async (c) => (await this.lock(c, actor, id)).r);
    if (!r.placement)
      throw Error(
        'uncertain start has no placement; inventory reconciliation required',
      );
    const view = await this.driver.inspect(r.placement);
    return tx(this.db, async (c) => {
      const { i, r: current } = await this.lock(c, actor, id);
      if (
        current.placement !== view.id ||
        view.tenant !== i.tenant ||
        view.computer !== id ||
        view.generation !== current.generation
      )
        throw Error('placement mismatch');
      if (current.state === 'STARTING' && view.status === 'RUNNING')
        await c.query(
          "UPDATE ct.computers SET state='RUNNING',revision=revision+1 WHERE tenant=$1 AND id=$2",
          [i.tenant, id],
        );
      return view;
    });
  }
  async lose(actor: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const { i, r } = await this.lock(c, actor, id);
      const row = (
        await c.query(
          "UPDATE ct.computers SET generation=generation+1,state='LOST',revision=revision+1 WHERE tenant=$1 AND id=$2 RETURNING *",
          [i.tenant, id],
        )
      ).rows[0];
      await append(c, i.tenant, 'COMPUTER_LOST_FENCED', {
        id,
        oldPlacement: r.placement,
        oldGeneration: r.generation,
        generation: row.generation,
        physicalTerminationNotAssumed: true,
      });
      return row;
    });
  }
  async destroy(actor: VerifiedIdentity, id: string) {
    const lost = await this.lose(actor, id);
    if (lost.placement) await this.driver.stop(lost.placement);
    return tx(this.db, async (c) => {
      const { i, r } = await this.lock(c, actor, id);
      if (r.generation !== lost.generation || r.state !== 'LOST')
        throw Error('concurrent placement change');
      const row = (
        await c.query(
          "UPDATE ct.computers SET state='STOPPED',placement=NULL,revision=revision+1 WHERE tenant=$1 AND id=$2 RETURNING *",
          [i.tenant, id],
        )
      ).rows[0];
      await append(c, i.tenant, 'COMPUTER_DESTROYED', {
        id,
        generation: r.generation,
      });
      return row;
    });
  }
  async authorizePlacement(
    actor: VerifiedIdentity,
    id: string,
    placement: string,
    generation: number,
  ) {
    return tx(this.db, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor);
      if (i.kind !== 'machine' || !i.principal) throw Error('machine required');
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR SHARE',
          [i.tenant, i.principal],
        )
      ).rows[0];
      const r = (
        await c.query(
          'SELECT * FROM ct.computers WHERE tenant=$1 AND principal=$2 FOR SHARE',
          [i.tenant, i.principal],
        )
      ).rows[0];
      if (
        !p?.active ||
        !r ||
        r.id !== identifier(id) ||
        r.placement !== placement ||
        actor.credentialPlacement === undefined ||
        actor.credentialPlacement !== Number(r.generation) ||
        generation !== actor.credentialPlacement ||
        actor.credentialGeneration !== Number(p.generation) ||
        actor.credentialEpoch !== Number(p.epoch) ||
        r.state !== 'RUNNING' ||
        actor.expires <=
          +(await c.query('SELECT clock_timestamp() t')).rows[0].t
      )
        throw Error('placement generation denied');
      return { tenant: i.tenant, computer: r.id, generation: r.generation };
    });
  }
}
