import { assertLocalFixtures } from '../runtime-profile.js';
import type pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { tx, canonical, append } from '../db.js';
import type { VerifiedIdentity } from '../identity-provider.js';
import { enrolled, activeControl } from '../service-auth.js';
import type { AuthorityService } from '../authority-service.js';
import type { ProductService } from '../product-service.js';
import {
  CommandSchema,
  CommandInputs,
  PUBLIC_GITHUB_RESOURCE,
  type HumanCommand,
} from './contracts.js';
import { redact, requiresRedaction } from './redaction.js';
import { OrganizationService } from '../regency/organization-service.js';
import { MandateService } from '../regency/mandate-service.js';
import { WorkCoordination } from './coordination.js';
import { VeraService } from '../regency/vera-service.js';
import { ModelConnectionService } from '../model-connection-service.js';
import { rejectSecretFields } from '../model-credential.js';
import {
  runtimeGeminiTransport,
  type GeminiTransport,
} from '../gemini-text.js';
export class ConsoleCommands {
  constructor(
    private db: pg.Pool,
    private authority: AuthorityService,
    private product: ProductService,
    private fence: string,
    private mode: 'LOCAL_FIXTURE' | 'STAGING',
    private organizations = new OrganizationService(),
    private mandates = new MandateService(),
    private coordination = new WorkCoordination(db, fence),
    private veras = new VeraService(db, fence),
    private models = new ModelConnectionService(runtimeGeminiTransport()),
  ) {
    if (this.mode === 'LOCAL_FIXTURE')
      assertLocalFixtures('local console commands profile');
  }
  useTransport(transport: GeminiTransport) {
    this.models.bind(transport);
  }
  async sealModelCredential(
    actor: VerifiedIdentity,
    connectionId: string,
    apiKey: string,
  ) {
    if (this.mode !== 'LOCAL_FIXTURE')
      throw Error('live commands qualification pending');
    if (typeof connectionId !== 'string' || typeof apiKey !== 'string')
      throw Error('model credential rejected');
    return tx(this.db, (c) => this.models.seal(c, actor, connectionId, apiKey));
  }
  async execute(actor: VerifiedIdentity, input: unknown) {
    rejectSecretFields(input);
    const cmd = CommandSchema.parse(input);
    let body: any;
    try {
      body = CommandInputs[cmd.kind].parse(cmd.input);
    } catch {
      throw Error('command input denied');
    }
    if (this.mode !== 'LOCAL_FIXTURE')
      throw Error('live commands qualification pending');
    const outcome = await tx(this.db, async (c) => {
      await activeControl(c, this.fence);
      const i = await enrolled(c, actor, true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        i.tenant + '|' + i.id + '|' + cmd.idempotency_key,
      ]);
      const digest = createHash('sha256').update(canonical(cmd)).digest('hex');
      const previous = (
        await c.query(
          'SELECT * FROM ct.console_commands WHERE tenant=$1 AND actor=$2 AND idempotency_key=$3',
          [i.tenant, i.id, cmd.idempotency_key],
        )
      ).rows[0];
      if (previous) {
        if (previous.body_digest !== digest)
          throw Error('command binding conflict');
        await enrolled(c, actor, true);
        if (previous.status === 'PENDING') {
          const attempt = (
            await c.query(
              'SELECT id, state FROM ct.model_text_attempts WHERE tenant=$1 AND idempotency_key=$2',
              [i.tenant, cmd.idempotency_key],
            )
          ).rows[0];
          if (attempt?.state === 'RESERVED')
            return {
              __dispatch: true,
              attempt: attempt.id,
              tenant: i.tenant,
              commandId: previous.id,
            };
          if (attempt?.state === 'SENDING')
            return {
              __recover: true,
              attempt: attempt.id,
              tenant: i.tenant,
              commandId: previous.id,
            };
        }
        return receipt(previous, true);
      }
      const id = randomUUID();
      await c.query(
        "INSERT INTO ct.console_commands(tenant,actor,id,idempotency_key,kind,body_digest,expected_version,status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING')",
        [
          i.tenant,
          i.id,
          id,
          cmd.idempotency_key,
          cmd.kind,
          digest,
          cmd.expected_version,
        ],
      );
      await c.query("SELECT set_config('ct.console_command_id',$1,true)", [id]);
      await c.query('SAVEPOINT reviewed_domain_command');
      let result: unknown,
        status = 'APPLIED',
        errorCode: string | null = null;
      try {
        result = await this.apply(c, actor, i.tenant, cmd, body);
        await enrolled(c, actor, true);
        await c.query('RELEASE SAVEPOINT reviewed_domain_command');
        if (result && (result as { phase?: string }).phase === 'RESERVED')
          status = 'PENDING';
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT reviewed_domain_command');
        status = 'DENIED';
        errorCode = 'STALE_OR_UNAUTHORIZED_COMMAND';
        result = {
          reason:
            'Current binding, version, eligibility or scope denied. No external action was requested by this command.',
        };
      }
      if (
        status === 'PENDING' &&
        (result as { phase?: string })?.phase === 'RESERVED'
      )
        return {
          __dispatch: true,
          attempt: (result as { attempt: string }).attempt,
          tenant: i.tenant,
          commandId: id,
        };
      const row = (
        await c.query(
          'UPDATE ct.console_commands SET status=$4,result=$5,error_code=$6 WHERE tenant=$1 AND actor=$2 AND id=$3 RETURNING *',
          [i.tenant, i.id, id, status, JSON.stringify(result), errorCode],
        )
      ).rows[0];
      await append(c, i.tenant, 'HUMAN_COMMAND_' + status, {
        command: id,
        actor: i.id,
        kind: cmd.kind,
        target: cmd.target,
        bodyDigest: digest,
        externalEffect: false,
      });
      return receipt(row, false);
    });
    if (outcome && (outcome as { __dispatch?: boolean }).__dispatch)
      return this.dispatchAfterCommit(
        actor,
        cmd,
        body,
        outcome as { attempt: string; tenant: string; commandId: string },
      );
    if (outcome && (outcome as { __recover?: boolean }).__recover)
      return this.recoverSending(
        outcome as { attempt: string; tenant: string; commandId: string },
      );
    return outcome as ReturnType<typeof receipt>;
  }
  private async dispatchAfterCommit(
    actor: VerifiedIdentity,
    cmd: HumanCommand,
    body: { text?: string },
    reserved: { attempt: string; tenant: string; commandId: string },
  ) {
    const admitted = await tx(this.db, (c) =>
      this.models.admit(c, reserved.tenant, reserved.attempt),
    );
    if (!admitted.send) {
      return tx(this.db, async (c) => {
        const row = await this.finishCommand(
          c,
          reserved.tenant,
          reserved.commandId,
          admitted.result,
        );
        return receipt(row.row, !row.fresh);
      });
    }
    const provider = await this.models.invoke(admitted, body.text ?? '');
    return tx(this.db, async (c) => {
      const result = await this.models.record(
        c,
        reserved.tenant,
        reserved.attempt,
        provider,
        {
          maxOutputChars: admitted.maxOutputChars,
          connectionId: admitted.connectionId,
        },
      );
      const row = await this.finishCommand(
        c,
        reserved.tenant,
        reserved.commandId,
        result,
      );
      if (row.fresh)
        await append(c, reserved.tenant, 'HUMAN_COMMAND_APPLIED', {
          command: reserved.commandId,
          kind: cmd.kind,
          target: cmd.target,
          externalEffect: false,
        });
      void actor;
      return receipt(row.row, !row.fresh);
    });
  }
  private async finishCommand(
    c: pg.PoolClient,
    tenant: string,
    commandId: string,
    result: unknown,
  ) {
    const updated = (
      await c.query(
        `UPDATE ct.console_commands SET status='APPLIED', result=$3
         WHERE tenant=$1 AND id=$2 AND status='PENDING' RETURNING *`,
        [tenant, commandId, JSON.stringify(result)],
      )
    ).rows[0];
    if (updated) return { row: updated, fresh: true };
    const current = (
      await c.query(
        'SELECT * FROM ct.console_commands WHERE tenant=$1 AND id=$2',
        [tenant, commandId],
      )
    ).rows[0];
    if (!current) throw Error('command outcome not observed');
    return { row: current, fresh: false };
  }
  private async recoverSending(reserved: {
    attempt: string;
    tenant: string;
    commandId: string;
  }) {
    return tx(this.db, async (c) => {
      const result = await this.models.recover(
        c,
        reserved.tenant,
        reserved.attempt,
      );
      const row = await this.finishCommand(
        c,
        reserved.tenant,
        reserved.commandId,
        result,
      );
      return receipt(row.row, true);
    });
  }
  async lookup(actor: VerifiedIdentity, key: string) {
    return tx(this.db, async (c) => {
      const i = await enrolled(c, actor);
      if (actor.kind !== 'user') throw Error('human only');
      const row = (
        await c.query(
          'SELECT * FROM ct.console_commands WHERE tenant=$1 AND actor=$2 AND idempotency_key=$3',
          [i.tenant, i.id, key],
        )
      ).rows[0];
      if (!row) throw Error('command outcome not observed');
      return receipt(row, true);
    });
  }
  private async version(
    c: pg.PoolClient,
    table: string,
    tenant: string,
    id: string,
    col: string,
    expected: number,
  ) {
    const names: Record<string, string> = {
      grants: 'id',
      operations: 'id',
      incidents: 'id',
      notifications: 'id',
    };
    if (!names[table] || !['version', 'revision'].includes(col))
      throw Error('invalid reviewed object');
    const row = (
      await c.query(
        `SELECT ${col} FROM ct.${table} WHERE tenant=$1 AND ${names[table]}=$2`,
        [tenant, id],
      )
    ).rows[0];
    if (!row || Number(row[col]) !== expected)
      throw Error('object version conflict');
  }
  private async apply(
    c: pg.PoolClient,
    a: VerifiedIdentity,
    tenant: string,
    cmd: HumanCommand,
    b: any,
  ): Promise<unknown> {
    switch (cmd.kind) {
      case 'create_model_connection':
        return this.models.create(c, a, cmd.target, b.name);
      case 'set_model_connection_limits':
        return this.models.setLimits(c, a, cmd.target, b);
      case 'test_model_connection':
        return this.models.test(c, a, cmd.target, cmd.idempotency_key);
      case 'select_model_connection_model':
        return this.models.selectModel(c, a, cmd.target, b.model);
      case 'assign_model_connection':
        return this.models.assign(c, a, cmd.target, b.principal);
      case 'revoke_model_connection':
        return this.models.revoke(c, a, cmd.target);
      case 'try_vera_text':
        return this.models.reserveText(
          c,
          a,
          cmd.target,
          b.principal,
          b.text,
          cmd.idempotency_key,
        );
      case 'create_vera': {
        if (cmd.expected_version !== 0) throw Error('new VERA profile version');
        const result = await this.veras.create(a, { id: cmd.target, ...b }, c);
        return {
          ...result,
          profileRevision: result.creation.profileRevision,
          version: result.creation.profileRevision,
        };
      }
      case 'update_vera_profile': {
        const result = await this.veras.updateProfile(
          a,
          {
            id: cmd.target,
            ...b,
            expectedRevision: cmd.expected_version,
          },
          c,
        );
        return {
          ...result,
          profileRevision: result.revision,
          version: result.revision,
        };
      }
      case 'create_project': {
        if (cmd.expected_version !== 0) throw Error('new project version');
        const result = await this.coordination.project(
          a,
          cmd.target,
          b.name,
          b.objective,
          c,
        );
        return {
          ...result,
          version: result.revision,
          workflowAdmitted: false,
          effectAuthority: false,
          externalEffect: false,
        };
      }
      case 'link_task_project': {
        if (
          !Number.isSafeInteger(cmd.expected_version) ||
          cmd.expected_version > Number.MAX_SAFE_INTEGER - 1
        )
          throw Error('coordination version');
        const result = await this.coordination.link(
          a,
          cmd.target,
          b.project,
          cmd.expected_version,
          c,
        );
        return {
          ...result,
          project: b.project,
          version: result.revision,
          workflowAdmitted: false,
          effectAuthority: false,
          externalEffect: false,
        };
      }
      case 'create_task': {
        if (cmd.expected_version !== 0) throw Error('new task version');
        const result = await this.product.createTask(
          a,
          { id: cmd.target, ...b },
          c,
        );
        await c.query(
          'INSERT INTO ct.work_coordination(tenant,task,accountable_vera) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [tenant, cmd.target, b.principal],
        );
        return {
          ...result,
          businessPhase: 'PLANNED',
          workflowAdmitted: false,
          externalEffect: false,
        };
      }
      case 'approve':
        return this.authority.approve(
          a,
          {
            operation: cmd.target,
            digest: b.digest,
            expires: b.expires,
            expectedOperationVersion: cmd.expected_version,
            expectedApprovalRevision: b.approvalRevision,
          },
          c,
        );
      case 'create_grant':
        if (cmd.expected_version !== 0) throw Error('new grant version');
        if (
          (b.action === 'write' && b.resource !== 'fixture-object') ||
          (b.action === 'readCommit' && b.resource !== PUBLIC_GITHUB_RESOURCE)
        )
          throw Error('unsupported reviewed selector');
        return this.authority.createGrant(a, { id: cmd.target, ...b }, c);
      case 'revoke_grant':
        await this.version(
          c,
          'grants',
          tenant,
          cmd.target,
          'version',
          cmd.expected_version,
        );
        return this.authority.revoke(a, cmd.target, c);
      case 'assign':
        await this.version(
          c,
          'operations',
          tenant,
          cmd.target,
          'version',
          cmd.expected_version,
        );
        return this.authority.assign(a, { operation: cmd.target, ...b }, c);
      case 'ack_incident': {
        const row = (
          await c.query(
            "UPDATE ct.incidents SET status='ACKNOWLEDGED',acknowledged_by=$4,acknowledged_at=clock_timestamp(),revision=revision+1 WHERE tenant=$1 AND id=$2 AND revision=$3 AND status='OPEN' RETURNING id,status,revision",
            [
              tenant,
              cmd.target,
              cmd.expected_version,
              (await enrolled(c, a, true)).id,
            ],
          )
        ).rows[0];
        if (!row) throw Error('incident CAS conflict');
        return { ...row, resolved: false };
      }
      case 'mark_notification_read': {
        const row = (
          await c.query(
            'UPDATE ct.notifications SET read_at=clock_timestamp(),revision=revision+1 WHERE tenant=$1 AND id=$2 AND revision=$3 AND read_at IS NULL RETURNING id,read_at,revision',
            [tenant, cmd.target, cmd.expected_version],
          )
        ).rows[0];
        if (!row) throw Error('notification CAS conflict');
        return { ...row, incidentResolved: false };
      }
      case 'create_organization': {
        if (cmd.expected_version !== 0) throw Error('new organization version');
        const actor = await enrolled(c, a, true);
        return this.organizations.create(
          c,
          tenant,
          actor.id,
          cmd.target,
          b.name,
        );
      }
      case 'rename_organization':
        return this.organizations.rename(
          c,
          tenant,
          cmd.target,
          b.name,
          cmd.expected_version,
        );
      case 'define_role': {
        if (cmd.expected_version !== 0) throw Error('new role version');
        return this.organizations.defineRole(
          c,
          tenant,
          b.organization,
          cmd.target,
          b.name,
        );
      }
      case 'add_membership': {
        if (cmd.expected_version !== 0) throw Error('new membership version');
        return this.organizations.addMembership(
          c,
          tenant,
          b.organization,
          b.subjectKind,
          cmd.target,
          b.roleId,
          b.ownerSeat,
        );
      }
      case 'remove_membership':
        return this.organizations.removeMembership(
          c,
          tenant,
          b.organization,
          b.subjectKind,
          cmd.target,
          cmd.expected_version,
        );
      case 'record_mandate': {
        const actor = await enrolled(c, a, true);
        return this.mandates.record(
          c,
          tenant,
          actor.id,
          b.organization,
          cmd.target,
          b.title,
          b.body,
          cmd.expected_version,
        );
      }
      case 'export_evidence': {
        const head = Number(
          (
            await c.query('SELECT seq FROM ct.evidence_heads WHERE tenant=$1', [
              tenant,
            ])
          ).rows[0]?.seq ?? 0,
        );
        if (b.snapshot !== cmd.expected_version || b.snapshot > head)
          throw Error('export snapshot conflict');
        const events = (
          await c.query(
            'SELECT seq,kind,payload,hash,prev_hash FROM ct.evidence_events WHERE tenant=$1 AND seq=ANY($2::bigint[]) AND seq<=$3 ORDER BY seq',
            [tenant, b.sequences, b.snapshot],
          )
        ).rows;
        if (events.length !== new Set(b.sequences).size)
          throw Error('export object scope');
        let changed = false;
        return {
          scope: 'AUTHORIZED_SELECTED_PAGE',
          completeness: 'partial',
          snapshot: b.snapshot,
          exportedAt: new Date().toISOString(),
          events: events.map((e) => {
            const value = JSON.parse(e.payload);
            if (requiresRedaction(value)) changed = true;
            return {
              ...e,
              payload: redact(value),
              integrity:
                'Original source digest; redacted bytes cannot independently validate the original hash',
            };
          }),
          redactionApplied: changed,
          providerTruth: 'No chain or export alone proves an external effect',
        };
      }
    }
  }
}
function receipt(row: any, reused: boolean) {
  return {
    schema_version: 1,
    command_id: row.id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    result_ref: row.id,
    result: redact(row.result),
    error_code: row.error_code ?? null,
    reused,
    external_effect: false,
  };
}
