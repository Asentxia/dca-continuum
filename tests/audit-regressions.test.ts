import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './implementation-helpers.js';
import { admin, gov, fence } from './helpers.js';
import { pool } from '../src/db.js';
import { ComputerService, type Placement } from '../src/computers.js';
import { EffectController } from '../src/controller.js';
import {
  GitHubReadOnlyAdapter,
  GITHUB_PUBLIC_READONLY_PROVIDER,
  safeRepository,
} from '../src/providers/github-readonly.js';
after(async () => {
  await Promise.all([admin.end(), gov.end()]);
});
test('AUDIT-MFA: approval waiting on authority locks rejects stale MFA', async () => {
  const f = await fixture('audit-mfa');
  const hold = await gov.connect();
  // Same five-minute owner MFA window as AuthorityService.owner.
  const mfaWindowMs = 300000;
  const dbNow = async () =>
    new Date(
      (await admin.query('SELECT clock_timestamp() t')).rows[0].t,
    ).getTime();
  // FOR UPDATE on a held principal row waits on that transaction id.
  const principalLockWaiters = async () =>
    Number(
      (
        await admin.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='transactionid' AND state='active' AND query LIKE 'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE%'",
        )
      ).rows[0].n,
    );
  try {
    const { x, op } = await f.intent('audit-mfa-operation');
    const mintedAt = await dbNow();
    const actor = await f.human.verify(
      await f.token('user', 'a', {
        // About thirty seconds of freshness remain, so approval can reach
        // the principal lock before the window closes.
        auth_time: Math.floor((mintedAt - (mfaWindowMs - 30000)) / 1000),
      }),
    );
    assert.equal(typeof actor.authTime, 'number');
    assert.ok(mintedAt - actor.authTime! <= mfaWindowMs);
    await hold.query('BEGIN');
    await hold.query(
      'SELECT * FROM ct.principals WHERE tenant=$1 AND id=$2 FOR UPDATE',
      ['a', f.principal],
    );
    const pending = f.authority
      .approve(actor, {
        operation: x.id,
        digest: op.digest,
        expires: x.deadline,
      })
      .then(
        () => ({ applied: true as const }),
        (e: Error) => ({ applied: false as const, error: e.message }),
      );
    const observeUntil = Date.now() + 10000;
    let waiting = 0;
    while (Date.now() < observeUntil) {
      waiting = await principalLockWaiters();
      if (waiting > 0) break;
      await delay(50);
    }
    assert.ok(waiting > 0, 'approval was not blocked on the principal lock');
    const blockedAt = await dbNow();
    assert.ok(
      blockedAt - actor.authTime! <= mfaWindowMs,
      'MFA was already expired when the principal lock wait was observed',
    );
    const expireUntil = Date.now() + 60000;
    while ((await dbNow()) - actor.authTime! <= mfaWindowMs) {
      assert.ok(
        Date.now() < expireUntil,
        'database clock did not pass the five-minute MFA window while the lock was held',
      );
      await delay(100);
    }
    await hold.query('COMMIT');
    const outcome = await pending;
    if (outcome.applied)
      assert.fail('stale MFA approval was applied after the lock was released');
    assert.match(
      outcome.error,
      /fresh independently enrolled owner MFA required/,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*)::int n FROM ct.approvals WHERE tenant='a' AND operation=$1",
            [x.id],
          )
        ).rows[0].n,
      ),
      0,
    );
    const fresh = await f.actor('user');
    const again = await f.intent('audit-mfa-fresh');
    await f.authority.approve(fresh, {
      operation: again.x.id,
      digest: again.op.digest,
      expires: again.x.deadline,
    });
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*)::int n FROM ct.approvals WHERE tenant='a' AND operation=$1",
            [again.x.id],
          )
        ).rows[0].n,
      ),
      1,
    );
  } finally {
    await hold.query('ROLLBACK').catch(() => {});
    hold.release();
    await f.close();
  }
});
test('AUDIT-GENERATION: pre-rotation workload token cannot renew post-rotation authority', async () => {
  const f = await fixture('audit-generation');
  const computersDb = pool('ct_computer_broker');
  const placements = new Map<string, Placement>();
  const driver = {
    async start(s: {
      generation: number;
      tenant: string;
      computer: string;
      principal: string;
      requestId: string;
    }) {
      const p: Placement = {
        id: `audit-placement-${s.generation}`,
        tenant: s.tenant,
        computer: s.computer,
        generation: s.generation,
        status: 'RUNNING',
      };
      placements.set(p.id, p);
      return p;
    },
    async inspect(id: string) {
      const found = placements.get(id);
      if (!found) throw Error('missing placement');
      return found;
    },
    async stop(id: string) {
      placements.delete(id);
    },
  };
  try {
    const computers = new ComputerService(computersDb, driver, fence);
    const owner = await f.actor('user');
    await computers.register(owner, 'audit-generation-computer', f.principal);
    await computers.start(owner, 'audit-generation-computer');
    const oldToken = await f.token('machine');
    const oldIdentity = await f.machine.verify(oldToken);
    const oldIntent = await f.intent('audit-old-generation-operation', true);
    const oldCapability = await f.capability(oldIntent.x.id);
    await computers.lose(owner, 'audit-generation-computer');
    await computers.start(owner, 'audit-generation-computer');
    assert.equal(
      (await f.controller.dispatch(oldCapability, oldIntent.x.id)).state,
      'DENIED',
    );
    await assert.rejects(
      computers.authorizePlacement(
        oldIdentity,
        'audit-generation-computer',
        'audit-placement-1',
        1,
      ),
      /placement generation denied/,
    );
    await assert.rejects(
      computers.authorizePlacement(
        oldIdentity,
        'audit-generation-computer',
        'audit-placement-2',
        2,
      ),
      /placement generation denied/,
    );
    const newIntent = await f.intent('audit-new-generation-operation', true);
    await assert.rejects(
      f.authority.renew(await f.machine.verify(oldToken), newIntent.x.id),
      /current authority\/assignment denied/,
    );
    const fresh = await f.capability(newIntent.x.id);
    assert.equal(fresh.generation, 1);
    assert.equal(fresh.placementGeneration, 2);
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT generation FROM ct.principals WHERE tenant=$1 AND id=$2',
            ['a', f.principal],
          )
        ).rows[0].generation,
      ),
      1,
    );
    assert.equal(
      (await f.controller.dispatch(fresh, newIntent.x.id)).state,
      'COMMITTED',
    );
  } finally {
    await computersDb.end();
    await f.close();
  }
});
test('AUDIT-PROVIDER: product proposals use the canonical public GitHub identifier', async () => {
  const f = await fixture('audit-provider');
  try {
    const owner = await f.actor('user'),
      worker = await f.actor('machine');
    const deadline = new Date(Date.now() + 3600000).toISOString();
    const resource = `repo:${safeRepository.owner}/${safeRepository.repo}@${safeRepository.commit}`;
    await f.authority.createGrant(owner, {
      id: 'audit-public-read-grant',
      principal: f.principal,
      action: 'readCommit',
      resource,
      expires: deadline,
      maxCost: 0,
      budget: 0,
    });
    await f.product.createTask(worker, {
      id: 'audit-public-read-task',
      principal: f.principal,
      objective: 'Read the fixed public immutable commit',
      deadline,
      ...f.admission.a,
    });
    const input = {
      id: 'audit-public-read-operation',
      task: 'audit-public-read-task',
      grant: 'audit-public-read-grant',
      provider: GITHUB_PUBLIC_READONLY_PROVIDER,
      action: 'readCommit',
      resource,
      params: { ...safeRepository },
      cost: 0,
      deadline,
    };
    const op = await f.product.propose(worker, input);
    await assert.rejects(
      f.product.propose(worker, {
        ...input,
        id: 'audit-alias-provider',
        provider: 'github-readonly',
      }),
    );
    await f.authority.approve(owner, {
      operation: input.id,
      digest: op.digest,
      expires: deadline,
    });
    await f.authority.assign(owner, {
      identity: f.prefix + '-worker-a',
      operation: input.id,
      expires: deadline,
    });
    const adapter = new GitHubReadOnlyAdapter();
    const row = (
      await admin.query(
        'SELECT * FROM ct.operations WHERE tenant=$1 AND id=$2',
        ['a', input.id],
      )
    ).rows[0];
    assert.equal(row.provider, adapter.provider);
    assert.equal(adapter.supports(row), true);
    if (process.env.CT_RUN_PUBLIC_READ_FIXTURE === 'yes') {
      const result = await new EffectController(
        f.controllerDb,
        adapter,
        fence,
      ).dispatch(await f.capability(input.id), input.id);
      assert.equal(result.state, 'COMMITTED');
      assert.ok(adapter.evidence.length >= 1);
    }
  } finally {
    await f.close();
  }
});
test('AUDIT-TENANT-FK: tenant-local creator writes are constrained', async () => {
  const f = await fixture('audit-tenant-fk');
  try {
    let code = '';
    try {
      await f.productDb.query(
        'INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          'a',
          'audit-cross-tenant-creator',
          f.principal,
          'Owned local FK integrity canary',
          new Date(Date.now() + 3600000),
          f.prefix + '-owner-b',
          f.admission.a.organization,
          f.admission.a.mandate,
          f.admission.a.mandateVersion,
        ],
      );
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    assert.equal(code, '23503');
    await f.productDb.query(
      'INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        'a',
        'audit-local-creator',
        f.principal,
        'Owned local FK integrity canary',
        new Date(Date.now() + 3600000),
        f.prefix + '-owner-a',
        f.admission.a.organization,
        f.admission.a.mandate,
        f.admission.a.mandateVersion,
      ],
    );
  } finally {
    await f.close();
  }
});
