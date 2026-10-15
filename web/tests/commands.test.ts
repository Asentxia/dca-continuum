import { afterEach, describe, it, expect, vi } from 'vitest';
import { command, lookupCommand } from '../lib/api';
const cmd = {
  schema_version: 1 as const,
  idempotency_key: 'test-command',
  kind: 'create_task' as const,
  target: 'task-new',
  expected_version: 0,
  input: {},
};
const valid = {
  schema_version: 1,
  command_id: 'b0c3a8b2-8e41-4313-b00c-bfcf0535d599',
  idempotency_key: 'test-command',
  status: 'APPLIED',
  result_ref: 'b0c3a8b2-8e41-4313-b00c-bfcf0535d599',
  result: { workflowAdmitted: false },
  error_code: null,
  reused: false,
  external_effect: false,
};
afterEach(() => vi.unstubAllGlobals());
describe('human receipt fail-closed contract', () => {
  it('Uses one lookup, not a second POST, after lost acknowledgement', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(Error('lost response'))
      .mockResolvedValueOnce({ ok: true, json: async () => valid });
    vi.stubGlobal('fetch', fetch);
    expect((await command(cmd, 'csrf')).status).toBe('APPLIED');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(fetch.mock.calls[1][0]).toContain('key=test-command');
  });
  it('Rejects unknown receipt schema and incorrect command identity', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...valid, schema_version: 99 }),
    });
    vi.stubGlobal('fetch', fetch);
    await expect(command(cmd, 'csrf')).rejects.toThrow('REQUEST_UNCONFIRMED');
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...valid, idempotency_key: 'other-command' }),
    });
    await expect(command(cmd, 'csrf')).rejects.toThrow('REQUEST_UNCONFIRMED');
  });
  it('Never maps PENDING or an external-effect assertion to applied human permission', async () => {
    for (const patch of [{ status: 'PENDING' }, { external_effect: true }]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ ...valid, ...patch }),
        }),
      );
      await expect(command(cmd, 'csrf')).rejects.toThrow('REQUEST_UNCONFIRMED');
    }
  });
  it('Session expiry performs no command lookup or replay', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal('fetch', fetch);
    const refused = command(cmd, 'csrf');
    await expect(refused).rejects.toThrow('SESSION_EXPIRED');
    await expect(refused).rejects.toMatchObject({ commandNotSubmitted: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('Explicit stored-outcome lookup performs one GET and never posts a command', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => valid,
    });
    vi.stubGlobal('fetch', fetch);
    expect((await lookupCommand(cmd.idempotency_key)).status).toBe('APPLIED');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/continuum/v1/command?key=test-command',
      { cache: 'no-store' },
    );
  });
  it('Lookup refuses malformed keys before I/O and preserves uncertainty for nonterminal receipts', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(lookupCommand('invalid key')).rejects.toThrow(
      'REQUEST_UNCONFIRMED',
    );
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...valid, status: 'PENDING' }),
    });
    await expect(lookupCommand(cmd.idempotency_key)).rejects.toThrow(
      'REQUEST_UNCONFIRMED',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('method', 'POST');
  });
  it('An HTTP error cannot establish APPLIED solely from a receipt-looking body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => valid,
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetch);
    await expect(command(cmd, 'csrf')).rejects.toThrow('REQUEST_UNCONFIRMED');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(fetch.mock.calls[1][1]).not.toHaveProperty('method', 'POST');
  });
  it('An expired session during a later lookup causes no POST or replay', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 401, ok: false });
    vi.stubGlobal('fetch', fetch);
    await expect(lookupCommand(cmd.idempotency_key)).rejects.toThrow(
      'SESSION_EXPIRED',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
