// Pure release-slip parser tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReleaseSlips, isReleaseSlip, parseUnstructuredRelease} from '../../lib/release-slip.ts';

const SLIP = `---(Escort Release)---
Mother Vessel: M.V. Poavosa-Wisdom
Lighter Vessel: M.V. Munsi-Deowsn
Master mobile:-01920-257491
Destination: Landing Ghat Kanchpur
Escort Name: Al-Amin
Escort mobile:-01888-619535
Start: 27/10/26-((N)
End: .05/11/26-(D)
Total day:-9-day
Food bill:-1350/-`;

test('release slip extracts vessel, escort, dates, shift and food evidence', () => {
  assert.equal(isReleaseSlip(SLIP), true);
  const [block] = parseReleaseSlips(SLIP);
  assert.equal(block.fields.motherVessel, 'Poavosa-Wisdom');
  assert.equal(block.fields.lighterVessel, 'Munsi-Deowsn');
  assert.equal(block.fields.escortMobile, '01888619535');
  assert.equal(block.fields.startDate, '2026-10-27');
  assert.equal(block.fields.startShift, 'N');
  assert.equal(block.fields.endDate, '2026-11-05');
  assert.equal(block.fields.endShift, 'D');
  assert.equal(block.fields.totalDays, 9);
  assert.equal(block.fields.foodBillMinor, 135000);
  assert.deepEqual(block.reasons, []);
});

test('label-only release message is accepted when mobile and end date exist', () => {
  const text = 'Escort Name: Test\nEscort mobile: 01812345678\nStart: 01/11/26 (D)\nEnd: 05/11/26 (N)';
  const [block] = parseReleaseSlips(text);
  assert.equal(block.fields.escortMobile, '01812345678');
  assert.equal(block.fields.endDate, '2026-11-05');
  assert.equal(block.fields.endShift, 'N');
});

test('incomplete release never becomes clean evidence', () => {
  const [block] = parseReleaseSlips('Escort Release\nEscort mobile: 01812345678\nEnd: 05/11/26');
  assert.ok(block.reasons.includes('RELEASE_SHIFT_UNRESOLVED'));
});

test('ordinary order text is not a release slip', () => {
  assert.equal(isReleaseSlip('Mother Vessel: MV Test\nLighter Vessel: L-1\nMaster mobile: 01911111111'), false);
});

test('Bangla release labels are recognized', () => {
  const text = 'এসকর্ট রিলিজ\nমাদার ভেসেল: এম.ভি. টেস্ট\nলাইটার ভেসেল: এল-১\nএসকর্ট নাম: টেস্ট\nএসকর্ট মোবাইল: 01812345678\nশুরু: 01/11/26 (D)\nরিলিজ তারিখ: 05/11/26 (N)';
  const [block] = parseReleaseSlips(text);
  assert.equal(block.fields.escortMobile, '01812345678');
  assert.equal(block.fields.startDate, '2026-11-01');
  assert.equal(block.fields.endDate, '2026-11-05');
  assert.equal(block.fields.endShift, 'N');
  assert.equal(block.fields.motherVessel, 'টেস্ট');
});

// --- Unstructured release-group evidence (real production samples) ---------

test('unstructured release: empty message stays empty and review-only', () => {
  const evidence = parseUnstructuredRelease('   ');
  assert.equal(evidence.kind, 'EMPTY');
  assert.ok(evidence.reasons.includes('EMPTY_MESSAGE'));
  assert.equal(evidence.fields.escortMobile, null);
});

test('unstructured release: food-bill message extracts amount, escort and no release', () => {
  const evidence = parseUnstructuredRelease(
    'ID: 01871663045 Md.Samir 01717909181(B) 1950/-food bill dukani bkash no',
  );
  assert.equal(evidence.kind, 'FOOD_BILL');
  assert.ok(evidence.kinds.includes('FOOD_BILL'));
  assert.equal(evidence.fields.escortMobile, '01871663045');
  assert.equal(evidence.fields.escortName, 'Md.Samir');
  assert.equal(evidence.fields.foodBillMinor, 195000);
  assert.ok(evidence.reasons.includes('FOOD_BILL_NOT_AUTO_POSTED'));
  assert.equal(evidence.fields.cancelDate, null);
});

test('unstructured release: replacement message is classified and not auto-applied', () => {
  const evidence = parseUnstructuredRelease(
    'ID: 01871663045 Md.Samir 01871663045(B) (Relaced man)--- অফিসে আসার গাড়ি ভাড়া',
  );
  assert.equal(evidence.kind, 'REPLACEMENT');
  assert.ok(evidence.kinds.includes('REPLACEMENT'));
  assert.equal(evidence.fields.escortMobile, '01871663045');
  assert.ok(evidence.reasons.includes('REPLACEMENT_NOT_AUTO_APPLIED'));
});

test('unstructured release: Ship-Cancaled block extracts full cancellation evidence', () => {
  const text = `===( Ship-Cancaled)===
 Mather v.s. :-M.v. Poavosa-Wisdom
Righter v.s. :- Deowan-Jobayer
Master mobile:- 01711-327593
Escort name:- Md.Samir
Escort mobile:- 01871-663045
Start date:- 25-10-2026-(N)
Canceled date:- 07-11-2026-(D)
( 13-day-1950/- food bill)`;
  const evidence = parseUnstructuredRelease(text);
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

test('unstructured release: inline -Cancaled lighter name is cleaned but flagged', () => {
  const evidence = parseUnstructuredRelease(
    'D: 01920547773 Md.Nurun Nabi 01815282644(B)  Righter v.s.:-Othoi-Cancaled, ব্যাচেল অথৈ থেকে নেমে ঘুডে করে ভেসেল খাতিজা খাতুনে উঠছে বুট ভাড়া',
  );
  assert.equal(evidence.kind, 'CANCELLATION');
  assert.equal(evidence.fields.lighterVessel, 'Othoi');
  assert.ok(evidence.reasons.includes('LIGHTER_NAME_HAS_CANCEL_SUFFIX'));
  assert.equal(evidence.fields.escortMobile, '01920547773');
});

test('unstructured release: ordinary release chatter stays OTHER', () => {
  const evidence = parseUnstructuredRelease('Please check the release.');
  assert.equal(evidence.kind, 'OTHER');
  assert.deepEqual(evidence.kinds, []);
});
