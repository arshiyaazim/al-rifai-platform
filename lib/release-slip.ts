// AL-RIFA'I — Escort Release Slip parser (pure, no database access).
//
// Real authorized release slips use this shape:
//
//   ---(Escort Release)---
//   Mother Vessel: M.V. ...
//   Lighter Vessel: M.V. ...
//   Master mobile: 019...
//   Destination: ...
//   Escort Name: ...
//   Escort mobile: 018...
//   Start: 27/10/26-((N)
//   End: 05/11/26-(D)
//   Total day: 9-day
//   Food bill: 1350/-
//
// The parser only extracts evidence. Matching and any program update stay in the
// router, which must refuse ambiguous matches and send them to review.

export type ReleaseSlipBlock = {
  blockKey: string;
  /** Every escort number on the slip; fields.escortMobile is the first. */
  escortMobiles: string[];
  fields: {
    motherVessel: string | null;
    lighterVessel: string | null;
    masterMobile: string | null;
    destination: string | null;
    escortName: string | null;
    escortMobile: string | null;
    startDate: string | null;
    startShift: 'D' | 'N' | null;
    endDate: string | null;
    endShift: 'D' | 'N' | null;
    totalDays: number | null;
    foodBillMinor: number | null;
  };
  reasons: string[];
};

const bengali = (value: string) =>
  value.replace(/[০-৯]/g, (digit) => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)));

const phone = (value: string | null | undefined): string | null => phones(value)[0] ?? null;

/**
 * Every Bangladeshi mobile in a field. A slip may carry two numbers on one
 * label ("01937-539700/01405-847642"); the first is the primary escort number
 * and the rest are kept as alternates.
 */
const phones = (value: string | null | undefined): string[] => {
  // Join digit runs first: "01937-539700/01405-847642" must yield two numbers,
  // and "01776-790425" must yield one, not two fragments.
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  const found = digits.match(/01[3-9][0-9]{8}/g) ?? [];
  return [...new Set(found)];
};

const date = (value: string | null | undefined): string | null => {
  const match = /(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})/.exec(String(value ?? ''));
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const month = Number(match[2]);
  const day = Number(match[1]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
};

const shift = (value: string | null | undefined): 'D' | 'N' | null => {
  const match = /\(?\s*([DN])\s*\)?/i.exec(String(value ?? ''));
  return match ? (match[1].toUpperCase() as 'D' | 'N') : null;
};

const money = (value: string | null | undefined): number | null => {
  const match = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*\/-/.exec(String(value ?? ''));
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
};

function grab(text: string, label: RegExp): string | null {
  const match = label.exec(text);
  return match?.[1]?.replace(/^[\s\-–—:]+/, '').trim() || null;
}

const vessel = (value: string | null): string | null =>
  value
    ? value
        .trim()
        .replace(/^[-–—:\s]+/, '')
        .replace(/^\s*(?:m\.?\s*v\.?|এম\s*\.?\s*ভি\s*\.?)\s*/i, '')
        .trim() || null
    : null;

function parseBlock(block: string, index: number): ReleaseSlipBlock {
  const text = bengali(block).replace(/\r/g, '');
  const startRaw = grab(text, /^\s*(?:Start(?:ing)?\s*(?:date)?|শুরু(?:র\s*তারিখ)?)\s*[:\-]\s*([^\n]+)/im);
  const endRaw = grab(text, /^\s*(?:End|Release\s*Date|Release|শেষ\s*(?:তারিখ)?|রিলিজ\s*(?:তারিখ)?)\s*(?:date)?\s*[:\-]\s*([^\n]+)/im);
  const fields: ReleaseSlipBlock['fields'] = {
    motherVessel: vessel(grab(text, /^\s*(?:Mother\s*Vessel|মাদার\s*ভেসেল)\s*[:\-]\s*([^\n]+)/im)),
    lighterVessel: vessel(grab(text, /^\s*(?:Lighter\s*Vessel|লাইটার\s*ভেসেল)\s*[:\-]\s*([^\n]+)/im)),
    masterMobile: phone(grab(text, /^\s*(?:Master\s*(?:mobile|number|no)|মাস্টার\s*মোবাইল)\s*[:\-]\s*([^\n]+)/im)),
    destination: grab(text, /^\s*(?:Destination|Ghat|গন্তব্য)\s*[:\-]\s*([^\n]+)/im),
    escortName: grab(text, /^\s*(?:Escort\s*Name|এসকর্ট\s*নাম)\s*[:\-]\s*([^\n]+)/im),
    escortMobile: (() => {
      const raw = grab(text, /^\s*(?:Escort\s*(?:mobile|number|no)|এসকর্ট\s*মোবাইল)\s*[:\-]\s*([^\n]+)/im);
      return phones(raw)[0] ?? null;
    })(),
    startDate: date(startRaw),
    startShift: shift(startRaw),
    endDate: date(endRaw),
    endShift: shift(endRaw),
    totalDays: (() => {
      const raw = grab(text, /^\s*(?:Total\s*(?:duty\s*)?day|মোট\s*(?:ডিউটি\s*)?দিন)[\s:\-]*([0-9]+)/im);
      const value = raw ? Number(raw) : null;
      return value !== null && Number.isInteger(value) && value > 0 && value < 1000 ? value : null;
    })(),
    // The food bill often shares the line with the day count:
    // "Totsl duty day: -09-day food bill: -1350/-".
    foodBillMinor: money(grab(text, /(?:Food\s*bill|খাবার\s*বিল)\s*[:\-]?\s*([^\n]+)/i)),
  };
  const reasons: string[] = [];
  if (!fields.escortMobile) reasons.push('ESCORT_MOBILE_UNRESOLVED');
  if (!fields.endDate) reasons.push('RELEASE_DATE_UNRESOLVED');
  if (!fields.endShift) reasons.push('RELEASE_SHIFT_UNRESOLVED');
  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) reasons.push('RELEASE_BEFORE_START');
  const escortMobiles = phones(grab(text, /^\s*(?:Escort\s*(?:mobile|number|no)|এসকর্ট\s*মোবাইল)\s*[:\-]\s*([^\n]+)/im));
  return {blockKey: `release-block-${index}`, escortMobiles, fields, reasons};
}

