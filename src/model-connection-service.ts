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

const NOT_VERIFIED = 'not verified';
const denied = {
  externalEffect: false,
  effectAuthority: false,
  workflowAdmitted: false,
  spendingCap: false,
  verification: NOT_VERIFIED,
  liveVerified: false,
};

// RESERVED is committed before any provider call. Revocation can still block it,
// and restart does not send it. SENDING is committed immediately before the
// network call and means the provider may already have accepted it: revocation
// does not stop it, and a duplicate or restart records UNCERTAIN without
// sending again. SETTLED is a finished answer or a definite failure. UNCERTAIN
// covers timeouts, missing usage, and crashes after SENDING; the allowance
// stays consumed and there is no automatic retry. BLOCKED means the request
// was not sent. These are not dollar spending caps.
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
      maxOutputTokens: number;
      maxResponseBytes: number;
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
      limits.maxOutputTokens,
      limits.maxResponseBytes,
    ];
    if (bounds.some((n) => !Number.isSafeInteger(n)))
      throw Error('connection limits');
    await c.query(
      `INSERT INTO ct.model_connection_limits(tenant,connection_id,max_requests,max_input_chars,max_output_chars,max_concurrent,timeout_ms,max_output_tokens,max_response_bytes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant, connection_id) DO UPDATE SET
         max_requests=EXCLUDED.max_requests,
         max_input_chars=EXCLUDED.max_input_chars,
         max_output_chars=EXCLUDED.max_output_chars,
         max_concurrent=EXCLUDED.max_concurrent,
         timeout_ms=EXCLUDED.timeout_ms,
         max_output_tokens=EXCLUDED.max_output_tokens,
         max_response_bytes=EXCLUDED.max_response_bytes
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
        limits.maxOutputTokens,
        limits.maxResponseBytes,
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
  async test(
    c: pg.PoolClient,
    actor: VerifiedIdentity,
    connectionId: string,
    idempotencyKey: string,
  ) {
    const i = await enrolled(c, actor, true);
    await this.locked(c, i.tenant, connectionId);
    const limits = await this.limits(c, i.tenant, connectionId);
    if (!Number(limits.max_output_tokens) || !Number(limits.max_response_bytes))
      throw Error('connection limits unavailable');
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
      idempotencyKey,
      'list',
    );
    return {
      phase: 'RESERVED' as const,
      attempt,
      dispatch: 'list' as const,
      connection: connectionId,
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
      phase: 'RESERVED' as const,
      attempt,
      dispatch: 'text' as const,
      connection: connectionId,
    };
  }
  async admit(c: pg.PoolClient, tenant: string, attemptId: string) {
    const attempt = (
      await c.query(
        'SELECT * FROM ct.model_text_attempts WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, attemptId],
      )
    ).rows[0];
    if (!attempt) throw Error('attempt scope');
    if (attempt.state !== 'RESERVED')
      return {
        send: false as const,
        result: this.stored(attempt),
      };
    const connection = await this.locked(c, tenant, attempt.connection_id);
    if (
      connection.status !== 'SEALED' ||
      (!this.transport.mock && process.env.CT_ENABLE_GEMINI !== 'yes')
    ) {
      const outcome =
        connection.status !== 'SEALED' ? 'REVOKED' : 'LIVE_DISABLED';
      await this.finish(c, tenant, attemptId, 'BLOCKED', outcome, null, false);
      return {
        send: false as const,
        result: {
          ...denied,
          outcome,
          sent: false,
          providerAction: false,
          message:
            outcome === 'LIVE_DISABLED'
              ? 'Live Gemini calls are disabled. This did not verify the key or connection.'
              : 'The connection is revoked. This request was not sent.',
        },
      };
    }
    const limits = await this.limits(c, tenant, attempt.connection_id);
    if (!Number(limits.max_output_tokens) || !Number(limits.max_response_bytes))
      throw Error('connection limits unavailable');
    let apiKey: string;
    try {
      apiKey = await this.key(c, tenant, attempt.connection_id);
    } catch {
      await this.finish(
        c,
        tenant,
        attemptId,
        'BLOCKED',
        'KEY_UNAVAILABLE',
        null,
        false,
      );
      return {
        send: false as const,
        result: {
          ...denied,
          outcome: 'KEY_UNAVAILABLE',
          sent: false,
          message:
            'The stored key could not be opened. The connection was not verified.',
        },
      };
    }
    await c.query(
      `UPDATE ct.model_text_attempts SET state='SENDING' WHERE tenant=$1 AND id=$2 AND state='RESERVED'`,
      [tenant, attemptId],
    );
    return {
      send: true as const,
      apiKey,
      model: connection.model as string,
      dispatch: attempt.dispatch as 'list' | 'text',
      timeoutMs: Number(limits.timeout_ms),
      maxOutputTokens: Number(limits.max_output_tokens),
      maxResponseBytes: Number(limits.max_response_bytes),
      maxOutputChars: Number(limits.max_output_chars),
      connectionId: attempt.connection_id as string,
    };
  }
  async invoke(
    admitted: {
      apiKey: string;
      model: string;
      dispatch: 'list' | 'text';
      timeoutMs: number;
      maxOutputTokens: number;
      maxResponseBytes: number;
    },
    text = '',
  ) {
    try {
      if (admitted.dispatch === 'list') {
        const models = await this.transport.listModels(admitted.apiKey);
        return {
          ok: true as const,
          models,
          usageReported: true,
          text: null as string | null,
        };
      }
      const generated = await this.transport.generate({
        apiKey: admitted.apiKey,
        model: admitted.model,
        text,
        timeoutMs: admitted.timeoutMs,
        maxOutputTokens: admitted.maxOutputTokens,
        maxResponseBytes: admitted.maxResponseBytes,
      });
      return {
        ok: true as const,
        models: null,
        text: generated.text,
        usageReported: generated.usageReported,
      };
    } catch (error) {
      const outcome = this.outcome(error);
      return {
        ok: false as const,
        outcome,
        mayStillComplete: outcome === 'TIMEOUT',
      };
    }
  }
  async record(
    c: pg.PoolClient,
    tenant: string,
    attemptId: string,
    provider: Awaited<ReturnType<ModelConnectionService['invoke']>>,
    limits: { maxOutputChars: number; connectionId: string },
  ) {
    const attempt = (
      await c.query(
        'SELECT * FROM ct.model_text_attempts WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, attemptId],
      )
    ).rows[0];
    if (!attempt || attempt.state !== 'SENDING') return this.stored(attempt);
    if (!provider.ok) {
      const state = provider.mayStillComplete ? 'UNCERTAIN' : 'SETTLED';
      await this.finish(
        c,
        tenant,
        attemptId,
        state,
        provider.outcome,
        null,
        false,
      );
      return {
        ...denied,
        outcome: provider.outcome,
        sent: true,
        mayStillComplete: provider.mayStillComplete,
        message:
          provider.outcome === 'LIVE_DISABLED'
            ? 'Live Gemini calls are disabled. This did not verify the key or connection.'
            : provider.mayStillComplete
              ? 'The provider may have accepted this request. It was not retried.'
              : 'The provider request failed. It was not retried.',
      };
    }
    if (provider.models) {
      const label = this.transport.mock ? VERIFICATION_LABEL : NOT_VERIFIED;
      await c.query(
        `UPDATE ct.model_connections
         SET supported_models=$3, verification_label=$4, revision=revision+1
         WHERE tenant=$1 AND id=$2`,
        [
          tenant,
          limits.connectionId,
          provider.models.map((model) => model.name),
          label,
        ],
      );
      await this.finish(c, tenant, attemptId, 'SETTLED', 'LISTED', null, true);
      return {
        ...denied,
        outcome: 'LISTED',
        verification: label,
        models: provider.models.map((model) => model.name),
        providerAction: true,
        message: this.transport.mock
          ? 'Mock-tested / live test pending. The connection was not live-verified.'
          : 'A provider list returned. This version does not mark the connection live-verified.',
      };
    }
    if ((provider.text ?? '').length > limits.maxOutputChars) {
      await this.finish(
        c,
        tenant,
        attemptId,
        'SETTLED',
        'OUTPUT_LIMIT',
        null,
        provider.usageReported,
      );
      return {
        ...denied,
        outcome: 'OUTPUT_LIMIT',
        sent: true,
        message: 'The answer exceeded the text limit and was not shown.',
      };
    }
    const state = provider.usageReported ? 'SETTLED' : 'UNCERTAIN';
    await this.finish(
      c,
      tenant,
      attemptId,
      state,
      state === 'SETTLED' ? 'TEXT' : 'UNCERTAIN',
      provider.text,
      provider.usageReported,
    );
    return {
      ...denied,
      outcome: state,
      text: provider.text,
      authority: false,
      execution: 'NONE',
      sent: true,
      usageReported: provider.usageReported,
      mayStillComplete: state === 'UNCERTAIN',
    };
  }
  async recover(c: pg.PoolClient, tenant: string, attemptId: string) {
    const attempt = (
      await c.query(
        'SELECT * FROM ct.model_text_attempts WHERE tenant=$1 AND id=$2 FOR UPDATE',
        [tenant, attemptId],
      )
    ).rows[0];
    if (!attempt || attempt.state !== 'SENDING') return this.stored(attempt);
    await this.finish(
      c,
      tenant,
      attemptId,
      'UNCERTAIN',
      'POSSIBLY_SENT',
      null,
      false,
    );
    return {
      ...denied,
      outcome: 'UNCERTAIN',
      sent: true,
      mayStillComplete: true,
      message: 'This request may already have been sent. It was not retried.',
    };
  }
  private stored(
    attempt:
      | { state?: string; outcome?: string; response_text?: string }
      | undefined,
  ) {
    return {
      ...denied,
      outcome: attempt?.outcome ?? attempt?.state ?? 'UNKNOWN',
      text: attempt?.response_text ?? undefined,
      sent:
        attempt?.state === 'SENDING' ||
        attempt?.state === 'SETTLED' ||
        attempt?.state === 'UNCERTAIN',
      mayStillComplete:
        attempt?.state === 'SENDING' || attempt?.state === 'UNCERTAIN',
    };
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
    dispatch: 'list' | 'text' = 'text',
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
      `INSERT INTO ct.model_text_attempts(tenant,id,connection_id,principal,idempotency_key,state,input_chars,dispatch)
       VALUES($1,$2,$3,$4,$5,'RESERVED',$6,$7)`,
      [
        tenant,
        id,
        connectionId,
        principal,
        idempotencyKey,
        inputChars,
        dispatch,
      ],
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
    if (message === 'gemini response too large') return 'BODY_LIMIT';
    if (message === 'gemini generation limit unavailable')
      return 'LIMIT_UNAVAILABLE';
    return 'PROVIDER_ERROR';
  }
}
