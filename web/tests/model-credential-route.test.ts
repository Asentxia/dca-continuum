import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  serverSession: vi.fn(),
  validateOrigin: vi.fn(),
  validateCsrf: vi.fn(),
  csrf: vi.fn(() => 'csrf-token'),
}));
const domain = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => session);
vi.mock('@/lib/server/domain', () => ({ domain }));

import { POST } from '../app/api/continuum/v1/[...path]/route';

const secret = 'AIza-route-test-secret-value';

function request(headers: Record<string, string> = {}) {
  return new Request(
    'http://127.0.0.1:5661/api/continuum/v1/model-credential',
    {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5661',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ connectionId: 'desk-connection', apiKey: secret }),
    },
  );
}

function post(headers: Record<string, string> = {}) {
  return POST(request(headers) as never, {
    params: Promise.resolve({ path: ['model-credential'] }),
  });
}

beforeEach(() => {
  session.serverSession.mockReset();
  session.validateOrigin.mockReset();
  session.validateCsrf.mockReset();
  domain.mockReset();
});

describe('model credential route', () => {
  it('rejects a missing session before any credential call', async () => {
    session.serverSession.mockResolvedValue(null);
    const response = await post();
    expect(response.status).toBe(401);
    expect(domain).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(secret);
  });

  it('rejects a missing or stale CSRF token before the key is forwarded', async () => {
    session.serverSession.mockResolvedValue({ key: 'session' });
    session.validateCsrf.mockImplementation(() => {
      throw Error('CSRF denied');
    });
    const response = await post();
    expect(response.status).toBe(403);
    expect(domain).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(secret);
  });

  it('returns a sealed acknowledgement without the provider key', async () => {
    session.serverSession.mockResolvedValue({ key: 'session' });
    domain.mockResolvedValue({
      response: new Response(
        JSON.stringify({ connection: 'desk-connection', sealed: true }),
        { status: 200 },
      ),
    });
    const response = await post({ 'x-ct-csrf': 'csrf-token' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ connection: 'desk-connection', sealed: true });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(domain).toHaveBeenCalledOnce();
  });
});
