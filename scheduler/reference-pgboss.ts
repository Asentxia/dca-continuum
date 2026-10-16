import { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { tx, canonical } from '../src/db.js';
import {
  validateReferenceJob,
  type ReferenceJob,
} from './reference-contracts.js';
export class ReferencePgBoss {
  private relayTimer?: ReturnType<typeof setInterval>;
  constructor(
    private db: pg.Pool,
    private boss: PgBoss,
    private safeEffect: (j: ReferenceJob, i: number) => Promise<string>,
    private queue: string,
    private versions: ReadonlySet<number> = new Set([1, 2]),
    private leaseMs = 30000,
  ) {}
  async start() {
    await this.boss.start();
    await this.boss.createQueue(this.queue, {
      retryLimit: 8,
      retryDelay: 1,
      expireInSeconds: 60,
    });
    await this.boss.work<{ task: string }>(
      this.queue,
      { pollingIntervalSeconds: 0.5 },
      async (messages) => {
        for (const m of messages) await this.advance(m.data.task);
      },
    );
    this.relayTimer = setInterval(() => this.relay().catch(() => {}), 250);
    await this.relay();
  }
  async stop() {
    if (this.relayTimer) clearInterval(this.relayTimer);
    await this.boss.stop({ graceful: true, timeout: 10000 });
  }
  async enqueue(j: ReferenceJob) {
    validateReferenceJob(j);
    await tx(this.db, async (c) => {
      const old = (
        await c.query('SELECT input FROM ctq.jobs WHERE id=$1 FOR UPDATE', [
          j.id,
        ])
      ).rows[0];
      if (old) {
        if (canonical(old.input) !== canonical(j))
          throw Error('job identity conflict');
        return;
      }
      await c.query('INSERT INTO ctq.jobs(id,version,input) VALUES($1,$2,$3)', [
        j.id,
        j.schemaVersion,
        j,
      ]);
      await c.query('INSERT INTO ctq.outbox(id,task_id) VALUES($1,$2)', [
        'ref:' + j.id + ':start',
        j.id,
      ]);
    });
    await this.relay();
  }
  async signal(id: string) {
    await tx(this.db, async (c) => {
      const r = await c.query(
        'UPDATE ctq.jobs SET approved=true,revision=revision+1 WHERE id=$1 RETURNING due',
        [id],
      );
      if (!r.rowCount) throw Error('job missing');
      await c.query(
        'INSERT INTO ctq.outbox(id,task_id,start_after) VALUES($1,$2,GREATEST(clock_timestamp(),$3::timestamptz)) ON CONFLICT DO NOTHING',
        ['ref:' + id + ':signal', id, r.rows[0].due],
      );
    });
    await this.relay();
  }
  async status(id: string) {
    return (
      await this.db.query(
        'SELECT phase,done,version,revision,due FROM ctq.jobs WHERE id=$1',
        [id],
      )
    ).rows[0];
  }
  private async relay() {
    const rows = (
      await this.db.query(
        "SELECT * FROM ctq.outbox WHERE NOT sent AND id LIKE 'ref:%' ORDER BY start_after LIMIT 20",
      )
    ).rows;
    for (const r of rows) {
      await this.boss.send(
        this.queue,
        { task: r.task_id },
        { startAfter: r.start_after, singletonKey: r.id },
      );
      await this.db.query('UPDATE ctq.outbox SET sent=true WHERE id=$1', [
        r.id,
      ]);
    }
  }
  private async advance(id: string) {
    const owner = randomUUID(),
      row = await tx(this.db, async (c) => {
        const r = (
          await c.query(
            'SELECT *,clock_timestamp() AS now FROM ctq.jobs WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!r || ['DONE', 'BLOCKED'].includes(r.phase)) return null;
        if (r.lease_until && +r.lease_until > +r.now) throw Error('busy lease');
        if (!this.versions.has(r.version))
          throw Error('retained handler missing');
        if (r.phase === 'WAITING' && (!r.approved || +r.due > +r.now))
          return null;
        await c.query(
          "UPDATE ctq.jobs SET owner=$2,lease_until=clock_timestamp()+($3::int*interval '1 millisecond'),revision=revision+1 WHERE id=$1",
          [id, owner, this.leaseMs],
        );
        return r;
      });
    if (!row) return;
    const j = validateReferenceJob(row.input as ReferenceJob),
      done = new Set<number>(row.done);
    const groups =
      j.schemaVersion === 2
        ? [
            [0, 2, 4, 6, 8],
            [1, 3, 5, 7, 9],
          ]
        : row.phase === 'READY'
          ? [[0], [1], [2], [3], [4], [5, 6]]
          : [[7], [8], [9]];
    try {
      let ok = true;
      for (const group of groups) {
        const states = await Promise.all(
          group.map(async (index) => {
            if (done.has(index)) return true;
            const state = await this.safeEffect(j, index);
            if (state !== 'COMMITTED') return false;
            done.add(index);
            return true;
          }),
        );
        if (!states.every(Boolean)) {
          ok = false;
          break;
        }
        const r = await this.db.query(
          "UPDATE ctq.jobs SET done=$3,lease_until=clock_timestamp()+($4::int*interval '1 millisecond'),revision=revision+1 WHERE id=$1 AND owner=$2 AND lease_until>clock_timestamp()",
          [id, owner, [...done].sort((a, b) => a - b), this.leaseMs],
        );
        if (!r.rowCount) throw Error('expired scheduler owner');
      }
      await tx(this.db, async (c) => {
        const waiting = ok && j.schemaVersion === 1 && row.phase === 'READY';
        const r = await c.query(
          "UPDATE ctq.jobs SET phase=$3,done=$4,due=CASE WHEN $3='WAITING' THEN clock_timestamp()+($5::int*interval '1 millisecond') ELSE due END,owner=NULL,lease_until=NULL,revision=revision+1 WHERE id=$1 AND owner=$2 AND lease_until>clock_timestamp()",
          [
            id,
            owner,
            !ok ? 'BLOCKED' : waiting ? 'WAITING' : 'DONE',
            [...done].sort((a, b) => a - b),
            j.waitMs,
          ],
        );
        if (!r.rowCount) throw Error('phase CAS');
        if (waiting)
          await c.query(
            "INSERT INTO ctq.outbox(id,task_id,start_after) VALUES($1,$2,clock_timestamp()+($3::int*interval '1 millisecond')) ON CONFLICT DO NOTHING",
            ['ref:' + id + ':wait', id, j.waitMs],
          );
      });
    } catch (e) {
      await this.db
        .query(
          'UPDATE ctq.jobs SET owner=NULL,lease_until=NULL,revision=revision+1 WHERE id=$1 AND owner=$2',
          [id, owner],
        )
        .catch(() => {});
      throw e;
    }
  }
}
