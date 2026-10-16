import { readJsonBody } from './bounded-body.js';
import { RequestBudget } from './operational-controls.js';
import http from 'node:http';
import type { IdentityVerifier } from './identity-provider.js';
import type { AuthorityService } from './authority-service.js';
export function identityApi(
  verifier: IdentityVerifier,
  service: AuthorityService,
) {
  const budget = new RequestBudget(60);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') throw Error('POST required');
      const bearer = req.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
      if (!bearer) throw Error('identity required');
      const actor = await verifier.verify(bearer);
      budget.take(actor.issuer + '|' + actor.subject);
      const x = await readJsonBody(req, 16384);
      if (!x || typeof x !== 'object' || Array.isArray(x))
        throw Error('object required');
      const schemas: Record<string, string[]> = {
        '/grants': [
          'id',
          'principal',
          'action',
          'resource',
          'expires',
          'maxCost',
          'budget',
        ],
        '/approvals': ['operation', 'digest', 'expires'],
        '/assignments': ['identity', 'operation', 'expires'],
        '/revoke': ['grant'],
        '/renew': ['operation'],
      };
      const keys = schemas[req.url ?? ''];
      if (
        !keys ||
        Object.keys(x).length !== keys.length ||
        Object.keys(x).some((k) => !keys.includes(k))
      )
        throw Error('unknown/missing fields');
      for (const k of keys)
        if (
          ['maxCost', 'budget'].includes(k)
            ? !Number.isSafeInteger(x[k])
            : typeof x[k] !== 'string'
        )
          throw Error('field type');
      let r: unknown;
      switch (req.url) {
        case '/grants':
          r = await service.createGrant(actor, x);
          break;
        case '/approvals':
          r = await service.approve(actor, x);
          break;
        case '/assignments':
          r = await service.assign(actor, x);
          break;
        case '/revoke':
          r = await service.revoke(actor, x.grant);
          break;
        case '/renew':
          r = await service.renew(actor, x.operation);
          break;
        default:
          throw Error('route');
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(r));
    } catch {
      res.writeHead(403, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end('{"error":"identity or authority denied"}');
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  return server;
}
