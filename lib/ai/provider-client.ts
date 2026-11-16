// Universal chat client for any supported provider, with multi-key failover.
//
// Wire formats handled here:
//   gemini-native  Google REST /models/{model}:generateContent   (key in query)
//   gemini (openai) Google's OpenAI-compatible /chat/completions
//   anthropic      /v1/messages                                  (x-api-key)
//   ollama         /chat/completions with no Authorization header
//   everything else /chat/completions with Bearer auth
//
// Failover contract:
//   429        -> cooldown the key, try the next one
//   401 / 403  -> disable the key, try the next one
//   5xx        -> count the failure, try the next one
//   any error  -> same as 5xx
// All keys exhausted -> {ok:false, reason}; the caller keeps the deterministic
// answer. Nothing here throws into the request path.

import {isGeminiNative} from '../ai-provider.ts';
import type {PlatformKey} from './key-store.ts';

export type ChatMessage = {role: 'system' | 'user' | 'assistant'; content: string};

export type ChatRequest = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  timeoutMsOverride?: number;
};

export type ChatSuccess = {
  ok: true;
  text: string;
  keyId: string;
  provider: string;
  model: string;
  latencyMs: number;
  tokens: {prompt: number; completion: number} | null;
};

export type ChatFailure = {ok: false; reason: string; attempts: number};

export type ChatOutcome = ChatSuccess | ChatFailure;

type Mode = 'gemini-native' | 'anthropic' | 'openai';

// Markers are resolved lazily so a pure unit test with an env-only key never
// opens a database connection. Keys with an `env` id have no row to update.
const isStored = (id: string) => Boolean(id) && id !== 'env' && !id.startsWith('env:');

type Markers = {
  success: (id: string) => Promise<void>;
  rateLimited: (id: string, seconds: number) => Promise<void>;
  authFailure: (id: string, message: string) => Promise<void>;
  error: (id: string, message: string) => Promise<void>;
};

let markers: Markers | null = null;

async function loadMarkers(): Promise<Markers> {
  if (!markers) {
    const store = await import('./key-store.ts');
    markers = {
      success: store.markSuccess,
      rateLimited: store.markRateLimited,
      authFailure: store.markAuthFailure,
      error: store.markError,
    };
  }
  return markers;
}

async function mark(kind: keyof Markers, id: string, detail: string | number): Promise<void> {
  if (!isStored(id)) return;
  try {
    const set = await loadMarkers();
    if (kind === 'rateLimited') await set.rateLimited(id, Number(detail) || 60);
    else await set[kind](id, String(detail));
  } catch { /* telemetry must not break a reply */ }
}

function modeFor(key: Pick<PlatformKey, 'provider' | 'baseUrl'>): Mode {
  if (key.provider === 'anthropic') return 'anthropic';
  if (key.provider === 'gemini' && isGeminiNative(key.baseUrl)) return 'gemini-native';
  return 'openai';
}

/** Reasoning models wrap scratchpad output in <think>…</think>; never send it. */
export function stripThinking(value: string): string {
  const withoutBlocks = String(value).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  if (/<think(?:ing)?>/i.test(withoutBlocks)) return '';
  return withoutBlocks.trim();
}

const trimSlash = (value: string) => String(value ?? '').replace(/\/+$/, '');

function authHeaders(key: PlatformKey): Record<string, string> {
  const secret = String(key.apiKey ?? '').trim();
  if (!secret || secret === 'ollama') return {};
  return {Authorization: `Bearer ${secret}`};
}

type BuiltRequest = {url: string; headers: Record<string, string>; body: Record<string, unknown>};

function buildRequest(key: PlatformKey, request: ChatRequest): BuiltRequest {
  const mode = modeFor(key);
  const base = trimSlash(key.baseUrl);
  const temperature = request.temperature ?? 0.2;
  const maxTokens = request.maxTokens ?? 700;

  if (mode === 'gemini-native') {
    const system = request.messages.filter((message) => message.role === 'system')
      .map((message) => message.content).join('\n\n');
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({role: message.role === 'assistant' ? 'model' : 'user', parts: [{text: message.content}]}));
    return {
      url: `${base}/models/${encodeURIComponent(key.model)}:generateContent?key=${encodeURIComponent(key.apiKey)}`,
      headers: {'Content-Type': 'application/json'},
      body: {
        contents,
        ...(system ? {systemInstruction: {parts: [{text: system}]}} : {}),
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(request.json ? {responseMimeType: 'application/json'} : {}),
        },
      },
    };
  }

  if (mode === 'anthropic') {
    const system = request.messages.filter((message) => message.role === 'system')
      .map((message) => message.content).join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content}));
    return {
      url: `${base}/v1/messages`,
      headers: {'Content-Type': 'application/json', 'x-api-key': key.apiKey, 'anthropic-version': '2023-06-01'},
      body: {
        model: key.model,
        max_tokens: maxTokens,
        temperature,
        messages,
        ...(system ? {system} : {}),
      },
    };
  }

  return {
    url: `${base}/chat/completions`,
    headers: {'Content-Type': 'application/json', ...authHeaders(key)},
    body: {
      model: key.model,
      messages: request.messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      ...(request.json ? {response_format: {type: 'json_object'}} : {}),
    },
  };
}

