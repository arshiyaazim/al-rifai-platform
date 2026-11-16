import {isGeminiNative, resolveBaseUrl} from './ai-provider.ts';

// Real HTTP checks against the provider the operator selected. Nothing here
// guesses a provider from the key: the provider and Base URL come from the form,
// which is what makes any OpenAI-compatible endpoint work.

export type KeyTestResult = {
  ok: boolean;
  provider: string;
  model: string;
  latency_ms: number;
  status?: number;
  error?: string;
};

type Mode = 'gemini-native' | 'anthropic' | 'openai';

const TIMEOUT_MS = 10_000;

function modeFor(provider: string, baseUrl: string): Mode {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'gemini' && isGeminiNative(baseUrl)) return 'gemini-native';
  return 'openai';
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? {Authorization: `Bearer ${apiKey}`} : {};
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as {error?: {message?: string} | string; message?: string};
    const message = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    if (message) return String(message).slice(0, 300);
  } catch { /* plain text */ }
  return text.slice(0, 300) || `HTTP_${response.status}`;
}

/** Send one tiny prompt and report latency. */
export async function testApiKey(input: {
  provider: string; apiKey: string; model: string; baseUrl?: string; timeoutMs?: number;
}): Promise<KeyTestResult> {
  const started = Date.now();
  const provider = String(input.provider ?? '').trim().toLowerCase();
  const model = String(input.model ?? '').trim();
  const fail = (error: string, status?: number): KeyTestResult => ({
    ok: false, provider, model, latency_ms: Date.now() - started,
    ...(status ? {status} : {}), error,
  });

  if (!provider) return fail('PROVIDER_REQUIRED');
  if (!model) return fail('MODEL_REQUIRED');
  const base = resolveBaseUrl(provider, input.baseUrl);
  if (!base) return fail('BASE_URL_REQUIRED');

  const mode = modeFor(provider, base);
  const signal = AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS);

  try {
    let response: Response;
    if (mode === 'gemini-native') {
      response = await fetch(
        `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
        {
          method: 'POST', signal, headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({contents: [{parts: [{text: 'Say OK'}]}]}),
        },
      );
    } else if (mode === 'anthropic') {
      response = await fetch(`${base}/v1/messages`, {
        method: 'POST', signal,
        headers: {'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
        body: JSON.stringify({model, max_tokens: 5, messages: [{role: 'user', content: 'Say OK'}]}),
      });
    } else {
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal,
        headers: {...authHeaders(input.apiKey), 'Content-Type': 'application/json'},
        body: JSON.stringify({model, messages: [{role: 'user', content: 'Say OK'}], max_tokens: 5}),
      });
    }

    const latency = Date.now() - started;
    if (!response.ok) {
      return {ok: false, provider, model, latency_ms: latency, status: response.status, error: await readError(response)};
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const valid = mode === 'gemini-native' ? Array.isArray(body.candidates)
      : mode === 'anthropic' ? Array.isArray(body.content)
        : Array.isArray(body.choices);
    return {ok: valid, provider, model, latency_ms: latency,
      ...(valid ? {} : {error: 'UNEXPECTED_RESPONSE'})};
  } catch (error) {
    return {
      ok: false, provider, model, latency_ms: Date.now() - started,
      error: error instanceof Error
        ? (error.name === 'TimeoutError' ? 'TIMEOUT_10S' : error.message.slice(0, 300))
        : 'REQUEST_FAILED',
    };
  }
}

export type ModelListResult = {
  ok: boolean;
  provider: string;
  models: string[];
  status?: number;
  error?: string;
};

/**
 * Verify a key and return the models it can actually use. This is the ONLY
 * key validation the platform performs — a 200 with a model list means valid.
 */
export async function listModels(input: {
  provider: string; apiKey: string; baseUrl?: string; timeoutMs?: number;
}): Promise<ModelListResult> {
  const provider = String(input.provider ?? '').trim().toLowerCase();
  const fail = (error: string, status?: number): ModelListResult => ({
    ok: false, provider, models: [], ...(status ? {status} : {}), error,
  });
  if (!provider) return fail('PROVIDER_REQUIRED');

  const base = resolveBaseUrl(provider, input.baseUrl);
  if (!base) return fail('BASE_URL_REQUIRED');

  const mode = modeFor(provider, base);
  const signal = AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS);

  try {
    let response: Response;
    if (mode === 'gemini-native') {
      response = await fetch(`${base}/models?pageSize=200&key=${encodeURIComponent(input.apiKey)}`, {signal});
    } else if (mode === 'anthropic') {
      response = await fetch(`${base}/v1/models?limit=1000`, {
        signal,
        headers: {'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01'},
      });
    } else {
      response = await fetch(`${base}/models`, {signal, headers: authHeaders(input.apiKey)});
    }

    if (!response.ok) return fail(await readError(response), response.status);

    const body = await response.json().catch(() => ({})) as {
      data?: Array<{id?: string}>;
      models?: Array<{name?: string; supportedGenerationMethods?: string[]}>;
    };

    let models: string[];
    if (mode === 'gemini-native') {
      models = (body.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => String(model.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
    } else {
      models = (body.data ?? []).map((model) => String(model.id ?? '')).filter(Boolean);
    }
    models = [...new Set(models)].sort();
    return {ok: models.length > 0, provider, models, ...(models.length ? {} : {error: 'NO_MODELS'})};
  } catch (error) {
    return {
      ok: false, provider, models: [],
      error: error instanceof Error
        ? (error.name === 'TimeoutError' ? 'TIMEOUT_10S' : error.message.slice(0, 300))
        : 'REQUEST_FAILED',
    };
  }
}
