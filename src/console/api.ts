import { readJsonBody } from '../bounded-body.js';
import { assertLocalFixtures } from '../runtime-profile.js';
import http from 'node:http';
import type { IdentityVerifier } from '../identity-provider.js';
import type { ConsoleReads } from './reads.js';
import type { ConsoleCommands } from './commands.js';
export function consoleApi(
  verifier: IdentityVerifier,
  reads: ConsoleReads,
  commands: ConsoleCommands,
  options: {
    fixtureLogin?: (tenant: string) => Promise<string>;
    fixtureServerKey?: string;
  } = {},
) {
  if (options.fixtureLogin || options.fixtureServerKey) {
    assertLocalFixtures('fixture domain login');
    if (!options.fixtureLogin || !options.fixtureServerKey)
      throw Error('Complete local fixture injection required');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (path.pathname === '/__fixture/login' && req.method === 'POST') {
        if (
          !options.fixtureLogin ||
          !options.fixtureServerKey ||
          req.headers['x-fixture-server-key'] !== options.fixtureServerKey
        )
          return send(404, { error: 'Unavailable' });
        const input = await body(req);
        if (
          !input ||
          Object.keys(input).join(',') !== 'tenant' ||
          !['a', 'b'].includes(input.tenant)
        )
          return send(422, { error: 'Invalid test workspace' });
        return send(200, { token: await options.fixtureLogin(input.tenant) });
      }
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer '))
        return send(401, { error: 'Sign-in required' });
      let actor;
      try {
        actor = await verifier.verify(header.slice(7));
      } catch {
        return send(401, { error: 'Sign-in required' });
      }
      if (req.method === 'GET' && path.pathname === '/read')
        return send(
          200,
          await reads.read(actor, path.searchParams.get('section') ?? 'work', {
            id: path.searchParams.get('id') ?? undefined,
            q: path.searchParams.get('q') ?? undefined,
            cursor: path.searchParams.get('cursor') ?? undefined,
          }),
        );
      if (req.method === 'GET' && path.pathname === '/command')
        return send(
          200,
          await commands.lookup(actor, path.searchParams.get('key') ?? ''),
        );
      if (req.method === 'POST' && path.pathname === '/command') {
        if (req.headers['content-type'] !== 'application/json')
          return send(422, { error: 'JSON required' });
        const result = await commands.execute(actor, await body(req));
        return send(result.status === 'DENIED' ? 409 : 200, result);
      }
      return send(404, {
        error: 'Unavailable; no dispatch/reconcile/renew route',
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      send(
        message.includes('cursor') || message.includes('conflict')
          ? 409
          : message.includes('qualification')
            ? 503
            : 403,
        {
          error: 'Request denied or stale',
          code: 'DENIED_OR_STALE',
          effectOutcome: 'not inferred',
        },
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  return server;
}
async function body(req: http.IncomingMessage) {
  return readJsonBody(req, 32768);
}
