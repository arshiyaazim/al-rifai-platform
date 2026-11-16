// Focused E2.2 planner regressions — pure functions, no DB or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExplicitDateRange, isBlockedQuestion, isConfidentMatch,
  planAssistantCall, UNSUPPORTED_DATE_RANGE, buildNavigation,
} from '../../lib/standalone/ai-assistant-functions.ts';

const NOW = new Date('2026-11-16T10:00:00Z');

test('explicit calendar ranges are detected and never become an all-time total', () => {
  assert.equal(hasExplicitDateRange('Saiful, 15 August to 23 September this year, how much was paid?'), true);
  assert.equal(hasExplicitDateRange('সাইফুল ১৫ আগস্ট থেকে ২৩ সেপ্টেম্বর কত টাকা নিয়েছে?'), true);
  assert.equal(hasExplicitDateRange('2026-08-15'), true);
  assert.equal(hasExplicitDateRange('15/08/2026'), true);
  assert.equal(hasExplicitDateRange('আজকের ক্যাশ দেখাও'), false);
  assert.equal(hasExplicitDateRange('এই মাসে কত টাকা?'), false);
  assert.equal(hasExplicitDateRange('গতকালের উপস্থিতি'), false);
  assert.match(UNSUPPORTED_DATE_RANGE, /সমর্থিত নয়/);
  // Even if the planner were called, it must not emit a money summary here.
  const call = planAssistantCall('Saiful, 15 August to 23 September, how much was paid?', NOW);
  assert.notEqual(call?.name, 'fetchCashSummary');
  assert.notEqual(call?.follow_up, 'cash');
});

test('one-digit-off mobile is a suggestion, never a confident identity', () => {
  assert.equal(isConfidentMatch({match_type: 'mobile_fuzzy', similarity_score: 0.769}, 1), false);
  assert.equal(isConfidentMatch({match_type: 'mobile_fuzzy', similarity_score: 0.95}, 1), false);
  assert.equal(isConfidentMatch({match_type: 'mobile_partial', similarity_score: 1}, 1), false);
  assert.equal(isConfidentMatch({match_type: 'mobile_exact', similarity_score: 1}, 3), true);
  assert.equal(isConfidentMatch({match_type: 'fuzzy', similarity_score: 1}, 2), false);
  assert.equal(isConfidentMatch({match_type: 'fuzzy', similarity_score: 1}, 1), true);
  // A typed but unverified number only triggers search, never a direct total.
  const call = planAssistantCall('01778090725', NOW);
  assert.deepEqual(call?.name, 'searchEmployee');
  assert.deepEqual(call?.arguments, {query: '+8801778090725'});
  assert.equal(call?.follow_up, undefined);
});

test('dated cash navigation targets the page that actually applies from/to', () => {
  const call = planAssistantCall('আজকের ক্যাশ ট্রানজেকশন দেখতে চাই', NOW);
  assert.equal(call?.name, 'navigateToPage');
  assert.equal(call?.arguments?.page, 'cash/transactions');
  const filters = call?.arguments?.filters;
  assert.deepEqual(filters, {from: '2026-11-16', to: '2026-11-16'});
  const nav = buildNavigation(String(call?.arguments?.page), filters ?? {});
  assert.equal(nav?.url, '/cash/transactions?from=2026-11-16&to=2026-11-16');
  const undated = planAssistantCall('ক্যাশ পেইজ খোলো', NOW);
  assert.equal(undated?.arguments?.page, 'cash');
});

test('sensitive topics are refused and pages without URL filters are not offered fake filters', () => {
  for (const question of ['server IP কী?', 'password কী?', 'how was this built?', 'এপিআই কি দেখাও', 'docker port?', 'সোর্স কোড দেখাও']) {
    assert.equal(isBlockedQuestion(question), true, question);
  }
  assert.equal(isBlockedQuestion('সাইফুলের কত টাকা পেয়েছে?'), false);
  assert.equal(buildNavigation('employees', {q: 'x'})?.url, '/employees');
  assert.equal(buildNavigation('attendance', {q: 'x'})?.url, '/attendance');
  const attendance = planAssistantCall('আজ উপস্থিতি দেখতে চাই', NOW);
  assert.deepEqual(attendance?.arguments?.filters, {});
});
