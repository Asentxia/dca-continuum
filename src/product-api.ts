import { readJsonBody } from './bounded-body.js';
import { RequestBudget } from './operational-controls.js';
import http from 'node:http';
import type { VerifiedIdentity } from './identity-provider.js';
import type { ProductService } from './product-service.js';
export interface ActorVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}
export function productApi(verifier: ActorVerifier, service: ProductService) {
  const budget = new RequestBudget(60);
  const routes: Record<string, string[]> = {
    '/tasks': [
      'id',
      'principal',
      'objective',
      'deadline',
      'organization',
      'mandate',
      'mandateVersion',
    ],
    '/operations': [
      'id',
      'task',
      'grant',
      'provider',
      'action',
      'resource',
      'params',
      'cost',
      'deadline',
    ],
    '/task-status': ['task'],
    '/list-tasks': [],
    '/cancel-task': ['task', 'revision'],
    '/disable-machine': ['identity'],
  };
  const s = http.createServer(async (req, res) => {
    try {
      if (
        req.method !== 'POST' ||
        !req.headers['content-type']?.startsWith('application/json')
      )
        throw Error('JSON POST required');
      const token = req.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
      if (!token) throw Error('identity required');
      const actor = await verifier.verify(token);
      budget.take(actor.issuer + '|' + actor.subject);
      const x = await readJsonBody(req, 32768),
        keys = routes[req.url ?? ''];
      const optional = req.url === '/operations' ? ['context', 'tool'] : [];
      const present =
        x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : [];
      if (
        !keys ||
        !x ||
        typeof x !== 'object' ||
        Array.isArray(x) ||
        keys.some((k) => !present.includes(k)) ||
        present.some((k) => !keys.includes(k) && !optional.includes(k))
      )
        throw Error('request schema');
      for (const k of keys)
        if (
          k !== 'params' &&
          (k === 'cost' || k === 'revision' || k === 'mandateVersion'
            ? !Number.isSafeInteger(x[k])
            : typeof x[k] !== 'string')
        )
          throw Error('field type');
      if (present.includes('context') && typeof x.context !== 'string')
        throw Error('field type');
      if (present.includes('tool') && typeof x.tool !== 'string')
        throw Error('field type');
      let r: unknown;
      switch (req.url) {
        case '/tasks':
          r = await service.createTask(actor, x);
          break;
        case '/operations':
          r = await service.propose(actor, x);
          break;
        case '/task-status':
          r = await service.status(actor, x.task);
          break;
        case '/list-tasks':
          r = await service.list(actor);
          break;
        case '/cancel-task':
          r = await service.cancel(actor, x.task, x.revision);
          break;
        case '/disable-machine':
          r = await service.disableMachine(actor, x.identity);
          break;
        default:
          throw Error('route');
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(r));
    } catch {
      res.writeHead(403, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end('{"error":"request or authority denied"}');
    }
  });
  s.requestTimeout = 10000;
  s.headersTimeout = 10000;
  s.maxHeadersCount = 32;
  return s;
}
