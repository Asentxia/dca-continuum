import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { ComputerService, type Placement } from '../src/computers.js';
import { EffectController } from '../src/controller.js';
import { fixture } from './implementation-helpers.js';
import { admin, fence, gov } from './helpers.js';

test('Continuity: one VERA survives interruption, reconciles UNKNOWN without a resend, and denies the stale worker', async () => {
  const f = await fixture('continuity');
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
        id: `continuity-placement-${s.generation}`,
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
    await computers.register(owner, 'continuity-computer', f.principal);
    const running = await computers.start(owner, 'continuity-computer');
    assert.equal(running.principal, f.principal);
    const identity = (
      await admin.query(
        'SELECT id,generation FROM ct.principals WHERE tenant=$1 AND id=$2',
        ['a', f.principal],
      )
    ).rows[0];
    assert.equal(identity.id, f.principal);
    assert.equal(Number(identity.generation), 1);

    const uncertain = await f.intent('continuity-uncertain', true);
    const issued = await f.capability(uncertain.x.id);
    const waiting = await f.intent('continuity-waiting', true);
    const waitingCapability = await f.capability(waiting.x.id);
    const staleWorker = await f.token('machine');
    f.provider.loseAck = true;
    assert.equal(
      (await f.controller.dispatch(issued, uncertain.x.id)).state,
      'UNKNOWN',
    );
    assert.equal(f.provider.sends, 1);

    const lost = await computers.lose(owner, 'continuity-computer');
    assert.equal(lost.state, 'LOST');
    const resumed = new EffectController(
      f.controllerDb,
      f.provider,
      fence,
      100,
    );
    assert.equal(
      (await resumed.dispatch(issued, uncertain.x.id)).state,
      'UNKNOWN',
    );
    assert.equal(f.provider.sends, 1);
    assert.equal(
      (await resumed.reconcile(issued, uncertain.x.id)).state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 1);
    assert.equal(
      f.provider.rows.filter((row) => row.operation === uncertain.x.id).length,
      1,
    );
    assert.equal(
      (await resumed.dispatch(waitingCapability, waiting.x.id)).state,
      'DENIED',
    );
    assert.equal(f.provider.sends, 1);
    await assert.rejects(
      computers.authorizePlacement(
        await f.machine.verify(staleWorker),
        'continuity-computer',
        'continuity-placement-1',
        1,
      ),
      /placement generation denied/,
    );

    const replaced = await computers.start(owner, 'continuity-computer');
    assert.equal(replaced.principal, f.principal);
    assert.equal(Number(replaced.generation), 2);
    await assert.rejects(
      computers.authorizePlacement(
        await f.machine.verify(staleWorker),
        'continuity-computer',
        replaced.placement,
        2,
      ),
      /placement generation denied/,
    );
    assert.equal(
      (
        await admin.query(
          'SELECT id FROM ct.principals WHERE tenant=$1 AND id=$2',
          ['a', f.principal],
        )
      ).rows[0].id,
      f.principal,
    );
    const resumedWork = await f.intent('continuity-resumed', true);
    await assert.rejects(
      f.authority.renew(await f.machine.verify(staleWorker), resumedWork.x.id),
      /current authority\/assignment denied/,
    );
    f.provider.loseAck = false;
    const fresh = await f.capability(resumedWork.x.id);
    assert.equal(fresh.principal, f.principal);
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
      (await resumed.dispatch(fresh, resumedWork.x.id)).state,
      'COMMITTED',
    );
    assert.equal(f.provider.sends, 2);
    assert.equal(
      f.provider.rows.filter((row) => row.operation === resumedWork.x.id)
        .length,
      1,
    );
  } finally {
    await computersDb.end();
    await f.close();
    await admin.end();
    await gov.end();
  }
});
