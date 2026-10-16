import http from 'node:http';
import { decodeBoundedUtf8 } from './bounded-body.js';
const responseLimit = 65536;
export function callController(
  socket: string,
  capability: string,
  operation: string,
  route = '/dispatch',
  extra?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ state: string; id: string; version: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : Error('controller response'));
    };
    const req = http.request(
      {
        socketPath: socket,
        path: route,
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + capability,
          'content-type': 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.on('data', (x: Buffer) => {
          size += x.length;
          if (size > responseLimit) {
            req.destroy();
            fail(Error('controller response bound'));
            return;
          }
          chunks.push(x);
        });
        res.on('end', () => {
          try {
            const text = decodeBoundedUtf8(chunks, responseLimit);
            if (res.statusCode === 200) {
              const parsed = JSON.parse(text);
              const states = [
                'REQUESTED',
                'RESERVED',
                'SENDING',
                'COMMITTED',
                'UNKNOWN',
                'DENIED',
                'FAILED_KNOWN_NO_EFFECT',
              ];
              if (
                !parsed ||
                parsed.id !== operation ||
                typeof parsed.state !== 'string' ||
                !states.includes(parsed.state)
              )
                throw Error('controller response rejected');
              if (settled) return;
              settled = true;
              resolve(parsed);
            } else fail(Error(text.slice(0, 500)));
          } catch (e) {
            fail(e);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      fail(Error('controller response deadline'));
    });
    req.on('error', fail);
    req.end(JSON.stringify({ ...extra, operation }));
  });
}
