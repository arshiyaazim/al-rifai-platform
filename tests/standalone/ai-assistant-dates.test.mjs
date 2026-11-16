// E2.5 date parser regressions — pure, Asia/Dhaka.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBnDate, parseDateExpression, toBengaliDigits, toLatinDigits,
} from '../../lib/standalone/ai-assistant-dates.ts';

const NOW = new Date('2026-11-16T10:00:00Z'); // Dhaka: 16 Nov 2026

test('digits convert both ways', () => {
  assert.equal(toLatinDigits('গত ৩ দিন'), 'গত 3 দিন');
  assert.equal(toBengaliDigits(2026), '২০২৬');
  assert.equal(formatBnDate('2026-11-15'), '১৫ নভেম্বর');
});

test('today and yesterday (Bengali inflections + English)', () => {
  for (const text of ['আজ', 'আজকের ক্যাশ', 'today']) {
    assert.deepEqual(pick(parseDateExpression(text, NOW)), ['2026-11-16', '2026-11-16'], text);
  }
  for (const text of ['গতকাল', 'গতকালে ক্যাশ সামারি', 'গতকালের হাজিরা', 'yesterday']) {
    assert.deepEqual(pick(parseDateExpression(text, NOW)), ['2026-11-15', '2026-11-15'], text);
  }
});

test('rolling windows: N days, week, 30 days', () => {
  assert.deepEqual(pick(parseDateExpression('গত ৩ দিন', NOW)), ['2026-11-14', '2026-11-16']);
  assert.deepEqual(pick(parseDateExpression('last 5 days', NOW)), ['2026-11-12', '2026-11-16']);
  assert.deepEqual(pick(parseDateExpression('গত সপ্তাহ', NOW)), ['2026-11-10', '2026-11-16']);
  assert.deepEqual(pick(parseDateExpression('last week', NOW)), ['2026-11-10', '2026-11-16']);
  assert.deepEqual(pick(parseDateExpression('গত মাস', NOW)), ['2026-10-18', '2026-11-16']);
  assert.deepEqual(pick(parseDateExpression('গত এক মাস', NOW)), ['2026-10-18', '2026-11-16']);
});

test('previous calendar month vs month-to-date', () => {
  assert.deepEqual(pick(parseDateExpression('গত মাসে', NOW)), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(pick(parseDateExpression('গত মাসের ক্যাশ', NOW)), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(pick(parseDateExpression('last month', NOW)), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(pick(parseDateExpression('এই মাস', NOW)), ['2026-11-01', '2026-11-16']);
  assert.deepEqual(pick(parseDateExpression('this month', NOW)), ['2026-11-01', '2026-11-16']);
});

test('day-of-month ranges use the current month, or the previous one when N is in the future', () => {
  assert.deepEqual(pick(parseDateExpression('১ তারিখ থেকে ১০ তারিখ', NOW)), ['2026-11-01', '2026-11-10']);
  assert.deepEqual(pick(parseDateExpression('১ তারিখ থেকে ১০ তারিখের ক্যাশ', NOW)), ['2026-11-01', '2026-11-10']);
  assert.deepEqual(pick(parseDateExpression('২৫ তারিখ থেকে ৩০ তারিখ', NOW)), ['2026-10-25', '2026-10-30']);
  assert.equal(parseDateExpression('৩০ তারিখ থেকে ৫ তারিখ', NOW), null);
});

test('explicit ISO ranges and month edges', () => {
  assert.deepEqual(pick(parseDateExpression('2026-11-01 থেকে 2026-11-07', NOW)), ['2026-11-01', '2026-11-07']);
  assert.deepEqual(pick(parseDateExpression('2026-11-09 to 2026-11-10', NOW)), ['2026-11-09', '2026-11-10']);
  assert.equal(parseDateExpression('2026-11-10 থেকে 2026-11-01', NOW), null);
  const marchFirst = new Date('2026-03-01T10:00:00Z');
  assert.deepEqual(pick(parseDateExpression('৩০ তারিখ থেকে ৩১ তারিখ', marchFirst)), ['2026-02-28', '2026-02-28']);
});

test('unparseable text returns null', () => {
  for (const text of ['', 'সাইফুল', 'Hello there', 'কোনো তারিখ নেই']) {
    assert.equal(parseDateExpression(text, NOW), null, text);
  }
});

function pick(value) {
  return value ? [value.from, value.to] : null;
}
