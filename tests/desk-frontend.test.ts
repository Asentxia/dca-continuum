import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type http from 'node:http';
import { fixture } from './implementation-helpers.js';
import { admin, gov } from './helpers.js';
import { pool } from '../src/db.js';
import { ContextService } from '../src/context-service.js';
import { deskServer } from '../internal/operator/server.js';
let f: Awaited<ReturnType<typeof fixture>>,
  server: http.Server,
  browser: Browser,
  page: Page,
  origin = '',
  op: any;
const contextDb = pool('ct_context_service');
before(async () => {
  f = await fixture('desk');
  op = await f.intent('desk-exact-action');
  await f.product.createTask(await f.actor('machine'), {
    id: 'desk-xss',
    principal: f.principal,
    objective: '<img src=x onerror="window.pwned=true">',
    deadline: op.x.deadline,
    ...f.admission.a,
  });
  const unknown = await f.intent('desk-unknown', true);
  f.provider.loseAck = true;
  await f.controller.dispatch(await f.capability(unknown.x.id), unknown.x.id);
  f.provider.loseAck = false;
  server = deskServer(
    {
      mode: 'fixture',
      origin: () => origin,
      fixtureActor: () => f.actor('user'),
      assets: path.resolve('internal/operator/ui'),
    },
    f.product,
    f.authority,
    new ContextService(contextDb),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  browser = await chromium.launch({
    executablePath: process.env.CT_CHROMIUM_PATH ?? '/usr/local/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const b = await browser.newContext({
    viewport: { width: 1440, height: 1160 },
  });
  await b.request.post(origin + '/__fixture-session', { headers: { origin } });
  page = await b.newPage();
  await page.goto(origin);
  await page.waitForSelector('[data-task="t-desk-exact-action"]');
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (f) await f.close();
  await Promise.all([contextDb.end(), admin.end(), gov.end()]);
});
test('Desk displays blocked live gates and no credential fields', async () => {
  assert.ok(
    (await page.locator('body').innerText()).includes(
      'Live sign-in tests: NOT RUN',
    ),
  );
  assert.ok(
    (await page.locator('body').innerText()).includes('BLOCKED / NO-GO'),
  );
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
});
test('Desk exact-action approval uses real backend; approval is not execution', async () => {
  await page.locator('[data-task="t-desk-exact-action"]').click();
  await page.waitForFunction(
    () => document.getElementById('phase')?.textContent === 'AWAITING_APPROVAL',
  );
  await page.locator('[data-operation="desk-exact-action"]').click();
  await page.waitForFunction(() =>
    document
      .getElementById('operations')
      ?.textContent?.includes('Independent approval recorded'),
  );
  assert.equal(
    f.provider.rows.filter((x) => x.operation === op.x.id).length,
    0,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT digest FROM ct.approvals WHERE tenant='a' AND operation=$1",
        [op.x.id],
      )
    ).rows[0].digest,
    op.op.digest,
  );
  await f.controller.dispatch(await f.capability(op.x.id), op.x.id);
  await page.locator('#refresh').click();
  await page.waitForFunction(
    () => document.getElementById('phase')?.textContent === 'VERIFIED_COMPLETE',
  );
});
test('Desk UNKNOWN is honest and has no resend action', async () => {
  await page.locator('[data-task="t-desk-unknown"]').click();
  await page.waitForFunction(() =>
    document
      .getElementById('operations')
      ?.textContent?.includes('Maybe happened. Do not resend.'),
  );
  assert.equal(await page.getByRole('button', { name: /resend/i }).count(), 0);
});
test('Desk renders hostile context as text, not executable HTML', async () => {
  await page.locator('[data-task="desk-xss"]').click();
  await page.waitForFunction(() =>
    document.getElementById('objective')?.textContent?.includes('<img'),
  );
  assert.equal(await page.locator('#objective img').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
});
test('Desk prevents cross-origin/CSRF and production fixture-route activation', async () => {
  const cookie = (await page.context().cookies())[0];
  const r = await fetch(origin + '/api/cancel', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookie.name + '=' + cookie.value,
      origin: 'https://evil.invalid',
    },
    body: JSON.stringify({ task: op.x.task, revision: 1 }),
  });
  assert.equal(r.status, 403);
  assert.throws(() =>
    deskServer(
      {
        mode: 'approved-staging',
        origin: () => 'https://stage.invalid',
        approvalReference: 'not-enough',
        fixtureActor: () => f.actor('user'),
        assets: path.resolve('internal/operator/ui'),
      },
      f.product,
      f.authority,
    ),
  );
  const s = await fetch(origin);
  assert.ok(
    s.headers
      .get('content-security-policy')
      ?.includes("frame-ancestors 'none'"),
  );
});
test('Desk screenshot and narrow fixture UI evidence preserved', async () => {
  await page.locator('[data-task="t-desk-exact-action"]').click();
  await page.screenshot({
    path: '.artifacts/implementation/OPERATOR-DESK.png',
    fullPage: true,
  });
  assert.equal(await page.locator('#mode').innerText(), 'LOCAL TEST FIXTURE');
});
