// Deterministic release/conveyance evidence — the rule orchestrator.
//
// Everything here is a pure function over one WhatsApp message (or a small
// follow-up chain). It reuses the existing release parser for identity, food
// bill, conveyance amount and message-date handling, and adds only the date
// evidence that parser now exposes (stated end date, travel date, office return
// date). No business rule is re-implemented.
//
// Owner decisions it encodes:
//   * a missing travel date is NOT a reason to discard an otherwise valid
//     release (historical dates are not always provable);
//   * an amount without a verified date stays UNRESOLVED and is allocated to no
//     month;
//   * the arrival timestamp is only used as the release date because the
//     approved release rule says the slip is sent on the release day — for
//     conveyance it is never used as the travel date;
//   * nothing here posts, approves or settles Cash. `cashPosting` is always
//     false and no Cash module is imported.

import {parseMessage, statedDateOnLine, type MatchStatus} from './release-parser.ts';
import {normalizeEmployeeMobile} from './employee-program-validation.mjs';
import {dhakaLocalTime, isValidDutyDate, monthOf} from './shift-boundary.ts';

export type ExtractionStatus = 'COMPLETE' | 'PARTIAL' | 'UNRESOLVED_CONVEYANCE' | 'INVALID_DATES' | 'NO_EVIDENCE';
export type DateSource = 'STATED_END_DATE' | 'MESSAGE_TIMESTAMP';

export type ReleaseFact = {
  escortPhone: string;
  escortName: string | null;
  /** Release (duty end) date. Stated by the message when possible, else the message date. */
  releaseDate: string;
  releaseDateSource: DateSource;
  releaseShift: 'D' | 'N' | null;
  dutyDays: number | null;
  foodBillBdt: number | null;
  conveyanceAmountBdt: number | null;
  /** Date the travel actually happened, when the message states it. */
  conveyanceDate: string | null;
  /** Date the escort returned to the office, when the message states it. */
  officeReturnDate: string | null;
  evidenceMessageId: string;
  sourceTimestamp: string;
  sourceMessageIds: string[];
  extractionStatus: ExtractionStatus;
  ruleTrace: string[];
};

export type ExtractInput = {text: string; timestamp: string; messageId: string};

const unique = (values: string[]) => [...new Set(values)];

/**
 * Extract one fact per escort from one message. Same message twice yields
 * byte-identical facts (the function has no clock and no randomness).
 */
export function extractReleaseFacts(input: ExtractInput): ReleaseFact[] {
  const text = String(input?.text ?? '');
  const timestamp = String(input?.timestamp ?? '');
  const messageId = String(input?.messageId ?? '');
  if (!text || !timestamp || !messageId) return [];

  const payments = parseMessage(text, timestamp);
  return payments.map((payment) => {
    const rules = [...(payment.rules ?? [])];
    const stated = payment.statedReleaseDate;
    const releaseDate = stated ?? payment.endDate;
    const releaseDateSource: DateSource = stated ? 'STATED_END_DATE' : 'MESSAGE_TIMESTAMP';
    if (!stated) rules.push('R-MESSAGE-DATE');
    if (payment.conveyance !== null) rules.push('R-CONVEYANCE-AMOUNT');
    if (payment.amountBdt !== null) rules.push('R-FOOD-BILL');

    const conveyanceAmountBdt = payment.conveyance ?? null;
    const conveyanceDate = payment.conveyanceDate ?? null;
    const officeReturnDate = payment.officeReturnDate ?? null;

    let extractionStatus: ExtractionStatus;
    if (rules.includes('R-INVALID-STATED-DATE') || !isValidDutyDate(releaseDate)) {
      extractionStatus = 'INVALID_DATES';
    } else if (conveyanceAmountBdt !== null && (conveyanceDate || officeReturnDate)) {
      extractionStatus = 'COMPLETE';
    } else if (conveyanceAmountBdt !== null) {
      extractionStatus = 'UNRESOLVED_CONVEYANCE';
    } else {
      extractionStatus = 'PARTIAL';
    }

    return {
      escortPhone: payment.escortPhone,
      escortName: payment.escortName,
      releaseDate,
      releaseDateSource,
      releaseShift: payment.statedReleaseShift ?? payment.endShift,
      dutyDays: payment.dutyDays,
      foodBillBdt: payment.amountBdt,
      conveyanceAmountBdt,
      conveyanceDate,
      officeReturnDate,
      evidenceMessageId: messageId,
      sourceTimestamp: timestamp,
      sourceMessageIds: [messageId],
      extractionStatus,
      ruleTrace: unique(rules),
    };
  });
}

