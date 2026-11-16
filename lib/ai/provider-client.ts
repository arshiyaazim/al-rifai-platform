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

export type ContentPart =
  | {type: 'text'; text: string}
  | {type: 'image'; mimeType: string; base64: string};

export type ChatMessage = {role: 'system' | 'user' | 'assistant'; content: string | ContentPart[]};

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
  failure: (id: string, status: number | null, detail: string) => Promise<void>;
};

let markers: Markers | null = null;

async function loadMarkers(): Promise<Markers> {
  if (!markers) {
    const store = await import('./key-store.ts');
    markers = {
      success: store.markSuccess,
      failure: store.recordKeyFailure,
    };
  }
  return markers;
}

async function markSuccess(id: string): Promise<void> {
  if (!isStored(id)) return;
  try {
    await (await loadMarkers()).success(id);
  } catch { /* telemetry must not break a reply */ }
}

async function markFailure(id: string, status: number | null, detail: string): Promise<void> {
  if (!isStored(id)) return;
  try {
    await (await loadMarkers()).failure(id, status, detail);
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

/** Text-only projection, used for `system` messages on every wire format. */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is {type: 'text'; text: string} => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function openAiContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? {type: 'text', text: part.text}
    : {type: 'image_url', image_url: {url: `data:${part.mimeType};base64,${part.base64}`}});
}

function geminiParts(content: ChatMessage['content']): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{text: content}];
  return content.map((part) => part.type === 'text'
    ? {text: part.text}
    : {inline_data: {mime_type: part.mimeType, data: part.base64}});
}

function anthropicContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? {type: 'text', text: part.text}
    : {type: 'image', source: {type: 'base64', media_type: part.mimeType, data: part.base64}});
}

type BuiltRequest = {url: string; headers: Record<string, string>; body: Record<string, unknown>};

function buildRequest(key: PlatformKey, request: ChatRequest): BuiltRequest {
  const mode = modeFor(key);
  const base = trimSlash(key.baseUrl);
  const temperature = request.temperature ?? 0.2;
  const maxTokens = request.maxTokens ?? 700;

  if (mode === 'gemini-native') {
    const system = request.messages.filter((message) => message.role === 'system')
      .map((message) => textOf(message.content)).join('\n\n');
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: geminiParts(message.content),
      }));
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
      .map((message) => textOf(message.content)).join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: anthropicContent(message.content),
      }));
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
      messages: request.messages.map((message) => ({
        role: message.role,
        content: openAiContent(message.content),
      })),
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
        await markFailure(key.id, 429, String(retryAfterSeconds(response)));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        lastReason = `HTTP_${response.status}`;
        await markFailure(key.id, response.status, lastReason);
        continue;
      }
      if (!response.ok) {
        lastReason = `HTTP_${response.status}`;
        await markFailure(key.id, response.status, lastReason);
        continue;
      }

      const payload = await response.json().catch(() => null);
      const parsed = parseResponse(mode, payload);
      const text = stripThinking(parsed.text);
      if (!text) {
        lastReason = 'EMPTY_RESPONSE';
        await markFailure(key.id, null, lastReason);
        continue;
      }

      await markSuccess(key.id);
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
      await markFailure(key.id, null, lastReason);
    }
  }

  return {ok: false, reason: lastReason, attempts};
}
