// Cash payment-block parser regression tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePaymentBlocks} from '../../lib/history-extraction.mjs';

test('standard payment block parses employee, payout, method and amount', () => {
  const [block] = parsePaymentBlocks('ID: 01712345678 Rahim Uddin 01812345678(B) 500/- duty');
  assert.deepEqual(block.reasons, []);
  assert.equal(block.fields.employeeMobile, '+8801712345678');
  assert.equal(block.fields.payoutMobile, '+8801812345678');
  assert.equal(block.fields.method, 'bkash');
  assert.equal(block.fields.amountMinor, '50000');
});

test('names with MD: are accepted and duplicate ID prefixes are normalized', () => {
  const [block] = parsePaymentBlocks('ID: ID: 01712345678 MD: Shah Alam 01812345678(B)1200/-');
  assert.deepEqual(block.reasons, []);
  assert.equal(block.fields.employeeName, 'MD: Shah Alam');
  assert.equal(block.fields.amountMinor, '120000');
});

test('a single phone is both employee identity and payout destination', () => {
  const [block] = parsePaymentBlocks('ID: 01712345678 Rahim Uddin (B) 500/-');
  assert.deepEqual(block.reasons, []);
  assert.equal(block.fields.employeeMobile, '+8801712345678');
  assert.equal(block.fields.payoutMobile, '+8801712345678');
  assert.equal(block.fields.employeeName, 'Rahim Uddin');
});

test('single-number form with the name before the number is accepted', () => {
  const [block] = parsePaymentBlocks('ID: Rahim Uddin 01712345678 (N) 500/-');
  assert.deepEqual(block.reasons, []);
  assert.equal(block.fields.employeeMobile, block.fields.payoutMobile);
  assert.equal(block.fields.employeeName, 'Rahim Uddin');
});

test('hyphenated numbers, extra separators and cash marker (C) are accepted', () => {
  const [block] = parsePaymentBlocks('ID: 01712-345678 Md.Noyon Khan 01712-345678(C)---20,500/-');
  assert.deepEqual(block.reasons, []);
  assert.equal(block.fields.method, 'cash');
  assert.equal(block.fields.amountMinor, '2050000');
});

test('missing method is never fabricated as cash', () => {
  const [block] = parsePaymentBlocks('ID: 01712345678 Rahim Uddin 01812345678 500/-');
  assert.ok(block.reasons.includes('PAYMENT_METHOD_UNRESOLVED'));
  assert.equal(block.fields.method, undefined);
});
