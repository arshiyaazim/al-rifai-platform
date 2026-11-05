// Cash submission validation (pure). A valid submission becomes PENDING_REVIEW;
// it never posts, never approves and never mutates an existing financial fact.
//
// Reuses the existing draft validator so business validation stays in one place.

import {createHash} from 'node:crypto';
import {validateDraft} from './operations.ts';

export type SubmissionState = 'PENDING_REVIEW';

export type SubmissionInput = {
  employeeName?: unknown;
  employeeMobile?: unknown;
  payoutMobile?: unknown;
  method?: unknown;
  amount?: unknown;
  purpose?: unknown;
  date?: unknown;
  note?: unknown;
  evidenceRef?: unknown;
};

export type SubmissionResult =
  | {ok: true; state: SubmissionState; payload: SubmissionPayload}
  | {ok: false; state: 'INVALID'; reasons: string[]};

export type SubmissionPayload = {
  employeeName: string;
  employeeMobile: string;
  payoutMobile: string;
  method: string;
  amountMinor: number;
  purpose: string;
  date: string;
  note: string;
  evidenceRef: string | null;
  instruction: string;
  payloadHash: string;
  state: SubmissionState;
  postingAuthorized: false;
};

const text = (value: unknown) => String(value ?? '').trim();

/** Deterministic hash of the normalized payload (idempotency key material). */
export function submissionHash(payload: Omit<SubmissionPayload, 'payloadHash' | 'state' | 'postingAuthorized'>): string {
  const canonical = JSON.stringify([
    payload.employeeMobile, payload.payoutMobile, payload.method,
    payload.amountMinor, payload.date, payload.purpose, payload.evidenceRef,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Validate a Cash Portal submission. Employee identity and payout destination
 * remain separate; the payout number never identifies an employee.
 */
export function validateSubmission(input: SubmissionInput): SubmissionResult {
  const note = text(input.note);
  if (note.length > 500) return {ok: false, state: 'INVALID', reasons: ['NOTE_TOO_LONG']};
  const evidenceRef = input.evidenceRef === undefined || input.evidenceRef === null || text(input.evidenceRef) === ''
    ? null
    : text(input.evidenceRef);
  if (evidenceRef && evidenceRef.length > 300) return {ok: false, state: 'INVALID', reasons: ['EVIDENCE_REF_TOO_LONG']};

  let draft;
  try {
    draft = validateDraft({
      name: input.employeeName,
      employeePhone: input.employeeMobile,
      payoutPhone: input.payoutMobile,
      method: input.method,
      amount: text(input.amount),
      purpose: input.purpose,
      date: input.date,
    });
  } catch (error) {
    return {ok: false, state: 'INVALID', reasons: [error instanceof Error ? error.message : 'SUBMISSION_INVALID']};
  }

  const payloadBase = {
    employeeName: draft.name,
    employeeMobile: draft.employeePhone,
    payoutMobile: draft.payoutPhone,
    method: draft.method,
    amountMinor: draft.amountCents,
    purpose: draft.purpose,
    date: draft.date,
    note,
    evidenceRef,
    instruction: draft.instruction,
  };
  const payloadHash = submissionHash(payloadBase);
  return {
    ok: true,
    state: 'PENDING_REVIEW',
    payload: {...payloadBase, payloadHash, state: 'PENDING_REVIEW', postingAuthorized: false},
  };
}
