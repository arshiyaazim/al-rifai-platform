// AL-RIFA'I — Phase 3 Increment 5: Review Queue UI helpers.
//
// Pure, dependency-free helpers shared by server components, client forms and
// tests. Nothing here touches the database, the session or the network, so it
// is safe to import from a client component. Authorization decisions made here
// are only for *display*; the API and services enforce the same rules again.

export type ReviewActor = {id: string; role: 'ADMIN' | 'USER'};

export type ReviewItemLike = {
  id: string;
  domain: string;
  category?: string | null;
  state: string;
  submitted_by: string;
  target_ref?: string | null;
};

export type ReviewActions = {
  canApprove: boolean;
  canReject: boolean;
  canCorrect: boolean;
  canWithdraw: boolean;
  canMarkDuplicate: boolean;
};

export const REVIEW_CATEGORIES = [
  {value: 'UNKNOWN_IDENTITY', label: 'Unknown identity', tone: 'danger'},
  {value: 'AMBIGUOUS_DOMAIN', label: 'Ambiguous domain', tone: 'warn'},
  {value: 'INCOMPLETE_CASH_INSTRUCTION', label: 'Incomplete cash instruction', tone: 'warn'},
  {value: 'CASH_DUPLICATE_CANDIDATE', label: 'Cash duplicate candidate', tone: 'warn'},
  {value: 'INCOMPLETE_VESSEL_ORDER', label: 'Incomplete vessel order', tone: 'warn'},
  {value: 'VESSEL_DUPLICATE_CANDIDATE', label: 'Vessel duplicate candidate', tone: 'warn'},
  {value: 'AMBIGUOUS_VESSEL_CONFIRMATION', label: 'Ambiguous vessel confirmation', tone: 'warn'},
  {value: 'UNMATCHED_VESSEL_ASSIGNMENT', label: 'Unmatched vessel assignment', tone: 'warn'},
  {value: 'EXTRACTION_FAILED', label: 'Extraction failed', tone: 'danger'},
  {value: 'PROCESSING_ERROR', label: 'Processing error', tone: 'danger'},
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number]['value'];

export const REVIEW_DOMAINS = [
  {value: 'CASH', label: 'Cash'},
  {value: 'PROGRAM', label: 'Vessel program'},
  {value: 'EMPLOYEE', label: 'Employee'},
  {value: 'ATTENDANCE', label: 'Attendance'},
] as const;

export const REVIEW_STATES = [
  {value: 'PENDING', label: 'Pending'},
  {value: 'RESOLVED', label: 'Resolved'},
  {value: 'REJECTED', label: 'Rejected'},
  {value: 'ALL', label: 'All'},
] as const;

export const REVIEW_CATEGORY_VALUES = REVIEW_CATEGORIES.map((entry) => entry.value);

export function reviewCategoryLabel(value: string | null | undefined): string {
  if (!value) return 'Uncategorised';
  return REVIEW_CATEGORIES.find((entry) => entry.value === value)?.label ?? value;
}

export function reviewCategoryTone(value: string | null | undefined): 'neutral' | 'ok' | 'warn' | 'danger' | 'brand' {
  return REVIEW_CATEGORIES.find((entry) => entry.value === value)?.tone ?? 'neutral';
}

export function reviewDomainLabel(value: string | null | undefined): string {
  return REVIEW_DOMAINS.find((entry) => entry.value === value)?.label ?? value ?? '—';
}

export function reviewStateLabel(value: string | null | undefined): string {
  if (!value) return '—';
  if (value === 'RESOLVED') return 'Resolved';
  if (value === 'WITHDRAWN') return 'Withdrawn';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function reviewStateTone(value: string | null | undefined): 'neutral' | 'ok' | 'warn' | 'danger' | 'brand' {
  if (value === 'APPROVED') return 'ok';
  if (value === 'REJECTED') return 'danger';
  if (value === 'PENDING') return 'warn';
  if (value === 'WITHDRAWN') return 'neutral';
  return 'brand';
}

/**
 * The single display-side authorization rule. The API re-checks the same
 * conditions (ADMIN, not the submitter, PENDING) before mutating anything.
 * A USER never sees approve/reject/correct controls, even on their own item.
 */
export function reviewActionsFor(actor: ReviewActor, item: ReviewItemLike): ReviewActions {
  const isAdmin = actor.role === 'ADMIN';
  const isSubmitter = actor.id === item.submitted_by;
  const isPending = item.state === 'PENDING';
  const canDecide = isAdmin && isPending && !isSubmitter;
  return {
    canApprove: canDecide,
    canReject: canDecide,
    canCorrect: canDecide,
    canWithdraw: isPending && isSubmitter,
    canMarkDuplicate: canDecide,
  };
}

export function canDecideReview(actor: ReviewActor, item: ReviewItemLike): boolean {
  return reviewActionsFor(actor, item).canApprove;
}

// ── payload readers ────────────────────────────────────────────────────────
type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
  const single = asString(value);
  return single ? [single] : [];
}