/** The month the conveyance is recognised in: the actual travel month, or null. */
export function conveyanceMonthOf(fact: ReleaseFact): string | null {
  // The return journey is the travel that settles the duty; when only a travel
  // date is stated, that date is used instead. Never the arrival timestamp.
  const date = fact.officeReturnDate ?? fact.conveyanceDate;
  if (!date || !isValidDutyDate(date)) return null;
  return monthOf(date);
}

export type MatchAssessment = {
  status: MatchStatus | 'PENDING_REVIEW';
  programId: string | null;
  confidence: 'high' | 'medium' | null;
  candidateIds?: string[];
  /** Roster context, when the caller has it. Used for cross-checks, never for guessing. */
  lighterVessel?: string | null;
  programStartDate?: string | null;
};

export type ReleaseDecision = {
  classification: 'CONFIRMED_RELEASE' | 'VERIFIED_CONVEYANCE' | 'PARTIAL_INFORMATION' | 'UNRESOLVED_CONVEYANCE' | 'NEEDS_REVIEW';
  /** The existing apply workflow remains the final authority; this is only the evidence gate. */
  releaseEligible: boolean;
  conveyance: {amountBdt: number | null; month: string | null; status: 'ALLOCATED' | 'UNRESOLVED' | 'NONE'};
  programId: string | null;
  reasons: string[];
  /** Structural guarantee: this module can never request a Cash posting. */
  cashPosting: false;
};

/**
 * Decide what this evidence supports. There is deliberately no path that
 * applies a release or allocates a month on ambiguous evidence.
 */
export function classifyReleaseEvent(fact: ReleaseFact, match: MatchAssessment): ReleaseDecision {
  const reasons: string[] = [];
  const month = conveyanceMonthOf(fact);
  const amount = fact.conveyanceAmountBdt;

  const conveyance: ReleaseDecision['conveyance'] = amount === null
    ? {amountBdt: null, month: null, status: 'NONE'}
    : month
      ? {amountBdt: amount, month, status: 'ALLOCATED'}
      : {amountBdt: amount, month: null, status: 'UNRESOLVED'};

  if (fact.extractionStatus === 'INVALID_DATES') reasons.push('DATE_EVIDENCE_INVALID');
  const travelDate = fact.officeReturnDate ?? fact.conveyanceDate;
  if (travelDate && isValidDutyDate(fact.releaseDate) && travelDate < fact.releaseDate) {
    reasons.push('DATE_CONFLICT_CONVEYANCE_BEFORE_RELEASE');
  }
  // A stated release date later than the slip's own arrival is not established
  // evidence; the approved rule is that the slip is sent on the release day.
  const messageDate = dhakaLocalTime(fact.sourceTimestamp)?.date ?? null;
  if (fact.releaseDateSource === 'STATED_END_DATE' && messageDate && fact.releaseDate > messageDate) {
    reasons.push('RELEASE_DATE_AFTER_MESSAGE');
  }
  if (match.status !== 'MATCHED' || !match.programId) {
    const candidates = match.candidateIds?.length ?? 0;
    reasons.push(candidates > 1 ? 'MULTIPLE_PROGRAM_CANDIDATES' : 'NO_PROGRAM_MATCH');
  }

  const blocked = reasons.length > 0;
  let classification: ReleaseDecision['classification'];
  if (blocked) classification = 'NEEDS_REVIEW';
  else if (conveyance.status === 'ALLOCATED') classification = 'VERIFIED_CONVEYANCE';
  else if (conveyance.status === 'UNRESOLVED') classification = 'UNRESOLVED_CONVEYANCE';
  else classification = fact.extractionStatus === 'PARTIAL' ? 'PARTIAL_INFORMATION' : 'CONFIRMED_RELEASE';

  return {
    classification,
    releaseEligible: !blocked,
    conveyance,
    programId: blocked ? null : match.programId,
    reasons,
    cashPosting: false,
  };
}

