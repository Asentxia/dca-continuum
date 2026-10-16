import { assertLocalFixtures } from './runtime-profile.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import { verifyCapability } from './capability.js';
import type { EffectController } from './controller.js';
export async function serveController(
  socket: string,
  secret:
    | string
    | { verify(token: string): Promise<import('./capability.js').Capability> },
  controller: EffectController,
) {
  const localHmac = typeof secret === 'string';
  if (localHmac) assertLocalFixtures('HMAC controller fixture');
  await fs.rm(socket, { force: true });
  const server = http.createServer(async (req, res) => {
    try {
      if (
        req.method !== 'POST' ||
        !['/dispatch', '/reconcile'].includes(req.url ?? '')
      )
        throw Error('unsupported route');
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const actor =
        typeof secret === 'string'
          ? verifyCapability(secret, token)
          : await secret.verify(token);
      let text = '';
      for await (const part of req) {
        text += part;
        if (Buffer.byteLength(text) > 4096) throw Error('oversized request');
      }
      const x = JSON.parse(text);
      if (
        !x ||
        Object.keys(x).length !== 1 ||
        typeof x.operation !== 'string' ||
        !actor.operations.includes(x.operation)
      )
        throw Error('only scoped operation reference allowed');
      const o =
        req.url === '/dispatch'
          ? await controller.dispatch(actor, x.operation)
          : await controller.reconcile(actor, x.operation);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: o.state, id: o.id, version: o.version }));
    } catch (e) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'capability, request or authority denied' }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, localHmac ? 0o666 : 0o600);
  return server;
}