function pick(payload: Payload, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return null;
}

export type SourceEvidence = {
  messageId: string | null;
  chatJid: string | null;
  accountId: string | null;
  timestamp: string | null;
  senderJid: string | null;
  direction: string | null;
  rawText: string | null;
  parser: string | null;
  classification: string | null;
  parseReasons: string[];
  needsReviewerResolution: boolean;
  messageHref: string | null;
};

export function reviewSourceEvidence(item: {payload?: unknown; sourceMessageId?: string | null; sourceChatJid?: string | null; sourceAccountId?: string | null}): SourceEvidence {
  const payload = asPayload(item.payload);
  const fields = asPayload(payload.fields);
  const messageId = asString(item.sourceMessageId) ?? pick(payload, ['sourceMessageId', 'message_id', 'messageId']) ?? pick(fields, ['sourceMessageId', 'message_id']);
  const chatJid = asString(item.sourceChatJid) ?? pick(payload, ['sourceChatJid', 'chat_jid', 'chatJid']) ?? pick(fields, ['sourceChatJid', 'chat_jid']);
  const accountId = asString(item.sourceAccountId) ?? pick(payload, ['sourceAccountId', 'account_id', 'accountId']) ?? pick(fields, ['sourceAccountId', 'account_id']);
  const timestamp = pick(payload, ['sourceTimestamp', 'timestamp', 'source_timestamp']);
  const senderJid = pick(payload, ['senderJid', 'sender_jid']);
  const direction = pick(payload, ['direction']);
  const rawText = pick(payload, ['rawText', 'raw_text', 'text']);
  const parser = pick(payload, ['parser']);
  const classification = pick(payload, ['classification']);
  const parseReasons = asStringArray(payload.parseReasons ?? payload.reasons ?? fields.reasons);
  const needsReviewerResolution = payload.needsReviewerResolution === true
    || payload.needsReviewerCorrection === true
    || parseReasons.length > 0;
  return {
    messageId,
    chatJid,
    accountId,
    timestamp,
    senderJid,
    direction,
    rawText,
    parser,
    classification,
    parseReasons,
    needsReviewerResolution,
    messageHref: sourceMessageHref(messageId, chatJid, accountId),
  };
}

export type ExtractedField = {label: string; value: string};

const FIELD_LABELS: Record<string, string> = {
  motherVessel: 'Mother vessel (original)',
  originalMotherVessel: 'Mother vessel (original)',
  normalizedMotherVessel: 'Mother vessel (normalized)',
  lighterVessel: 'Lighter vessel (original)',
  originalLighterVessel: 'Lighter vessel (original)',
  normalizedLighterVessel: 'Lighter vessel (normalized)',
  masterMobile: 'Master mobile',
  destination: 'Destination',
  escortName: 'Escort name',
  escortMobile: 'Escort mobile',
  startDate: 'Start date',
  startShift: 'Start shift',
  endDate: 'End date',
  endShift: 'End shift',
  notes: 'Notes',
  employeeName: 'Employee / payee',
  employeeMobile: 'Employee mobile',
  payoutMobile: 'Payout mobile',
  method: 'Method',
  amountMinor: 'Amount (paisa)',
  amount: 'Amount',
  purpose: 'Purpose',
  accountId: 'Pay from account',
  preferredName: 'Preferred name',
  dutyType: 'Duty type',
  dutyDate: 'Duty date',
  hours: 'Hours',
  state: 'State',
  confirmationMessageId: 'Confirmation message ID',
  confirmationMessageHref: 'Confirmation message',
};

const FIELD_ORDER = Object.keys(FIELD_LABELS);

