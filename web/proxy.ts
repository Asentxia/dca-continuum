import {
  consoleProfile,
  compiledConsoleProfile,
} from './lib/deployment-profile';
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server';
import { randomBytes } from 'node:crypto';
export async function proxy(request: NextRequest, event: NextFetchEvent) {
  let profile;
  try {
    profile = consoleProfile(process.env, compiledConsoleProfile);
  } catch {
    return NextResponse.json(
      { error: 'Deployment profile misconfigured; sign-in unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  const nonce = randomBytes(18).toString('base64'),
    dev = process.env.NODE_ENV === 'development';
  const policy = `default-src 'self'; script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);
  let response: Response;
  if (
    profile === 'PRODUCT' &&
    process.env.WORKOS_CLIENT_ID &&
    process.env.WORKOS_API_KEY &&
    process.env.WORKOS_COOKIE_PASSWORD
  ) {
    const { authkitMiddleware } = await import('@workos-inc/authkit-nextjs');
    request.headers.set('x-nonce', nonce);
    request.headers.set('content-security-policy', policy);
    const result = await authkitMiddleware()(request, event);
    response =
      result instanceof Response
        ? result
        : NextResponse.next({ request: { headers } });
  } else response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  response.headers.set('cache-control', 'no-store');
  return response;
}
export const config = {
  matcher: ['/console/:path*', '/sign-in', '/api/:path*', '/auth/:path*'],
};
