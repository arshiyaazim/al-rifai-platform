// AL-RIFA'I — Phase 3: message classifier tests.
// Pure function tests: no database, no network, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyDomain, looksLikeCash, looksLikeVessel} from '../../lib/message-classifier.ts';

test('classifyDomain: empty text returns UNKNOWN', () => {
  const r = classifyDomain(null, 'CASH');
  assert.equal(r.domain, 'UNKNOWN');
  assert.equal(r.confidence, 'LOW');
  assert.ok(r.reasons.includes('NO_DOMAIN_SIGNALS'));
});

test('classifyDomain: cash keywords + amount in CASH chat', () => {
  const r = classifyDomain('ID: 01712345678 Rahim 01812345678(B) 1,250.50/- duty pay', 'CASH');
  assert.equal(r.domain, 'CASH');
  assert.equal(r.confidence, 'HIGH');
});

test('classifyDomain: cash keywords in ORDERS chat → UNKNOWN (purpose mismatch)', () => {
  const r = classifyDomain('ID: 01712345678 Rahim 01812345678(B) 1,250.50/-', 'ORDERS');
  assert.equal(r.domain, 'UNKNOWN');
  assert.ok(r.reasons.includes('CHAT_PURPOSE_DOES_NOT_ALLOW_CASH'));
});

test('classifyDomain: vessel keywords in ORDERS chat', () => {
  const r = classifyDomain('Mother Vessel: MV Ocean Star Lighter Vessel: L-77 Master: 01911111111', 'ORDERS');
  assert.equal(r.domain, 'VESSEL');
  assert.equal(r.confidence, 'HIGH');
});

test('classifyDomain: vessel keywords in CASH chat → UNKNOWN', () => {
  const r = classifyDomain('Mother Vessel: MV Ocean Star Lighter Vessel: L-77', 'CASH');
  assert.equal(r.domain, 'UNKNOWN');
  assert.ok(r.reasons.includes('CHAT_PURPOSE_DOES_NOT_ALLOW_VESSEL'));
});

test('classifyDomain: ambiguous cash+vessel → UNKNOWN', () => {
  const r = classifyDomain('ID: 01712345678 Rahim 01812345678(B) 1,250.50/- Mother Vessel: MV X Lighter: L-1', 'BOTH');
  assert.equal(r.domain, 'UNKNOWN');
  assert.ok(r.reasons.includes('AMBIGUOUS_CASH_AND_VESSEL_SIGNALS'));
});

test('classifyDomain: no signals → UNKNOWN', () => {
  const r = classifyDomain('Hello, how are you?', 'BOTH');
  assert.equal(r.domain, 'UNKNOWN');
  assert.ok(r.reasons.includes('NO_DOMAIN_SIGNALS'));
});

test('looksLikeCash: detects payment block pattern', () => {
  assert.equal(looksLikeCash('ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay'), true);
});

test('looksLikeCash: rejects plain text', () => {
  assert.equal(looksLikeCash('Hello, how are you today?'), false);
});

test('looksLikeVessel: detects mother+lighter pattern', () => {
  assert.equal(looksLikeVessel('Mother Vessel: MV Ocean Star Lighter Vessel: L-77'), true);
});

test('looksLikeVessel: detects M.V. + master pattern', () => {
  assert.equal(looksLikeVessel('M.V. Beltokyo master +8801921155548'), true);
});

test('looksLikeVessel: rejects plain text', () => {
  assert.equal(looksLikeVessel('Hello, how are you?'), false);
});

test('classifyDomain: BOTH chat allows cash', () => {
  const r = classifyDomain('ID: 01712345678 Rahim 01812345678(B) 1,250.50/-', 'BOTH');
  assert.equal(r.domain, 'CASH');
});

test('classifyDomain: BOTH chat allows vessel', () => {
  const r = classifyDomain('Mother Vessel: MV X Lighter Vessel: L-1 Master: 01911111111', 'BOTH');
  assert.equal(r.domain, 'VESSEL');
});
