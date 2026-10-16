import 'server-only';
import { domainOrigin, serverSession } from './session';
export async function domain(path: string, init: RequestInit = {}) {
  const session = await serverSession();
  if (!session) throw Error('Sign-in required');
  if (
    !path.startsWith('/read?') &&
    path !== '/command' &&
    !path.startsWith('/command?')
  )
    throw Error('Unreviewed API path');
  const response = await fetch(domainOrigin() + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + session.token,
    },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  return { response, session };
}