export type MergeKind = 'FOLLOW_UP' | 'CORRECTION';
export type MergeResult = {fact: ReleaseFact; reasons: string[]};

const mergeable = (prior: ReleaseFact, update: ReleaseFact) =>
  prior.escortPhone === update.escortPhone
  && Date.parse(update.sourceTimestamp) >= Date.parse(prior.sourceTimestamp);

/**
 * Attach a later message to an earlier one: a separate conveyance line, or a
 * correction. The release date is only taken from a message that states one
 * explicitly, so a later slip's arrival date can never silently rewrite it.
 */
export function mergeEvidence(prior: ReleaseFact, update: ReleaseFact, kind: MergeKind): MergeResult {
  const reasons: string[] = [];
  if (!mergeable(prior, update)) return {fact: prior, reasons: ['MERGE_NOT_RELATED_OR_OUT_OF_ORDER']};

  const fact: ReleaseFact = {
    ...prior,
    sourceMessageIds: unique([...prior.sourceMessageIds, update.evidenceMessageId]),
    ruleTrace: unique([...prior.ruleTrace, ...update.ruleTrace, kind === 'CORRECTION' ? 'R-CORRECTION' : 'R-FOLLOW_UP']),
  };

  if (update.releaseDateSource === 'STATED_END_DATE') {
    if (prior.releaseDateSource === 'STATED_END_DATE' && prior.releaseDate !== update.releaseDate && kind === 'FOLLOW_UP') {
      reasons.push('CONFLICTING_STATED_DATES');
    } else {
      fact.releaseDate = update.releaseDate;
      fact.releaseDateSource = 'STATED_END_DATE';
      fact.releaseShift = update.releaseShift ?? fact.releaseShift;
    }
  }
  if (update.foodBillBdt !== null) {
    fact.foodBillBdt = update.foodBillBdt;
    fact.dutyDays = update.dutyDays;
  }
  if (update.conveyanceAmountBdt !== null) fact.conveyanceAmountBdt = update.conveyanceAmountBdt;
  if (update.conveyanceDate) fact.conveyanceDate = update.conveyanceDate;
  if (update.officeReturnDate) fact.officeReturnDate = update.officeReturnDate;

  fact.extractionStatus = statusOf(fact);
  return {fact, reasons};
}

function statusOf(fact: ReleaseFact): ExtractionStatus {
  if (fact.ruleTrace.includes('R-INVALID-STATED-DATE') || !isValidDutyDate(fact.releaseDate)) return 'INVALID_DATES';
  if (fact.conveyanceAmountBdt !== null && (fact.conveyanceDate || fact.officeReturnDate)) return 'COMPLETE';
  if (fact.conveyanceAmountBdt !== null) return 'UNRESOLVED_CONVEYANCE';
  return 'PARTIAL';
}

/** Stable key for the insert: one row per (message, escort, release date). */
export function evidenceKey(fact: ReleaseFact): string {
  return `${fact.evidenceMessageId}|${fact.escortPhone}|${fact.releaseDate}`;
}

/** True when two extractions describe the same stored evidence (replay or duplicate). */
export function isSameEvidence(left: ReleaseFact, right: ReleaseFact): boolean {
  return evidenceKey(left) === evidenceKey(right)
    && left.releaseShift === right.releaseShift
    && left.conveyanceAmountBdt === right.conveyanceAmountBdt
    && left.conveyanceDate === right.conveyanceDate
    && left.officeReturnDate === right.officeReturnDate
    && left.extractionStatus === right.extractionStatus;
}

// ════════════════════════════════════════════════════════════════════════════
// Food Bill as release evidence, and same-day additional money as conveyance
// evidence (Owner rules B and C, 2026-11-04).
//
// A correctly identified duty-ending Food Bill can establish the Release Date.
// A same-day additional payment may be conveyance, but an unlabelled amount is
// only ever a CANDIDATE: never verified because of its amount or its date.
// ════════════════════════════════════════════════════════════════════════════

