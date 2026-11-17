// E2.6: resilient names, conversational answers, context memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateNameVariants, toBengali} from '../../lib/standalone/ai-assistant-names.ts';
import {
  classifyPersonMessage, extractPersonName, formatMany, formatNoMatch, formatOne,
  inheritedIntent, isBarePersonQuery, isPronounQuery, resolvePerson,
} from '../../lib/standalone/ai-assistant-person.ts';
import {
  CONTEXT_TTL_MS, decodeContext, encodeContext,
} from '../../lib/standalone/ai-assistant-context.ts';
import {fallbackMessage} from '../../lib/standalone/ai-assistant-functions.ts';

const NOW = new Date('2026-11-17T10:00:00Z');

test('variant generator covers Bengali and Latin spelling pairs', () => {
  const bengali = generateNameVariants('নেয়াজ');
  for (const expected of ['neyaj', 'neyaz', 'niyaz', 'niyaj']) {
    assert.ok(bengali.latin.includes(expected), `missing ${expected}`);
  }
  assert.ok(bengali.all.includes('নেয়াজ'));
  assert.ok(bengali.bengali.includes('নিয়াজ'));

  const latin = generateNameVariants('Neyaz');
  assert.ok(latin.bengali.includes('নেয়াজ'), latin.bengali.join(','));
  assert.equal(toBengali('Neyaz'), 'নেয়াজ');
  assert.equal(toBengali('Niyaz'), 'নিয়াজ');
  assert.ok(generateNameVariants('Neyaz').all.length <= 40);
});

test('intent regression: name questions reach employee search / cash summary', () => {
  const search = classifyPersonMessage('নেয়াজ নামক কোনো এমপ্লোয়ি আছে?');
  assert.deepEqual(search, {kind: 'search', query: 'নেয়াজ'});
  const money = classifyPersonMessage('আমার নেয়াজ নামক এমপ্লোয়ির হিসাব জানা দরকার');
  assert.deepEqual(money, {kind: 'money', query: 'নেয়াজ'});
  const dated = classifyPersonMessage('গতকালে ক্যাশ সামারি দাও');
  assert.equal(dated, null, 'dated summaries must not be treated as a person');
  assert.equal(extractPersonName('নেয়াজ নামক কোনো এমপ্লোয়ি আছে?'), 'নেয়াজ');
});

test('resolution merges variants, dedupes by mobile and ranks the exact name first', async () => {
  const fake = async (term) => {
    if (term === 'neyaz') {
      return [
        {employee_mobile: '+8801700000001', preferred_name: 'Neyaz Uddin', designation: null},
        {employee_mobile: '+8801700000002', preferred_name: 'Neyaz Ahmed', designation: null},
      ];
    }
    if (term === 'neyaj') return [{employee_mobile: '+8801700000001', preferred_name: 'Neyaz Uddin', designation: null}];
    return [{employee_mobile: '+8801700000003', preferred_name: 'Niyaz Khan', designation: null}];
  };
  const resolution = await resolvePerson('Neyaz', fake);
  assert.equal(resolution.matches.length, 3);
  assert.ok(resolution.matches[0].preferred_name.startsWith('Neyaz'), resolution.matches[0].preferred_name);
  assert.ok(resolution.matches.some((match) => match.preferred_name === 'Neyaz Uddin'));
  assert.ok(resolution.variants.includes('neyaz'));
});

test('conversational answers: no-match lists tried variants; one asks for confirmation', () => {
  const none = formatNoMatch('নেয়াজ', ['নেয়াজ', 'neyaj', 'neyaz', 'niyaz']);
  assert.match(none.text, /'নেয়াজ' নামে কাউকে পাইনি/);
  assert.match(none.text, /neyaj\/neyaz\/niyaz/);
  assert.match(none.text, /মোবাইল নম্বর দিন/);
  assert.equal(none.actions[0].href, '/employees');

  const one = formatOne('নেয়াজ', {employee_mobile: '+8801712345678', preferred_name: 'Neyaz Uddin', designation: null});
  assert.match(one.text, /Neyaz Uddin/);
  assert.equal(one.chips?.[0]?.label, 'হ্যাঁ');
  assert.ok(one.chips?.[1]?.label.includes('অন্য'));

  const many = formatMany('নেয়াজ', [
    {employee_mobile: '+8801700000001', preferred_name: 'Neyaz Uddin', designation: null},
    {employee_mobile: '+8801700000002', preferred_name: 'Neyaz Ahmed', designation: null},
  ]);
  assert.match(many.text, /২ জন মিলেছে/);
  assert.ok(many.actions.some((action) => action.label.startsWith('View ')));
});

test('context tokens round-trip, expire after 10 minutes and keep flow ids', () => {
  const token = encodeContext({domain: 'cash', from: '2026-11-16', to: '2026-11-16', at: NOW.getTime()});
  const decoded = decodeContext(token, NOW);
  assert.equal(decoded?.domain, 'cash');
  assert.equal(decoded?.from, '2026-11-16');
  assert.equal(decodeContext('cash-payment', NOW)?.flow, 'cash-payment');
  const later = new Date(NOW.getTime() + CONTEXT_TTL_MS + 1000);
  assert.equal(decodeContext(token, later), null);
  assert.equal(decodeContext('garbage', NOW), null);
});

test('bare follow-ups inherit the previous domain (cash + "নেয়াজের?")', () => {
  assert.equal(isBarePersonQuery('নেয়াজের?'), true);
  assert.equal(isBarePersonQuery('গতকালের ক্যাশ'), false);
  assert.equal(isPronounQuery('ওর হিসাব'), true);
  const prior = decodeContext(encodeContext({domain: 'cash', from: '2026-11-16', to: '2026-11-16', at: NOW.getTime()}), NOW);
  assert.deepEqual(inheritedIntent(prior, 'নেয়াজের?'), {
    domain: 'cash', name: 'নেয়াজ', from: '2026-11-16', to: '2026-11-16',
  });
  const employee = decodeContext(encodeContext({domain: 'employee', employeeMobile: '+8801712345678', at: NOW.getTime()}), NOW);
  assert.equal(inheritedIntent(employee, 'ওর হিসাব')?.mobile, '+8801712345678');
  assert.equal(inheritedIntent(prior, 'গতকালের ক্যাশ সামারি'), null);
  assert.equal(inheritedIntent(null, 'নেয়াজের?'), null);
});

test('localised fallback never returns the old English dashboard line', () => {
  assert.match(fallbackMessage('নেয়াজ নামক কোনো এমপ্লোয়ি আছে?'), /বুঝতে পারিনি/);
  assert.match(fallbackMessage('hello there'), /could not understand/i);
  assert.doesNotMatch(fallbackMessage('hello'), /I can help you find information from your dashboards/);
});
