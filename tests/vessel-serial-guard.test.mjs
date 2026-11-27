import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVesselNames} from '../lib/vessel-match.ts';

test('different trailing vessel serials are never variants', () => {
  assert.equal(compareVesselNames('GLORY OF SRINAGAR 4', 'Glory of Srinagar 9'), 'DIFFERENT');
  assert.equal(compareVesselNames('CITY 14', 'CITY 15'), 'DIFFERENT');
});

test('a leading zero does not split the same serial', () => {
  assert.notEqual(compareVesselNames('WAN MING 1', 'WAN MINH 01'), 'DIFFERENT');
});
