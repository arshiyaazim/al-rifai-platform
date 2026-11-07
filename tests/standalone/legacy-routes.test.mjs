import test from 'node:test';
import assert from 'node:assert/strict';
import {LEGACY_REDIRECTS, LEGACY_UNMAPPED} from '../../lib/legacy-redirects.ts';

test('legacy browser redirects map to verified Phase 3 routes without loops', () => {
  const sources = new Set();
  for (const entry of LEGACY_REDIRECTS) {
    assert.ok(entry.source.startsWith('/'));
    assert.ok(entry.destination.startsWith('/'));
    assert.notEqual(entry.source, entry.destination);
    assert.equal(sources.has(entry.source), false);
    sources.add(entry.source);
  }
  const bySource = Object.fromEntries(LEGACY_REDIRECTS.map((entry) => [entry.source, entry.destination]));
  assert.equal(bySource['/transactions'], '/cash');
  assert.equal(bySource['/vessel-register'], '/vessel');
  assert.equal(bySource['/register'], '/vessel');
  assert.equal(bySource['/sources-review'], '/review');
  assert.equal(bySource['/insights'], '/reports');
  assert.equal(bySource['/cash/submissions'], '/cash');
  assert.deepEqual([...LEGACY_UNMAPPED], ['/assistant']);
});
