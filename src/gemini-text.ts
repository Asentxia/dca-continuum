export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
export const VERIFICATION_LABEL = 'mock-tested / live test pending';

export type GeminiModel = Readonly<{ name: string }>;
export type GeminiTextResult = Readonly<{
  text: string;
  usageReported: boolean;
}>;

export interface GeminiTransport {
  listModels(apiKey: string): Promise<GeminiModel[]>;
  readonly mock?: boolean;
  generate(input: {
    apiKey: string;
    model: string;
    text: string;
    timeoutMs: number;
    maxOutputTokens: number;
    maxResponseBytes: number;
  }): Promise<GeminiTextResult>;
}

type FetchLike = (
  url: URL,
  init: RequestInit,
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

export function geminiUrl(path: string) {
  if (
    !path.startsWith('/v1beta/') ||
    path.includes('://') ||
    path.includes('..') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\\')
  )
    throw Error('gemini path denied');
  const url = new URL(path, GEMINI_ORIGIN);
  if (url.origin !== GEMINI_ORIGIN || url.username || url.password)
    throw Error('gemini origin denied');
  return url;
}

function modelName(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^models\/[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(value)
  )
    return undefined;
  return value;
}

function supportsText(model: Record<string, unknown>) {
  const methods = model.supportedGenerationMethods ?? model.supportedActions;
  return Array.isArray(methods) && methods.includes('generateContent');
}

export function modelsFromList(body: unknown): GeminiModel[] {
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { models?: unknown }).models)
  )
    throw Error('gemini model list malformed');
  const names = (body as { models: unknown[] }).models.flatMap((model) => {
    if (!model || typeof model !== 'object') return [];
    const record = model as Record<string, unknown>;
    const name = modelName(record.name);
    if (!name || !supportsText(record)) return [];
    return [{ name }];
  });
  if (names.length === 0) throw Error('gemini model list empty');
  return names;
}

export function textFromGenerate(body: unknown): GeminiTextResult {
  if (!body || typeof body !== 'object')
    throw Error('gemini response malformed');
  const record = body as Record<string, unknown>;
  const candidates = record.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1)
    throw Error('gemini response malformed');
  const content = (candidates[0] as { content?: { parts?: unknown[] } })
    .content;
  const parts = content?.parts;
  if (!Array.isArray(parts) || parts.length === 0)
    throw Error('gemini response malformed');
  let text = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object')
      throw Error('gemini response malformed');
    const fields = part as Record<string, unknown>;
    if (
      'functionCall' in fields ||
      'function_call' in fields ||
      'tool' in fields ||
      'executableCode' in fields
    )
      throw Error('gemini tool rejected');
    if (typeof fields.text !== 'string')
      throw Error('gemini response malformed');
    text += fields.text;
  }
  if (!text.trim()) throw Error('gemini response malformed');
  const usage = record.usageMetadata;
  const usageReported =
    !!usage &&
    typeof usage === 'object' &&
    Number.isInteger(
      (usage as { promptTokenCount?: unknown }).promptTokenCount,
    ) &&
    Number.isInteger(
      (usage as { candidatesTokenCount?: unknown }).candidatesTokenCount,
    );
  return { text, usageReported };
}

export function liveGeminiTransport(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): GeminiTransport {
  if (process.env.CT_ENABLE_GEMINI !== 'yes')
    throw Error('gemini live calls disabled');
  async function call(
    path: string,
    apiKey: string,
    timeoutMs: number,
    maxResponseBytes: number,
    body?: unknown,
  ) {
    const response = await fetchImpl(geminiUrl(path), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        'x-goog-api-key': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    )
      throw Error('gemini key rejected');
    if (response.status === 429) throw Error('gemini rate limited');
    if (response.status < 200 || response.status >= 300)
      throw Error('gemini provider error');
    const bytes = response.arrayBuffer
      ? await response.arrayBuffer()
      : new TextEncoder().encode(JSON.stringify(await response.json()));
    if (bytes.byteLength > maxResponseBytes)
      throw Error('gemini response too large');
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  return {
    mock: false,
    async listModels(apiKey) {
      return modelsFromList(await call('/v1beta/models', apiKey, 5000, 16384));
    },
    async generate(input) {
      if (!modelName(input.model)) throw Error('gemini model rejected');
      if (
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 1
      )
        throw Error('gemini generation limit unavailable');
      return textFromGenerate(
        await call(
          `/v1beta/${input.model}:generateContent`,
          input.apiKey,
          input.timeoutMs,
          input.maxResponseBytes,
          {
            contents: [{ role: 'user', parts: [{ text: input.text }] }],
            generationConfig: { maxOutputTokens: input.maxOutputTokens },
          },
        ),
      );
    },
  };
}

export function disabledGeminiTransport(): GeminiTransport {
  return {
    mock: false,
    listModels() {
      return Promise.reject(Error('gemini live calls disabled'));
    },
    generate() {
      return Promise.reject(Error('gemini live calls disabled'));
    },
  };
}

export function runtimeGeminiTransport(
  env: Record<string, string | undefined> = process.env,
): GeminiTransport {
  if (env.CT_MODEL_TRANSPORT === 'mock')
    throw Error('mock transport cannot be selected by environment');
  if (env.CT_ENABLE_GEMINI === 'yes') return liveGeminiTransport();
  return disabledGeminiTransport();
}
