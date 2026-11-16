// E2.5: walkthrough context, mid-flow answers and the dated-summary regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_IDS, WALKTHROUGHS, flowFromContext, flowFromMessage, walkthroughAnswer, walkthroughDigest,
} from '../../lib/standalone/ai-assistant-walkthrough.ts';
import {detectDatedIntent} from '../../lib/standalone/ai-assistant-summaries.ts';

const NOW = new Date('2026-11-16T10:00:00Z');

test('context tokens resolve to flows (string and {flow} shapes)', () => {
  for (const flow of FLOW_IDS) {
    assert.equal(flowFromContext(flow), flow);
    assert.equal(flowFromContext({flow}), flow);
  }
  assert.equal(flowFromContext('cash-payment-extra'), null);
  assert.equal(flowFromContext(undefined), null);
  assert.equal(flowFromContext({}), null);
});

test('mid-flow questions answer from the KB, including the no-delete rule', () => {
  const save = walkthroughAnswer('cash-payment', 'সেভ হচ্ছে না');
  assert.match(save.text, /Create \(review\)/);
  assert.match(save.text, /REVIEW/);
  assert.equal(save.context, 'cash-payment');
  assert.ok(save.suggestions.length >= 2);

  const remove = walkthroughAnswer('cash-payment', 'ডিলিট করতে চাই');
  assert.match(remove.text, /ডিলিট করতে পারবে না|Decline/);

  const cancel = walkthroughAnswer('attendance-add', 'ক্যান্সেল করব কিভাবে');
  assert.match(cancel.text, /Cancel/);

  const upload = walkthroughAnswer('employees-create', 'ছবি আপলোড কিভাবে');
  assert.match(upload.text, /Documents|আপলোড/);

  const next = walkthroughAnswer('vessel-program', 'পরের ধাপ কী?');
  assert.match(next.text, /Mother Vessel/);
});

test('keyword fallback finds a flow only for flow-shaped questions', () => {
  assert.equal(flowFromMessage('হোটেল বিল কিভাবে দেব?'), 'cash-payment');
  assert.equal(flowFromMessage('রিলিজ স্লিপ OCR'), 'release-ocr');
  assert.equal(flowFromMessage('আজকের ক্যাশ'), null);
});

test('prompt digest carries the verified business rules', () => {
  const digest = walkthroughDigest();
  assert.match(digest, /REVIEW/);
  assert.match(digest, /cannot delete/);
  assert.match(digest, /vessel\.release/);
});

test('regression: "গতকালে ক্যাশ সামারি দাও" becomes a dated cash summary', () => {
  const intent = detectDatedIntent('গতকালে ক্যাশ সামারি দাও', NOW);
  assert.ok(intent, 'must detect a dated intent');
  assert.equal(intent.domain, 'cash');
  assert.equal(intent.range.from, '2026-11-15');
  assert.equal(intent.range.to, '2026-11-15');
});

test('dated intents cover attendance, vessel and employee scoping; non-dated text is ignored', () => {
  assert.equal(detectDatedIntent('গতকালের হাজিরা সামারি', NOW)?.domain, 'attendance');
  assert.equal(detectDatedIntent('গত সপ্তাহে ভেসেল কে গেছিলো', NOW)?.domain, 'vessel');
  assert.equal(detectDatedIntent('গত মাসে সাইফুলের ক্যাশ সামারি', NOW)?.domain, 'cash');
  assert.equal(detectDatedIntent('গতকালে ক্যাশ সামারি', NOW)?.range.to, '2026-11-15');
  assert.equal(detectDatedIntent('সাইফুল', NOW), null);
  assert.equal(detectDatedIntent('আজকের ক্যাশ সামারি', NOW)?.range.from, '2026-11-16');
});

test('every flow has verified steps, save/cancel text and an action link', () => {
  for (const flow of FLOW_IDS) {
    const guide = WALKTHROUGHS[flow];
    assert.ok(guide.steps.length >= 3, flow);
    assert.ok(guide.save.length > 10 && guide.cancel.length > 10, flow);
    assert.match(guide.mistakes, /ডিলিট|Decline|INACTIVE|Edit/, flow);
    assert.ok(guide.actions.length >= 1 && guide.actions[0].href.startsWith('/'), flow);
  }
});