export type EvidenceMessage = {text: string; timestamp: string; messageId: string};

export type ConveyancePurpose =
  | 'OFFICE_RETURN_CONVEYANCE'
  | 'GHAT_DUTY_CONVEYANCE'
  | 'OTHER_VERIFIED_TRANSPORT'
  | 'UNKNOWN_CONVEYANCE_PURPOSE';

export type ConveyanceStatus = 'VERIFIED' | 'CANDIDATE' | 'UNRESOLVED' | 'NONE';

export type ReleaseDateSource = 'STATED_END_DATE' | 'FOOD_BILL_EVENT' | 'MESSAGE_TIMESTAMP' | 'NONE';
export type TravelDateSource = 'EXPLICIT_TRAVEL_DATE' | 'SAME_DAY_ESTABLISHED' | null;

export type BundleClassification =
  | 'CONFIRMED_RELEASE'
  | 'FOOD_BILL_RELEASE_EVIDENCE'
  | 'VERIFIED_CONVEYANCE'
  | 'SAME_DAY_CONVEYANCE_CANDIDATE'
  | 'UNRESOLVED_CONVEYANCE'
  | 'PARTIAL_INFORMATION'
  | 'NEEDS_REVIEW';

export type ReleaseBundle = {
  programId: string | null;
  employeeMobile: string;
  lighterVessel: string | null;
  foodBillDate: string | null;
  foodBillAmount: number | null;
  /** floor(foodBillAmount / BDT 150) — the day count the amount implies. */
  foodBillDutyDays: number | null;
  /** The day count the message states ("6-day", "To duty:-6"), when present. */
  foodBillStatedDays: number | null;
  /** Non-blocking evidence notes (e.g. DAY_COUNT_MISMATCH). Never a gate. */
  evidenceFlags: string[];
  /** How the escort number was taken from the message (audit only). */
  employeeIdentitySource: 'ID_LABEL' | 'ESCORT_LABEL' | 'FIRST_MOBILE' | null;
  /** The message named a Sukani/Master number; never an escort identity. */
  sukaniMentioned: boolean;
  releaseDate: string | null;
  releaseDateSource: ReleaseDateSource;
  additionalAmount: number | null;
  conveyancePurpose: ConveyancePurpose | null;
  travelDate: string | null;
  travelDateSource: TravelDateSource;
  paymentInstructionDate: string | null;
  /** Office-return date the message stated, when any (supporting evidence). */
  officeReturnDate: string | null;
  /** Month the conveyance belongs to (actual travel month), or null. */
  conveyanceMonth: string | null;
  conveyanceStatus: ConveyanceStatus;
  /** Primary class; all applicable classes are also listed in `signals`. */
  classification: BundleClassification;
  signals: BundleClassification[];
  releaseEligible: boolean;
  evidenceMessageIds: string[];
  ruleTrace: string[];
  reviewReasons: string[];
  cashPosting: false;
};

const SALARY_RE = /salary|বেতন|মাইনে/i;
const ADVANCE_RE = /advance|অগ্রিম|এডভান্স/i;
const OLD_BILL_RE = /\bold\s*(?:bill)?\b|পুরাতন|আগের\s*বিল|previous\s*bill|earlier\s*bill/i;
const FUTURE_BILL_RE = /\bfuture\b|আগামী|পরের\s*মাস|next\s*month|afterwards/i;
const GHAT_RE = /ghat|ঘাট/i;
const OFFICE_RETURN_WORDS = /office\s*(?:back|return)|অফিসে\s*(?:আসার|ফেরার|ফির)|ফিরে\s*আস|return/i;
const TRANSPORT_RE = /conv|conveyance|গাড়ি|ভাড়া|gari|vara|transport|travel/i;
// "টাকা যাবে" / "will go" routes money to a number; it says nothing about when
// the travel happened, so it can never establish a same-day travel date.
const PAYMENT_ROUTING_RE = /টাকা\s*যাবে|যাবে|will\s*(?:go|be\s*sent)|পাঠাব|pathabo/i;

const dhakaDateOf = (timestampIso: string): string | null => dhakaLocalTime(timestampIso)?.date ?? null;

