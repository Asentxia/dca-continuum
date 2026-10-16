import { NextRequest, NextResponse } from 'next/server';
import {
  logout,
  validateOrigin,
  serverSession,
  validateCsrf,
  configuredAuth,
} from '@/lib/server/session';
export async function POST(request: NextRequest) {
  try {
    validateOrigin(request.headers.get('origin'));
    const session = await serverSession();
    if (session) validateCsrf(request.headers.get('x-ct-csrf'), session.key);
    await logout();
    if (process.env.CT_CONSOLE_MODE !== 'LOCAL_FIXTURE' && configuredAuth()) {
      const { signOut } = await import('@workos-inc/authkit-nextjs');
      await signOut({ returnTo: process.env.CT_CONSOLE_ORIGIN + '/sign-in' });
    }
    return NextResponse.json(
      { signedOut: true },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'Sign-out unavailable' },
      { status: 403 },
    );
  }
}
