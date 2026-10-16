import type pg from 'pg';
import { identifier } from '../service-auth.js';
function textOf(value: string, label: string, max: number) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw Error(label);
  return value;
}
export class MandateService {
  async record(
    c: pg.PoolClient,
    tenant: string,
    actorId: string,
    organization: string,
    id: string,
    title: string,
    body: string,
    expected: number,
  ) {
    identifier(organization);
    identifier(id);
    const heading = textOf(title, 'mandate title', 200);
    const text = textOf(body, 'mandate body', 8000);
    // Admission's FOR SHARE waits on this row lock, and the version update
    // below waits on that share.
    const current = (
      await c.query(
        'SELECT revision,current_version FROM ct.mandates WHERE tenant=$1 AND organization=$2 AND id=$3 FOR UPDATE',
        [tenant, organization, id],
      )
    ).rows[0];
    if (!current) {
      if (expected !== 0) throw Error('object version conflict');
      await c.query(
        'INSERT INTO ct.mandates(tenant,organization,id,current_version) VALUES($1,$2,$3,1)',
        [tenant, organization, id],
      );
      await c.query(
        'INSERT INTO ct.mandate_versions(tenant,organization,mandate,version,title,body,recorded_by) VALUES($1,$2,$3,1,$4,$5,$6)',
        [tenant, organization, id, heading, text, actorId],
      );
      return { revision: 1, version: 1, effectAuthority: false };
    }
    if (Number(current.revision) !== expected)
      throw Error('object version conflict');
    const version = Number(current.current_version) + 1;
    await c.query(
      'INSERT INTO ct.mandate_versions(tenant,organization,mandate,version,title,body,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [tenant, organization, id, version, heading, text, actorId],
    );
    const row = (
      await c.query(
        'UPDATE ct.mandates SET current_version=$4,revision=revision+1 WHERE tenant=$1 AND organization=$2 AND id=$3 AND revision=$5 RETURNING revision,current_version',
        [tenant, organization, id, version, expected],
      )
    ).rows[0];
    if (!row) throw Error('object version conflict');
    return {
      revision: Number(row.revision),
      version: Number(row.current_version),
      effectAuthority: false,
    };
  }
}