const isTransportLine = (text: string) => TRANSPORT_RE.test(text) || GHAT_RE.test(text) || OFFICE_RETURN_WORDS.test(text);

function purposeOf(text: string): ConveyancePurpose {
  const ghat = GHAT_RE.test(text);
  const office = OFFICE_RETURN_WORDS.test(text);
  if (ghat && office) return 'UNKNOWN_CONVEYANCE_PURPOSE'; // conflicting evidence
  if (ghat) return 'GHAT_DUTY_CONVEYANCE';
  if (office) return 'OFFICE_RETURN_CONVEYANCE';
  if (TRANSPORT_RE.test(text)) return 'OTHER_VERIFIED_TRANSPORT';
  return 'UNKNOWN_CONVEYANCE_PURPOSE';
}

type ParsedMessage = {message: EvidenceMessage; date: string; payments: ReturnType<typeof parseMessage>};

function parseAll(messages: readonly EvidenceMessage[]): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const message of messages) {
    const date = dhakaDateOf(message.timestamp);
    if (!date || !message.messageId) continue;
    const payments = parseMessage(message.text, message.timestamp);
    if (payments.length) out.push({message, date, payments});
  }
  return out;
}

/**
 * Correlate one escort's messages (same day or a stated follow-up) into a single
 * evidence bundle. Messages for other escorts are ignored; nothing is inferred
 * from a similar vessel name or a similar amount.
 */
type StatedStatement = {date: string; shift: 'D' | 'N' | null; messageId: string; timestamp: string};

export function analyseReleaseBundle(
  messages: readonly EvidenceMessage[],
  match: MatchAssessment,
): ReleaseBundle[] {
  const parsed = parseAll(messages);
  // A follow-up correction may be a date-only message (no escort number). It is
  // attached only when the whole input has exactly one escort, so it can never
  // be applied to the wrong person.
  const orphans: StatedStatement[] = [];
  const handled = new Set(parsed.map((item) => item.message.messageId));
  for (const message of messages) {
    if (handled.has(message.messageId)) continue;
    const date = dhakaDateOf(message.timestamp);
    if (!date) continue;
    for (const line of String(message.text ?? '').split(/\r?\n/)) {
      const stated = statedDateOnLine(line, date);
      if (stated?.date && stated.kind === 'release') {
        orphans.push({date: stated.date, shift: stated.shift, messageId: message.messageId, timestamp: message.timestamp});
      }
    }
  }
  const byEscort = new Map<string, ParsedMessage[]>();
  for (const item of parsed) {
    for (const payment of item.payments) {
      const related = byEscort.get(payment.escortPhone) ?? [];
      if (!related.includes(item)) related.push(item);
      byEscort.set(payment.escortPhone, related);
    }
  }

  // A date-only message cannot choose between several escorts.
  const orphansUsable = byEscort.size === 1 ? orphans : [];
  const orphanAmbiguous = orphans.length > 0 && byEscort.size > 1;
  const bundles: ReleaseBundle[] = [];
  for (const [employeeMobile, items] of byEscort) {
    bundles.push(buildBundle(employeeMobile, items, match, orphansUsable, orphanAmbiguous));
  }
  return bundles;
}