const normalizeReleaseText = (text: string): string =>
  bengali(String(text ?? '')).replace(/\r/g, '')
    .replace(/\bRelace\b/gi, 'Release')
    .replace(/\bMasage\b/gi, 'Message')
    .replace(/\bMahter\s*\.?\s*v\.?\s*s\.?/gi, 'Mother Vessel')
    .replace(/\bRighter\s*\.?\s*v\.?\s*s\.?/gi, 'Lighter Vessel')
    .replace(/\bTotsl\b/gi, 'Total')
    .replace(/\btska\b/gi, 'taka')
    .replace(/\bFood\s*bil\b/gi, 'Food bill')
    .replace(/Name\s+off?\s+Mother\s+Vessel/gi, 'Mother Vessel')
    .replace(/Name\s+off?\s+Lighter\s+Vessel/gi, 'Lighter Vessel')
    .replace(/Name\s+off?\s+Escort/gi, 'Escort Name');

export function parseReleaseSlips(text: string): ReleaseSlipBlock[] {
  const normalized = normalizeReleaseText(text);
  if (!/(?:^|\n)\s*-*\s*\(?\s*(?:Escort\s*Release|এসকর্ট\s*রিলিজ|রিলিজ)\s*\)?\s*-*(?:\n|$)/im.test(normalized)) {
    // Label-only release messages are accepted only when both an escort mobile
    // and an explicit end/release date are present.
    if (!/^\s*(?:Escort\s*(?:mobile|number)|এসকর্ট\s*মোবাইল)\s*[:\-]/im.test(normalized) ||
        !/^\s*(?:End|Release\s*Date|শেষ|রিলিজ\s*তারিখ)\s*(?:date)?\s*[:\-]/im.test(normalized)) {
      return [];
    }
    return [parseBlock(normalized, 0)];
  }
  const parts = normalized
    .split(/\n\s*-*\s*\(?\s*(?:Escort\s*Release|এসকর্ট\s*রিলিজ|রিলিজ)\s*\)?\s*-*\s*\n/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.map(parseBlock);
}

export function isReleaseSlip(text: string): boolean {
  return parseReleaseSlips(text).length > 0;
}

// ---------------------------------------------------------------------------
// Unstructured release-group evidence
//
// Real release-group traffic also contains free-form cancellation, replacement
// and food-bill messages that are not valid Escort Release slips. They must
// never auto-release a program, but they can still carry usable evidence. This
// pure parser extracts that evidence and classifies the message so the router
// can attach it to a review item and match candidate programs read-only.
// ---------------------------------------------------------------------------

export type UnstructuredReleaseKind =
  | 'EMPTY'
  | 'CANCELLATION'
  | 'TRANSFER'
  | 'REPLACEMENT'
  | 'FOOD_BILL'
  | 'OTHER';

export type UnstructuredReleaseEvidence = {
  kind: UnstructuredReleaseKind;
  kinds: UnstructuredReleaseKind[];
  fields: {
    motherVessel: string | null;
    motherVesselRaw: string | null;
    lighterVessel: string | null;
    lighterVesselRaw: string | null;
    masterMobile: string | null;
    escortName: string | null;
    escortMobile: string | null;
    mobileCandidates: string[];
    startDate: string | null;
    startShift: 'D' | 'N' | null;
    cancelDate: string | null;
    cancelShift: 'D' | 'N' | null;
    totalDays: number | null;
    foodBillMinor: number | null;
  };
  matchedTokens: string[];
  reasons: string[];
};

const CANCELLATION_PATTERN = /can+[cs]?[ae]l+ed|can+cel+ation|ক্যান্সেল|বাতিল|cancaled|cancelled|cancellation/i;
const TRANSFER_PATTERN = /নেমে|উঠছে|উঠে|বদলি|transfer|shifted|re-?board/i;
const REPLACEMENT_PATTERN = /replac|relac|replaced|replacement|বদল|পরিবর্ত|রিপ্লেস/i;
const FOOD_PATTERN = /food\s*bill|খাবার\s*বিল|খাবার|বিল/i;
const TRANSPORT_PATTERN = /গাড়ি\s*ভাড়া|বুট\s*ভাড়া|ভাড়া|car\s*rent|boat\s*rent/i;

const cancelSuffix = (value: string): {clean: string; hadSuffix: boolean} => {
  const cleaned = value.replace(/[\s\-–—]*\(?\s*(?:can+[cs]?[ae]l+ed|cancaled|cancelled|বাতিল)\s*\)?\s*$/i, '').trim();
  return {clean: cleaned || value, hadSuffix: cleaned !== value};
};

/** Cut free-text tails (commas, Bangla commentary) off an inline vessel label. */
const vesselToken = (value: string | null): string | null => {
  if (!value) return null;
  const cut = value
    .split(/[,;]/)[0]
    .replace(/\s+[ঀ-৿].*$/, '')
    .trim();
  return cut || null;
};

function inlineIdentity(text: string): {
  name: string | null;
  mobiles: string[];
} {
  const line = /^\s*(?:ID|D)\s*[:\-]\s*([^\n]+)/im.exec(text)?.[1];
  if (!line) return {name: null, mobiles: []};
  const matches = [...line.matchAll(/(?:\+?880|0)[\s-]?1[3-9](?:[\s-]?\d){8}(?!\d)/g)];
  const mobiles = matches
    .map((match) => phone(match[0]))
    .filter((value): value is string => Boolean(value));
  let name: string | null = null;
  if (matches.length) {
    const first = matches[0];
    const start = (first.index ?? 0) + first[0].length;
    const end = matches[1]?.index ?? line.length;
    name = line.slice(start, end)
      .replace(/\((?:B|b)\)/g, '')
      .replace(/^\s*[-,:;]+|[\s,;:-]+$/g, '')
      .split(/[-–—]/)[0]
      .trim() || null;
  }
  return {name, mobiles};
}

function foodBill(text: string): number | null {
  const labelled = grab(text, /^\s*(?:Food\s*bill|খাবার\s*বিল)\s*[:\-]\s*([^\n]+)/im);
  const labelledAmount = money(labelled);
  if (labelledAmount !== null) return labelledAmount;
  const inline = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*\/-\s*(?:food\s*bill|খাবার\s*বিল)/i.exec(text);
  const parenthesised = /\(\s*[0-9]{1,3}\s*-?\s*day\s*-\s*([0-9][0-9,]*)\s*\/-/i.exec(text);
  const raw = inline?.[1] ?? parenthesised?.[1] ?? null;
  if (raw === null) return null;
  const amount = Number(raw.replaceAll(',', ''));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

export function parseUnstructuredRelease(text: string): UnstructuredReleaseEvidence {
  const normalized = normalizeReleaseText(text);
  const trimmed = normalized.trim();
  const inline = inlineIdentity(normalized);
  const motherRaw = grab(normalized, /(?:^|\s)(?:mather|mother)\s*(?:v\.?\s*s\.?|vessel|ভেসেল)?\s*[:\-]\s*([^\n]+)/im);
  const lighterRaw = grab(normalized, /(?:^|\s)(?:righter|lighter)\s*(?:v\.?\s*s\.?|vessel|ভেসেল)?\s*[:\-]\s*([^\n]+)/im);
  const motherCleaned = vessel(vesselToken(motherRaw));
  const lighterCleanedRaw = vessel(vesselToken(lighterRaw));
  const lighterCancel = lighterCleanedRaw ? cancelSuffix(lighterCleanedRaw) : {clean: null, hadSuffix: false};
  const startRaw = grab(normalized, /^\s*(?:Start(?:ing)?\s*(?:date)?|শুরু(?:র\s*তারিখ)?)\s*[:\-]\s*([^\n]+)/im);
  const cancelRaw = grab(normalized, /^\s*(?:Cancel+ed|cancel+ation|বাতিল)\s*(?:date)?\s*[:\-]\s*([^\n]+)/im);
  const explicitEscortMobile = phone(grab(normalized, /^\s*(?:Escort\s*(?:mobile|number|no)|এসকর্ট\s*মোবাইল)\s*[:\-]\s*([^\n]+)/im));
  const mobileCandidates = [...new Set([
    ...(explicitEscortMobile ? [explicitEscortMobile] : []),
    ...inline.mobiles,
  ])];
  const totalDayParenthesised = /\(\s*([0-9]{1,3})\s*-?\s*day/i.exec(normalized)?.[1];
  const totalDayLabelled = grab(normalized, /^\s*(?:Total\s*(?:duty\s*)?day|মোট\s*(?:ডিউটি\s*)?দিন)[\s:\-]*([0-9]+)/im);
  const totalDaysRaw = totalDayLabelled ?? totalDayParenthesised ?? null;
  const totalDays = totalDaysRaw !== null && Number(totalDaysRaw) > 0 && Number(totalDaysRaw) < 1000
    ? Number(totalDaysRaw)
    : null;

  const kinds: UnstructuredReleaseKind[] = [];
  const matchedTokens: string[] = [];
  const cancelMatch = CANCELLATION_PATTERN.exec(normalized);
  if (cancelMatch) { kinds.push('CANCELLATION'); matchedTokens.push(cancelMatch[0]); }
  const transferMatch = TRANSFER_PATTERN.exec(normalized);
  if (transferMatch) { kinds.push('TRANSFER'); matchedTokens.push(transferMatch[0]); }
  const replaceMatch = REPLACEMENT_PATTERN.exec(normalized);
  if (replaceMatch) { kinds.push('REPLACEMENT'); matchedTokens.push(replaceMatch[0]); }
  const foodMatch = FOOD_PATTERN.exec(normalized);
  if (foodMatch) { kinds.push('FOOD_BILL'); matchedTokens.push(foodMatch[0]); }
  const transportMatch = TRANSPORT_PATTERN.exec(normalized);
  if (transportMatch) matchedTokens.push(transportMatch[0]);

  const resolvedFoodBill = foodBill(normalized);
  // A transfer is more specific than a cancellation: "Othoi-Cancaled ... boarded
  // another vessel" is both, but the actionable outcome is a transfer. Both
  // kinds are retained in `kinds` so a reviewer sees the whole picture.
  const kind: UnstructuredReleaseKind = !trimmed
    ? 'EMPTY'
    : kinds.includes('TRANSFER')
      ? 'TRANSFER'
      : kinds.includes('CANCELLATION')
        ? 'CANCELLATION'
        : kinds.includes('REPLACEMENT')
          ? 'REPLACEMENT'
          : resolvedFoodBill !== null || kinds.includes('FOOD_BILL')
            ? 'FOOD_BILL'
            : 'OTHER';

  const fields: UnstructuredReleaseEvidence['fields'] = {
    motherVessel: motherCleaned,
    motherVesselRaw: motherRaw,
    lighterVessel: lighterCancel.clean,
    lighterVesselRaw: lighterRaw,
    masterMobile: phone(grab(normalized, /^\s*(?:Master\s*(?:mobile|number|no)|মাস্টার\s*মোবাইল)\s*[:\-]\s*([^\n]+)/im)),
    escortName: grab(normalized, /^\s*(?:Escort\s*Name|এসকর্ট\s*নাম)\s*[:\-]\s*([^\n]+)/im) ?? inline.name,
    escortMobile: explicitEscortMobile ?? inline.mobiles[0] ?? null,
    mobileCandidates,
    startDate: date(startRaw),
    startShift: shift(startRaw),
    cancelDate: date(cancelRaw),
    cancelShift: shift(cancelRaw),
    totalDays,
    foodBillMinor: resolvedFoodBill,
  };

  const reasons: string[] = [];
  if (kind === 'EMPTY') reasons.push('EMPTY_MESSAGE');
  if (!fields.motherVessel && !fields.lighterVessel && !fields.escortMobile) reasons.push('NO_VESSEL_IDENTITY');
  if (!fields.escortMobile) reasons.push('NO_ESCORT_MOBILE');
  if (mobileCandidates.length > 1) reasons.push('MULTIPLE_MOBILES');
  if (lighterCancel.hadSuffix) reasons.push('LIGHTER_NAME_HAS_CANCEL_SUFFIX');
  if (kinds.includes('CANCELLATION')) reasons.push('CANCELLATION_NOT_AUTO_APPLIED');
  if (kinds.includes('TRANSFER')) reasons.push('TRANSFER_NOT_AUTO_APPLIED');
  if (kinds.includes('REPLACEMENT')) reasons.push('REPLACEMENT_NOT_AUTO_APPLIED');
  if (fields.foodBillMinor !== null) reasons.push('FOOD_BILL_NOT_AUTO_POSTED');

  return {kind, kinds, fields, matchedTokens, reasons};
}

