import {
  EnvelopeSchema,
  CommandReceiptSchema,
  Identifier,
  type ReadEnvelope,
  type HumanCommand,
} from '@continuum/contracts';
export type ClientEnvelope = ReadEnvelope & { csrf: string };
export async function read(
  section: string,
  query: Record<string, string> = {},
): Promise<ClientEnvelope> {
  const r = await fetch(
    '/api/continuum/v1/' + section + '?' + new URLSearchParams(query),
    { cache: 'no-store' },
  );
  if (r.status === 401) throw Error('SESSION_EXPIRED');
  if (!r.ok)
    throw Error(r.status === 409 ? 'STALE_SNAPSHOT' : 'READ_UNAVAILABLE');
  const body = await r.json();
  const { csrf, ...raw } = body;
  if (typeof csrf !== 'string') throw Error('UNKNOWN_SCHEMA');
  try {
    return { ...EnvelopeSchema.parse(raw), csrf };
  } catch {
    throw Error('UNKNOWN_SCHEMA');
  }
}
function receipt(key: string, body: unknown) {
  const data = CommandReceiptSchema.parse(body);
  if (
    data.idempotency_key !== key ||
    data.result_ref !== data.command_id ||
    data.status === 'PENDING'
  )
    throw Error('REQUEST_UNCONFIRMED');
  return data;
}

export async function lookupCommand(key: string) {
  if (!Identifier.safeParse(key).success) throw Error('REQUEST_UNCONFIRMED');
  try {
    const result = await fetch(
      '/api/continuum/v1/command?' + new URLSearchParams({ key }),
      { cache: 'no-store' },
    );
    if (result.status === 401) throw Error('SESSION_EXPIRED');
    if (!result.ok) throw Error('REQUEST_UNCONFIRMED');
    return receipt(key, await result.json());
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_EXPIRED')
      throw error;
    throw Error('REQUEST_UNCONFIRMED');
  }
}

export async function sealModelKey(
  connectionId: string,
  apiKey: string,
  csrf: string,
) {
  const response = await fetch('/api/continuum/v1/model-credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ct-csrf': csrf },
    body: JSON.stringify({ connectionId, apiKey }),
  });
  if (response.status === 401) throw Error('SESSION_EXPIRED');
  if (!response.ok) throw Error('CREDENTIAL_DENIED');
  const body = await response.json();
  if (body.sealed !== true || body.connection !== connectionId)
    throw Error('CREDENTIAL_DENIED');
  return body as { connection: string; sealed: true };
}

export async function command(value: HumanCommand, csrf: string) {
  try {
    const r = await fetch('/api/continuum/v1/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ct-csrf': csrf },
      body: JSON.stringify(value),
    });
    if (r.status === 401)
      throw Object.assign(Error('SESSION_EXPIRED'), {
        commandNotSubmitted: true,
      });
    if (!r.ok) throw Error('REQUEST_UNCONFIRMED');
    return receipt(value.idempotency_key, await r.json());
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_EXPIRED')
      throw error;
    return lookupCommand(value.idempotency_key);
  }
}
