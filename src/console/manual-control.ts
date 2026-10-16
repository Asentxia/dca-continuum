import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { tx, append } from '../db.js';
import type { VerifiedIdentity } from '../identity-provider.js';
import { enrolled, activeControl, identifier } from '../service-auth.js';
// Durable lease/fence foundation, NOT a managed screen/browser-control certification.
export class ManualControl {
  constructor(
    private db: pg.Pool,
    private fence: string,
    private allowLocalFixture: boolean,
  ) {}
  async take(a: VerifiedIdentity, computer: string, generation: number) {
    return tx(this.db, async (c) => {
      if (!this.allowLocalFixture)
        throw Error('managed control qualification pending');
      await activeControl(c, this.fence);
      const i = await enrolled(c, a, true);
      const base = (
        await c.query('SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2', [
          i.tenant,
          identifier(computer),
        ])
      ).rows[0];
      if (!base) throw Error('computer scope');
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, base.principal],
        )
      ).rows[0];
      const comp = (
        await c.query(
          'SELECT * FROM ct.computers WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, computer],
        )
      ).rows[0];
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      if (
        !p.active ||
        comp.generation !== generation ||
        p.execution_mode !== 'AGENT'
      )
        throw Error('mode/generation conflict');
      const observation = (
        await c.query(
          "SELECT * FROM ct.computer_observations WHERE tenant=$1 AND computer=$2 AND generation=$3 AND qualification_scope='LOCAL_FIXTURE'",
          [i.tenant, computer, generation],
        )
      ).rows[0];
      if (
        !observation ||
        +observation.fresh_until <= now ||
        !['ready', 'running', 'paused'].includes(observation.raw_state)
      )
        throw Error('trusted fixture placement observation required');
      const id = randomUUID();
      await c.query(
        'INSERT INTO ct.manual_leases(tenant,id,computer,principal,human_identity,generation,expires) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          i.tenant,
          id,
          computer,
          p.id,
          i.id,
          generation,
          new Date(Math.min(now + 90000, a.expires)),
        ],
      );
      await c.query(
        "UPDATE ct.principals SET execution_mode='HUMAN',epoch=epoch+1 WHERE tenant=$1 AND id=$2",
        [i.tenant, p.id],
      );
      await enrolled(c, a, true);
      await append(c, i.tenant, 'MANUAL_FIXTURE_LEASE_STARTED', {
        computer,
        lease: id,
        generation,
        actor: i.id,
        agentAdmissionFenced: true,
        managedBrowserIsolation: 'NOT RUN',
      });
      return { id, mode: 'HUMAN', managedBrowser: 'UNAVAILABLE' };
    });
  }
  async validate(a: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, a, true);
      const row = (
        await c.query(
          'SELECT l.*,c.generation current_generation,p.execution_mode FROM ct.manual_leases l JOIN ct.principals p ON p.tenant=l.tenant AND p.id=l.principal JOIN ct.computers c ON c.tenant=l.tenant AND c.id=l.computer WHERE l.tenant=$1 AND l.id=$2 AND l.human_identity=$3',
          [i.tenant, id, i.id],
        )
      ).rows[0];
      const now = +(await c.query('SELECT clock_timestamp() t')).rows[0].t;
      if (
        !row ||
        row.ended_at ||
        +row.expires <= now ||
        row.current_generation !== row.generation ||
        row.execution_mode !== 'HUMAN'
      )
        throw Error('missing/stale control lease');
      return { id, scope: 'LOCAL_FIXTURE', browserInput: 'UNAVAILABLE' };
    });
  }
  async handBack(a: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, a, true);
      const lease = (
        await c.query(
          'SELECT * FROM ct.manual_leases WHERE tenant=$1 AND id=$2',
          [i.tenant, id],
        )
      ).rows[0];
      if (!lease || lease.human_identity !== i.id) throw Error('lease scope');
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, lease.principal],
      );
      const row = (
        await c.query(
          'UPDATE ct.manual_leases SET ended_at=clock_timestamp() WHERE tenant=$1 AND id=$2 AND ended_at IS NULL RETURNING id',
          [i.tenant, id],
        )
      ).rows[0];
      if (!row) throw Error('lease ended');
      await c.query(
        "UPDATE ct.principals SET execution_mode='PAUSED',epoch=epoch+1 WHERE tenant=$1 AND id=$2",
        [i.tenant, lease.principal],
      );
      await append(c, i.tenant, 'MANUAL_FIXTURE_HAND_BACK', {
        id,
        agentResumed: false,
        reauthorizationRequired: true,
      });
      return { id, agentResumed: false, mode: 'PAUSED' };
    });
  }
}
