import { NextRequest, NextResponse } from 'next/server';
import { configuredAuth } from '@/lib/server/session';
export async function GET(request: NextRequest) {
  if (!configuredAuth())
    return NextResponse.json(
      { error: 'Configuration required' },
      { status: 503 },
    );
  const { handleAuth } = await import('@workos-inc/authkit-nextjs');
  return handleAuth({ returnPathname: '/console/work' })(request);
}
