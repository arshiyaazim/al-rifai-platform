// The continuous router is default-disabled. This test proves the environment
// gate without requiring a live router activation; the router itself is covered
// by the 49 message-router and 18 cutover integration tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  phase3RouterWorkerStatus,
  startPhase3RouterWorker,
  stopPhase3RouterWorker,
} from '../../lib/phase3-router-worker.ts';

test('router worker: disabled unless explicitly enabled', () => {
  const previous = process.env.PHASE3_ROUTER_WORKER_ENABLED;
  delete process.env.PHASE3_ROUTER_WORKER_ENABLED;
  try {
    const result = startPhase3RouterWorker();
    assert.equal(result.started, false);
    assert.equal(result.reason, 'WORKER_DISABLED');
    assert.equal(phase3RouterWorkerStatus().started, false);
  } finally {
    stopPhase3RouterWorker();
    if (previous !== undefined) process.env.PHASE3_ROUTER_WORKER_ENABLED = previous;
  }
});

test('router worker: starts once when enabled and can be stopped', () => {
  const previousEnabled = process.env.PHASE3_ROUTER_WORKER_ENABLED;
  const previousInterval = process.env.PHASE3_ROUTER_WORKER_INTERVAL_MS;
  process.env.PHASE3_ROUTER_WORKER_ENABLED = '1';
  process.env.PHASE3_ROUTER_WORKER_INTERVAL_MS = '60000';
  try {
    const first = startPhase3RouterWorker();
    assert.equal(first.started, true);
    assert.equal(first.intervalMs, 60000);
    const second = startPhase3RouterWorker();
    assert.equal(second.started, false);
    assert.equal(second.reason, 'ALREADY_STARTED');
  } finally {
    stopPhase3RouterWorker();
    if (previousEnabled === undefined) delete process.env.PHASE3_ROUTER_WORKER_ENABLED;
    else process.env.PHASE3_ROUTER_WORKER_ENABLED = previousEnabled;
    if (previousInterval === undefined) delete process.env.PHASE3_ROUTER_WORKER_INTERVAL_MS;
    else process.env.PHASE3_ROUTER_WORKER_INTERVAL_MS = previousInterval;
  }
  assert.equal(phase3RouterWorkerStatus().started, false);
});
