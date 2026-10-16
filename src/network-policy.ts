import dns from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
export function publicAddress(address: string) {
  try {
    let a = ipaddr.parse(address);
    if (a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress())
      a = (a as ipaddr.IPv6).toIPv4Address();
    return a.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function pinPublicTarget(
  raw: string,
  host: string,
  resolve: (h: string) => Promise<string[]> = async (h) =>
    (await dns.lookup(h, { all: true })).map((x) => x.address),
) {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    u.hostname !== host ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== '443') ||
    ipaddr.isValid(u.hostname)
  )
    throw Error('fixed HTTPS host required');
  const addresses = await resolve(host);
  if (!addresses.length || addresses.some((a) => !publicAddress(a)))
    throw Error('non-public DNS result');
  return { url: u, address: addresses[0] };
}
// Trusted adapter transport. A worker never supplies host, headers, resolver or arbitrary request options.
export async function pinnedRequest(
  raw: string,
  host: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
) {
  const { url, address } = await pinPublicTarget(raw, host);
  if (body && Buffer.byteLength(body) > 65536) throw Error('request limit');
  return new Promise<{
    status: number;
    body: string;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        headers,
        agent: false,
        servername: host,
        lookup: ((_h: any, _o: any, cb: any) => {
          if (_o?.all)
            cb(null, [
              {
                address,
                family: ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6,
              },
            ]);
          else
            cb(null, address, ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6);
        }) as any,
      },
      (r) => {
        if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400) {
          r.destroy();
          reject(Error('redirect denied'));
          return;
        }
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (b) => {
          text += b;
          if (Buffer.byteLength(text) > 1048576) {
            r.destroy();
            reject(Error('response limit'));
          }
        });
        r.on('end', () =>
          resolve({
            status: r.statusCode ?? 0,
            body: text,
            headers: r.headers,
          }),
        );
        r.on('error', reject);
      },
    );
    request.setTimeout(5000, () => request.destroy(Error('transport timeout')));
    request.on('error', reject);
    request.end(body);
  });
}
