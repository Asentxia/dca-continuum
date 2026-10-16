import { consoleProfile, compiledConsoleProfile } from '../deployment-profile';
import 'server-only';
import { cookies } from 'next/headers';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
interface LocalSession {
  token: string;
  expires: number;
}
const root = globalThis as unknown as {
  ctSessions?: Map<string, LocalSession>;
  ctCsrf?: Buffer;
};
root.ctSessions ??= new Map();
export function fixtureMode() {
  return consoleProfile(process.env, compiledConsoleProfile) === 'LOCAL_TEST';
}
export function configuredAuth() {
  if (fixtureMode()) return false;
  return Boolean(
    process.env.WORKOS_API_KEY &&
      process.env.WORKOS_CLIENT_ID &&
      process.env.WORKOS_COOKIE_PASSWORD &&
      process.env.WORKOS_REDIRECT_URI &&
      process.env.CT_DOMAIN_API_ORIGIN,
  );
}
export function consoleOrigin() {
  const u = new URL(process.env.CT_CONSOLE_ORIGIN ?? 'http://127.0.0.1:5661');
  if (fixtureMode() && u.hostname !== '127.0.0.1')
    throw Error('Fixture is loopback-only');
  if (!fixtureMode() && u.protocol !== 'https:')
    throw Error('Approved HTTPS origin required');
  return u.origin;
}
export function domainOrigin() {
  const u = new URL(
    process.env.CT_DOMAIN_API_ORIGIN ?? 'http://127.0.0.1:5660',
  );
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw Error('Pinned API origin required');
  if (fixtureMode() ? u.hostname !== '127.0.0.1' : u.protocol !== 'https:')
    throw Error('Approved API transport required');
  return u.origin;
}
export async function serverSession() {
  if (fixtureMode()) {
    const id = (await cookies()).get('ct_local_session')?.value,
      s = id ? root.ctSessions!.get(id) : undefined;
    if (!id || !s || s.expires <= Date.now()) return null;
    return {
      key: id,
      token: s.token,
      expires: s.expires,
      mode: 'LOCAL_FIXTURE' as const,
    };
  }
  if (!configuredAuth()) return null;
  const { withAuth } = await import('@workos-inc/authkit-nextjs');
  const auth = await withAuth();
  if (!auth.user || !auth.accessToken) return null;
  return {
    key: auth.sessionId,
    token: auth.accessToken,
    expires: null,
    mode: 'STAGING' as const,
  };
}
export function csrf(key: string) {
  let secret = root.ctCsrf;
  if (!secret) {
    if (fixtureMode()) secret = root.ctCsrf = randomBytes(32);
    else {
      const configured = process.env.CT_CONSOLE_CSRF_SECRET;
      if (!configured || configured.length < 32)
        throw Error('Secure CSRF signing reference not configured');
      secret = Buffer.from(configured);
    }
  }
  return createHmac('sha256', secret).update(key).digest('base64url');
}
export function validateOrigin(origin: string | null) {
  if (origin !== consoleOrigin()) throw Error('Same-origin required');
}
export function validateCsrf(value: string | null, key: string) {
  const expected = Buffer.from(csrf(key)),
    actual = Buffer.from(value ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw Error('CSRF denied');
}
export async function fixtureLogin(tenant: string) {
  if (!fixtureMode() || !['a', 'b'].includes(tenant))
    throw Error('Test sign-in unavailable');
  const key = process.env.CT_FIXTURE_SERVER_KEY;
  if (!key) throw Error('Test bootstrap not configured');
  const response = await fetch(domainOrigin() + '/__fixture/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fixture-server-key': key,
    },
    body: JSON.stringify({ tenant }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error('Test identity unavailable');
  const { token } = await response.json();
  if (typeof token !== 'string') throw Error('Test identity unavailable');
  const id = randomBytes(32).toString('hex'),
    expires = Date.now() + 600000;
  for (const [key, s] of root.ctSessions!)
    if (s.expires < Date.now()) root.ctSessions!.delete(key);
  if (root.ctSessions!.size >= 100) throw Error('Session limit');
  root.ctSessions!.set(id, { token, expires });
  (await cookies()).set('ct_local_session', id, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
    maxAge: 600,
  });
  return { mode: 'LOCAL_FIXTURE' };
}
export async function logout() {
  const cookie = await cookies(),
    id = cookie.get('ct_local_session')?.value;
  if (id) root.ctSessions!.delete(id);
  cookie.delete('ct_local_session');
}