function parseResponse(mode: Mode, body: unknown): {text: string; tokens: {prompt: number; completion: number} | null} {
  const payload = (body ?? {}) as Record<string, unknown>;
  if (mode === 'gemini-native') {
    const candidates = payload.candidates as Array<{content?: {parts?: Array<{text?: string}>}}> | undefined;
    const usage = payload.usageMetadata as {promptTokenCount?: number; candidatesTokenCount?: number} | undefined;
    return {
      text: candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
      tokens: usage
        ? {prompt: Number(usage.promptTokenCount ?? 0), completion: Number(usage.candidatesTokenCount ?? 0)}
        : null,
    };
  }
  if (mode === 'anthropic') {
    const content = payload.content as Array<{text?: string}> | undefined;
    const usage = payload.usage as {input_tokens?: number; output_tokens?: number} | undefined;
    return {
      text: content?.map((part) => part.text ?? '').join('') ?? '',
      tokens: usage
        ? {prompt: Number(usage.input_tokens ?? 0), completion: Number(usage.output_tokens ?? 0)}
        : null,
    };
  }
  const choices = payload.choices as Array<{message?: {content?: string | Array<{text?: string}>}}> | undefined;
  const value = choices?.[0]?.message?.content;
  const usage = payload.usage as {prompt_tokens?: number; completion_tokens?: number} | undefined;
  return {
    text: typeof value === 'string' ? value
      : Array.isArray(value) ? value.map((part) => part.text ?? '').join('') : '',
    tokens: usage
      ? {prompt: Number(usage.prompt_tokens ?? 0), completion: Number(usage.completion_tokens ?? 0)}
      : null,
  };
}

/** Honour Retry-After in either seconds or HTTP-date form. */
function retryAfterSeconds(response: Response): number {
  const header = response.headers.get('retry-after');
  if (!header) return 60;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 86_400);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(Math.ceil((date - Date.now()) / 1000), 5), 86_400);
  return 60;
}

/**
 * Try each key once, in the order supplied (already sorted free-first, then
 * priority, then least recently used). A failing key is marked and skipped for
 * the rest of this call.
 */
export async function completeChat(keys: PlatformKey[], request: ChatRequest): Promise<ChatOutcome> {
  if (!keys.length) return {ok: false, reason: 'NO_KEYS', attempts: 0};

  let lastReason = 'NO_USABLE_KEY';
  let attempts = 0;

  for (const key of keys) {
    attempts += 1;
    const started = Date.now();
    const timeoutMs = request.timeoutMsOverride ?? key.timeoutMs;
    const mode = modeFor(key);
    try {
      const built = buildRequest(key, request);
      const response = await fetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify(built.body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 429) {
        lastReason = 'RATE_LIMITED';
        await mark('rateLimited', key.id, retryAfterSeconds(response));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        lastReason = `HTTP_${response.status}`;
        await mark('authFailure', key.id, lastReason);
        continue;
      }
      if (!response.ok) {
        lastReason = `HTTP_${response.status}`;
        await mark('error', key.id, lastReason);
        continue;
      }

      const payload = await response.json().catch(() => null);
      const parsed = parseResponse(mode, payload);
      const text = stripThinking(parsed.text);
      if (!text) {
        lastReason = 'EMPTY_RESPONSE';
        await mark('error', key.id, lastReason);
        continue;
      }

      await mark('success', key.id, '');
      return {
        ok: true,
        text,
        keyId: key.id,
        provider: key.provider,
        model: key.model,
        latencyMs: Date.now() - started,
        tokens: parsed.tokens,
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      lastReason = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'REQUEST_FAILED';
      await mark('error', key.id, lastReason);
    }
  }

  return {ok: false, reason: lastReason, attempts};
}
