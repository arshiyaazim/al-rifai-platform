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

test('a single phone is not silently treated as both identities', () => {
  const [block] = parsePaymentBlocks('ID: 01712345678 Rahim Uddin (B) 500/-');
  assert.ok(block.reasons.includes('PAYOUT_DESTINATION_UNRESOLVED'));
});
