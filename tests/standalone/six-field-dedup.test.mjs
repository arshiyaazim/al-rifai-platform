import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateSixFieldDedup, scoreSixFields} from '../../lib/pipelines/vessel/six-field-dedup.ts';

const base = {
  id: 'p1', motherVessel: 'BELTOKYO', lighterVessel: 'SANAM-2', masterMobile: '01752775656',
  escortMobile: '+8801771435111', startDate: '2026-11-10', startShift: 'D', state: 'CONFIRMED',
};

test('6/6 match is a duplicate', () => {
  const result = evaluateSixFieldDedup({
    motherVessel: 'M.V. Beltokyo', lighterVessel: 'MV Sanam 2', masterMobile: '+880 1752-775656',
    escortMobile: '01771435111', startDate: '2026-11-10', startShift: 'D',
  }, [base]);
  assert.equal(scoreSixFields({
    motherVessel: 'M.V. Beltokyo', lighterVessel: 'MV Sanam 2', masterMobile: '+880 1752-775656',
    escortMobile: '01771435111', startDate: '2026-11-10', startShift: 'D',
  }, base).matchCount, 6);
  assert.equal(result.action, 'DUPLICATE');
});

test('different escort mobile is ESCORT_CHANGE', () => {
  const result = evaluateSixFieldDedup({
    motherVessel: 'BELTOKYO', lighterVessel: 'SANAM-2', masterMobile: '01752775656',
    escortMobile: '01711111111', startDate: '2026-11-10', startShift: 'D',
  }, [base]);
  assert.equal(result.action, 'ESCORT_CHANGE');
  assert.equal(result.candidateId, 'p1');
});

test('same escort with a new date is UPDATE', () => {
  const result = evaluateSixFieldDedup({
    motherVessel: 'BELTOKYO', lighterVessel: 'SANAM-2', masterMobile: '01752775656',
    escortMobile: '01771435111', startDate: '2026-11-12', startShift: 'D',
  }, [base]);
  assert.equal(result.action, 'UPDATE');
});

test('different vessel is NEW', () => {
  const result = evaluateSixFieldDedup({
    motherVessel: 'OTHER SHIP', lighterVessel: 'OTHER LIGHTER', masterMobile: '01752775656',
    escortMobile: '01771435111', startDate: '2026-11-10', startShift: 'D',
  }, [base]);
  assert.equal(result.action, 'NEW');
});
