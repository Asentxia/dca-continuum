import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const dir = '.artifacts/canonical/browser';
let browser: Browser,
  context: BrowserContext,
  page: Page,
  api: ChildProcess,
  web: ChildProcess,
  origin: string,
  apiPort: number,
  key: string;
const requests: any[] = [],
  metrics: any[] = [];
async function port() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const n = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return n;
}
async function ready(url: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Local server did not become ready');
}
async function login(p: Page, tenant = 'a') {
  await p.goto(origin + '/sign-in');
  await p
    .getByRole('button', {
      name:
        tenant === 'a'
          ? 'Enter local test workspace'
          : 'Enter second test workspace',
      exact: true,
    })
    .click();
  await p.waitForURL('**/console/work');
  await p.getByRole('heading', { name: 'Work', exact: true }).waitFor();
  await p
    .locator('.record')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});
}
async function go(section: string, selected?: string) {
  await page.goto(
    origin +
      '/console/' +
      section +
      (selected ? '?selected=' + encodeURIComponent(selected) : ''),
  );
  await page
    .getByRole('heading', {
      name:
        (
          {
            agents: 'VERAs',
            integrations: 'Connections',
            context: 'State / Context',
            usage: 'Usage / Limits',
            setup: 'Onboarding / Setup',
          } as any
        )[section] ?? section[0].toUpperCase() + section.slice(1),
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.list-heading')
        ?.textContent?.includes('Authorized snapshot') ||
      document
        .querySelector('.list-heading')
        ?.textContent?.includes('Partial snapshot'),
  );
  if (selected) await page.locator('.inspector-heading h2').waitFor();
}
async function readApi(section: string) {
  const r = await context.request.get(origin + '/api/continuum/v1/' + section);
  assert.equal(r.status(), 200);
  return r.json();
}
before(async () => {
  await fs.mkdir(dir, { recursive: true });
  apiPort = await port();
  const webPort = await port();
  origin = 'http://127.0.0.1:' + webPort;
  key = randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    CT_RUNTIME_ENV: 'local-test',
    CT_ALLOW_LOCAL_FIXTURES: 'yes',
    CT_LOCAL_TEST_BUILD: 'yes',
    CT_CONSOLE_MODE: 'LOCAL_FIXTURE',
    CT_DATABASE: 'ct_console_browser',
    CT_API_PORT: String(apiPort),
    CT_DOMAIN_API_ORIGIN: 'http://127.0.0.1:' + apiPort,
    CT_CONSOLE_ORIGIN: origin,
    CT_FIXTURE_SERVER_KEY: key,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  api = spawn(process.execPath, ['dist/internal/fixtures/console-server.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: true,
  });
  api.stdout!.pipe(createWriteStream(dir + '/DOMAIN-SERVER.log'));
  api.stderr!.pipe(createWriteStream(dir + '/DOMAIN-ERROR.log'));
  await ready('http://127.0.0.1:' + apiPort + '/read');
  web = spawn(
    (process.env.CT_NODE22_BIN ?? '') + '/node',
    [
      path.resolve('node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    {
      cwd: path.resolve('web'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  web.stdout!.pipe(createWriteStream(dir + '/FRONTEND-SERVER.log'));
  web.stderr!.pipe(createWriteStream(dir + '/FRONTEND-ERROR.log'));
  await ready(origin + '/sign-in');
  browser = await chromium.launch({
    executablePath: process.env.CT_CHROMIUM_PATH ?? '/usr/local/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  context.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === origin && u.pathname.startsWith('/api/'))
      requests.push({
        method: r.request().method(),
        path: u.pathname,
        status: r.status(),
      });
  });
  page = await context.newPage();
  await fs.writeFile(
    dir + '/ENVIRONMENT.json',
    JSON.stringify(
      {
        scope: 'LOCAL_FIXTURE',
        frontendNode: execFileSync(
          (process.env.CT_NODE22_BIN ?? '') + '/node',
          ['--version'],
          { encoding: 'utf8' },
        ).trim(),
        backendNode: process.version,
        browser: browser.version(),
        production: 'BLOCKED',
        tracePolicy:
          'No authentication headers/cookies/tokens recorded; HTTP metadata and fixture UI only.',
      },
      null,
      2,
    ),
  );
});
after(async () => {
  if (context) await context.close();
  if (browser) await browser.close();
  for (const p of [api, web])
    if (p?.pid)
      try {
        process.kill(-p.pid, 'SIGTERM');
      } catch {}
  await fs.writeFile(
    dir + '/RAW-HTTP-METADATA.json',
    JSON.stringify(requests, null, 2),
  );
  await fs.writeFile(
    dir + '/PERFORMANCE.json',
    JSON.stringify(metrics, null, 2),
  );
});
test('A01/A11 authenticated fixture entry; no JWT/key/role claims in public UI responses', async () => {
  await page.goto(origin + '/console/work');
  await page.waitForURL('**/sign-in');
  await login(page);
  const session = await readApi('session');
  assert.equal(session.session.tenant, 'a');
  assert.equal(session.scope, 'LOCAL_FIXTURE');
  assert.ok(
    !/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\./.test(await page.content()),
  );
  assert.ok(!('accessToken' in session));
  assert.ok(session.items[0].fields.identitySource.includes('TEST'));
});
test('A02/A03/A04 Focus is backend-derived, no false all-clear and review order stays explicit', async () => {
  await go('work');
  assert.ok(
    (await page.locator('.record').first().innerText()).includes(
      'acknowledgement',
    ),
  );
  assert.equal(await page.getByText('All clear', { exact: true }).count(), 0);
  await page.locator('.record').first().click();
  await page.locator('.inspector-heading').waitFor();
  assert.ok(
    await page.getByRole('button', { name: /Refresh order/ }).isVisible(),
  );
  await page.screenshot({
    path: dir + '/FOCUS-DESK-DESKTOP.png',
    fullPage: true,
  });
});
test('A04 a new critical cause is announced without stealing focus or changing review order', async () => {
  await go('work');
  const first = await page
    .locator('.record')
    .first()
    .getAttribute('aria-label');
  await page.locator('.record').first().click();
  await page.locator('.inspector-heading').waitFor();
  const selected = new URL(page.url()).searchParams.get('selected');
  const refresh = page.getByRole('button', { name: /^Refresh order/ });
  await refresh.focus();
  execFileSync(
    'psql',
    [
      '-d',
      'ct_console_browser',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "INSERT INTO ct.incidents(tenant,id,root_id,cause,severity,status,title,owner_vera,source_version) VALUES('a','fresh-critical','live-fixture-cause','SECURITY',0,'OPEN','New critical fixture cause','p-focus',1); INSERT INTO ct.incident_tasks VALUES('a','fresh-critical','t-review-vendor'),('a','fresh-critical','t-draft-summary');",
    ],
    {
      env: {
        ...process.env,
        PGHOST: '127.0.0.1',
        PGPORT: '55432',
        PGUSER: 'localtest',
      },
      stdio: 'ignore',
    },
  );
  await page
    .getByRole('status')
    .filter({ hasText: 'new attention group' })
    .waitFor({ timeout: 15000 });
  assert.equal(new URL(page.url()).searchParams.get('selected'), selected);
  assert.equal(
    await page.locator('.record').first().getAttribute('aria-label'),
    first,
  );
  assert.ok(
    (
      await page.evaluate(() => document.activeElement?.textContent)
    )?.startsWith('Refresh order'),
  );
  await refresh.click();
  await page.waitForFunction(
    () =>
      document.querySelector('.record-title')?.textContent ===
      'New critical fixture cause',
  );
});
test('A16 exact preview preserves Unicode/markup as inert read-only data', async () => {
  await go('approvals', 'review-vendor');
  await page
    .getByRole('button', { name: 'Approve exact action', exact: true })
    .waitFor();
  assert.ok(
    await page
      .locator('.payload')
      .first()
      .innerText()
      .then((x) => x.includes('Δ Unicode')),
  );
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.equal(await page.locator('textarea').count(), 0);
  await page.screenshot({
    path: dir + '/EXACT-APPROVAL-DESKTOP.png',
    fullPage: true,
  });
});
test('A17 approval is a durable human command, not execution; independent worker later verifies', async () => {
  await page
    .getByRole('button', { name: 'Approve exact action', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Exact approval recorded' })
    .waitFor();
  let data = await readApi('approvals?id=review-vendor');
  assert.equal(data.items[0].fields.effectState, 'REQUESTED');
  assert.equal(data.items[0].fields.approvalRevision, 1);
  const result = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error('Fixture worker step timeout')),
      10000,
    );
    const handler = (message: any) => {
      if (
        message.type === 'local-worker-result' &&
        message.operation === 'review-vendor'
      ) {
        api.off('message', handler);
        clearTimeout(timeout);
        resolve(message);
      }
    };
    api.on('message', handler);
    api.send!({ type: 'local-worker-step', operation: 'review-vendor' });
  });
  assert.equal(result.state, 'COMMITTED');
  await go('evidence', 'operation:review-vendor');
  assert.ok(
    (await page.locator('.inspector').innerText()).includes(
      'Verified fixture result',
    ),
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Approve exact action', exact: true })
      .count(),
    0,
  );
});
test('A12 failed machine refresh cannot submit a stale selection', async () => {
  await go('approvals', 'draft-summary');
  await context.route('**/api/continuum/v1/security*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}',
    }),
  );
  try {
    await page
      .getByRole('button', { name: 'Review machine assignment', exact: true })
      .click();
    const submit = page.getByRole('button', {
      name: 'Record exact assignment',
      exact: true,
    });
    await submit.waitFor();
    assert.equal(await submit.isDisabled(), true);
  } finally {
    await context.unroute('**/api/continuum/v1/security*');
  }
});
test('A12 recorded machine assignment is independent of approval and capability issuance', async () => {
  await go('approvals', 'draft-summary');
  await page
    .getByRole('button', { name: 'Review machine assignment', exact: true })
    .click();
  await page.getByLabel('Machine identity').selectOption('focus-worker-a');
  await page
    .getByRole('button', { name: 'Record exact assignment', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Workload assignment recorded' })
    .waitFor();
  const op = (await readApi('approvals?id=draft-summary')).items[0];
  assert.equal(op.fields.workloadAssignments.length, 1);
  assert.equal(op.fields.workloadAssignments[0].identity, 'focus-worker-a');
  assert.equal(op.fields.approvalRevision, 0);
  assert.equal(op.fields.effectState, 'REQUESTED');
});
test('A06/A39 lost human-command acknowledgement uses one lookup and never resubmits', async () => {
  let posts = 0,
    lookups = 0;
  await go('work');
  await context.route('**/api/continuum/v1/command*', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Injected lost acknowledgement after durable local commit',
        }),
      });
    } else {
      lookups++;
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByLabel('Work objective')
    .fill('Lost acknowledgement fixture task');
  await page.getByRole('button', { name: 'Record task', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Task recorded' }).waitFor();
  await context.unroute('**/api/continuum/v1/command*');
  assert.equal(posts, 1);
  assert.equal(lookups, 1);
  const tasks = await readApi('work?q=Lost acknowledgement fixture task');
  assert.equal(tasks.items.length, 1);
  assert.equal(tasks.items[0].fields.operations.length, 0);
});
test('A05/A06 new task form records work without starting a workflow/effect', async () => {
  await go('work');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByLabel('Work objective')
    .fill('Browser-owned coordination task');
  await page.getByRole('button', { name: 'Record task', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Task recorded' }).waitFor();
  const data = await readApi('work?q=Browser-owned');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].status, 'Planned — no workflow admitted');
  assert.equal(data.items[0].fields.operations.length, 0);
});
test('A20 bounded grant form persists exact scope and does not assign, approve or execute', async () => {
  await go('authority');
  await page
    .getByRole('button', { name: 'New bounded grant', exact: true })
    .click();
  await page.getByLabel('Maximum action cost · test units').fill('2');
  await page.getByLabel('Total bound · test units').fill('6');
  await page
    .getByRole('button', { name: 'Create bounded grant', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Human command durably applied' })
    .waitFor();
  const grants = (await readApi('authority')).items.filter((x: any) =>
    x.id.startsWith('grant-'),
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].fields.scope.action, 'write');
  assert.equal(grants[0].fields.scope.resource, 'fixture-object');
  assert.equal(grants[0].fields.maxCost, 2);
  assert.equal(grants[0].fields.budget, 6);
  assert.equal(grants[0].fields.reserved, 0);
  const ops = (await readApi('approvals')).items;
  assert.ok(ops.every((x: any) => x.fields.grant !== grants[0].id));
});
test('C2 browser profile creation and rename persist without changing principal counters or configuring services', async () => {
  const name = 'Browser Verá <literal>';
  const description = 'Human-managed metadata only.\nNo execution requested.';
  await go('agents');
  await page.getByRole('button', { name: 'New VERA', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill(description);
  await page
    .getByRole('button', { name: 'Record VERA profile', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'VERA profile recorded in PAUSED mode' })
    .waitFor();
  const created = await readApi('agents?q=' + encodeURIComponent(name));
  assert.equal(created.total, 1);
  const original = created.items[0];
  assert.equal(original.title, name);
  assert.equal(original.status, 'Paused VERA');
  assert.equal(original.fields.profileRevision, 1);
  assert.equal(String(original.fields.principalEpoch), '1');
  assert.equal(original.fields.principalGeneration, 1);
  assert.equal(original.fields.executionMode, 'PAUSED');
  assert.equal(original.fields.description, description);
  assert.deepEqual(original.fields.workloadIdentities, []);
  assert.equal(original.fields.logicalComputer, undefined);
  assert.equal(original.fields.cognition, 'Model binding not configured');
  await go('agents', original.id);
  await page
    .getByRole('button', { name: 'Edit VERA profile', exact: true })
    .click();
  const renamed = name + ' · renamed';
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(renamed);
  await page
    .getByRole('button', { name: 'Record profile changes', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Profile text updated' })
    .waitFor();
  const changed = (
    await readApi('agents?id=' + encodeURIComponent(original.id))
  ).items[0];
  assert.equal(changed.id, original.id);
  assert.equal(changed.title, renamed);
  assert.equal(changed.fields.profileRevision, 2);
  for (const field of [
    'principalEpoch',
    'principalGeneration',
    'profileCreatedBy',
    'executionMode',
    'workloadIdentities',
    'cognition',
  ])
    assert.deepEqual(changed.fields[field], original.fields[field], field);
  assert.equal(changed.fields.description, description);
  await page.reload();
  await page.getByRole('heading', { name: renamed, exact: true }).waitFor();
  assert.equal(await page.locator('.inspector img').count(), 0);
});
test('C1 browser project creation is durable and searchable by both name and objective', async () => {
  const name = 'Browser project Δ';
  const objective = 'A separate searchable coordination objective';
  const beforeWork = await readApi('work');
  await go('projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByLabel('Project objective', { exact: true }).fill(objective);
  await page
    .getByRole('button', { name: 'Submit project request', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Project recorded. No work' })
    .waitFor();
  let target = '';
  for (const query of [name, objective]) {
    const result = await readApi('projects?q=' + encodeURIComponent(query));
    assert.equal(result.total, 1);
    assert.equal(result.items[0].title, name);
    assert.equal(result.items[0].fields.objective, objective);
    assert.deepEqual(result.items[0].fields.tasks, []);
    if (target) assert.equal(result.items[0].id, target);
    target = result.items[0].id;
  }
  assert.equal((await readApi('work')).total, beforeWork.total);
  await go('projects', target);
  await page.getByRole('heading', { name, exact: true }).waitFor();
});
test('C1/J an unresolved project reply survives reload and resolves through an explicit GET without another POST', async () => {
  let posts = 0,
    lookups = 0,
    loseLookup = true,
    submittedKey = '';
  await go('projects');
  await context.route('**/api/continuum/v1/command*', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      submittedKey = route.request().postDataJSON().idempotency_key;
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Lost fixture acknowledgement' }),
      });
    } else {
      lookups++;
      if (loseLookup)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Fixture lookup unavailable' }),
        });
      else await route.continue();
    }
  });
  try {
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page
      .getByLabel('Project name', { exact: true })
      .fill('Unconfirmed browser project');
    await page
      .getByRole('button', { name: 'Submit project request', exact: true })
      .click();
    await page
      .getByText('Command outcome unconfirmed', { exact: true })
      .waitFor();
    const stored = await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem('continuum.console.unconfirmed-command')!,
      ),
    );
    assert.deepEqual(Object.keys(stored).sort(), ['identity', 'key']);
    assert.equal(stored.key, submittedKey);
    assert.equal(posts, 1);
    assert.equal(lookups, 1);
    await page
      .getByRole('button', { name: 'Refresh authorized snapshot', exact: true })
      .click();
    assert.equal(
      await page
        .getByRole('button', { name: 'New project', exact: true })
        .isEnabled(),
      false,
    );
    await page.reload();
    await page
      .getByText('Command outcome unconfirmed', { exact: true })
      .waitFor();
    assert.equal(lookups, 1, 'reload must not automatically query or resubmit');
    assert.equal(posts, 1);
    assert.equal(
      await page
        .getByRole('button', { name: 'New project', exact: true })
        .isEnabled(),
      false,
    );
    loseLookup = false;
    await page
      .getByRole('button', {
        name: 'Check stored command outcome',
        exact: true,
      })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Stored human-command receipt found: applied' })
      .waitFor();
    assert.equal(posts, 1);
    assert.equal(lookups, 2);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem('continuum.console.unconfirmed-command'),
      ),
      null,
    );
    const projects = await readApi(
      'projects?q=' + encodeURIComponent('Unconfirmed browser project'),
    );
    assert.equal(projects.total, 1);
  } finally {
    await context.unroute('**/api/continuum/v1/command*');
  }
});
test('C1/J server search and a real second project page can link existing UNKNOWN work without changing effect bindings', async () => {
  const csrf = (await readApi('session')).csrf;
  for (let index = 0; index < 64; index++) {
    const suffix = String(index).padStart(3, '0');
    const result = await context.request.post(
      origin + '/api/continuum/v1/command',
      {
        headers: {
          origin,
          'content-type': 'application/json',
          'x-ct-csrf': csrf,
        },
        data: {
          schema_version: 1,
          idempotency_key: 'browser-catalog-seed-' + suffix,
          kind: 'create_project',
          target: 'browser-catalog-' + suffix,
          expected_version: 0,
          input: {
            name: 'Catalog project ' + suffix,
            objective: 'Authorized catalog pagination fixture',
          },
        },
      },
    );
    assert.equal(result.status(), 200, 'owned fixture project seed');
    assert.equal((await result.json()).status, 'APPLIED');
  }
  const before = (await readApi('work?id=t-ledger-uncertain')).items[0];
  assert.equal(before.fields.operations[0].state, 'UNKNOWN');
  await go('work', before.id);
  await page
    .getByRole('button', { name: 'Link work to project', exact: true })
    .click();
  const form = page.getByRole('form', {
    name: 'Link existing work to a project',
    exact: true,
  });
  await form
    .getByLabel('Search projects', { exact: true })
    .fill('Authorized catalog pagination fixture');
  await form
    .getByRole('button', { name: 'Search projects', exact: true })
    .click();
  await form
    .getByText(/60 project choices on this server-scoped first page/)
    .waitFor();
  assert.equal(
    await form.getByRole('option', { name: /Catalog project 063/ }).count(),
    0,
  );
  await form
    .getByRole('button', { name: 'Load more project choices', exact: true })
    .click();
  await form
    .getByText(/64 unique project choices loaded across 2 server-scoped pages/)
    .waitFor();
  await form
    .getByRole('combobox', { name: 'Project from server results', exact: true })
    .selectOption('browser-catalog-063');
  await form
    .getByRole('button', { name: 'Submit project link request', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Project link recorded' })
    .waitFor();
  const after = (await readApi('work?id=t-ledger-uncertain')).items[0];
  assert.equal(after.fields.project, 'browser-catalog-063');
  assert.equal(
    after.fields.coordinationRevision,
    before.fields.coordinationRevision + 1,
  );
  assert.equal(after.version, before.version);
  assert.equal(after.status, before.status);
  const {
    project: beforeProject,
    coordinationRevision: beforeRevision,
    ...beforeFacts
  } = before.fields;
  const {
    project: afterProject,
    coordinationRevision: afterRevision,
    ...afterFacts
  } = after.fields;
  assert.deepEqual(afterFacts, beforeFacts);
  assert.equal(after.fields.operations[0].state, 'UNKNOWN');
});
test('J local appearance preserves the open profile draft and commands while forms reflow and pass automated axe checks', async () => {
  await go('agents');
  await page.getByRole('button', { name: 'New VERA', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Unsaved appearance draft');
  const commandsBefore = requests.filter(
    (request) =>
      request.method === 'POST' && request.path === '/api/continuum/v1/command',
  ).length;
  const findings: Record<string, unknown> = {};
  for (const appearance of ['light', 'dark', 'system']) {
    await page
      .getByLabel('Appearance', { exact: true })
      .selectOption(appearance);
    assert.equal(
      await page.locator('.console').getAttribute('data-appearance'),
      appearance,
    );
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Name', exact: true })
        .inputValue(),
      'Unsaved appearance draft',
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'Record VERA profile', exact: true })
        .isEnabled(),
      true,
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(
        (await page.evaluate(() => document.documentElement.scrollWidth)) <=
          width + 1,
        appearance + ' form overflows ' + width,
      );
    }
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    findings[appearance] = {
      violations: axe.violations,
      passes: axe.passes.map((pass) => pass.id),
    };
    assert.equal(axe.violations.length, 0, appearance + ' profile form axe');
    if (appearance !== 'system')
      await page.screenshot({
        path: dir + '/PROFILE-FORM-' + appearance.toUpperCase() + '.png',
        fullPage: true,
      });
  }
  await fs.writeFile(
    dir + '/AXE-PROFILE-THEMES.json',
    JSON.stringify(findings, null, 2),
  );
  assert.equal(
    requests.filter(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/continuum/v1/command',
    ).length,
    commandsBefore,
  );
  await page.getByRole('textbox', { name: 'Name', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Description', exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
});
test('J read-only Work map uses the authorized filtered page, preserves UNKNOWN and supports keyboard/theme/reflow navigation', async () => {
  const wire = (await readApi('work?id=t-ledger-uncertain')).items[0];
  const operation = wire.fields.operations[0];
  assert.equal(operation.state, 'UNKNOWN');
  const commandsBefore = requests.filter(
    (request) =>
      request.method === 'POST' && request.path === '/api/continuum/v1/command',
  ).length;
  await go('work');
  await page
    .getByLabel('Search authorized Work', { exact: true })
    .fill(wire.id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('q') === wire.id);
  await page.getByRole('button', { name: 'All work', exact: true }).click();
  const mapButton = page.getByRole('button', { name: 'Map', exact: true });
  await mapButton.focus();
  await page.keyboard.press('Enter');
  const map = page.getByRole('region', {
    name: 'Work relationships',
    exact: true,
  });
  const task = map.getByRole('article', {
    name: 'Task ' + wire.id,
    exact: true,
  });
  await task.waitFor({ state: 'visible' });
  assert.equal(await mapButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await map.getByRole('article').count(), 1);
  assert.ok((await task.innerText()).includes('Wire state: UNKNOWN'));
  assert.equal(
    await task.getByText('Verified fixture result', { exact: true }).count(),
    0,
  );
  assert.equal(
    await task
      .getByRole('link', {
        name: 'Inspect operation ' + operation.id,
        exact: true,
      })
      .getAttribute('href'),
    '/console/evidence?selected=' +
      encodeURIComponent('operation:' + operation.id),
  );
  const findings: Record<string, unknown> = {};
  for (const appearance of ['light', 'dark', 'system']) {
    await page
      .getByLabel('Appearance', { exact: true })
      .selectOption(appearance);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(
        (await page.evaluate(() => document.documentElement.scrollWidth)) <=
          width + 1,
        appearance + ' Work map overflows ' + width,
      );
    }
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    findings[appearance] = {
      violations: axe.violations,
      passes: axe.passes.map((pass) => pass.id),
    };
    assert.equal(axe.violations.length, 0, appearance + ' Work map axe');
  }
  await fs.writeFile(
    dir + '/AXE-WORK-MAP-THEMES.json',
    JSON.stringify(findings, null, 2),
  );
  await page.screenshot({ path: dir + '/WORK-MAP-MOBILE.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'List', exact: true }).click();
  assert.equal(
    await page
      .getByRole('heading', { name: 'Work relationships', exact: true })
      .count(),
    0,
  );
  await mapButton.click();
  const inspectTask = task.getByRole('button', {
    name: wire.title + ' · Inspect task ' + wire.id,
    exact: true,
  });
  await inspectTask.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(
    (url) =>
      url.searchParams.get('selected') === 'task:' + wire.id &&
      url.searchParams.get('q') === wire.id,
  );
  await page.locator('.inspector-heading h2').waitFor({ state: 'visible' });
  assert.equal(
    requests.filter(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/continuum/v1/command',
    ).length,
    commandsBefore,
  );
  assert.deepEqual(
    (await readApi('work?id=' + wire.id)).items[0].fields,
    wire.fields,
  );
});
test('A07/A08/A10/A14/A15/A19/A26/A33/A35/A37 every major read surface uses authenticated backend facts', async () => {
  await go('work');
  assert.equal(
    await page.getByRole('list', { name: 'How to start working' }).isVisible(),
    false,
  );
  await page
    .getByText('New here? See the three-step setup', { exact: true })
    .click();
  assert.equal(
    await page.getByRole('list', { name: 'How to start working' }).isVisible(),
    true,
  );
  const advancedSummary = page.locator(
    '.sidebar .advanced-navigation > summary',
  );
  await advancedSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await page
      .locator('.sidebar .advanced-navigation')
      .evaluate((el) => (el as HTMLDetailsElement).open),
    true,
  );
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('href')),
    '/console/evidence',
  );
  assert.equal(
    await page.locator('.sidebar [aria-label="Everyday work"] a').count(),
    5,
  );
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Evidence', exact: true }).waitFor();

  for (const section of [
    'projects',
    'governance',
    'agents',
    'computers',
    'authority',
    'context',
    'evidence',
    'recovery',
    'integrations',
    'incidents',
    'notifications',
    'usage',
    'security',
    'settings',
    'setup',
  ]) {
    await go(section);
    assert.equal(await page.locator('.degraded-banner').count(), 0);
  }
  const usage = await readApi('usage');
  assert.equal(usage.items[0].fields.unit, 'test units');
  assert.equal(
    usage.items[0].fields.measuredMoneySpent,
    'unknown — no billing meter',
  );
  const contextData = await readApi('context');
  assert.equal(
    contextData.items[0].fields.authority,
    'Context is data, never a grant',
  );
});
test('A22/A31 UNKNOWN detail has no resend/retry/regrant or browser controller action', async () => {
  await go('recovery', 'ledger-uncertain');
  assert.ok(
    (await page.locator('.inspector').innerText()).includes(
      'Outcome uncertain',
    ),
  );
  for (const label of [/^Retry$/i, /^Resend$/i, /^Resume$/i, /^Regrant$/i])
    assert.equal(await page.getByRole('button', { name: label }).count(), 0);
  for (const target of ['dispatch', 'reconcile', 'renew']) {
    const r = await context.request.post(
      origin + '/api/continuum/v1/' + target,
      { data: {} },
    );
    assert.equal(r.status(), 404);
  }
  assert.equal(
    (
      await fetch('http://127.0.0.1:' + apiPort + '/__fixture/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant: 'a' }),
      })
    ).status,
    404,
  );
});
test('A21/A30/A40 revocation confirmation traps/returns focus and never says all effects stopped', async () => {
  await go('authority', 'g-ledger-uncertain');
  await page.getByRole('button', { name: 'Revoke grant', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    'Keep grant',
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'revoke-button',
  );
  await page.getByRole('button', { name: 'Revoke grant', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm revocation', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: 'Grant revoked' }).waitFor();
  assert.ok(
    (await page.locator('.command-status').innerText()).includes(
      'may still finish',
    ),
  );
  await go('recovery', 'ledger-uncertain');
  assert.ok(
    (await page.locator('.inspector').innerText()).includes(
      'Outcome uncertain',
    ),
  );
});
test('A32/A34 incident acknowledgement and notification read do not resolve UNKNOWN', async () => {
  await go('incidents', 'unknown-ledger');
  await page
    .getByRole('button', { name: 'Acknowledge incident', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: 'not resolved' }).waitFor();
  await go('notifications', 'ledger-notice');
  await page
    .getByRole('button', { name: 'Mark notification read', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'incident remains unchanged' })
    .waitFor();
  assert.equal(
    (await readApi('incidents?id=unknown-ledger')).items[0].status,
    'ACKNOWLEDGED',
  );
  assert.equal(
    (await readApi('recovery?id=ledger-uncertain')).items[0].status,
    'Outcome uncertain',
  );
});
test('A25 authorized selected-page export preserves partial/provenance markers', async () => {
  await go('evidence');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('button', { name: 'Export this authorized page', exact: true })
      .click(),
  ]);
  const p = await download.path();
  assert.ok(p);
  const data = JSON.parse(await fs.readFile(p!, 'utf8'));
  assert.equal(data.completeness, 'partial');
  assert.equal(data.scope, 'AUTHORIZED_SELECTED_PAGE');
  assert.ok(!JSON.stringify(data).includes('Bearer '));
});
test('A01/A39 wrong origin, missing CSRF and caller-supplied tenant never authorize a command', async () => {
  const r = await context.request.post(origin + '/api/continuum/v1/command', {
    headers: { origin: 'https://untrusted.invalid' },
    data: { schema_version: 1, kind: 'create_task' },
  });
  assert.equal(r.status(), 403);
  const missing = await context.request.post(
    origin + '/api/continuum/v1/command',
    { headers: { origin }, data: {} },
  );
  assert.equal(missing.status(), 403);
});
test('A39 offline snapshot disables commands and never implies empty/all-clear', async () => {
  await go('work');
  await context.setOffline(true);
  await page.getByRole('alert').filter({ hasText: 'Offline' }).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'New task', exact: true })
      .isEnabled(),
    false,
  );
  assert.equal(await page.getByText('All clear', { exact: true }).count(), 0);
  await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.degraded-banner'));
  assert.equal(
    await page
      .getByRole('button', { name: 'New task', exact: true })
      .isEnabled(),
    true,
  );
});
test('A39 unknown response schema fails closed rather than enabling stale controls', async () => {
  await context.route('**/api/continuum/v1/focus*', async (route) => {
    const original = await route.fetch();
    const data = await original.json();
    data.schema_version = 99;
    await route.fulfill({ response: original, json: data });
  });
  await page.getByRole('button', { name: /^Refresh order/ }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'unknown response schema' })
    .waitFor();
  await page.waitForTimeout(700);
  assert.equal(
    await page
      .getByRole('button', { name: 'New task', exact: true })
      .isEnabled(),
    false,
  );
  await context.unroute('**/api/continuum/v1/focus*');
  await page
    .getByRole('button', { name: 'Refresh authorized snapshot', exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector('.degraded-banner'));
});
test('A38/A40 keyboard landmarks, responsive list/detail and no horizontal approval overflow', async () => {
  await go('approvals', 'draft-summary');
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const dimension = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
    }));
    assert.ok(
      dimension.scroll <= dimension.width + 1,
      JSON.stringify({ viewportWidth: width, ...dimension }),
    );
    assert.ok(
      await page
        .getByRole('button', { name: 'Approve exact action', exact: true })
        .isVisible(),
    );
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.getByRole('button', { name: 'Back to Approvals' }).click();
  await page.waitForURL((u) => !u.searchParams.has('selected'));
  await page.locator('.record').first().waitFor({ state: 'visible' });
  await page.locator('.record').first().click();
  await page.locator('.inspector-heading').waitFor({ state: 'visible' });
  await page.screenshot({
    path: dir + '/FOCUS-DESK-MOBILE.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Tab');
  assert.ok(
    await page.evaluate(() => document.activeElement !== document.body),
  );
});
test('A40 200% text enlargement and 400%-equivalent 320-CSS-px reflow keep exact review usable', async () => {
  await go('approvals', 'draft-summary');
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.addStyleTag({ content: 'html{font-size:200%!important}' });
  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 768,
  );
  await page.reload();
  await page.setViewportSize({ width: 320, height: 1000 });
  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 320,
  );
  await page
    .getByRole('button', { name: 'Approve exact action', exact: true })
    .waitFor();
  await fs.writeFile(
    dir + '/ZOOM-METHOD.json',
    JSON.stringify(
      {
        text200: 'Actual browser root text enlarged to 200%',
        zoom400:
          '320 CSS px reflow equivalent to 1280px desktop at 400%; not manual browser-chrome/assistive-tech certification',
        nativeScreenReader: 'NOT RUN',
      },
      null,
      2,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
});
test('A40 axe WCAG 2.2 AA automated checks and actual keyboard/ARIA snapshot', async () => {
  await go('work');
  const work = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await fs.writeFile(
    dir + '/AXE-WORK.json',
    JSON.stringify(
      { violations: work.violations, passes: work.passes.map((x) => x.id) },
      null,
      2,
    ),
  );
  assert.equal(
    work.violations.length,
    0,
    work.violations
      .map(
        (x) => x.id + ': ' + x.nodes.map((n) => n.target.join(' ')).join(','),
      )
      .join('\n'),
  );
  await go('approvals', 'draft-summary');
  const review = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await fs.writeFile(
    dir + '/AXE-APPROVAL.json',
    JSON.stringify(
      { violations: review.violations, passes: review.passes.map((x) => x.id) },
      null,
      2,
    ),
  );
  assert.equal(
    review.violations.length,
    0,
    review.violations.map((x) => x.id).join(','),
  );
  await fs.writeFile(
    dir + '/ARIA-REVIEW.yaml',
    await page.locator('body').ariaSnapshot(),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page.evaluate(
      () => matchMedia('(prefers-reduced-motion:reduce)').matches,
    ),
    true,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
test('A01 two tabs/account switch clear prior tenant data; second workspace cannot read first records', async () => {
  const other = await context.newPage();
  await other.goto(origin + '/console/work');
  await other.locator('.record').first().waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/sign-in');
  await other
    .getByRole('alert')
    .filter({ hasText: 'Session expired or changed' })
    .waitFor();
  assert.equal(await other.locator('.record').count(), 0);
  await login(page, 'b');
  const b = await readApi('work');
  assert.equal(b.session.tenant, 'b');
  assert.equal(b.items.length, 0);
  assert.equal(
    (
      await context.request.get(
        origin + '/api/continuum/v1/work?id=t-review-vendor',
      )
    ).status(),
    200,
  );
  assert.equal(
    await page
      .getByText('Review the vendor statement', { exact: true })
      .count(),
    0,
  );
  await other.close();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/sign-in');
  await login(page);
});
test('Performance: 10,000 durable fixture tasks stay paginated and DOM-bounded; latency is measured', async () => {
  execFileSync(
    'psql',
    [
      '-d',
      'ct_console_browser',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "INSERT INTO ct.tasks(tenant,id,principal,objective,deadline,created_by,organization,mandate,mandate_version) SELECT 'a','bulk-'||lpad(n::text,5,'0'),'p-focus','Volume fixture task '||n,now()+interval '1 hour','focus-owner-a','focus-org','focus-mandate',1 FROM generate_series(1,10000) n",
    ],
    {
      env: {
        ...process.env,
        PGHOST: '127.0.0.1',
        PGPORT: '55432',
        PGUSER: 'localtest',
      },
      stdio: 'ignore',
    },
  );
  const samples: number[] = [];
  for (let n = 0; n < 12; n++) {
    const start = performance.now();
    const data = await readApi('work');
    samples.push(performance.now() - start);
    assert.equal(data.items.length, 60);
    assert.ok(data.total >= 10000);
    assert.ok(data.cursor);
  }
  await go('work');
  await page.getByRole('button', { name: 'All work', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.record-reason')?.textContent?.includes('p-focus'),
  );
  assert.ok((await page.locator('.record').count()) <= 60);
  const sorted = [...samples].sort((a, b) => a - b),
    p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  metrics.push({
    dataset: 10000,
    scope: 'LOCAL_FIXTURE',
    metric: 'authenticated BFF + domain page read',
    samplesMs: samples,
    p95Ms: p95,
    targetMs: 1500,
    domRows: await page.locator('.record').count(),
    pollingMs: 10000,
  });
  assert.ok(p95 < 1500, 'Measured local p95 exceeds the stated fixture budget');
  const focus = await readApi('focus');
  assert.equal(focus.completeness, 'partial');
  assert.ok(focus.items.some((x: any) => x.fields.cause === 'LOST_ACK'));
});
