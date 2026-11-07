// Pure unit coverage for Cash payment filter normalization and Dhaka dates.
// These tests never open a database connection.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentMonthRange,
  dhakaToday,
  formatPayoutNumber,
  normalizeCashPaymentFilters,
  payoutMethodLabel,
  previousMonthRange,
  shiftIsoDate,
} from '../../lib/standalone/cash-dashboard.ts';

test('cash filters: empty input stays unfiltered', () => {
  const filters = normalizeCashPaymentFilters({});
  assert.deepEqual(filters, {
    from: null,
    to: null,
    employeeMobile: null,
    source: null,
    q: '',
    errors: [],
  });
});

test('cash filters: a single date overrides a range', () => {
  const filters = normalizeCashPaymentFilters({date: '2026-11-07', from: '2026-10-01', to: '2026-10-31'});
  assert.equal(filters.from, '2026-11-07');
  assert.equal(filters.to, '2026-11-07');
  assert.deepEqual(filters.errors, []);
});

test('cash filters: invalid dates are reported and never applied', () => {
  assert.deepEqual(
    normalizeCashPaymentFilters({date: '2026-02-30'}).errors,
    ['INVALID_DATE'],
  );
  const badRange = normalizeCashPaymentFilters({from: '07/11/2026', to: '2026-11-07'});
  assert.equal(badRange.from, null);
  assert.equal(badRange.to, '2026-11-07');
  assert.deepEqual(badRange.errors, ['INVALID_FROM_DATE']);
});

test('cash filters: reversed date ranges are rejected explicitly', () => {
  const filters = normalizeCashPaymentFilters({from: '2026-11-08', to: '2026-11-07'});
  assert.equal(filters.from, '2026-11-08');
  assert.equal(filters.to, '2026-11-07');
  assert.deepEqual(filters.errors, ['INVALID_DATE_RANGE']);
});

test('cash filters: source accepts only the supported pay sources', () => {
  assert.equal(normalizeCashPaymentFilters({source: 'whatsapp'}).source, 'WHATSAPP');
  assert.equal(normalizeCashPaymentFilters({source: 'OFFICE'}).source, 'OFFICE');
  assert.equal(normalizeCashPaymentFilters({source: 'ALL'}).source, null);
  const invalid = normalizeCashPaymentFilters({source: 'BANK'});
  assert.equal(invalid.source, null);
  assert.deepEqual(invalid.errors, ['INVALID_SOURCE']);
});

test('cash filters: employee input and query are bounded', () => {
  const mobile = normalizeCashPaymentFilters({employeeMobile: '01712-345678'});
  assert.equal(mobile.employeeMobile, '+8801712345678');
  assert.equal(normalizeCashPaymentFilters({employeeMobile: '+8801712345678'}).employeeMobile, '+8801712345678');
  assert.equal(normalizeCashPaymentFilters({q: 'x'.repeat(300)}).q.length, 100);
});

test('cash dates: business date follows Asia/Dhaka, not UTC', () => {
  assert.equal(dhakaToday(new Date('2026-11-07T17:30:00Z')), '2026-11-07');
  assert.equal(dhakaToday(new Date('2026-11-07T19:00:00Z')), '2026-11-08');
});

test('cash dates: current and previous month ranges include leap days', () => {
  assert.deepEqual(currentMonthRange('2024-02-10'), {from: '2024-02-01', to: '2024-02-29'});
  assert.deepEqual(previousMonthRange('2026-01-15'), {from: '2025-12-01', to: '2025-12-31'});
  assert.deepEqual(previousMonthRange('2026-03-31'), {from: '2026-02-01', to: '2026-02-28'});
});

test('cash dates: shifting crosses month and year boundaries safely', () => {
  assert.equal(shiftIsoDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftIsoDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftIsoDate('2026-12-31', 1), '2027-01-01');
});

test('cash payout display keeps method in parentheses', () => {
  assert.equal(payoutMethodLabel('bkash'), 'bKash');
  assert.equal(formatPayoutNumber('01712345678', 'bkash'), '01712345678 (bKash)');
  assert.equal(formatPayoutNumber(null, 'cash'), '— (Cash)');
});
