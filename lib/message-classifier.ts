// AL-RIFA'I — Phase 3: WhatsApp message domain classifier.
//
// Pure rules only: no database, no network, no configuration. Classifies a
// staged WhatsApp message into a business domain (CASH, VESSEL, UNKNOWN) based
// on its text content and the configured purpose of the chat it arrived in.
//
// The classifier never establishes authority: conversation authorization is
// enforced separately by the router using whatsapp_chats.authorized and the
// account's admin_jids. A message classified as CASH or VESSEL is only routed
// when the chat purpose and sender role permit it.

export type Domain = 'CASH' | 'VESSEL' | 'UNKNOWN';

export type ClassificationResult = {
  domain: Domain;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
};

/** Bengali digit normalization for consistent matching. */
const bengaliDigits = (s: string) =>
  s.replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));

/** Cash-related keywords (Bangla + English). */
const CASH_KEYWORDS = [
  'payment', 'পেমেন্ট', 'বিকাশ', 'bkash', 'নগদ', 'nagad', 'রকেট', 'rocket',
  'বাইঙ', 'bank', 'টাকা', 'amount', 'অনুপাত', 'প Ridge', 'প Ridge',
  'পজল', 'দিন', 'মজুরি', 'দপ্তর', 'খরচ', 'আয়', 'ব্যয়',
];

/** Vessel-related keywords (Bangla + English). */
const VESSEL_KEYWORDS = [
  'মাদার', 'mother vessel', 'মাদার ভেসেল', 'মাঁ', 'লাইটার', 'lighter vessel',
  'লাইটার ভেসেল', 'মászter', 'master', 'গন্তব্য', 'destination', 'এসকর্ট',
  'escort', 'শিফট', 'shift', 'তারিখ', 'date', 'ডেট', 'ক্যাপাসিটি', 'capacity',
  'ক্যাপ', 'ইমপোর্ট', 'importer', 'কার্গো', 'cargo', 'অ্যাসাইনমেন্ট',
  'assignment', 'রিলিজ', 'release',
];

function hasKeyword(text: string, keywords: string[]): boolean {
  const normalized = bengaliDigits(text.toLowerCase());
  return keywords.some((k) => normalized.includes(k.toLowerCase()));
}

export function looksLikeCash(text: string): boolean {
  const normalized = bengaliDigits(text.toLowerCase())
    // Bangla cash markers are the same signal as (B)/(N).
    .replace(/\(\s*বি(?:কাশ)?\s*\)/g, '(b)')
    .replace(/\(\s*(?:এন|নগদ)\s*\)/g, '(n)');
  // Explicit payment block marker: "ID: <phone> <name> <payout>(B/N) <amount>/-"
  const paymentBlock = /ID\s*[:=]?\s*[0-9+\s-]{10,}/i.test(normalized);
  // Amount pattern: number followed by /- or taka
  const amountPattern = /[\d,]+\s*(\.\d{1,2})?\s*\/\-/i.test(normalized);
  // Method markers (case-insensitive: the text is already lower-cased)
  const methodMarker = /\(\s*[bn]\s*\)/i.test(normalized);
  // Cash keywords
  const keyword = hasKeyword(normalized, CASH_KEYWORDS);

  // A complete payment block with an explicit method marker is recognizable
  // cash intent even when the amount is missing; it must go to review, not be
  // silently ignored. Authority is still enforced by the router.
  if (paymentBlock && methodMarker) return true;
  if (paymentBlock && amountPattern) return true;
  if (methodMarker && amountPattern && keyword) return true;
  if (keyword && amountPattern && methodMarker) return true;
  return false;
}

export function looksLikeVessel(text: string): boolean {
  const normalized = bengaliDigits(text.toLowerCase());
  // Vessel order typically has mother vessel + lighter vessel
  const motherVessel = /mother\s+vessel|মাদার\s*ভেসেল/i.test(normalized);
  const lighterVessel = /lighter\s+vessel|লাইটার\s*ভেসেল/i.test(normalized);
  // Or M.V. pattern + master mobile
  const mvPattern = /m\s*\.\s*v\s*\.\s*\S/i.test(normalized);
  const masterMobile = /master\s*(mobile|no|মোবাইল)?|মাস্টার\s*মোবাইল/i.test(normalized);
  // Vessel keywords
  const keyword = hasKeyword(normalized, VESSEL_KEYWORDS);

  if (motherVessel && lighterVessel) return true;
  if (mvPattern && masterMobile) return true;
  if (keyword && (motherVessel || lighterVessel || mvPattern)) return true;
  return false;
}

/**
 * Classify a message into a domain.
 *
 * @param text - The message text content (may be empty or null)
 * @param chatPurpose - The configured purpose of the chat (ORDERS, CASH, BOTH)
 * @returns ClassificationResult with domain, confidence and reasons
 */
export function classifyDomain(
  text: string | null | undefined,
  chatPurpose: string | null | undefined,
): ClassificationResult {
  const reasons: string[] = [];
  const content = text ?? '';

  const isCash = looksLikeCash(content);
  const isVessel = looksLikeVessel(content);

  if (isCash && isVessel) {
    // Ambiguous: both cash and vessel signals present
    return {
      domain: 'UNKNOWN',
      confidence: 'LOW',
      reasons: ['AMBIGUOUS_CASH_AND_VESSEL_SIGNALS'],
    };
  }

  if (isCash) {
    reasons.push('CASH_KEYWORDS_MATCHED');
    const purposeAllows =
      chatPurpose === 'CASH' || chatPurpose === 'BOTH';
    return {
      domain: purposeAllows ? 'CASH' : 'UNKNOWN',
      confidence: purposeAllows ? 'HIGH' : 'MEDIUM',
      reasons: purposeAllows
        ? reasons
        : [...reasons, 'CHAT_PURPOSE_DOES_NOT_ALLOW_CASH'],
    };
  }

  if (isVessel) {
    reasons.push('VESSEL_KEYWORDS_MATCHED');
    const purposeAllows =
      chatPurpose === 'ORDERS' || chatPurpose === 'BOTH';
    return {
      domain: purposeAllows ? 'VESSEL' : 'UNKNOWN',
      confidence: purposeAllows ? 'HIGH' : 'MEDIUM',
      reasons: purposeAllows
        ? reasons
        : [...reasons, 'CHAT_PURPOSE_DOES_NOT_ALLOW_VESSEL'],
    };
  }

  return {
    domain: 'UNKNOWN',
    confidence: 'LOW',
    reasons: ['NO_DOMAIN_SIGNALS'],
  };
}

const classifier = { classifyDomain, looksLikeCash, looksLikeVessel };
export default classifier;
