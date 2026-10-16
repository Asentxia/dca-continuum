// Synthetic CI capability probe only: no product, database, model or provider call.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  response.end('continuum-ci-local-only');
});
let browser;
let context;
const report = { scope: 'synthetic CI capability only; not product acceptance' };
try {
  report.externalConnectionDenied = await new Promise((resolve, reject) => {
    const connection = net.connect({ host: '1.1.1.1', port: 443 });
    connection.setTimeout(1000);
    connection.once('connect', () => { connection.destroy(); reject(new Error('External connection unexpectedly succeeded')); });
    connection.once('error', () => { connection.destroy(); resolve(true); });
    connection.once('timeout', () => { connection.destroy(); resolve(true); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.CT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    window.networkEvents = { online: 0, offline: 0 };
    for (const name of ['online', 'offline']) addEventListener(name, () => { window.networkEvents[name] += 1; });
  });
  const state = () => page.evaluate(async () => ({
    online: navigator.onLine, events: { ...window.networkEvents },
    fetch: await fetch('/', { cache: 'no-store', signal: AbortSignal.timeout(2000) }).then((r) => r.status).catch(() => 'denied'),
  }));
  report.initial = await state();
  assert.equal(report.initial.online, true);
  assert.equal(report.initial.fetch, 200);
  try {
    await context.setOffline(true);
    await delay(300);
    report.offline = await state();
    assert.equal(report.offline.online, false);
    assert.equal(report.offline.fetch, 'denied');
    assert.equal(report.offline.events.offline, 1);
  } finally {
    await context.setOffline(false);
    await delay(300);
    report.restored = await state();
    assert.equal(report.restored.online, true);
    assert.equal(report.restored.fetch, 200);
    assert.equal(report.restored.events.online, 1);
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = String(error?.message ?? error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify(report, null, 2));
}
