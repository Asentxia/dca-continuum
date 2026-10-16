import type pg from 'pg';
import { z } from 'zod';
import { append, canonical, sha, tx } from '../db.js';
import type { VerifiedIdentity } from '../identity-provider.js';
import { activeControl, enrolled, identifier } from '../service-auth.js';

const principalId = z
  .string()
  .max(128)
  .refine((value) => {
    try {
      identifier(value);
      // Check the whole input: JS '$' may accept a final line terminator.
      // Reject it rather than normalizing the caller's stable identifier.
      return value === value.trim();
    } catch {
      return false;
    }
  }, 'invalid identifier');
const profileText = {
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0, 'nonblank VERA name required'),
  description: z.string().max(8000),
};

export const VeraCreateSchema = z
  .object({ id: principalId, ...profileText })
  .strict();
export const VeraProfileUpdateSchema = z
  .object({
    id: principalId,
    ...profileText,
    expectedRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export type VeraCreateInput = z.infer<typeof VeraCreateSchema>;
export type VeraProfileUpdateInput = z.infer<typeof VeraProfileUpdateSchema>;

// Constant effect-denial flags, not authentication data or passwords.
const deniedEffectFlags = {
  effectAuthority: false,
  workflowAdmitted: false,
  externalEffect: false,
} as const;

/** Original creation facts, not a projection of the current lifecycle/profile. */
export interface VeraCreationResult {
  id: string;
  createdBy: string;
  reused: boolean;
  creation: {
    profileRevision: 1;
    epoch: 1;
    generation: 1;
    active: true;
    executionMode: 'PAUSED';
    availability: 'requires_setup';
  };
  effectAuthority: false;
  workflowAdmitted: false;
  externalEffect: false;
}

export interface VeraProfileResult {
  id: string;
  name: string;
  description: string;
  revision: number;
  createdBy: string;
  effectAuthority: false;
  workflowAdmitted: false;
  externalEffect: false;
}

function creationResult(
  id: string,
  createdBy: string,
  reused: boolean,
): VeraCreationResult {
  return {
    id,
    createdBy,
    reused,
    creation: {
      profileRevision: 1,
      epoch: 1,
      generation: 1,
      active: true,
      executionMode: 'PAUSED',
      availability: 'requires_setup',
    },
    ...deniedEffectFlags,
  };
}

function profileResult(row: Record<string, any>): VeraProfileResult {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw Error('VERA profile revision overflow');
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    revision,
    createdBy: row.created_by,
    ...deniedEffectFlags,
  };
}

/**
 * Trusted human-managed records only. No identity enrollment, Computer, model,
 * membership, grant, approval, task, workflow or sender is involved.
 *
 * An optional client must already be in a caller-owned transaction. The local
 * savepoint enforces that requirement and prevents a caught service error from
 * leaving an orphan principal. It never commits the caller's transaction.
 * The caller must not use that client concurrently and must recheck eligibility
 * before a later outer commit (as ConsoleCommands does).
 */
export class VeraService {
  constructor(
    private db: pg.Pool,
    private fence: string,
  ) {}

  private async unit<T>(
    client: pg.PoolClient | undefined,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!client) return tx(this.db, fn);
    await client.query('SAVEPOINT vera_profile_service');
    try {
      const result = await fn(client);
      await client.query('RELEASE SAVEPOINT vera_profile_service');
      return result;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT vera_profile_service');
      await client.query('RELEASE SAVEPOINT vera_profile_service');
      throw error;
    }
  }

  private async lock(c: pg.PoolClient, tenant: string, id: string) {
    // Serialize the absent-row case as well as updates/replays. The namespace
    // and tenant are part of the key; no caller-controlled tenant context exists.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      canonical(['vera-profile', tenant, id]),
    ]);
    const principal = (
      await c.query(
        'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, id],
      )
    ).rows[0];
    const profile = (
      await c.query(
        'SELECT * FROM ct.vera_profiles WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, id],
      )
    ).rows[0];
    return { principal, profile };
  }

  async create(
    actor: VerifiedIdentity,
    input: unknown,
    client?: pg.PoolClient,
  ): Promise<VeraCreationResult> {
    return this.unit(client, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor, true);
      const x = VeraCreateSchema.parse(input);
      const digest = sha(canonical({ tenant: i.tenant, ...x }));
      const { principal, profile } = await this.lock(c, i.tenant, x.id);
      // Lock waits must not turn stale authentication into a permitted write
      // or an authorized replay.
      await enrolled(c, actor, true);
      if (profile) {
        if (!principal || profile.creation_digest !== digest)
          throw Error('VERA creation conflict');
        return creationResult(profile.id, profile.created_by, true);
      }
      if (principal) throw Error('VERA creation conflict');

      const created = (
        await c.query(
          "INSERT INTO ct.principals(tenant,id,epoch,generation,active,execution_mode) VALUES($1,$2,1,1,true,'PAUSED') ON CONFLICT (tenant,id) DO NOTHING RETURNING id",
          [i.tenant, x.id],
        )
      ).rows[0];
      // Another trusted writer need not participate in this service's advisory
      // lock. A uniqueness race must conflict, never adopt its principal.
      if (!created) throw Error('VERA creation conflict');
      await c.query(
        'INSERT INTO ct.vera_profiles(tenant,id,name,description,revision,created_by,creation_digest) VALUES($1,$2,$3,$4,1,$5,$6)',
        [i.tenant, x.id, x.name, x.description, i.id, digest],
      );
      await append(c, i.tenant, 'VERA_CREATED', {
        id: x.id,
        actor: i.id,
        creationDigest: digest,
        ...creationResult(x.id, i.id, false).creation,
        ...deniedEffectFlags,
      });
      // The evidence-head lock may also wait. Failure rolls back both records
      // and the append, including when this is inside a command transaction.
      await enrolled(c, actor, true);
      return creationResult(x.id, i.id, false);
    });
  }

  async updateProfile(
    actor: VerifiedIdentity,
    input: unknown,
    client?: pg.PoolClient,
  ): Promise<VeraProfileResult> {
    return this.unit(client, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor, true);
      const x = VeraProfileUpdateSchema.parse(input);
      const { principal, profile } = await this.lock(c, i.tenant, x.id);
      await enrolled(c, actor, true);
      if (
        !principal ||
        !profile ||
        Number(profile.revision) !== x.expectedRevision
      )
        throw Error('VERA profile version conflict');
      const updated = (
        await c.query(
          'UPDATE ct.vera_profiles SET name=$4,description=$5,revision=revision+1 WHERE tenant=$1 AND id=$2 AND revision=$3 RETURNING id,name,description,revision,created_by',
          [i.tenant, x.id, x.expectedRevision, x.name, x.description],
        )
      ).rows[0];
      if (!updated) throw Error('VERA profile version conflict');
      const result = profileResult(updated);
      await append(c, i.tenant, 'VERA_PROFILE_UPDATED', {
        id: x.id,
        actor: i.id,
        previousRevision: x.expectedRevision,
        revision: result.revision,
        profileDigest: sha(
          canonical({ name: x.name, description: x.description }),
        ),
        ...deniedEffectFlags,
      });
      await enrolled(c, actor, true);
      return result;
    });
  }
}
