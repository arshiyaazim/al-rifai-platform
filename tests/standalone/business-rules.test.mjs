// Shared normalization and identity-level rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMobile, phoneForms, sameMobile, normalizeVesselName, vesselKey,
  normalizePersonName, nameSimilarity, looksLikeRelease, RULE_VERSION, DUPLICATE_WINDOWS,
} from '../../lib/business-rules.mjs';
import {classifyIdentity, mayAttachAutomatically, requiresReview} from '../../lib/identity-resolution.mjs';

test('phone normalization accepts Bengali digits, country codes, hyphens and spacing', () => {
  for (const value of ['01959122300', '০১৯৫৯১২২৩০০', '01959-122300', '+8801959122300', '8801959122300', '+88 01959 122300']) {
    assert.equal(normalizeMobile(value), '+8801959122300', value);
  }
  assert.equal(normalizeMobile('01958122300'), '+8801958122300');
  assert.notEqual(normalizeMobile('01959122300'), normalizeMobile('01958122300'));
  assert.equal(normalizeMobile('12345'), null);
});

test('phone forms support exact comparison without fuzzy matching', () => {
  const forms = phoneForms('+8801959122300');
  assert.ok(forms.includes('01959122300'));
  assert.ok(forms.includes('8801959122300'));
  assert.equal(sameMobile('01959-122300', '+8801959122300'), true);
  assert.equal(sameMobile('01959122300', '01958122300'), false);
});

test('vessel names normalize Latin and Bangla prefixes without merging distinct names', () => {
  assert.equal(normalizeVesselName('M.V. Poavosa-Wisdom'), 'Poavosa-Wisdom');
  assert.equal(normalizeVesselName('এম.ভি. টেস্ট'), 'টেস্ট');
  assert.equal(vesselKey('MV  Ocean  Star'), 'ocean star');
  assert.notEqual(vesselKey('Ocean Star'), vesselKey('Ocean Star 2'));
});

test('person names strip titles and use token overlap only as evidence', () => {
  assert.equal(normalizePersonName('MD: Shah Alam'), 'shah alam');
  assert.equal(normalizePersonName('Mohammad Rahim Uddin'), 'rahim uddin');
  assert.ok(nameSimilarity('Md Rahim Uddin', 'Rahim Uddin') >= 0.99);
  assert.ok(nameSimilarity('Rahim Uddin', 'Karim Mia') === 0);
});

test('identity levels preserve review boundaries', () => {
  assert.equal(classifyIdentity({exactPhone: true}), 'EXACT');
  assert.equal(classifyIdentity({verifiedAlias: true}), 'VERIFIED_ALIAS');
  assert.equal(classifyIdentity({contextSignals: 2}), 'CONTEXT_SUPPORTED');
  assert.equal(classifyIdentity({contextSignals: 1}), 'AMBIGUOUS');
  assert.equal(classifyIdentity({conflicting: true, exactPhone: true}), 'AMBIGUOUS');
  assert.equal(classifyIdentity({}), 'UNRESOLVED');
  assert.equal(mayAttachAutomatically('EXACT'), true);
  assert.equal(mayAttachAutomatically('VERIFIED_ALIAS'), true);
  assert.equal(requiresReview('CONTEXT_SUPPORTED'), true);
  assert.equal(requiresReview('UNRESOLVED'), true);
});

test('rule version and duplicate windows are explicit', () => {
  assert.match(RULE_VERSION, /^alrifai-rules-/);
  assert.equal(DUPLICATE_WINDOWS.cashEmployeeAmountDays, 7);
  assert.equal(DUPLICATE_WINDOWS.vesselNearDuplicateDays, 1);
  assert.equal(looksLikeRelease('---(Escort Release)---'), true);
  assert.equal(looksLikeRelease('Mother Vessel: MV Test'), false);
});
