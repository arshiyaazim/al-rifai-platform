import type {AiProvider} from './ai-provider.ts';

export type KeyTestResult = {
  ok: boolean;
  provider: AiProvider;
  model: string;
  latency_ms: number;
  status?: number;
  error?: string;
};

const TIMEOUT_MS = 10_000;

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as {error?: {message?: string} | string; message?: string};
    const message = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    if (message) return String(message).slice(0, 300);
  } catch { /* plain text */ }
  return text.slice(0, 300) || `HTTP_${response.status}`;
}

/** Real HTTP test against the provider. Never uses an internal AI client. */
export async function testApiKey(input: {
  provider: AiProvider; apiKey: string; model: string; baseUrl?: string;
}): Promise<KeyTestResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let response: Response;
    if (input.provider === 'gemini') {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
        {
          method: 'POST', signal: timeout,
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({contents: [{parts: [{text: 'Say OK'}]}]}),
        },
      );
    } else if (input.provider === 'openai') {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: timeout,
        headers: {'Authorization': `Bearer ${input.apiKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({model: input.model, messages: [{role: 'user', content: 'Say OK'}], max_tokens: 5}),
      });
    } else if (input.provider === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: timeout,
        headers: {
          'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
        },
        body: JSON.stringify({model: input.model, max_tokens: 5, messages: [{role: 'user', content: 'Say OK'}]}),
      });
    } else {
      const base = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
      if (!base) {
        return {ok: false, provider: input.provider, model: input.model, latency_ms: Date.now() - started, error: 'BASE_URL_REQUIRED'};
      }
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal: timeout,
        headers: {'Authorization': `Bearer ${input.apiKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({model: input.model, messages: [{role: 'user', content: 'Say OK'}], max_tokens: 5}),
      });
    }
    const latency = Date.now() - started;
    if (!response.ok) {
      return {ok: false, provider: input.provider, model: input.model, latency_ms: latency,
        status: response.status, error: await readError(response)};
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const valid = input.provider === 'gemini' ? Array.isArray(body.candidates)
      : input.provider === 'openai' || input.provider === 'other' ? Array.isArray(body.choices)
        : Array.isArray(body.content);
    return {ok: valid, provider: input.provider, model: input.model, latency_ms: latency,
      ...(valid ? {} : {error: 'UNEXPECTED_RESPONSE'})};
  } catch (error) {
    return {
      ok: false, provider: input.provider, model: input.model, latency_ms: Date.now() - started,
      error: error instanceof Error
        ? (error.name === 'TimeoutError' ? 'TIMEOUT_10S' : error.message.slice(0, 300))
        : 'REQUEST_FAILED',
    };
  }
}
