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

const phone = (value: string | null | undefined): string | null => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  const national = digits.replace(/^(?:880|00880)/, '0');
  return /^01[3-9][0-9]{8}$/.test(national) ? national : null;
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
  return match?.[1]?.trim() || null;
}

const vessel = (value: string | null): string | null =>
  value ? value.replace(/^\s*(?:m\.?\s*v\.?|এম\s*\.?\s*ভি\s*\.?)\s*/i, '').trim() || null : null;

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
    escortMobile: phone(grab(text, /^\s*(?:Escort\s*(?:mobile|number|no)|এসকর্ট\s*মোবাইল)\s*[:\-]\s*([^\n]+)/im)),
    startDate: date(startRaw),
    startShift: shift(startRaw),
    endDate: date(endRaw),
    endShift: shift(endRaw),
    totalDays: (() => {
      const raw = grab(text, /^\s*(?:Total\s*(?:duty\s*)?day|মোট\s*(?:ডিউটি\s*)?দিন)[\s:\-]*([0-9]+)/im);
      const value = raw ? Number(raw) : null;
      return value !== null && Number.isInteger(value) && value > 0 && value < 1000 ? value : null;
    })(),
    foodBillMinor: money(grab(text, /^\s*(?:Food\s*bill|খাবার\s*বিল)\s*[:\-]\s*([^\n]+)/im)),
  };
  const reasons: string[] = [];
  if (!fields.escortMobile) reasons.push('ESCORT_MOBILE_UNRESOLVED');
  if (!fields.endDate) reasons.push('RELEASE_DATE_UNRESOLVED');
  if (!fields.endShift) reasons.push('RELEASE_SHIFT_UNRESOLVED');
  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) reasons.push('RELEASE_BEFORE_START');
  return {blockKey: `release-block-${index}`, fields, reasons};
}

export function parseReleaseSlips(text: string): ReleaseSlipBlock[] {
  const normalized = bengali(String(text ?? '')).replace(/\r/g, '');
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
