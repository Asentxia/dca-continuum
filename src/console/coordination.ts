import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { tx, append } from '../db.js';
import type { VerifiedIdentity } from '../identity-provider.js';
import { enrolled, identifier, activeControl } from '../service-auth.js';
// Trusted domain seam; not an implicit browser command or delegation engine.
export class WorkCoordination {
  constructor(
    private db: pg.Pool,
    private fence: string,
  ) {}
  private async start(c: pg.PoolClient, a: VerifiedIdentity, owner = true) {
    await activeControl(c, this.fence);
    const i = await enrolled(c, a, owner);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'coordination:' + i.tenant,
    ]);
    return i;
  }
  async project(
    a: VerifiedIdentity,
    id: string,
    name: string,
    objective: string,
    client?: pg.PoolClient,
  ) {
    const run = async (c: pg.PoolClient) => {
      const i = await this.start(c, a);
      identifier(id);
      if (!name.trim() || name.length > 200 || objective.length > 8000)
        throw Error('project bounds');
      const row = (
        await c.query(
          'INSERT INTO ct.projects(tenant,id,name,objective) VALUES($1,$2,$3,$4) RETURNING revision',
          [i.tenant, id, name, objective],
        )
      ).rows[0];
      await append(c, i.tenant, 'PROJECT_REGISTERED', { id, actor: i.id });
      return { id, revision: Number(row.revision) };
    };
    return client ? run(client) : tx(this.db, run);
  }
  async link(
    a: VerifiedIdentity,
    task: string,
    project: string,
    expected: number,
    client?: pg.PoolClient,
  ) {
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected > Number.MAX_SAFE_INTEGER - 1
    )
      throw Error('coordination version');
    const run = async (c: pg.PoolClient) => {
      const i = await this.start(c, a);
      const t = (
        await c.query('SELECT * FROM ct.tasks WHERE tenant=$1 AND id=$2', [
          i.tenant,
          identifier(task),
        ])
      ).rows[0];
      if (!t) throw Error('task scope');
      const old = (
        await c.query(
          'SELECT * FROM ct.work_coordination WHERE tenant=$1 AND task=$2 FOR UPDATE',
          [i.tenant, task],
        )
      ).rows[0];
      if (Number(old?.revision ?? 0) !== expected)
        throw Error('coordination CAS');
      if (old)
        await c.query(
          'UPDATE ct.work_coordination SET project=$3,revision=revision+1 WHERE tenant=$1 AND task=$2',
          [i.tenant, task, identifier(project)],
        );
      else
        await c.query(
          'INSERT INTO ct.work_coordination(tenant,task,project,accountable_vera) VALUES($1,$2,$3,$4)',
          [i.tenant, task, identifier(project), t.principal],
        );
      await append(c, i.tenant, 'TASK_PROJECT_LINKED', { task, project });
      return { task, revision: expected + 1 };
    };
    return client ? run(client) : tx(this.db, run);
  }
  async dependency(
    a: VerifiedIdentity,
    task: string,
    dependsOn: string,
    expected: number,
  ) {
    return tx(this.db, async (c) => {
      const i = await this.start(c, a);
      identifier(task);
      identifier(dependsOn);
      const t = (
        await c.query(
          'SELECT * FROM ct.work_coordination WHERE tenant=$1 AND task=$2 FOR UPDATE',
          [i.tenant, task],
        )
      ).rows[0];
      if (!t || Number(t.revision) !== expected) throw Error('dependency CAS');
      const cycle = (
        await c.query(
          'WITH RECURSIVE reach(id) AS (SELECT $2::text UNION SELECT d.depends_on FROM ct.task_dependencies d JOIN reach r ON d.task=r.id WHERE d.tenant=$1) SELECT 1 FROM reach WHERE id=$3',
          [i.tenant, dependsOn, task],
        )
      ).rowCount;
      if (cycle) throw Error('dependency cycle');
      await c.query('INSERT INTO ct.task_dependencies VALUES($1,$2,$3,$4)', [
        i.tenant,
        task,
        dependsOn,
        expected,
      ]);
      await c.query(
        'UPDATE ct.work_coordination SET revision=revision+1 WHERE tenant=$1 AND task=$2',
        [i.tenant, task],
      );
      await append(c, i.tenant, 'TASK_DEPENDENCY_BOUND', { task, dependsOn });
      return { revision: expected + 1 };
    });
  }
  async offer(
    a: VerifiedIdentity,
    task: string,
    target: string,
    expected: number,
  ) {
    return tx(this.db, async (c) => {
      const i = await this.start(c, a);
      const t = (
        await c.query(
          'SELECT * FROM ct.work_coordination WHERE tenant=$1 AND task=$2 FOR UPDATE',
          [i.tenant, identifier(task)],
        )
      ).rows[0];
      if (
        !t ||
        Number(t.revision) !== expected ||
        t.accountable_vera === target
      )
        throw Error('handoff CAS');
      const p = (
        await c.query(
          'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 AND active',
          [i.tenant, identifier(target)],
        )
      ).rows[0];
      if (!p) throw Error('target scope');
      const id = randomUUID();
      await c.query(
        "INSERT INTO ct.handoffs VALUES($1,$2,$3,$4,$5,$6,'OFFERED',$7,NULL,clock_timestamp())",
        [i.tenant, id, task, t.accountable_vera, target, expected, i.id],
      );
      await append(c, i.tenant, 'HANDOFF_OFFERED', {
        id,
        task,
        from: t.accountable_vera,
        to: target,
        transfersAuthority: false,
      });
      return { id };
    });
  }
  async accept(a: VerifiedIdentity, id: string) {
    return tx(this.db, async (c) => {
      const i = await this.start(c, a, false);
      if (i.kind !== 'machine' || i.domain_role !== 'worker')
        throw Error('independent target workload acceptance required');
      const h = (
        await c.query(
          "SELECT * FROM ct.handoffs WHERE tenant=$1 AND id=$2 AND status='OFFERED' FOR UPDATE",
          [i.tenant, id],
        )
      ).rows[0];
      if (!h || i.principal !== h.target_vera)
        throw Error('target acceptance scope');
      const changed = await c.query(
        'UPDATE ct.work_coordination SET accountable_vera=$3,revision=revision+1 WHERE tenant=$1 AND task=$2 AND revision=$4 AND accountable_vera=$5',
        [i.tenant, h.task, h.target_vera, h.expected_revision, h.source_vera],
      );
      if (!changed.rowCount) throw Error('handoff conflict');
      await c.query(
        "UPDATE ct.handoffs SET status='ACCEPTED',accepted_by=$3 WHERE tenant=$1 AND id=$2",
        [i.tenant, id, i.id],
      );
      await append(c, i.tenant, 'HANDOFF_ACCEPTED', {
        id,
        task: h.task,
        from: h.source_vera,
        to: h.target_vera,
        originalOperationsUnchanged: true,
        transfersAuthority: false,
      });
      return {
        task: h.task,
        accountableVERA: h.target_vera,
        authorityTransferred: false,
      };
    });
  }
}
