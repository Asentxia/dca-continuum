import { NextResponse } from 'next/server';
import { configuredAuth } from '@/lib/server/session';
export async function GET() {
  if (!configuredAuth())
    return NextResponse.json(
      { error: 'Sign-in configuration required' },
      { status: 503 },
    );
  const { getSignInUrl } = await import('@workos-inc/authkit-nextjs');
  return NextResponse.redirect(
    await getSignInUrl({ returnTo: '/console/work' }),
  );
}
