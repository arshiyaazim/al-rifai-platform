// AL-RIFA'I — identity decision levels.
//
// EXACT             canonical employee mobile / verified JID match
// VERIFIED_ALIAS    a previously confirmed alias or alternate number
// CONTEXT_SUPPORTED multiple consistent signals, but not enough authority for
//                   an automatic financial/duty attachment
// AMBIGUOUS         conflicting or incomplete evidence
// UNRESOLVED        no reliable identity
//
// Only EXACT and VERIFIED_ALIAS may be used to attach a financial record
// automatically. CONTEXT_SUPPORTED and below must go to review.

export const IDENTITY_LEVELS = Object.freeze([
  'EXACT',
  'VERIFIED_ALIAS',
  'CONTEXT_SUPPORTED',
  'AMBIGUOUS',
  'UNRESOLVED',
]);

const RANK = Object.freeze({EXACT: 5, VERIFIED_ALIAS: 4, CONTEXT_SUPPORTED: 3, AMBIGUOUS: 2, UNRESOLVED: 1});

export function identityRank(level) {
  return RANK[level] ?? 0;
}

export function classifyIdentity({exactPhone = false, verifiedAlias = false, contextSignals = 0, conflicting = false}) {
  if (conflicting) return 'AMBIGUOUS';
  if (exactPhone) return 'EXACT';
  if (verifiedAlias) return 'VERIFIED_ALIAS';
  if (contextSignals >= 2) return 'CONTEXT_SUPPORTED';
  if (contextSignals === 1) return 'AMBIGUOUS';
  return 'UNRESOLVED';
}

export function mayAttachAutomatically(level) {
  return level === 'EXACT' || level === 'VERIFIED_ALIAS';
}

export function requiresReview(level) {
  return !mayAttachAutomatically(level);
}
