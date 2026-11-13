// WhatsApp "Export Chat" (.txt) parser.
//
// Handles both common envelopes:
//   12h: [11/10/26, 2:30:15 PM] Hridoy: BELTOKYO
//   24h: [10/11/2026, 14:30:15] Hridoy: BELTOKYO
//
// The parser is pure: no filesystem, database or network. It keeps every
// message body verbatim (including newlines) and reports what it skipped so an
// operator can see why a line did not become a message.

export type ParsedChatMessage = {
  timestamp: string;       // ISO 8601 with +06:00 (Asia/Dhaka, no DST)
  sender: string;
  body: string;
  line: number;
};

export type ChatParseResult = {
  messages: ParsedChatMessage[];
  skipped: number;
  rejected: Array<{line: number; text: string; reason: string}>;
};

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
const normaliseDigits = (value: string) =>
  value.replace(/[০-৯]/g, (char) => String(BENGALI_DIGITS.indexOf(char)));

const ENVELOPE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\]\s+([^:]+?):\s?([\s\S]*)$/i;
const MEDIA = /^(?:<media omitted>|(?:image|video|audio|document|sticker|gif|contact card)\s+omitted)$/i;
const SYSTEM_HINTS = [
  /messages and calls are end-to-end encrypted/i,
  /you were added/i,
  /created group/i,
  /changed the subject/i,
  /changed this group's icon/i,
  /joined using this group's invite link/i,
  /left$/i,
];

const pad = (value: number) => String(value).padStart(2, '0');

/** Convert a Dhaka wall-clock date/time to an ISO instant with +06:00. */
function dhakaIso(year: number, month: number, day: number, hour: number, minute: number, second: number): string | null {
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+06:00`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Reject 31/02-like impossible dates that Date would roll over.
  const check = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(parsed).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  if (Number(check.year) !== year || Number(check.month) !== month || Number(check.day) !== day) return null;
  return iso;
}

function parseStamp(rawDay: string, rawMonth: string, rawYear: string, rawHour: string, rawMinute: string,
  rawSecond: string | undefined, meridiem: string | undefined): string | null {
  const day = Number(normaliseDigits(rawDay));
  const month = Number(normaliseDigits(rawMonth));
  let year = Number(normaliseDigits(rawYear));
  if (rawYear.length <= 2) year += 2000;
  let hour = Number(normaliseDigits(rawHour));
  const minute = Number(normaliseDigits(rawMinute));
  const second = rawSecond ? Number(normaliseDigits(rawSecond)) : 0;
  if (meridiem) {
    const upper = meridiem.toUpperCase();
    if (hour < 1 || hour > 12) return null;
    if (upper === 'AM') hour = hour === 12 ? 0 : hour;
    if (upper === 'PM') hour = hour === 12 ? 12 : hour + 12;
  }
  return dhakaIso(year, month, day, hour, minute, second);
}

const cleanBody = (value: string) => value.replace(/^\u200e/, '').replace(/\r$/, '');

export function parseWhatsAppChat(text: string): ChatParseResult {
  const messages: ParsedChatMessage[] = [];
  const rejected: ChatParseResult['rejected'] = [];
  let skipped = 0;
  let current: ParsedChatMessage | null = null;

  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = normaliseDigits(rawLine);
    const match = ENVELOPE.exec(line);
    if (!match) {
      // A line without an envelope is either a continuation of the previous
      // message or an unparseable header. Continuations are appended verbatim.
      if (current) {
        current.body += `\n${cleanBody(line)}`;
        return;
      }
      if (!line.trim()) return;
      if (SYSTEM_HINTS.some((pattern) => pattern.test(line))) { skipped += 1; return; }
      rejected.push({line: lineNumber, text: line.slice(0, 300), reason: 'TIMESTAMP_OR_SENDER_MISSING'});
      return;
    }

    const [, day, month, year, hour, minute, second, meridiem, senderRaw, bodyRaw] = match;
    const sender = senderRaw.trim();
    const body = cleanBody(bodyRaw);
    if (!sender) {
      skipped += 1;
      current = null;
      return;
    }
    if (MEDIA.test(body.trim())) {
      skipped += 1;
      current = null;
      return;
    }
    if (SYSTEM_HINTS.some((pattern) => pattern.test(body))) {
      skipped += 1;
      current = null;
      return;
    }
    const timestamp = parseStamp(day, month, year, hour, minute, second, meridiem);
    if (!timestamp) {
      rejected.push({line: lineNumber, text: line.slice(0, 300), reason: 'TIMESTAMP_INVALID'});
      current = null;
      return;
    }
    current = {timestamp, sender, body, line: lineNumber};
    messages.push(current);
  });

  return {messages, skipped, rejected};
}

/** Stable message key used by the import API for de-duplication. */
export function chatMessageKey(message: Pick<ParsedChatMessage, 'timestamp' | 'sender' | 'body'>): string {
  const normal = `${message.timestamp}|${message.sender.trim().toLowerCase()}|${message.body.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  // Node's crypto is only used by server callers; keep the parser dependency-free
  // by returning the normalised text and let the API hash it.
  return normal;
}
