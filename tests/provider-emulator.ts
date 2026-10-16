import http from 'node:http';
import fs from 'node:fs';
import { readJsonBody } from '../src/bounded-body.js';
import { pool } from '../src/db.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const db = pool('ct_provider');
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== 'Bearer ' + config.providerSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    const u = new URL(req.url!, 'http://fixture');
    if (u.pathname !== '/effects') throw Error('unsupported');
    if (req.method === 'POST') {
      const x = await readJsonBody(req, 16384);
      await db.query(
        'INSERT INTO provider.effects(tenant,operation,digest,idempotency_key,payload) VALUES($1,$2,$3,$4,$5)',
        [x.tenant, x.operation, x.digest, x.idempotency_key, x.payload],
      );
      if (config.loseAck?.includes(x.operation)) {
        req.socket.destroy();
        return;
      }
      if (config.delayAck?.includes(x.operation))
        await new Promise((r) => setTimeout(r, 3500));
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"accepted":true}');
      return;
    }
    const r = await db.query(
      'SELECT tenant,operation,digest,idempotency_key,payload FROM provider.effects WHERE tenant=$1 AND operation=$2 ORDER BY seq',
      [u.searchParams.get('tenant'), u.searchParams.get('operation')],
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.rows));
  } catch {
    res.writeHead(500);
    res.end('Provider fixture request failed');
  }
});
server.listen(56670, '127.0.0.1', () => {
  console.log('READY');
});
