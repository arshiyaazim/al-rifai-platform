// Owner-approved display rule for the homepage employee search Cash total.
// Minor units in, one-line text out. No financial calculation is performed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {compactTaka} from '../../lib/format-money.ts';

const taka = (value) => value * 100;

test('amounts up to BDT 1,000,000 keep the full grouped value', () => {
  assert.equal(compactTaka(taka(100_000)), '100,000');
  assert.equal(compactTaka(taka(500_000)), '500,000');
  assert.equal(compactTaka(taka(1_000_000)), '1,000,000');
  assert.equal(compactTaka(0), '0');
});

test('amounts above BDT 1,000,000 use the English k suffix', () => {
  assert.equal(compactTaka(taka(1_250_000)), '1,250k');
  assert.equal(compactTaka(taka(2_500_000)), '2,500k');
  assert.equal(compactTaka(taka(1_000_001)), '1,000k');
});

test('missing or unusable values render an em dash', () => {
  assert.equal(compactTaka(null), '—');
  assert.equal(compactTaka(undefined), '—');
  assert.equal(compactTaka(''), '—');
  assert.equal(compactTaka('not-a-number'), '—');
});

test('every rendered value stays on one line (no separators other than commas)', () => {
  for (const value of [100_000, 1_000_000, 1_250_000, 2_500_000]) {
    const rendered = compactTaka(taka(value));
    assert.ok(!/\s/.test(rendered), `${rendered} must not contain whitespace`);
  }
});
