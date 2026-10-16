import type pg from 'pg';
import { tx } from './db.js';
import { enrolled, identifier } from './service-auth.js';
import type { VerifiedIdentity } from './identity-provider.js';

export interface CognitionInput {
  principal: string;
  provider: string;
  model: string;
  configurationReference: string;
  compatibility: 'UNKNOWN' | 'TESTED' | 'NEEDS_TESTING';
}

export class CognitionService {
  constructor(private db: pg.Pool) {}
  async record(actor: VerifiedIdentity, input: CognitionInput) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor, true);
      const principal = identifier(input.principal);
      if (
        typeof input.provider !== 'string' ||
        !input.provider ||
        input.provider.length > 200 ||
        typeof input.model !== 'string' ||
        !input.model ||
        input.model.length > 200 ||
        typeof input.configurationReference !== 'string' ||
        !input.configurationReference ||
        input.configurationReference.length > 500 ||
        !['UNKNOWN', 'TESTED', 'NEEDS_TESTING'].includes(input.compatibility)
      )
        throw Error('cognition bounds');
      const locked = (
        await c.query(
          'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
          [i.tenant, principal],
        )
      ).rows[0];
      if (!locked) throw Error('cognition principal');
      const next = Number(
        (
          await c.query(
            'SELECT COALESCE(MAX(revision),0)+1 AS n FROM ct.cognition_bindings WHERE tenant=$1 AND principal=$2',
            [i.tenant, principal],
          )
        ).rows[0].n,
      );
      await c.query(
        'INSERT INTO ct.cognition_bindings(tenant,principal,revision,provider,model,configuration_reference,compatibility) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          i.tenant,
          principal,
          next,
          input.provider,
          input.model,
          input.configurationReference,
          input.compatibility,
        ],
      );
      return { principal, revision: next };
    });
  }
}