export function reviewExtractedFields(item: {domain?: string | null; payload?: unknown}): ExtractedField[] {
  const payload = asPayload(item.payload);
  const nested = asPayload(payload.fields);
  const extracted = asPayload(payload.extractedFields);
  const merged: Payload = {...nested, ...extracted, ...payload};
  const fields: ExtractedField[] = [];
  for (const key of FIELD_ORDER) {
    const value = asString(merged[key]);
    if (!value) continue;
    fields.push({label: FIELD_LABELS[key], value});
  }
  return fields;
}

/** Field-name → value map used to prefill correction forms. */
export function reviewExtractedFieldValues(item: {payload?: unknown}): Record<string, string> {
  const payload = asPayload(item.payload);
  const nested = asPayload(payload.fields);
  const extracted = asPayload(payload.extractedFields);
  const merged: Payload = {...nested, ...extracted, ...payload};
  const values: Record<string, string> = {};
  for (const key of FIELD_ORDER) {
    const value = asString(merged[key]);
    if (value) values[key] = value;
  }
  return values;
}

export type ReviewReason = {label: string; value: string};

export function reviewReasons(item: {payload?: unknown; decisionReason?: string | null}): ReviewReason[] {
  const payload = asPayload(item.payload);
  const reasons: ReviewReason[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string | null) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    reasons.push({label, value});
  };
  for (const reason of asStringArray(payload.reasons)) add('Router reason', reason);
  for (const reason of asStringArray(payload.parseReasons)) add('Parser reason', reason);
  for (const reason of asStringArray(payload.missingFields)) add('Missing field', reason);
  for (const reason of asStringArray(payload.conflicts)) add('Conflict', reason);
  for (const reason of asStringArray(payload.missingFields)) add('Missing field', reason);
  add('Review reason', asString(payload.reason) ?? asString(payload.reviewReason));
  add('Decision reason', item.decisionReason ?? null);
  return reasons;
}

export function reviewMissingFields(item: {payload?: unknown}): string[] {
  const payload = asPayload(item.payload);
  const values = [
    ...asStringArray(payload.missingFields),
    ...asStringArray(payload.missing),
    ...asStringArray(payload.parseReasons),
    ...asStringArray(payload.reasons),
    ...asStringArray(payload.conflicts),
  ];
  return [...new Set(values)];
}

export function reviewVesselNames(item: {payload?: unknown}): {original: string[]; normalized: string[]} {
  const payload = asPayload(item.payload);
  const fields = asPayload(payload.fields);
  const merged = {...fields, ...payload};
  const original = [
    asString(merged.originalMotherVessel),
    asString(merged.originalLighterVessel),
    asString(merged.motherVessel),
    asString(merged.lighterVessel),
  ].filter((value): value is string => Boolean(value));
  const normalized = [
    asString(merged.normalizedMotherVessel),
    asString(merged.normalizedLighterVessel),
  ].filter((value): value is string => Boolean(value));
  return {original: [...new Set(original)], normalized: [...new Set(normalized)]};
}

export function reviewConfirmationEvidence(item: {payload?: unknown; confirmationMessageId?: string | null}): {messageId: string | null; href: string | null} {
  const payload = asPayload(item.payload);
  const messageId = asString(item.confirmationMessageId)
    ?? pick(payload, ['confirmationMessageId', 'confirmation_message_id'])
    ?? pick(asPayload(payload.fields), ['confirmationMessageId', 'confirmation_message_id']);
  return {messageId, href: sourceMessageHref(messageId)};
}

export function reviewEscortConflict(item: {payload?: unknown}): string | null {
  const payload = asPayload(item.payload);
  return pick(payload, ['escortAssignmentConflict', 'escortConflict', 'assignmentConflict'])
    ?? asStringArray(payload.conflicts)[0]
    ?? null;
}

// ── links / formatting ─────────────────────────────────────────────────────
export function buildReviewHref(filters: Record<string, string | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && value !== 'ALL') params.set(key, value);
  }
  const query = params.toString();
  return query ? `/review?${query}` : '/review';
}

export function sourceMessageHref(messageId: string | null | undefined, chatJid?: string | null, accountId?: string | null): string | null {
  if (!messageId) return null;
  const params = new URLSearchParams({q: messageId});
  if (chatJid) params.set('chat', chatJid);
  if (accountId) params.set('account', accountId);
  return `/messages?${params.toString()}`;
}

export function formatReviewTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function formatReviewAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const minor = Number(value);
  if (!Number.isFinite(minor)) return String(value);
  return `৳${(minor / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}
