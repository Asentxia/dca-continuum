import { assertLocalFixtures } from '../../src/runtime-profile.js';
// Dedicated LOCAL TEST executable. Never imported by the staging server.
import { ContextService } from '../../src/context-service.js';
import { fixture } from '../../tests/implementation-helpers.js';
import { admin, gov, fence } from '../../tests/helpers.js';
import { pool } from '../../src/db.js';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { ConsoleReads } from '../../src/console/reads.js';
import { ConsoleCommands } from '../../src/console/commands.js';
import { CursorCodec } from '../../src/console/pagination.js';
import { WorkCoordination } from '../../src/console/coordination.js';
import { consoleApi } from '../../src/console/api.js';
if (
  process.env.CT_CONSOLE_MODE !== 'LOCAL_FIXTURE' ||
  !['ct_console_browser', 'ct_console_dev'].includes(
    process.env.CT_DATABASE ?? '',
  )
)
  throw Error('Explicit disposable console fixture database/mode required');
assertLocalFixtures('console fixture executable');
const f = await fixture('focus'),
  reader = pool('ct_console_reader'),
  writer = pool('ct_authority_api');
const coord = new WorkCoordination(writer, fence),
  owner = await f.actor('user');
await admin.query(
  "INSERT INTO ct.computers(tenant,id,principal,generation,state) VALUES('a','continuity-desk',$1,1,'RUNNING')",
  [f.principal],
);
await gov.query(
  "INSERT INTO ct.computer_observations VALUES('a','continuity-desk',1,'stopped','local-process','unknown','LOCAL_FIXTURE',now(),now()+interval '10 minutes',NULL)",
);
await coord.project(
  owner,
  'operations',
  'Operating week',
  'Local test: exact decisions, durable continuity and honest outcomes.',
);
for (const example of [
  {
    id: 'review-vendor',
    title: 'Review the vendor statement',
    state: 'pending',
  },
  {
    id: 'ledger-uncertain',
    title: 'Confirm the ledger update',
    state: 'unknown',
  },
  {
    id: 'close-books',
    title: 'Review the completed reconciliation',
    state: 'verified',
  },
  {
    id: 'venue-access',
    title: 'Inspect the revoked venue permission',
    state: 'denied',
  },
  { id: 'draft-summary', title: 'Prepare the board summary', state: 'planned' },
]) {
  const { x } = await f.intent(
    example.id,
    ['unknown', 'verified', 'denied'].includes(example.state),
    example.title,
    example.id === 'review-vendor'
      ? {
          value:
            'Review the exact local fixture statement.\nΔ Unicode detail and <img src=x onerror=alert(1)> stay inert.\n' +
            'Full reviewable terms. '.repeat(40),
        }
      : undefined,
  );
  await coord.link(owner, x.task, 'operations', 0);
  if (example.id === 'draft-summary')
    await admin.query(
      'DELETE FROM ct.assignments WHERE tenant=$1 AND operation=$2',
      ['a', x.id],
    );
  if (example.state === 'unknown') {
    f.provider.loseAck = true;
    await f.controller.dispatch(await f.capability(x.id), x.id);
    f.provider.loseAck = false;
  }
  if (example.state === 'verified')
    await f.controller.dispatch(await f.capability(x.id), x.id);
  if (example.state === 'denied') {
    const cap = await f.capability(x.id);
    await f.authority.revoke(owner, x.grant);
    await f.controller.dispatch(cap, x.id);
  }
}
await f.product.createTask(owner, {
  id: 'work-next-week',
  principal: f.principal,
  objective: 'Plan the next operating week',
  deadline: new Date(Date.now() + 3600000).toISOString(),
  ...f.admission.a,
});
await coord.link(owner, 'work-next-week', 'operations', 0);
await gov.query(
  "INSERT INTO ct.incidents(tenant,id,root_id,cause,severity,status,title,owner_vera,source_version) VALUES('a','unknown-ledger','ledger-uncertain','LOST_ACK',0,'OPEN','Provider acknowledgement missing — retain uncertainty',$1,1)",
  [f.principal],
);
await gov.query(
  "INSERT INTO ct.incident_tasks VALUES('a','unknown-ledger','t-ledger-uncertain')",
);
await gov.query(
  "INSERT INTO ct.notifications(tenant,id,incident,source_version,channel,delivery_state) VALUES('a','ledger-notice','unknown-ledger',1,'in-app','IN_APP')",
);
const contextPool = pool('ct_context_service');
await new ContextService(contextPool).ingest(await f.actor('machine'), {
  id: 'operating-notes',
  expectedVersion: 0,
  payload: { text: 'A context fact is not permission.' },
  source: { kind: 'document', reference: 'local-fixture:operating-notes' },
  ttlSeconds: 3600,
});
await contextPool.end();
const api = consoleApi(
  f.human,
  new ConsoleReads(
    reader,
    new CursorCodec(randomBytes(32)),
    'LOCAL_FIXTURE',
    process.env.CT_SOURCE_REVISION ?? 'canonical-local',
    fence,
  ),
  new ConsoleCommands(writer, f.authority, f.product, fence, 'LOCAL_FIXTURE'),
  {
    fixtureLogin: (tenant) => f.token('user', tenant),
    fixtureServerKey: process.env.CT_FIXTURE_SERVER_KEY,
  },
);
const port = Number(process.env.CT_API_PORT ?? 5660);
await new Promise<void>((resolve) => api.listen(port, '127.0.0.1', resolve));
console.log('LOCAL_FIXTURE domain API ready; production BLOCKED.');
if (process.env.CT_FIXTURE_READY_FILE)
  await fs.writeFile(
    process.env.CT_FIXTURE_READY_FILE,
    JSON.stringify({
      port,
      mode: 'LOCAL_FIXTURE',
      principal: f.principal,
      production: 'BLOCKED',
    }),
  );
async function close() {
  await new Promise<void>((r) => api.close(() => r()));
  await f.close();
  await reader.end();
  await writer.end();
  await admin.end();
  await gov.end();
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);

process.on('message', async (message: any) => {
  if (
    !message ||
    message.type !== 'local-worker-step' ||
    !['review-vendor', 'draft-summary'].includes(message.operation)
  )
    return;
  try {
    const outcome = await f.controller.dispatch(
      await f.capability(message.operation),
      message.operation,
    );
    process.send?.({
      type: 'local-worker-result',
      operation: message.operation,
      state: outcome.state,
    });
  } catch {
    process.send?.({
      type: 'local-worker-result',
      operation: message.operation,
      state: 'DENIED',
    });
  }
});
