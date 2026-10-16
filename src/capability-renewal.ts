import type { Capability } from './capability.js';
export interface IdentityTokenSource {
  current(): Promise<string>;
}
export class RenewingCapabilityClient {
  private origin: string;
  constructor(
    endpoint: string,
    private identity: IdentityTokenSource,
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
      throw Error('HTTPS identity endpoint required');
    this.origin = u.origin;
  }
  async forOperation(operation: string) {
    const identityToken = await this.identity.current();
    const r = await fetch(this.origin + '/renew', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + identityToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!r.ok) throw Error('renewal denied');
    const x = (await r.json()) as { token: string; expires: number };
    if (
      typeof x.token !== 'string' ||
      !Number.isFinite(x.expires) ||
      x.expires <= Date.now()
    )
      throw Error('invalid renewal response');
    return x.token;
  }
}
