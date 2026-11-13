import assert from 'node:assert/strict';
import test from 'node:test';
import {buildMotherClusters, editDistance, canonicalNormalise} from '../../lib/vessel-canonical.ts';

const aliasesFor = (name, clusters) => clusters.find((c) => c.name === name)?.aliases ?? [];

test('existing variants consolidate to the highest-use spelling', () => {
  const clusters = buildMotherClusters([
    {name: 'BELFORTE', count: 23},
    {name: 'BEL FORTE', count: 3},
    {name: 'BELL FORTE', count: 1},
    {name: 'UNION ODYSSEY', count: 13},
    {name: 'UNION UDYSSY', count: 3},
    {name: 'BELIYAMATO', count: 9},
    {name: 'BELYAMATO', count: 9},
  ]);
  assert.deepEqual(aliasesFor('BELFORTE', clusters).sort(), ['BEL FORTE', 'BELL FORTE']);
  assert.deepEqual(aliasesFor('UNION ODYSSEY', clusters), ['UNION UDYSSY']);
  assert.deepEqual(aliasesFor('BELYAMATO', clusters), ['BELIYAMATO']);
});

test('three code-point edits match, four do not', () => {
  const three = buildMotherClusters([{name: 'VESSEL ABC', count: 10}, {name: 'VESSEL XYZ', count: 1}]);
  assert.deepEqual(aliasesFor('VESSEL ABC', three), ['VESSEL XYZ']);
  const four = buildMotherClusters([{name: 'VESSEL ABCD', count: 10}, {name: 'VESSEL WXYZ', count: 1}]);
  assert.deepEqual(aliasesFor('VESSEL ABCD', four), []);
});

test('different vessel numbers are never merged', () => {
  const clusters = buildMotherClusters([{name: 'SHIP 1', count: 10}, {name: 'SHIP 2', count: 5}]);
  assert.deepEqual(aliasesFor('SHIP 1', clusters), []);
  assert.equal(editDistance('SHIP1', 'SHIP2'), 1);
});

test('leading zero in a number is treated as the same number', () => {
  const clusters = buildMotherClusters([{name: 'WAN MING 1', count: 5}, {name: 'WAN MINH 01', count: 4}]);
  assert.deepEqual(aliasesFor('WAN MING 1', clusters), ['WAN MINH 01']);
});

test('short names are not fuzzy-merged', () => {
  const clusters = buildMotherClusters([{name: 'AB 1', count: 5}, {name: 'AB 2', count: 4}]);
  assert.deepEqual(aliasesFor('AB 1', clusters), []);
});

test('no transitive merge beyond the chosen canonical', () => {
  const clusters = buildMotherClusters([
    {name: 'OCEAN STAR', count: 10},
    {name: 'OCEAN STAR X', count: 5},
    {name: 'OCEAN STAR XXXX', count: 2},
  ]);
  assert.deepEqual(aliasesFor('OCEAN STAR', clusters), ['OCEAN STAR X']);
  assert.deepEqual(aliasesFor('OCEAN STAR XXXX', clusters), []);
});

test('unicode-aware normalization and distance', () => {
  assert.equal(canonicalNormalise('M.V. বেল্টোকিও (CARGO)'), 'বেল্টোকিও');
  assert.equal(editDistance('বেল্টোকিও', 'বেল্টোকিও'), 0);
});
