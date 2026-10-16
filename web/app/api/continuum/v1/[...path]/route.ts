import { boundedJson } from '@/lib/bounded-body';
import { NextRequest, NextResponse } from 'next/server';
import { EnvelopeSchema, CommandSchema } from '@continuum/contracts';
import { domain } from '@/lib/server/domain';
import {
  serverSession,
  csrf,
  validateOrigin,
  validateCsrf,
} from '@/lib/server/session';
export const dynamic = 'force-dynamic';
function reply(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    if (path.length !== 1) return reply({ error: 'Unavailable' }, 404);
    const session = await serverSession();
    if (!session) return reply({ error: 'Sign-in required' }, 401);
    const route = path[0];
    let apiPath;
    if (route === 'command')
      apiPath =
        '/command?' +
        new URLSearchParams({
          key: request.nextUrl.searchParams.get('key') ?? '',
        });
    else {
      const params = new URLSearchParams({ section: route });
      for (const k of ['id', 'q', 'cursor']) {
        const value = request.nextUrl.searchParams.get(k);
        if (value) params.set(k, value);
      }
      apiPath = '/read?' + params;
    }
    const { response } = await domain(apiPath);
    if (!response.ok)
      return reply(
        {
          error:
            response.status === 401
              ? 'Sign-in required'
              : 'Read unavailable or stale',
          code: 'READ_UNAVAILABLE',
        },
        response.status,
      );
    const raw = await response.json();
    if (route === 'command') return reply(raw);
    const data = EnvelopeSchema.parse(raw);
    return reply({ ...data, csrf: csrf(session.key) });
  } catch {
    return reply(
      {
        error: 'Read unavailable; no operational outcome inferred',
        code: 'READ_UNAVAILABLE',
      },
      503,
    );
  }
}
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    if (path.join('/') !== 'command')
      return reply(
        { error: 'Unavailable; no browser dispatch, reconcile or renew' },
        404,
      );
    const session = await serverSession();
    if (!session) return reply({ error: 'Sign-in required' }, 401);
    validateOrigin(request.headers.get('origin'));
    validateCsrf(request.headers.get('x-ct-csrf'), session.key);
    if (request.headers.get('content-type') !== 'application/json')
      return reply({ error: 'JSON required' }, 422);
    const command = CommandSchema.parse(await boundedJson(request, 32768));
    const { response } = await domain('/command', {
      method: 'POST',
      body: JSON.stringify(command),
    });
    const data = await response.json();
    return reply(data, response.status);
  } catch {
    return reply(
      {
        error: 'Command denied; no external success inferred',
        code: 'COMMAND_DENIED',
      },
      403,
    );
  }
}
