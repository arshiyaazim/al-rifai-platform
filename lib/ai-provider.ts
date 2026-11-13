// Shared (client + server safe) provider detection and model catalogue.
// No secrets, no fetch: the API routes and the form use the same rules.

export type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'other';

export function detectProvider(apiKey: string): AiProvider {
  const key = String(apiKey ?? '').trim();
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('sk-')) return 'openai';
  return 'other';
}

export const PROVIDER_MODELS: Record<AiProvider, string[]> = {
  gemini: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'],
  anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
  other: [],
};

export function defaultModel(provider: AiProvider): string {
  return PROVIDER_MODELS[provider][0] ?? '';
}

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', other: 'Other',
};

/** Base URL is stored in the existing `notes` text column; schema unchanged. */
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
