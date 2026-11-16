import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseUrlFromNotes, defaultBaseUrl, isGeminiNative, normalizeProvider,
  notesWithBaseUrl, PROVIDER_SPECS, providerLabel, requiresBaseUrl, resolveBaseUrl,
} from '../../lib/ai-provider.ts';
import {maskKey} from '../../lib/standalone/api-keys.ts';

test('providers are a catalogue, not key-prefix detection', () => {
  const ids = PROVIDER_SPECS.map((spec) => spec.id);
  for (const id of ['gemini', 'openai', 'anthropic', 'openrouter', 'groq', 'mistral', 'ollama', 'other']) {
    assert.ok(ids.includes(id), `${id} must be selectable`);
  }
  // Any operator-supplied provider is accepted and normalised.
  assert.equal(normalizeProvider('  Groq '), 'groq');
  assert.equal(normalizeProvider('my-internal-gateway'), 'my-internal-gateway');
  assert.equal(normalizeProvider(''), '');
  assert.equal(providerLabel('my-internal-gateway'), 'my-internal-gateway');
});

test('base URL defaults are provider-driven', () => {
  assert.equal(defaultBaseUrl('gemini'), 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(defaultBaseUrl('ollama'), 'http://ollama:11434/v1');
  assert.equal(defaultBaseUrl('groq'), 'https://api.groq.com/openai/v1');
  assert.equal(defaultBaseUrl('other'), '');
  assert.equal(requiresBaseUrl('other'), true);
  assert.equal(requiresBaseUrl('gemini'), false);
});

test('explicit base URL wins over the provider default', () => {
  assert.equal(resolveBaseUrl('gemini', 'https://proxy.example.com/v1'), 'https://proxy.example.com/v1');
  assert.equal(resolveBaseUrl('gemini', ''), 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(resolveBaseUrl('other', ''), '');
  // Trailing slashes never produce double slashes in request paths.
  assert.equal(resolveBaseUrl('openai', 'https://api.openai.com/v1/'), 'https://api.openai.com/v1');
});

test('Gemini native REST endpoint is distinguished from its OpenAI-compatible one', () => {
  assert.equal(isGeminiNative('https://generativelanguage.googleapis.com/v1beta'), true);
  assert.equal(isGeminiNative('https://generativelanguage.googleapis.com/v1beta/'), true);
  assert.equal(isGeminiNative('https://generativelanguage.googleapis.com/v1beta/openai'), false);
});

test('Base URL persists in the legacy notes column for the recruitment worker', () => {
  const notes = notesWithBaseUrl('https://generativelanguage.googleapis.com/v1');
  assert.equal(notes, 'base_url:https://generativelanguage.googleapis.com/v1');
  assert.equal(baseUrlFromNotes(notes), 'https://generativelanguage.googleapis.com/v1');
  assert.equal(baseUrlFromNotes('free tier; requested model unavailable\nbase_url:https://x.test/v1'), 'https://x.test/v1');
});

test('masked key never exposes the full secret', () => {
  const key = 'AIza' + 'B'.repeat(35);
  const masked = maskKey(key);
  assert.ok(masked.startsWith('AIza'));
  assert.ok(masked.endsWith('BBBB'));
  assert.ok(!masked.includes(key));
  assert.ok(masked.includes('****'));
});
