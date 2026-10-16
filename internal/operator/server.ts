import { assertLocalFixtures } from '../../src/runtime-profile.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { VerifiedIdentity } from '../../src/identity-provider.js';
import type { ProductService } from '../../src/product-service.js';
import type { AuthorityService } from '../../src/authority-service.js';
import type { ContextService } from '../../src/context-service.js';
export interface DeskAuthentication {
  actor: VerifiedIdentity;
  csrf: string;
}
export interface DeskConfig {
  mode: 'fixture' | 'approved-staging';
  origin: () => string;
  approvalReference?: string;
  authenticate?: (req: http.IncomingMessage) => Promise<DeskAuthentication>;
  fixtureActor?: () => Promise<VerifiedIdentity>;
  assets: string;
}
export function deskServer(
  config: DeskConfig,
  product: ProductService,
  authority: AuthorityService,
  context?: ContextService,
) {
  if (
    config.mode === 'approved-staging' &&
    (!config.approvalReference || !config.authenticate || config.fixtureActor)
  )
    throw Error('approved staging authentication bridge required');
  if (config.mode !== 'fixture')
    throw Error(
      'Legacy operator UI is internal/test-only; use canonical Focus Desk.',
    );
  assertLocalFixtures('internal operator fixture');
  const sessions = new Map<string, { expires: number; csrf: string }>();
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
  const server = http.createServer(async (req, res) => {
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    try {
      const origin = config.origin(),
        u = new URL(origin);
      if (
        req.headers.host !== u.host ||
        (config.mode === 'fixture' && u.hostname !== '127.0.0.1') ||
        (config.mode === 'approved-staging' && u.protocol !== 'https:')
      )
        throw Error('origin policy');
      if (req.method === 'POST' && req.headers.origin !== origin)
        throw Error('same-origin required');
      if (req.url === '/__fixture-session' && req.method === 'POST') {
        if (config.mode !== 'fixture' || !config.fixtureActor)
          throw Error('fixture route disabled');
        const sid = randomBytes(32).toString('hex');
        for (const [id, v] of sessions)
          if (v.expires <= Date.now()) sessions.delete(id);
        if (sessions.size >= 100) throw Error('fixture session limit');
        sessions.set(sid, {
          expires: Date.now() + 1200000,
          csrf: randomBytes(24).toString('hex'),
        });
        res.setHeader(
          'set-cookie',
          `ct_fixture=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1200`,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"mode":"fixture"}');
        return;
      }
      const assets: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/desk.js': ['desk.js', 'text/javascript; charset=utf-8'],
        '/desk.css': ['desk.css', 'text/css; charset=utf-8'],
      };
      if (req.method === 'GET' && assets[req.url ?? '']) {
        const [file, type] = assets[req.url!];
        res.writeHead(200, { 'content-type': type });
        res.end(await fs.readFile(path.join(config.assets, file)));
        return;
      }
      let session: DeskAuthentication;
      if (config.mode === 'fixture') {
        const id = req.headers.cookie?.match(
            /(?:^|;\s*)ct_fixture=([a-f0-9]{64})(?:;|$)/,
          )?.[1],
          s = id ? sessions.get(id) : undefined;
        if (!s || s.expires <= Date.now() || !config.fixtureActor)
          throw Error('fixture session required');
        session = { actor: await config.fixtureActor(), csrf: s.csrf };
      } else session = await config.authenticate!(req);
      if (req.url === '/api/session' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            csrf: session.csrf,
            mode: config.mode,
            production: 'BLOCKED',
            P1: 'PARTIAL',
            liveIdentity: 'NOT RUN',
            scheduler: 'HELD',
            canary: 'NO-GO',
          }),
        );
        return;
      }
      if (
        req.method !== 'POST' ||
        req.headers['content-type'] !== 'application/json'
      )
        throw Error('JSON POST');
      const csrf = String(req.headers['x-ct-csrf'] ?? '');
      if (
        csrf.length !== session.csrf.length ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      )
        throw Error('CSRF');
      let raw = '';
      for await (const b of req) {
        raw += b;
        if (Buffer.byteLength(raw) > 32768) throw Error('body limit');
      }
      const x = JSON.parse(raw),
        schemas: Record<string, string[]> = {
          '/api/tasks': [],
          '/api/task': ['id'],
          '/api/approve': ['operation', 'digest', 'expires'],
          '/api/cancel': ['task', 'revision'],
          '/api/context': ['id'],
          '/api/context-review': ['id', 'version', 'digest'],
        };
      const keys = schemas[req.url ?? ''];
      if (
        !keys ||
        !x ||
        typeof x !== 'object' ||
        Array.isArray(x) ||
        Object.keys(x).sort().join(',') !== keys.sort().join(',')
      )
        throw Error('request schema');
      for (const k of keys)
        if (
          ['version', 'revision'].includes(k)
            ? !Number.isSafeInteger(x[k])
            : typeof x[k] !== 'string'
        )
          throw Error('field type');
      let result: unknown;
      switch (req.url) {
        case '/api/tasks':
          result = await product.list(session.actor);
          break;
        case '/api/task':
          result = await product.status(session.actor, x.id);
          break;
        case '/api/approve':
          result = await authority.approve(session.actor, x);
          break;
        case '/api/cancel':
          result = await product.cancel(session.actor, x.task, x.revision);
          break;
        case '/api/context':
          if (!context) throw Error('context not configured');
          result = await context.inspectQuarantine(session.actor, x.id);
          break;
        case '/api/context-review':
          if (!context) throw Error('context not configured');
          result = await context.approve(
            session.actor,
            x.id,
            x.version,
            x.digest,
          );
          break;
        default:
          throw Error('route');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"request, identity or authority denied"}');
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  return server;
}
