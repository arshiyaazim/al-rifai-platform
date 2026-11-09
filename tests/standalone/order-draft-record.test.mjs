// Owner order-draft projection tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {isOwnerDraft, renderOwnerDraft, renderOwnerDraftFields} from '../../lib/order-draft-template.ts';
import {
  OWNER_DRAFT_DELIVERY,
  normalizeDraftDate,
  normalizeDraftShift,
  ownerDraftFromProgram,
  ownerDraftFromRecord,
  ownerDraftFromReviewPayload,
} from '../../lib/order-draft-from-record.ts';

const EXPECTED = [
  'Mother Vessel: MV Union-Odyssey',
  'Lighter Vessel: MV Fardin-7',
  'Master Mobile: 01911428354',
  'Destination:',
  'Escort Name:',
  'Escort Mobile:',
  '03.11.2026 (D)',
  '',
  "Al-Rifa'i Integrated Services",
].join('\n');

test('program record renders the exact Owner layout', () => {
  const result = ownerDraftFromProgram({
    mother_vessel: 'Union-Odyssey',
    lighter_vessel: 'M.V. Fardin-7',
    master_mobile: '+8801911428354',
    destination: null,
    start_date: '2026-11-03',
    start_shift: 'D',
    source_message_id: 'AC123',
  });
  assert.equal(result.text, EXPECTED);
  assert.equal(isOwnerDraft(result.text), true);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.delivery, OWNER_DRAFT_DELIVERY);
  assert.equal(result.sourceMessageId, 'AC123');
});

test('destination is rendered only when parsed; escort fields are never invented', () => {
  const plain = ownerDraftFromProgram({
    mother_vessel: 'Union-Odyssey', lighter_vessel: 'Fardin-7', master_mobile: '01911428354',
    start_date: '2026-11-03', start_shift: 'D',
  });
  assert.match(plain.text ?? '', /^Destination:$/m);
  assert.match(plain.text ?? '', /^Escort Name:$/m);
  assert.match(plain.text ?? '', /^Escort Mobile:$/m);

  const withDestination = ownerDraftFromProgram({
    mother_vessel: 'Union-Odyssey', lighter_vessel: 'Fardin-7', master_mobile: '01911428354',
    destination: 'Landing Ghat Kanchpur', start_date: '2026-11-03', start_shift: 'N',
  });
  assert.match(withDestination.text ?? '', /^Destination: Landing Ghat Kanchpur$/m);
  assert.match(withDestination.text ?? '', /^03\.11\.2026 \(N\)$/m);
});

test('a missing required field blocks the draft instead of inventing a value', () => {
  const result = ownerDraftFromProgram({
    mother_vessel: 'Union-Odyssey', lighter_vessel: 'Fardin-7', master_mobile: '',
    start_date: '2026-11-03', start_shift: 'D',
  });
  assert.equal(result.text, null);
  assert.deepEqual(result.gaps, ['MISSING_MASTER_MOBILE']);
  assert.ok(result.warnings.some((warning) => warning.includes('MISSING_MASTER_MOBILE')));
});

test('date and shift normalisation accepts the real order shapes', () => {
  assert.equal(normalizeDraftDate('03-11-2026'), '2026-11-03');
  assert.equal(normalizeDraftDate('3/11/26'), '2026-11-03');
  assert.equal(normalizeDraftDate('2026-11-03'), '2026-11-03');
  assert.equal(normalizeDraftDate(new Date(2026, 10, 3)), '2026-11-03');
  assert.equal(normalizeDraftDate('31-02-2026'), '');
  assert.equal(normalizeDraftShift('day'), 'D');
  assert.equal(normalizeDraftShift('N'), 'N');
  assert.equal(normalizeDraftShift('shift'), '');
});

test('review payload mapping reads nested fields and derives shift from the source timestamp', () => {
  const result = ownerDraftFromReviewPayload({
    fields: {
      motherVessel: 'M.V. Union-Odyssey',
      lighterVessel: 'Fardin-7',
      masterMobile: '01911-428354',
      destination: 'Landing',
    },
    assignmentDate: '03-11-2026',
    sourceMessageId: 'AC999',
    sourceTimestamp: '2026-11-03T06:30:00Z',
  });
  assert.equal(result.text, renderOwnerDraftFields({
    motherVessel: 'M.V. Union-Odyssey',
    lighterVessel: 'Fardin-7',
    masterMobile: '01911-428354',
    destination: 'Landing',
    date: '2026-11-03',
    shift: 'D',
  }));
  assert.deepEqual(result.gaps, []);
  assert.equal(result.sourceMessageId, 'AC999');
});

test('review payload without vessel fields yields no draft and no invention', () => {
  const result = ownerDraftFromReviewPayload({rawText: 'ID: 01871663045 Md.Samir 1950/-food bill'});
  assert.equal(result.text, null);
  assert.ok(result.gaps.includes('MISSING_MOTHER_VESSEL'));
  assert.ok(result.gaps.includes('MISSING_LIGHTER_VESSEL'));
});

test('timestamp-derived draft stays identical to the record-derived draft', () => {
  const timestamp = '2026-11-03T20:30:00Z';
  const fromTimestamp = renderOwnerDraft({
    motherVessel: 'M.V. Union-Odyssey',
    lighterVessel: 'M.V. Fardin-7',
    masterMobile: '+8801911428354',
    destination: '',
    timestamp,
  });
  const fromRecord = ownerDraftFromRecord({
    motherVessel: 'Union-Odyssey',
    lighterVessel: 'Fardin-7',
    masterMobile: '+8801911428354',
    sourceTimestamp: timestamp,
  });
  assert.equal(fromRecord.text, fromTimestamp);
});
