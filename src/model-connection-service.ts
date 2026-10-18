import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { append } from './db.js';
import type { VerifiedIdentity } from './identity-provider.js';
import { enrolled, identifier } from './service-auth.js';
import { openCredential, sealCredential } from './model-credential.js';
import {
  VERIFICATION_LABEL,
  disabledGeminiTransport,
  type GeminiTransport,
} from './gemini-text.js';

const denied = {
  externalEffect: false,
  effectAuthority: false,
  workflowAdmitted: false,
  spendingCap: false,
  verification: VERIFICATION_LABEL,
};

export class ModelConnectionService {
  constructor(private transport: GeminiTransport = disabledGeminiTransport()) {}
  bind(transport: GeminiTransport) {
    this.transport = transport;
  }
  async create(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    id: string,
    name: string,
  ) {
    const i = await enrolled(c, actor, true);
    identifier(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 200)
      throw Error('connection name');
    await c.query(
      `INSERT INTO ct.model_connections(tenant,id,name,provider,status,created_by)
       VALUES($1,$2,$3,'gemini','AWAITING_KEY',$4)`,
      [i.tenant, id, name, i.id],
    );
    await append(c, i.tenant, 'MODEL_CONNECTION_CREATED', {
      connection: id,
      provider: 'gemini',
    });
    return { ...denied, connection: id, status: 'AWAITING_KEY', revision: 1 };
  }
  async seal(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
    apiKey: string,
  ) {
    const i = await enrolled(c, actor, true);
    const row = await this.locked(c, i.tenant, connectionId);
    if (row.status !== 'AWAITING_KEY')
      throw Error('connection not awaiting key');
    const sealed = sealCredential(apiKey);
    await c.query(
      `INSERT INTO ct.model_connection_secrets(tenant,connection_id,nonce,ciphertext,key_version)
       VALUES($1,$2,$3,$4,$5)`,
      [
        i.tenant,
        connectionId,
        sealed.nonce,
        sealed.ciphertext,
        sealed.keyVersion,
      ],
    );
    await c.query(
      `UPDATE ct.model_connections SET status='SEALED', revision=revision+1
       WHERE tenant=$1 AND id=$2 AND status='AWAITING_KEY'`,
      [i.tenant, connectionId],
    );
    await append(c, i.tenant, 'MODEL_CONNECTION_KEY_SEALED', {
      connection: connectionId,
    });
    return { connection: connectionId, sealed: true };
  }
  async setLimits(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
    limits: {
      maxRequests: number;
      maxInputChars: number;
      maxOutputChars: number;
      maxConcurrent: number;
      timeoutMs: number;
    },
  ) {
    const i = await enrolled(c, actor, true);
    const row = await this.locked(c, i.tenant, connectionId);
    if (row.status === 'REVOKED') throw Error('connection revoked');
    const bounds = [
      limits.maxRequests,
      limits.maxInputChars,
      limits.maxOutputChars,
      limits.maxConcurrent,
      limits.timeoutMs,
    ];
    if (bounds.some((n) => !Number.isSafeInteger(n)))
      throw Error('connection limits');
    await c.query(
      `INSERT INTO ct.model_connection_limits(tenant,connection_id,max_requests,max_input_chars,max_output_chars,max_concurrent,timeout_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant, connection_id) DO UPDATE SET
         max_requests=EXCLUDED.max_requests,
         max_input_chars=EXCLUDED.max_input_chars,
         max_output_chars=EXCLUDED.max_output_chars,
         max_concurrent=EXCLUDED.max_concurrent,
         timeout_ms=EXCLUDED.timeout_ms
       WHERE ct.model_connection_limits.requests_reserved=0
         AND ct.model_connection_limits.requests_settled=0
         AND ct.model_connection_limits.concurrent_requests=0`,
      [
        i.tenant,
        connectionId,
        limits.maxRequests,
        limits.maxInputChars,
        limits.maxOutputChars,
        limits.maxConcurrent,
        limits.timeoutMs,
      ],
    );
    await this.bump(c, i.tenant, connectionId);
    return {
      ...denied,
      connection: connectionId,
      limitKind: 'requests and text size',
      spendingCap: false,
    };
  }
  async test(c: pg.PoolClient, actor: VerifiedIdentity, connectionId: string) {
    const i = await enrolled(c, actor, true);
    await this.locked(c, i.tenant, connectionId);
    const principal = (
      await c.query(
        'SELECT id FROM ct.principals WHERE tenant=$1 ORDER BY id LIMIT 1',
        [i.tenant],
      )
    ).rows[0];
    if (!principal) throw Error('connection principal');
    const attempt = await this.reserve(
      c,
      i.tenant,
      connectionId,
      principal.id,
      0,
      0,
    );
    let outcome = 'PROVIDER_ERROR';
    try {
      const apiKey = await this.key(c, i.tenant, connectionId);
      const models = await this.transport.listModels(apiKey);
      await c.query(
        `UPDATE ct.model_connections
         SET supported_models=$3, verification_label=$4, revision=revision+1
         WHERE tenant=$1 AND id=$2`,
        [
          i.tenant,
          connectionId,
          models.map((model) => model.name),
          VERIFICATION_LABEL,
        ],
      );
      outcome = 'MOCK_OR_UNVERIFIED_LIST';
      await this.finish(c, i.tenant, attempt, 'SETTLED', outcome, null, true);
    } catch (error) {
      outcome = this.outcome(error);
      await this.finish(
        c,
        i.tenant,
        attempt,
        outcome === 'TIMEOUT' ? 'UNCERTAIN' : 'SETTLED',
        outcome,
        null,
        false,
      );
    }
    return {
      ...denied,
      connection: connectionId,
      outcome,
      providerAction: true,
      liveVerified: false,
    };
  }
  async selectModel(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
    model: string,
  ) {
    const i = await enrolled(c, actor, true);
    const row = await this.locked(c, i.tenant, connectionId);
    if (!row.supported_models.includes(model)) throw Error('unsupported model');
    await c.query(
      `UPDATE ct.model_connections SET model=$3, revision=revision+1 WHERE tenant=$1 AND id=$2`,
      [i.tenant, connectionId, model],
    );
    return { ...denied, connection: connectionId, model, liveVerified: false };
  }
  async assign(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
    principal: string,
  ) {
    const i = await enrolled(c, actor, true);
    const row = await this.locked(c, i.tenant, connectionId);
    if (row.status !== 'SEALED' || !row.model)
      throw Error('connection not ready');
    identifier(principal);
    const vera = (
      await c.query(
        'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [i.tenant, principal],
      )
    ).rows[0];
    if (!vera) throw Error('vera scope');
    await c.query(
      `UPDATE ct.model_connections SET assigned_principal=$3, revision=revision+1
       WHERE tenant=$1 AND id=$2`,
      [i.tenant, connectionId, principal],
    );
    const recorded = (
      await c.query(
        `INSERT INTO ct.cognition_bindings(tenant,principal,provider,model,configuration_reference,compatibility)
         VALUES($1,$2,'gemini',$3,$4,'NEEDS_TESTING') RETURNING revision`,
        [i.tenant, principal, row.model, connectionId],
      )
    ).rows[0];
    return {
      ...denied,
      connection: connectionId,
      principal,
      cognitionRevision: Number(recorded.revision),
    };
  }
  async revoke(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
  ) {
    const i = await enrolled(c, actor, true);
    await this.locked(c, i.tenant, connectionId);
    await c.query(
      `UPDATE ct.model_connections SET status='REVOKED', assigned_principal=NULL, revision=revision+1
       WHERE tenant=$1 AND id=$2`,
      [i.tenant, connectionId],
    );
    await c.query(
      'DELETE FROM ct.model_connection_secrets WHERE tenant=$1 AND connection_id=$2',
      [i.tenant, connectionId],
    );
    const queued = (
      await c.query(
        `SELECT id FROM ct.model_text_attempts
         WHERE tenant=$1 AND connection_id=$2 AND state='RESERVED'`,
        [i.tenant, connectionId],
      )
    ).rows;
    for (const attempt of queued)
      await this.finish(
        c,
        i.tenant,
        attempt.id,
        'BLOCKED',
        'REVOKED',
        null,
        false,
      );
    await append(c, i.tenant, 'MODEL_CONNECTION_REVOKED', {
      connection: connectionId,
      queuedBlocked: queued.length,
      sentRequestsMayComplete: true,
    });
    return {
      ...denied,
      connection: connectionId,
      status: 'REVOKED',
      sentRequestsMayComplete: true,
    };
  }
  async reserveText(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
    principal: string,
    text: string,
    idempotencyKey: string,
  ) {
    const i = await enrolled(c, actor, true);
    const row = await this.locked(c, i.tenant, connectionId);
    if (row.assigned_principal !== principal || !row.model)
      throw Error('connection assignment');
    if (typeof text !== 'string' || !text.trim()) throw Error('text required');
    const limits = await this.limits(c, i.tenant, connectionId);
    if (text.length > Number(limits.max_input_chars))
      throw Error('input limit');
    const attempt = await this.reserve(
      c,
      i.tenant,
      connectionId,
      principal,
      text.length,
      Number(limits.max_output_chars),
      idempotencyKey,
    );
    return {
      attempt,
      model: row.model as string,
      timeoutMs: Number(limits.timeout_ms),
    };
  }
  async sendText(
    c: pg.PoolClient,
    tenant: string,
    connectionId: string,
    attempt: string,
    model: string,
    text: string,
    timeoutMs: number,
  ) {
    const current = await this.locked(c, tenant, connectionId);
    if (current.status !== 'SEALED') {
      await this.finish(c, tenant, attempt, 'BLOCKED', 'REVOKED', null, false);
      return {
        ...denied,
        outcome: 'REVOKED',
        sent: false,
        sentRequestsMayComplete: false,
      };
    }
    await c.query(
      `UPDATE ct.model_text_attempts SET state='SENT' WHERE tenant=$1 AND id=$2 AND state='RESERVED'`,
      [tenant, attempt],
    );
    try {
      const apiKey = await this.key(c, tenant, connectionId);
      const generated = await this.transport.generate({
        apiKey,
        model,
        text,
        timeoutMs,
      });
      const limits = await this.limits(c, tenant, connectionId);
      if (generated.text.length > Number(limits.max_output_chars)) {
        await this.finish(
          c,
          tenant,
          attempt,
          'SETTLED',
          'OUTPUT_LIMIT',
          null,
          true,
        );
        return { ...denied, outcome: 'OUTPUT_LIMIT', sent: true };
      }
      const state = generated.usageReported ? 'SETTLED' : 'UNCERTAIN';
      await this.finish(
        c,
        tenant,
        attempt,
        state,
        generated.usageReported ? 'TEXT' : 'UNCERTAIN',
        generated.text,
        generated.usageReported,
      );
      return {
        ...denied,
        outcome: state,
        text: generated.text,
        authority: false,
        execution: 'NONE',
        sent: true,
        usageReported: generated.usageReported,
      };
    } catch (error) {
      const outcome = this.outcome(error);
      await this.finish(
        c,
        tenant,
        attempt,
        outcome === 'TIMEOUT' ? 'UNCERTAIN' : 'SETTLED',
        outcome,
        null,
        false,
      );
      return {
        ...denied,
        outcome,
        sent: true,
        mayStillComplete: outcome === 'TIMEOUT',
      };
    }
  }
  private async locked(c: pg.PoolClient, tenant: string, id: string) {
    const row = (
      await c.query(
        'SELECT * FROM ct.model_connections WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw Error('connection scope');
    return row;
  }
  private async limits(c: pg.PoolClient, tenant: string, id: string) {
    const row = (
      await c.query(
        'SELECT * FROM ct.model_connection_limits WHERE tenant=$1 AND connection_id=$2 FOR UPDATE',
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw Error('connection limits unavailable');
    return row;
  }
  private async key(c: pg.PoolClient, tenant: string, id: string) {
    const row = (
      await c.query(
        'SELECT nonce,ciphertext,key_version FROM ct.model_connection_secrets WHERE tenant=$1 AND connection_id=$2',
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw Error('model credential unavailable');
    return openCredential({
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      keyVersion: Number(row.key_version),
    });
  }
  private async reserve(
    c: pg.PoolClient,
    tenant: string,
    connectionId: string,
    principal: string,
    inputChars: number,
    outputChars: number,
    idempotencyKey: string = randomUUID(),
  ) {
    const row = await this.locked(c, tenant, connectionId);
    if (row.status !== 'SEALED') throw Error('connection revoked');
    const limits = await this.limits(c, tenant, connectionId);
    if (
      Number(limits.requests_reserved) + Number(limits.requests_settled) + 1 >
        Number(limits.max_requests) ||
      Number(limits.concurrent_requests) + 1 > Number(limits.max_concurrent) ||
      inputChars > Number(limits.max_input_chars) ||
      outputChars > Number(limits.max_output_chars)
    )
      throw Error('connection allowance');
    const id = randomUUID();
    await c.query(
      `UPDATE ct.model_connection_limits
       SET requests_reserved=requests_reserved+1, concurrent_requests=concurrent_requests+1
       WHERE tenant=$1 AND connection_id=$2`,
      [tenant, connectionId],
    );
    await c.query(
      `INSERT INTO ct.model_text_attempts(tenant,id,connection_id,principal,idempotency_key,state,input_chars)
       VALUES($1,$2,$3,$4,$5,'RESERVED',$6)`,
      [tenant, id, connectionId, principal, idempotencyKey, inputChars],
    );
    return id;
  }
  private async finish(
    c: pg.PoolClient,
    tenant: string,
    attempt: string,
    state: 'SETTLED' | 'UNCERTAIN' | 'BLOCKED',
    outcome: string,
    response: string | null,
    usageReported: boolean,
  ) {
    const row = (
      await c.query(
        'SELECT * FROM ct.model_text_attempts WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, attempt],
      )
    ).rows[0];
    if (!row || row.state === 'SETTLED' || row.state === 'BLOCKED') return;
    const consume = state !== 'BLOCKED';
    await c.query(
      `UPDATE ct.model_connection_limits SET
         requests_reserved=requests_reserved-1,
         requests_settled=requests_settled+$3,
         concurrent_requests=concurrent_requests-1
       WHERE tenant=$1 AND connection_id=$2`,
      [tenant, row.connection_id, consume ? 1 : 0],
    );
    await c.query(
      `UPDATE ct.model_text_attempts
       SET state=$3, outcome=$4, response_text=$5, reported_usage=$6, may_still_complete=$7
       WHERE tenant=$1 AND id=$2`,
      [
        tenant,
        attempt,
        state,
        outcome,
        response,
        usageReported,
        state === 'UNCERTAIN',
      ],
    );
  }
  private async bump(c: pg.PoolClient, tenant: string, id: string) {
    await c.query(
      'UPDATE ct.model_connections SET revision=revision+1 WHERE tenant=$1 AND id=$2',
      [tenant, id],
    );
  }
  private outcome(error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'gemini key rejected') return 'INVALID_KEY';
    if (message === 'gemini rate limited') return 'RATE_LIMIT';
    if (message === 'gemini tool rejected') return 'TOOL_REJECTED';
    if (
      message === 'gemini response malformed' ||
      message === 'gemini model list malformed'
    )
      return 'MALFORMED';
    if (
      message.toLowerCase().includes('timeout') ||
      message.includes('aborted')
    )
      return 'TIMEOUT';
    if (message === 'gemini live calls disabled') return 'LIVE_DISABLED';
    return 'PROVIDER_ERROR';
  }
}
