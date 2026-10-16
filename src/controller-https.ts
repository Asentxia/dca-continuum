import https from 'node:https';
import { readJsonBody } from './bounded-body.js';
import type { EffectController } from './controller.js';
import type { PublicCapabilityVerifier } from './production-capability.js';
import { identifier } from './service-auth.js';
export function controllerHttps(
  tls: { key: string | Buffer; cert: string | Buffer },
  verifier: PublicCapabilityVerifier,
  controller: EffectController,
) {
  const server = https.createServer(
    { ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 16384 },
    async (req, res) => {
      try {
        if (
          req.method !== 'POST' ||
          !['/dispatch', '/reconcile'].includes(req.url ?? '')
        )
          throw Error('route');
        const token = req.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
        if (!token) throw Error('capability required');
        const actor = await verifier.verify(token);
        const x = await readJsonBody(req, 4096);
        if (
          !x ||
          typeof x !== 'object' ||
          Array.isArray(x) ||
          Object.keys(x).join(',') !== 'operation'
        )
          throw Error('operation-only request');
        identifier(x.operation);
        const o =
          req.url === '/dispatch'
            ? await controller.dispatch(actor, x.operation)
            : await controller.reconcile(actor, x.operation);
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(
          JSON.stringify({
            id: o.id,
            state: o.state,
            version: Number(o.version),
          }),
        );
      } catch {
        res.writeHead(403, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end('{"error":"capability, request or authority denied"}');
      }
    },
  );
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  return server;
}
export class HttpsControllerClient {
  private origin: string;
  constructor(
    endpoint: string,
    private ca?: string | Buffer,
  ) {
    const u = new URL(endpoint);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw Error('configured HTTPS controller origin required');
    this.origin = u.origin;
  }
  async call(
    capability: string,
    operation: string,
    route: '/dispatch' | '/reconcile' = '/dispatch',
  ) {
    identifier(operation);
    if (
      capability.length > 16384 ||
      !['/dispatch', '/reconcile'].includes(route)
    )
      throw Error('controller request bound');
    return new Promise<{ id: string; state: string; version: number }>(
      (resolve, reject) => {
        const r = https.request(
          this.origin + route,
          {
            method: 'POST',
            ca: this.ca,
            rejectUnauthorized: true,
            headers: {
              authorization: 'Bearer ' + capability,
              'content-type': 'application/json',
            },
            agent: false,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(Error('controller denied/unavailable; no alternate send'));
              return;
            }
            let s = '';
            res.on('data', (b) => {
              s += b;
              if (Buffer.byteLength(s) > 4096) {
                res.destroy();
                reject(Error('controller response limit'));
              }
            });
            res.on('end', () => {
              try {
                const x = JSON.parse(s);
                if (
                  x.id !== operation ||
                  ![
                    'REQUESTED',
                    'RESERVED',
                    'SENDING',
                    'COMMITTED',
                    'UNKNOWN',
                    'DENIED',
                    'FAILED_KNOWN_NO_EFFECT',
                  ].includes(x.state) ||
                  !Number.isSafeInteger(x.version)
                )
                  throw Error('controller response shape');
                resolve(x);
              } catch (e) {
                reject(e);
              }
            });
            res.on('error', reject);
          },
        );
        r.setTimeout(5000, () => r.destroy(Error('controller timeout')));
        r.on('error', reject);
        r.end(JSON.stringify({ operation }));
      },
    );
  }
}
