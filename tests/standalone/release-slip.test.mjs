// Pure release-slip parser tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReleaseSlips, isReleaseSlip} from '../../lib/release-slip.ts';

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
