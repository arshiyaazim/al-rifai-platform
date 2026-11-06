// The WA-02 AI worker is default-disabled. This only tests the environment gate;
// the engine is covered by the DB integration suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {aiWa02WorkerStatus, startAiWa02Worker, stopAiWa02Worker} from '../../lib/ai/worker.ts';

test('WA-02 AI worker is disabled unless AI_WA02_ENABLED=1', () => {
  const previous = process.env.AI_WA02_ENABLED;
  delete process.env.AI_WA02_ENABLED;
  try {
    const result = startAiWa02Worker();
    assert.equal(result.started, false);
    assert.equal(result.reason, 'AI_WA02_ENV_DISABLED');
    assert.equal(aiWa02WorkerStatus().started, false);
  } finally {
    stopAiWa02Worker();
    if (previous !== undefined) process.env.AI_WA02_ENABLED = previous;
  }
});

test('WA-02 AI worker starts once when enabled and stops cleanly', () => {
  const previousEnabled = process.env.AI_WA02_ENABLED;
  const previousInterval = process.env.AI_WA02_INTERVAL_MS;
  process.env.AI_WA02_ENABLED = '1';
  process.env.AI_WA02_INTERVAL_MS = '60000';
  try {
    const first = startAiWa02Worker();
    assert.equal(first.started, true);
    assert.equal(first.intervalMs, 60000);
    assert.equal(startAiWa02Worker().reason, 'ALREADY_STARTED');
  } finally {
    stopAiWa02Worker();
    if (previousEnabled === undefined) delete process.env.AI_WA02_ENABLED;
    else process.env.AI_WA02_ENABLED = previousEnabled;
    if (previousInterval === undefined) delete process.env.AI_WA02_INTERVAL_MS;
    else process.env.AI_WA02_INTERVAL_MS = previousInterval;
  }
  assert.equal(aiWa02WorkerStatus().started, false);
});
