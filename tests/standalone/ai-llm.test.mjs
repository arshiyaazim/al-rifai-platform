// Optional LLM adapter tests against a local mock HTTP endpoint.
// The provider is never contacted; no credential is real.
import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import http from 'node:http';
import {composeReply, llmStatus, numericFactsPreserved, resetLlmCounters} from '../../lib/ai/llm.ts';

const mode = {value: 'ok'};
const requests = [];

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk.toString(); });
  request.on('end', () => {
    requests.push(JSON.parse(body || '{}'));
    if (mode.value === 'slow') {
      setTimeout(() => {
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({choices: [{message: {content: 'too late'}}]}));
      }, 2000);
      return;
    }
    if (mode.value === 'error') {
      response.writeHead(503, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: 'unavailable'}));
      return;
    }
    const content = mode.value === 'drift'
      ? 'Your income is BDT 9,500.00.'
      : 'Cash 2026-11-06: income BDT 1,500.00, expense BDT 500.00.';
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({
      choices: [{message: {content}}],
      usage: {prompt_tokens: 120, completion_tokens: 30},
    }));
  });
});

let baseUrl = '';

test('LLM adapter starts', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  delete process.env.AI_LLM_ENABLED;
  delete process.env.AI_LLM_API_KEY;
  delete process.env.AI_LLM_MODEL;
  delete process.env.AI_LLM_BASE_URL;
  delete process.env.AI_LLM_TIMEOUT_MS;
});

function configure(extra = {}) {
  process.env.AI_LLM_ENABLED = '1';
  process.env.AI_LLM_API_KEY = 'test-key-not-real';
  process.env.AI_LLM_MODEL = 'mock-model';
  process.env.AI_LLM_BASE_URL = baseUrl;
  process.env.AI_LLM_TIMEOUT_MS = '4000';
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  resetLlmCounters();
}

const deterministic = 'Cash 2026-11-06: income BDT 1,500.00, expense BDT 500.00.';

test('LLM stays disabled without an explicit switch and credential', () => {
  delete process.env.AI_LLM_ENABLED;
  delete process.env.AI_LLM_API_KEY;
  const status = llmStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'AI_LLM_DISABLED');
});

test('a rephrased answer is used only when every numeric fact survives', async () => {
  mode.value = 'ok';
  configure();
  const result = await composeReply({
    deterministicAnswer: deterministic,
    userText: 'cash please',
    category: 'VERIFIED_ADMIN',
    intent: 'ADMIN_QUERY',
    conversationId: 'conv-a',
  });
  assert.equal(result.used, true);
  assert.match(result.text, /1,500\.00/);
  assert.equal(result.tokens?.prompt, 120);
  const body = requests.at(-1);
  assert.match(body.messages[0].content, /Never add names, amounts/);
  assert.match(body.messages[1].content, /VERIFIED ANSWER/);
});

test('invented numbers fall back to the deterministic answer', async () => {
  mode.value = 'drift';
  configure();
  const result = await composeReply({
    deterministicAnswer: deterministic,
    userText: 'cash please',
    category: 'VERIFIED_ADMIN',
    intent: 'ADMIN_QUERY',
    conversationId: 'conv-b',
  });
  assert.equal(result.used, false);
  assert.equal(result.reason, 'AI_LLM_FACT_DRIFT');
  assert.equal(result.text, deterministic);
});

test('provider errors and timeouts fall back safely', async () => {
  mode.value = 'error';
  configure();
  const failed = await composeReply({
    deterministicAnswer: deterministic, userText: 'hi', category: 'UNKNOWN_CONTACT',
    intent: 'UNKNOWN', conversationId: 'conv-c',
  });
  assert.equal(failed.used, false);
  assert.match(String(failed.reason), /AI_LLM_HTTP_503/);

  mode.value = 'slow';
  configure({AI_LLM_TIMEOUT_MS: '1000'});
  const timedOut = await composeReply({
    deterministicAnswer: deterministic, userText: 'hi', category: 'UNKNOWN_CONTACT',
    intent: 'UNKNOWN', conversationId: 'conv-d',
  });
  assert.equal(timedOut.used, false);
  assert.equal(timedOut.reason, 'AI_LLM_TIMEOUT');
});

test('numeric guard normalises Bangla digits and rejects new facts', () => {
  assert.equal(numericFactsPreserved('BDT 1500.00', '৳১৫০০.০০'), true);
  assert.equal(numericFactsPreserved('BDT 1500.00', '৳৯৫০০.০০'), false);
  assert.equal(numericFactsPreserved('No amount', 'No amount here'), true);
  assert.equal(numericFactsPreserved('No amount', 'Amount 500'), false);
});
