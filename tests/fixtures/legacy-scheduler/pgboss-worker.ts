import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { pool, tx } from '../../../src/db.js';
import { effect } from './effect-activity.js';
import type { Job } from './contracts.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const db = pool('ct_scheduler');
const boss = new PgBoss({
  host: '127.0.0.1',
  port: 55432,
  user: 'ct_scheduler',
  database: 'ct_test',
  schema: 'pgboss_ct',
  monitorIntervalSeconds: 5,
});
boss.on('error', (e) => console.error('queue error', String(e)));
await boss.start();
await boss.createQueue('continuum-bounded', {
  retryLimit: 8,
  retryDelay: 1,
  expireInSeconds: 5,
});
async function relay() {
  const r = await db.query(
    'SELECT * FROM ctq.outbox WHERE NOT sent ORDER BY start_after LIMIT 20',
  );
  for (const row of r.rows) {
    await boss.send(
      'continuum-bounded',
      { task: row.task_id },
      { startAfter: row.start_after, singletonKey: row.id },
    );
    await db.query('UPDATE ctq.outbox SET sent=true WHERE id=$1', [row.id]);
  }
}
await boss.work<{ task: string }>(
  'continuum-bounded',
  { pollingIntervalSeconds: 0.5 },
  async (msgs) => {
    for (const msg of msgs) {
      const owner = randomUUID();
      const row = await tx(db, async (c) => {
        const j = (
          await c.query('SELECT * FROM ctq.jobs WHERE id=$1 FOR UPDATE', [
            msg.data.task,
          ])
        ).rows[0];
        if (!j || ['DONE', 'BLOCKED'].includes(j.phase)) return null;
        if (j.lease_until && new Date(j.lease_until).getTime() > Date.now())
          throw Error('busy');
        if (j.version === 2 && config.version !== 2)
          throw Error('v2 handler unavailable');
        if (
          j.phase === 'WAITING' &&
          (!j.approved || new Date(j.due).getTime() > Date.now())
        )
          throw Error('gate not ready');
        await c.query(
          "UPDATE ctq.jobs SET owner=$2,lease_until=now()+interval '4 seconds',revision=revision+1 WHERE id=$1",
          [j.id, owner],
        );
        return j;
      });
      if (!row) continue;
      const job = row.input as Job;
      const done = new Set<number>(row.done);
      const indices =
        row.version === 2
          ? [...Array(10).keys()]
          : row.phase === 'READY'
            ? [0, 1, 2, 3, 4, 5, 6]
            : [7, 8, 9];
      async function one(i: number) {
        if (done.has(i)) return true;
        const result = await effect(job, i);
        if (result !== 'COMMITTED') return false;
        if (config.killAfterEffectId === job.id && i === 0)
          process.kill(process.pid, 'SIGKILL');
        done.add(i);
        const r = await db.query(
          'UPDATE ctq.jobs SET done=$3,revision=revision+1 WHERE id=$1 AND owner=$2',
          [job.id, owner, [...done].sort((a, b) => a - b)],
        );
        if (!r.rowCount) throw Error('stale scheduler owner');
        return true;
      }
      let ok = true;
      try {
        for (const i of indices) {
          if (i === 5 && row.version === 1) {
            const branch = await Promise.all([5, 6].map(one));
            ok = branch.every(Boolean);
            break;
          }
          if (!(await one(i))) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          await db.query(
            "UPDATE ctq.jobs SET phase='BLOCKED',lease_until=NULL,revision=revision+1 WHERE id=$1 AND owner=$2",
            [job.id, owner],
          );
          continue;
        }
        await tx(db, async (c) => {
          if (row.version === 1 && row.phase === 'READY') {
            await c.query(
              "UPDATE ctq.jobs SET phase='WAITING',due=now()+($3::int*interval '1 millisecond'),lease_until=NULL,revision=revision+1 WHERE id=$1 AND owner=$2",
              [job.id, owner, job.waitMs],
            );
            await c.query(
              "INSERT INTO ctq.outbox(id,task_id,start_after) VALUES($1,$2,now()+($3::int*interval '1 millisecond')) ON CONFLICT DO NOTHING",
              [job.id + ':after-wait', job.id, job.waitMs],
            );
          } else
            await c.query(
              "UPDATE ctq.jobs SET phase='DONE',lease_until=NULL,revision=revision+1 WHERE id=$1 AND owner=$2",
              [job.id, owner],
            );
        });
      } catch (e) {
        await db
          .query(
            'UPDATE ctq.jobs SET lease_until=NULL WHERE id=$1 AND owner=$2',
            [job.id, owner],
          )
          .catch(() => {});
        throw e;
      }
    }
  },
);
setInterval(
  () => relay().catch((e) => console.error('relay error', String(e))),
  500,
);
await relay();
console.log('READY');
