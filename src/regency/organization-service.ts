import type pg from 'pg';
import { identifier } from '../service-auth.js';
function nameOf(value: string, label: string, max: number) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw Error(label);
  return value;
}
export class OrganizationService {
  async create(
    c: pg.PoolClient,
    tenant: string,
    actorId: string,
    id: string,
    name: string,
  ) {
    identifier(id);
    const org = (
      await c.query(
        'INSERT INTO ct.organizations(tenant,id,name,created_by) VALUES($1,$2,$3,$4) RETURNING id,revision',
        [tenant, id, nameOf(name, 'organization name', 200), actorId],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO ct.role_definitions(tenant,organization,id,name) VALUES($1,$2,'steward','Steward')",
      [tenant, id],
    );
    const member = (
      await c.query(
        "INSERT INTO ct.memberships(tenant,organization,subject_kind,subject_id,role_id,owner_seat) VALUES($1,$2,'human',$3,'steward',true) RETURNING revision",
        [tenant, id, actorId],
      )
    ).rows[0];
    return {
      id: org.id,
      revision: Number(org.revision),
      ownerMembershipRevision: Number(member.revision),
      effectAuthority: false,
    };
  }
  async rename(
    c: pg.PoolClient,
    tenant: string,
    id: string,
    name: string,
    expected: number,
  ) {
    identifier(id);
    const row = (
      await c.query(
        'UPDATE ct.organizations SET name=$4,revision=revision+1 WHERE tenant=$1 AND id=$2 AND revision=$3 RETURNING id,revision',
        [tenant, id, expected, nameOf(name, 'organization name', 200)],
      )
    ).rows[0];
    if (!row) throw Error('object version conflict');
    return {
      id: row.id,
      revision: Number(row.revision),
      effectAuthority: false,
    };
  }
  async defineRole(
    c: pg.PoolClient,
    tenant: string,
    organization: string,
    id: string,
    name: string,
  ) {
    identifier(organization);
    identifier(id);
    const row = (
      await c.query(
        'INSERT INTO ct.role_definitions(tenant,organization,id,name) VALUES($1,$2,$3,$4) RETURNING id,revision',
        [tenant, organization, id, nameOf(name, 'role name', 80)],
      )
    ).rows[0];
    return {
      id: row.id,
      revision: Number(row.revision),
      effectAuthority: false,
    };
  }
  async addMembership(
    c: pg.PoolClient,
    tenant: string,
    organization: string,
    subjectKind: string,
    subjectId: string,
    roleId: string,
    ownerSeat: boolean,
  ) {
    identifier(organization);
    identifier(subjectId);
    identifier(roleId);
    if (subjectKind !== 'human' && subjectKind !== 'vera')
      throw Error('membership subject');
    if (ownerSeat && subjectKind !== 'human')
      throw Error('a VERA cannot own an organization');
    const row = (
      await c.query(
        'INSERT INTO ct.memberships(tenant,organization,subject_kind,subject_id,role_id,owner_seat) VALUES($1,$2,$3,$4,$5,$6) RETURNING revision',
        [tenant, organization, subjectKind, subjectId, roleId, ownerSeat],
      )
    ).rows[0];
    return {
      revision: Number(row.revision),
      effectAuthority: false,
    };
  }
  async removeMembership(
    c: pg.PoolClient,
    tenant: string,
    organization: string,
    subjectKind: string,
    subjectId: string,
    expected: number,
  ) {
    identifier(organization);
    identifier(subjectId);
    const locked = (
      await c.query(
        'SELECT revision FROM ct.memberships WHERE tenant=$1 AND organization=$2 AND subject_kind=$3 AND subject_id=$4 FOR UPDATE',
        [tenant, organization, subjectKind, subjectId],
      )
    ).rows[0];
    if (!locked || Number(locked.revision) !== expected)
      throw Error('object version conflict');
    const row = (
      await c.query(
        'DELETE FROM ct.memberships WHERE tenant=$1 AND organization=$2 AND subject_kind=$3 AND subject_id=$4 AND revision=$5 RETURNING subject_id',
        [tenant, organization, subjectKind, subjectId, expected],
      )
    ).rows[0];
    if (!row) throw Error('object version conflict');
    return { removed: true, effectAuthority: false };
  }
}
