import { boundedJson } from '@/lib/bounded-body';
import { NextRequest, NextResponse } from 'next/server';
import { fixtureLogin, validateOrigin } from '@/lib/server/session';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    validateOrigin(request.headers.get('origin'));
    if (request.headers.get('content-type') !== 'application/json')
      throw Error('JSON');
    const input = (await boundedJson(request, 200)) as Record<string, unknown>;
    if (typeof input.tenant !== 'string') throw Error('Schema');
    if (Object.keys(input).join(',') !== 'tenant') throw Error('Schema');
    return NextResponse.json(await fixtureLogin(input.tenant), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Test sign-in unavailable' },
      { status: 403 },
    );
  }
}
