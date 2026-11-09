// Regression tests for the seven historical RELEASE_UNSTRUCTURED production
// review items (2026-11-07, chat 120363408741101070@g.us, account wa-01).
//
// These are the exact raw texts preserved in production; no production record
// is read or modified here. The tests pin the improved parser's classification
// and extracted evidence so a future change cannot silently regress them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUnstructuredRelease} from '../../lib/release-slip.ts';

export const HISTORICAL_ITEMS = [
  {
    id: 'rev_da390319d03a40ee96cc',
    sourceMessageId: 'AC3488314AD921520B5A1EE1CFA9251E',
    rawText: '',
  },
  {
    id: 'rev_d7c87e77d704407faef4',
    sourceMessageId: 'AC9A437A46EBBFEFDA399BB87CD9D7B9',
    rawText: 'ID: 01871663045 Md.Samir 01717909181(B) 1950/-food bill dukani bkash no',
  },
  {
    id: 'rev_3aa77fefc2b149729516',
    sourceMessageId: 'ACC5DD5C76F37BF9BF362B6B784C4863',
    rawText: '',
  },
  {
    id: 'rev_c0ea50971ac848f58882',
    sourceMessageId: 'AC71913DBA55B1DF4DCC22411A32869D',
    rawText: 'ID: 01871663045 Md.Samir 01871663045(B) (Relaced man)--- অফিসে আসার গাড়ি ভাড়া',
  },
  {
    id: 'rev_b58f76987982422cba05',
    sourceMessageId: 'AC5E4583FD833F41878A80A1690D020B',
    rawText: '===( Ship-Cancaled)===\n Mather v.s. :-M.v. Poavosa-Wisdom\nRighter v.s. :- Deowan-Jobayer\nMaster mobile:- 01711-327593\nEscort name:- Md.Samir\nEscort mobile:- 01871-663045\nStart date:- 25-10-2026-(N)\nCanceled date:- 07-11-2026-(D)\n( 13-day-1950/- food bill)',
  },
  {
    id: 'rev_4b58b161b354453397a2',
    sourceMessageId: 'AC6A4C96C9161244232ABCCB9C4BA6BB',
    rawText: '',
  },
  {
    id: 'rev_5176f0749f274608b1a4',
    sourceMessageId: 'AC59A06D190824A611BAF4BD5F3B8B9D',
    rawText: 'D: 01920547773 Md.Nurun Nabi 01815282644(B)  Righter v.s.:-Othoi-Cancaled, ব্যাচেল অথৈ থেকে নেমে ঘুডে করে ভেসেল খাতিজা খাতুনে উঠছে বুট ভাড়া',
  },
];

const parse = (index) => parseUnstructuredRelease(HISTORICAL_ITEMS[index].rawText);

test('three empty historical messages stay EMPTY with no invented evidence', () => {
  for (const index of [0, 2, 5]) {
    const evidence = parse(index);
    assert.equal(evidence.kind, 'EMPTY');
    assert.deepEqual(evidence.kinds, []);
    assert.ok(evidence.reasons.includes('EMPTY_MESSAGE'));
    assert.equal(evidence.fields.escortMobile, null);
    assert.equal(evidence.fields.foodBillMinor, null);
    assert.equal(evidence.fields.cancelDate, null);
  }
});

test('food-bill item extracts amount and escort without any release evidence', () => {
  const evidence = parse(1);
  assert.equal(evidence.kind, 'FOOD_BILL');
  assert.deepEqual(evidence.kinds, ['FOOD_BILL']);
  assert.equal(evidence.fields.foodBillMinor, 195000);
  assert.equal(evidence.fields.escortMobile, '01871663045');
  assert.equal(evidence.fields.escortName, 'Md.Samir');
  assert.equal(evidence.fields.cancelDate, null);
  assert.ok(evidence.reasons.includes('MULTIPLE_MOBILES'));
  assert.ok(evidence.reasons.includes('FOOD_BILL_NOT_AUTO_POSTED'));
});

test('replacement item is classified and never auto-applied', () => {
  const evidence = parse(3);
  assert.equal(evidence.kind, 'REPLACEMENT');
  assert.ok(evidence.kinds.includes('REPLACEMENT'));
  assert.equal(evidence.fields.escortMobile, '01871663045');
  assert.equal(evidence.fields.escortName, 'Md.Samir');
  assert.ok(evidence.reasons.includes('REPLACEMENT_NOT_AUTO_APPLIED'));
});

test('Ship-Cancaled item extracts full structured cancellation evidence', () => {
  const evidence = parse(4);
  assert.equal(evidence.kind, 'CANCELLATION');
  assert.ok(evidence.kinds.includes('CANCELLATION'));
  assert.ok(evidence.kinds.includes('FOOD_BILL'));
  assert.equal(evidence.fields.motherVessel, 'Poavosa-Wisdom');
  assert.equal(evidence.fields.lighterVessel, 'Deowan-Jobayer');
  assert.equal(evidence.fields.masterMobile, '01711327593');
  assert.equal(evidence.fields.escortName, 'Md.Samir');
  assert.equal(evidence.fields.escortMobile, '01871663045');
  assert.equal(evidence.fields.startDate, '2026-10-25');
  assert.equal(evidence.fields.startShift, 'N');
  assert.equal(evidence.fields.cancelDate, '2026-11-07');
  assert.equal(evidence.fields.cancelShift, 'D');
  assert.equal(evidence.fields.totalDays, 13);
  assert.equal(evidence.fields.foodBillMinor, 195000);
  assert.ok(evidence.reasons.includes('CANCELLATION_NOT_AUTO_APPLIED'));
  assert.ok(evidence.reasons.includes('FOOD_BILL_NOT_AUTO_POSTED'));
});

test('Othoi-Cancaled transfer is both cancellation and transfer, never auto-applied', () => {
  const evidence = parse(6);
  assert.equal(evidence.kind, 'TRANSFER');
  assert.ok(evidence.kinds.includes('CANCELLATION'));
  assert.ok(evidence.kinds.includes('TRANSFER'));
  assert.equal(evidence.fields.lighterVessel, 'Othoi');
  assert.equal(evidence.fields.escortMobile, '01920547773');
  assert.equal(evidence.fields.escortName, 'Md.Nurun Nabi');
  assert.ok(evidence.reasons.includes('LIGHTER_NAME_HAS_CANCEL_SUFFIX'));
  assert.ok(evidence.reasons.includes('CANCELLATION_NOT_AUTO_APPLIED'));
  assert.ok(evidence.reasons.includes('TRANSFER_NOT_AUTO_APPLIED'));
  assert.ok(evidence.reasons.includes('MULTIPLE_MOBILES'));
});

test('no historical item ever produces an auto-applied end/release date', () => {
  for (let index = 0; index < HISTORICAL_ITEMS.length; index += 1) {
    const evidence = parse(index);
    // The parser only exposes cancelDate (evidence), never an endDate that a
    // release slip could apply.
    assert.equal('endDate' in evidence.fields, false);
    assert.equal('endShift' in evidence.fields, false);
  }
});
