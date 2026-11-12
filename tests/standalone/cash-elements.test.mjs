// Element-based Cash parser tests (operator rule).
// Pure function tests: no database, no network, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCashElements, nationalMobile} from '../../lib/cash-elements.mjs';

const parsed = (text) => parseCashElements(text);

test('operator example 1: ID + name + payout + (N) + slash amount', () => {
  const r = parsed('ID: 01581138565 Al.Jubayer Ahmmed-Alif 01401520054(N) 3000/-Salay');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01581138565', '01401520054']);
  assert.equal(r.amountMinor, 300000);
  assert.equal(r.nameHint, 'Al.Jubayer Ahmmed-Alif');
  assert.equal(r.method, 'nagad');
  assert.equal(r.ambiguous, false);
});

test('operator example 2: name before mobile, dashes, slash amount', () => {
  const r = parsed('ID: Al.Jubayer-Ahmmed-Alif 01581138565(N)----3000/---');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01581138565']);
  assert.equal(r.amountMinor, 300000);
  assert.equal(r.nameHint, 'Al.Jubayer-Ahmmed-Alif');
});

test('operator example 3: dashed mobile, lowercase id, bare amount', () => {
  const r = parsed('iD : 01581-138565al.Jubayer Ahmmed-alif 01401520054(n) 3000');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01581138565', '01401520054']);
  assert.equal(r.amountMinor, 300000);
  assert.equal(r.nameHint, 'al.Jubayer Ahmmed-alif');
});

test('operator example 4: mixed separators, bare amount with trailing dash', () => {
  const r = parsed('Id:01581138565 Al-jubayer.Ahmmed-Alif   01401520054  (N)-3000-');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01581138565', '01401520054']);
  assert.equal(r.amountMinor, 300000);
  assert.equal(r.nameHint, 'Al-jubayer.Ahmmed-Alif');
});

test('operator example 5: no ID keyword, minimal format', () => {
  const r = parsed('Just 01712345678 some name 500');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01712345678']);
  assert.equal(r.amountMinor, 50000);
  assert.equal(r.nameHint, 'some name');
  assert.equal(r.methodInferred, true);
  assert.equal(r.method, null);
});

test('operator example 6: minimal name + amount', () => {
  const r = parsed('01712345678  Rahim  2500/-');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01712345678']);
  assert.equal(r.amountMinor, 250000);
  assert.equal(r.nameHint, 'Rahim');
});

test('no mobile → not a cash payment', () => {
  assert.equal(parsed('Hello how are you'), null);
  assert.equal(parsed('ID: 12345 some name 3000'), null);
});

test('forwarded sender-name prefix line does not break parsing', () => {
  const r = parsed('Karim:\n01712345678 John 5000');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01712345678']);
  assert.equal(r.amountMinor, 500000);
  assert.equal(r.nameHint, 'John');
});

test('three or more distinct mobiles are ambiguous, never guessed', () => {
  const r = parsed('ID: 01712345678 Rahim 01812345678 Karim 01912345678 (B) 500/-');
  assert.ok(r);
  assert.equal(r.ambiguous, true);
});

test('cancellation is flagged, never auto-posted', () => {
  const r = parsed('01712345678 Rahim 2500/- cancel');
  assert.ok(r);
  assert.equal(r.cancelled, true);
});

test('name before two adjacent mobiles is accepted', () => {
  const r = parsed('Md.Nurun Nabi 01920547773 01770807812(B) 1200/-');
  assert.ok(r);
  assert.deepEqual(r.mobiles, ['01920547773', '01770807812']);
  assert.equal(r.amountMinor, 120000);
  assert.equal(r.nameHint, 'Md.Nurun Nabi');
});

test('nationalMobile normalises every mobile form', () => {
  assert.equal(nationalMobile('01581138565'), '01581138565');
  assert.equal(nationalMobile('01581-138565'), '01581138565');
  assert.equal(nationalMobile('+8801581138565'), '01581138565');
  assert.equal(nationalMobile('8801581138565'), '01581138565');
  assert.equal(nationalMobile('008801581138565'), '01581138565');
  assert.equal(nationalMobile('12345'), null);
});

test('Bangla method markers are recognised', () => {
  const r = parsed('01712345678 Rahim (নগদ) 2500/-');
  assert.ok(r);
  assert.equal(r.method, 'nagad');
  assert.equal(r.methodInferred, false);
});
