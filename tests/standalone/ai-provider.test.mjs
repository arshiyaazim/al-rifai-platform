import assert from 'node:assert/strict';
import test from 'node:test';
import {detectProvider, defaultModel, notesWithBaseUrl, baseUrlFromNotes} from '../../lib/ai-provider.ts';
import {maskKey} from '../../lib/standalone/api-keys.ts';

test('provider detection follows the owner prefix rules', () => {
  assert.equal(detectProvider('sk-ant-abc123'), 'anthropic');
  assert.equal(detectProvider('AIza' + 'A'.repeat(35)), 'gemini');
  assert.equal(detectProvider('sk-abc123'), 'openai');
  assert.equal(detectProvider('AQ.Ab8Rexample'), 'other');
});

test('default model per provider', () => {
  assert.equal(defaultModel('gemini'), 'gemini-2.0-flash');
  assert.equal(defaultModel('openai'), 'gpt-4o');
  assert.equal(defaultModel('anthropic'), 'claude-3-5-sonnet-20241022');
  assert.equal(defaultModel('other'), '');
});

test('Base URL is persisted in the existing notes column without schema change', () => {
  const notes = notesWithBaseUrl('https://generativelanguage.googleapis.com/v1');
  assert.equal(notes, 'base_url:https://generativelanguage.googleapis.com/v1');
  assert.equal(baseUrlFromNotes(notes), 'https://generativelanguage.googleapis.com/v1');
});

test('masked key never exposes the full secret', () => {
  const key = 'AIza' + 'B'.repeat(35);
  const masked = maskKey(key);
  assert.ok(masked.startsWith('AIza'));
  assert.ok(masked.endsWith('BBBB'));
  assert.ok(!masked.includes(key));
  assert.ok(masked.includes('****'));
});