function buildBundle(
  employeeMobile: string,
  items: readonly ParsedMessage[],
  match: MatchAssessment,
  orphanStated: readonly StatedStatement[] = [],
  orphanAmbiguous = false,
): ReleaseBundle {
  const ruleTrace: string[] = [];
  const reviewReasons: string[] = [];
  const evidenceMessageIds: string[] = [];
  const addRule = (rule: string) => { if (!ruleTrace.includes(rule)) ruleTrace.push(rule); };
  const evidenceFlags: string[] = [];
  const addFlag = (flag: string) => { if (!evidenceFlags.includes(flag)) evidenceFlags.push(flag); };

  const entries = items.map((item) => {
    const payment = item.payments.find((p) => p.escortPhone === employeeMobile);
    return payment ? {item, payment} : null;
  }).filter((entry): entry is {item: ParsedMessage; payment: NonNullable<ReturnType<typeof parseMessage>[number]>} => entry !== null);

  entries.sort((a, b) => Date.parse(a.item.message.timestamp) - Date.parse(b.item.message.timestamp));
  for (const entry of entries) evidenceMessageIds.push(entry.item.message.messageId);
  // A labelled date that does not parse is an explicit contradiction, not a gap.
  const hasInvalidStatedDate = entries.some((entry) => entry.payment.rules.includes('R-INVALID-STATED-DATE'));
  if (hasInvalidStatedDate) reviewReasons.push('INVALID_STATED_DATE');

  const foodEntry = entries.find((entry) => entry.payment.foodBillWords && entry.payment.amountBdt !== null)
    ?? entries.find((entry) => entry.payment.amountBdt !== null);
  const foodBillAmount = foodEntry?.payment.amountBdt ?? null;
  const foodDate = foodEntry ? (foodEntry.payment.statedReleaseDate ?? foodEntry.item.date) : null;

  const salaryLabeled = entries.some((entry) => SALARY_RE.test(entry.item.message.text) || SALARY_RE.test(entry.payment.line));
  const advanceLabeled = entries.some((entry) => ADVANCE_RE.test(entry.item.message.text) || ADVANCE_RE.test(entry.payment.line));
  const oldBillLabeled = entries.some((entry) => OLD_BILL_RE.test(entry.item.message.text));
  const futureBillLabeled = entries.some((entry) => FUTURE_BILL_RE.test(entry.item.message.text));

  // ── additional money on the same Dhaka date ────────────────────────────────
  const explicitConveyance = entries.find((entry) => entry.payment.conveyance !== null)
    ?? entries.find((entry) => entry !== foodEntry
      && entry.payment.amountBdt !== null
      && isTransportLine(entry.item.message.text));
  let additionalAmount: number | null = null;
  let conveyancePurpose: ConveyancePurpose | null = null;
  let conveyanceStatus: ConveyanceStatus = 'NONE';
  let travelDate: string | null = null;
  let travelDateSource: TravelDateSource = null;
  let paymentInstructionDate: string | null = null;
  let transportEvidenceText = '';

  if (explicitConveyance) {
    additionalAmount = explicitConveyance.payment.conveyance ?? explicitConveyance.payment.amountBdt;
    transportEvidenceText = explicitConveyance.payment.line + ' ' + explicitConveyance.item.message.text;
    conveyancePurpose = purposeOf(transportEvidenceText);
    addRule('R-CONVEYANCE-AMOUNT');
    if (explicitConveyance.payment.conveyanceDate) {
      travelDate = explicitConveyance.payment.conveyanceDate;
      travelDateSource = 'EXPLICIT_TRAVEL_DATE';
      addRule('R-CONVEYANCE-DATE');
    } else {
      paymentInstructionDate = explicitConveyance.item.date;
      addRule('R-PAYMENT-INSTRUCTION-DATE');
      conveyanceStatus = 'UNRESOLVED';
    }
  } else {
    // A second, unlabelled payment for the same escort on the same date is a
    // CANDIDATE at most: the amount and the date are never proof.
    const sameDateExtra = entries.find((entry) =>
      foodEntry && entry !== foodEntry
      && entry.item.date === foodEntry.item.date
      && entry.payment.amountBdt !== null
      && !SALARY_RE.test(entry.item.message.text)
      && !ADVANCE_RE.test(entry.item.message.text));
    if (sameDateExtra && sameDateExtra.payment.amountBdt !== null) {
      additionalAmount = sameDateExtra.payment.amountBdt;
      transportEvidenceText = sameDateExtra.item.message.text;
      conveyancePurpose = purposeOf(transportEvidenceText);
      conveyanceStatus = 'CANDIDATE';
      paymentInstructionDate = sameDateExtra.item.date;
      addRule('R-SAME-DAY-ADDITIONAL-PAYMENT');
    }
  }

  // A travel date may also be stated in an explicit line of any related message.
  if (!travelDate) {
    const stated = entries.map((entry) => entry.payment.conveyanceDate ?? entry.payment.officeReturnDate).find(Boolean);
    if (stated && additionalAmount !== null) {
      travelDate = stated;
      travelDateSource = 'EXPLICIT_TRAVEL_DATE';
      addRule('R-EXPLICIT-TRAVEL-DATE');
    }
  }

  // Same-day establishment: the transport wording sits in the same message that
  // establishes the completed duty, with no payment-routing-only marker.
  if (!travelDate && additionalAmount !== null && foodEntry && explicitConveyance
    && explicitConveyance.item.message.messageId === foodEntry.item.message.messageId
    && isTransportLine(transportEvidenceText)
    && !PAYMENT_ROUTING_RE.test(transportEvidenceText)
    // A message that tried to state a date and failed cannot establish one by
    // falling back to the same-day rule.
    && !hasInvalidStatedDate) {
    travelDate = foodEntry.item.date;
    travelDateSource = 'SAME_DAY_ESTABLISHED';
    addRule('R-SAME-DAY-CONVEYANCE-DATE');
  }

  if (additionalAmount !== null && travelDate && conveyanceStatus !== 'CANDIDATE') conveyanceStatus = 'VERIFIED';

  // ── release date precedence (Owner rule A4 / B3) ───────────────────────────
  const statements: StatedStatement[] = [
    ...entries
      .filter((entry) => entry.payment.statedReleaseDate !== null)
      .map((entry) => ({date: entry.payment.statedReleaseDate as string, shift: entry.payment.statedReleaseShift, messageId: entry.item.message.messageId, timestamp: entry.item.message.timestamp})),
    ...orphanStated,
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const lastStated = statements.at(-1) ?? null;
  const statedReleaseDate = lastStated?.date ?? null;
  for (const statement of orphanStated) evidenceMessageIds.push(statement.messageId);
  if (orphanAmbiguous) reviewReasons.push('ORPHAN_DATE_MESSAGE_AMBIGUOUS');
  let releaseDate: string | null = null;
  let releaseDateSource: ReleaseDateSource = 'NONE';

  if (statedReleaseDate) {
    releaseDate = statedReleaseDate;
    releaseDateSource = 'STATED_END_DATE';
    addRule('R-STATED-END-DATE');
    // The explicit date is kept. A conflict is flagged only when the food-bill
    // message itself is dated later than that explicit date and a different
    // message stated it — a later restatement is a correction, not a conflict.
    if (foodEntry && lastStated && lastStated.messageId !== foodEntry.item.message.messageId
      && foodEntry.item.date > statedReleaseDate) {
      reviewReasons.push('FOOD_BILL_CONFLICTS_WITH_EXPLICIT_RELEASE');
    }
  } else if (foodEntry && foodBillAmount !== null) {
    const dayCount = foodEntry.payment.dutyDays;
    const statedDays = foodEntry.payment.explicitDayCount;
    const dayCountMismatch = statedDays !== null && dayCount !== null && statedDays !== dayCount;
    const beforeProgramStart = !!(match.programStartDate && foodDate && foodDate < match.programStartDate);
    if (salaryLabeled || advanceLabeled) {
      reviewReasons.push(salaryLabeled ? 'FOOD_BILL_LABELED_SALARY' : 'FOOD_BILL_LABELED_ADVANCE');
    } else if (oldBillLabeled) {
      reviewReasons.push('FOOD_BILL_FOR_EARLIER_DUTY');
    } else if (futureBillLabeled) {
      reviewReasons.push('FOOD_BILL_FOR_FUTURE_DUTY');
    } else if (beforeProgramStart) {
      reviewReasons.push('FOOD_BILL_PRECEDES_PROGRAM');
    } else {
      // Owner rule (2026-11-04): an agreeing day count is supporting evidence,
      // never a requirement. A mismatch is recorded for audit and never blocks
      // on its own — only independent contradictions (Program identity, invalid
      // Release Date, Salary/Advance label, old/future bill) send it to review.
      releaseDate = foodDate;
      releaseDateSource = 'FOOD_BILL_EVENT';
      addRule('R-FOOD-BILL-RELEASE-DATE');
      if (statedDays !== null && dayCount !== null) {
        if (dayCountMismatch) addFlag('DAY_COUNT_MISMATCH');
        else addRule('R-DAY-COUNT-AGREES');
      }
    }
  }

  if (!releaseDate) {
    // Legacy fallback: the approved message-date rule, only when nothing is
    // contradicted above.
    const last = entries[entries.length - 1];
    releaseDate = last?.item.date ?? null;
    releaseDateSource = releaseDate ? 'MESSAGE_TIMESTAMP' : 'NONE';
    if (releaseDate) addRule('R-MESSAGE-DATE');
  }

  if (foodDate && releaseDateSource === 'MESSAGE_TIMESTAMP' && foodDate !== releaseDate) {
    // The food bill is dated differently from the slip that carries it.
    reviewReasons.push('FOOD_BILL_DATE_DIFFERS_FROM_MESSAGE');
  }

  // ── matching gate ──────────────────────────────────────────────────────────
  if (match.status !== 'MATCHED' || !match.programId) {
    const candidates = match.candidateIds?.length ?? 0;
    reviewReasons.push(candidates > 1 ? 'MULTIPLE_PROGRAM_CANDIDATES' : 'NO_PROGRAM_MATCH');
  }
  if (travelDate && releaseDate && travelDate < releaseDate) {
    reviewReasons.push('CONVEYANCE_BEFORE_RELEASE');
  }
  if (!releaseDate) reviewReasons.push('RELEASE_DATE_UNKNOWN');

  const blocked = reviewReasons.length > 0;

  // ── classification (signals are cumulative; the primary is the strongest) ──
  const signals: BundleClassification[] = [];
  if (releaseDateSource === 'FOOD_BILL_EVENT') signals.push('FOOD_BILL_RELEASE_EVIDENCE');
  if (conveyanceStatus === 'VERIFIED') signals.push('VERIFIED_CONVEYANCE');
  if (conveyanceStatus === 'CANDIDATE') signals.push('SAME_DAY_CONVEYANCE_CANDIDATE');
  if (conveyanceStatus === 'UNRESOLVED') signals.push('UNRESOLVED_CONVEYANCE');
  if (releaseDateSource === 'STATED_END_DATE' || (releaseDateSource === 'MESSAGE_TIMESTAMP' && !foodEntry)) signals.push('CONFIRMED_RELEASE');

  let classification: BundleClassification;
  if (blocked) classification = 'NEEDS_REVIEW';
  else if (conveyanceStatus === 'VERIFIED') classification = 'VERIFIED_CONVEYANCE';
  else if (conveyanceStatus === 'CANDIDATE') classification = 'SAME_DAY_CONVEYANCE_CANDIDATE';
  else if (conveyanceStatus === 'UNRESOLVED') classification = 'UNRESOLVED_CONVEYANCE';
  else if (releaseDateSource === 'FOOD_BILL_EVENT') classification = 'FOOD_BILL_RELEASE_EVIDENCE';
  else if (signals.length) classification = 'CONFIRMED_RELEASE';
  else classification = 'PARTIAL_INFORMATION';
  if (!signals.includes(classification)) signals.unshift(classification);

  return {
    programId: blocked ? null : match.programId,
    employeeMobile: normalizeEmployeeMobile(employeeMobile, 'employee_id') || employeeMobile,
    lighterVessel: match.lighterVessel ?? null,
    foodBillDate: foodDate,
    foodBillAmount,
    foodBillDutyDays: foodEntry?.payment.dutyDays ?? null,
    foodBillStatedDays: foodEntry?.payment.explicitDayCount ?? null,
    evidenceFlags,
    employeeIdentitySource: foodEntry?.payment.identitySource ?? null,
    sukaniMentioned: entries.some((entry) => entry.payment.sukaniMentioned),
    releaseDate,
    releaseDateSource,
    additionalAmount,
    conveyancePurpose,
    travelDate,
    travelDateSource,
    paymentInstructionDate,
    officeReturnDate: entries.map((entry) => entry.payment.officeReturnDate).find(Boolean) ?? null,
    conveyanceMonth: travelDate ? monthOf(travelDate) : null,
    conveyanceStatus,
    classification,
    signals,
    releaseEligible: !blocked && !!releaseDate && match.status === 'MATCHED' && !!match.programId,
    evidenceMessageIds: unique(evidenceMessageIds),
    ruleTrace: unique(ruleTrace),
    reviewReasons: unique(reviewReasons),
    cashPosting: false,
  };
}
