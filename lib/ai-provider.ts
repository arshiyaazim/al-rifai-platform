// Shared (client + server safe) provider catalogue.
//
// There is intentionally NO key-prefix detection here. The operator selects the
// provider in the UI and the system only supplies a suggested Base URL. This is
// what makes the platform work with any OpenAI-compatible provider (Gemini,
// OpenAI, OpenRouter, Groq, Mistral, local Ollama, or anything added later)
// without a code change.
//
// No secrets, no fetch: the API routes and the form share these rules.

export type AiProvider = string;

export type ProviderSpec = {
  id: string;
  label: string;
  /** Endpoint applied when the operator leaves Base URL empty. '' = must be supplied. */
  defaultBaseUrl: string;
  /** true when there is no sensible default and the operator must type one. */
  requiresBaseUrl: boolean;
  /** true when the endpoint uses the OpenAI /chat/completions wire format. */
  openAiCompatible: boolean;
};

export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: 'gemini', label: 'Gemini (Google)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresBaseUrl: false, openAiCompatible: true,
  },
  {
    id: 'openai', label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresBaseUrl: false, openAiCompatible: true,
  },
  {
    id: 'anthropic', label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresBaseUrl: false, openAiCompatible: false,
  },
  {
    id: 'openrouter', label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresBaseUrl: false, openAiCompatible: true,
  },
  {
    id: 'groq', label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresBaseUrl: false, openAiCompatible: true,
  },
  {
    id: 'mistral', label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    requiresBaseUrl: false, openAiCompatible: true,
  },
  {
    id: 'ollama', label: 'Ollama (local)',
    defaultBaseUrl: 'http://ollama:11434/v1',
    requiresBaseUrl: false, openAiCompatible: true,
  },
  {
    id: 'other', label: 'Other (OpenAI-compatible)',
    defaultBaseUrl: '',
    requiresBaseUrl: true, openAiCompatible: true,
  },
];

/** Purposes offered by the key form. `general` stays for backward compatibility. */
export const KEY_PURPOSES: Array<{id: string; label: string}> = [
  {id: 'platform-llm', label: 'AI / LLM — WhatsApp replies (encrypted)'},
  {id: 'platform-assistant', label: 'Platform assistant — floating widget (encrypted)'},
  {id: 'ocr', label: 'OCR — release slip vision (encrypted)'},
  {id: 'general', label: 'General — legacy platform LLM (encrypted)'},
  {id: 'recruitment', label: 'Recruitment application (plaintext, read by the worker)'},
  {id: 'vessel-ai', label: 'Vessel AI (encrypted)'},
];

const SPEC_BY_ID = new Map(PROVIDER_SPECS.map((spec) => [spec.id, spec]));

/** Normalise an operator-supplied provider id. Any non-empty string is allowed. */
export function normalizeProvider(value: unknown): string {
  const provider = String(value ?? '').trim().toLowerCase();
  return provider.slice(0, 60);
}

export function providerSpec(provider: string): ProviderSpec | undefined {
  return SPEC_BY_ID.get(normalizeProvider(provider));
}

export function providerLabel(provider: string): string {
  return providerSpec(provider)?.label ?? (normalizeProvider(provider) || 'Other');
}

export function defaultBaseUrl(provider: string): string {
  return providerSpec(provider)?.defaultBaseUrl ?? '';
}

export function requiresBaseUrl(provider: string): boolean {
  return providerSpec(provider)?.requiresBaseUrl ?? false;
}

/** Explicit value wins; otherwise the provider default; otherwise ''. */
export function resolveBaseUrl(provider: string, explicit?: string | null): string {
  const value = String(explicit ?? '').trim().replace(/\/+$/, '');
  if (value) return value;
  return defaultBaseUrl(provider).replace(/\/+$/, '');
}

/** Gemini's native REST surface (as opposed to its OpenAI-compatible endpoint). */
export function isGeminiNative(baseUrl: string): boolean {
  const value = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return /generativelanguage\.googleapis\.com\/v1beta$/i.test(value)
    || /generativelanguage\.googleapis\.com\/v1$/.test(value);
}

/**
 * Base URL is persisted in the existing `notes` column for rows the separate
 * recruitment worker reads. New rows also store `api_keys.base_url`; the notes
 * copy is kept so the recruitment app needs no change in this phase.
 */
export function notesWithBaseUrl(baseUrl: string | null | undefined, existing: string | null = null): string | null {
  const url = String(baseUrl ?? '').trim();
  if (!url) return existing;
  return `base_url:${url.slice(0, 500)}`;
}

export function baseUrlFromNotes(notes: string | null | undefined): string {
  const text = String(notes ?? '');
  const match = /(?:^|\n)base_url:(\S+)/.exec(text);
  return match?.[1] ?? '';
}
