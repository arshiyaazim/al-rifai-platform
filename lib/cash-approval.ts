// Cash submission review policy (pure). Submission ≠ approval ≠ posting.
// Database constraints enforce the same rules; these helpers give the API and
// UI one shared, testable definition.

export type ReviewActor = {id: string; role: 'ADMIN' | 'USER'};
export type SubmissionLike = {id: string; submittedByUserRef: string};
export type Decision = 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUESTED';

export const DECISIONS: readonly Decision[] = ['APPROVED', 'REJECTED', 'CORRECTION_REQUESTED'] as const;

export class ApprovalError extends Error {
  readonly code: string;
  readonly status = 403;
  constructor(code: string) {
    super(code);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

const deny = (code: string): never => {
  throw new ApprovalError(code);
};

/** ADMIN sees every submission; USER sees only their own submissions. */
export function canViewSubmission(actor: ReviewActor, submission: SubmissionLike): boolean {
  if (actor.role === 'ADMIN') return true;
  return actor.id === submission.submittedByUserRef;
}

export function assertCanViewSubmission(actor: ReviewActor, submission: SubmissionLike): void {
  if (!canViewSubmission(actor, submission)) deny('SUBMISSION_NOT_VISIBLE');
}

export type DecisionInput = {
  actor: ReviewActor;
  submission: SubmissionLike;
  decision: string;
  note?: string | null;
  /** Decisions already recorded for this submission, if known. */
  priorDecisions?: Array<{actorUserRef: string; decision: string}>;
};

/**
 * Approval requires an ADMIN who did not submit the record. Repeated decisions
 * remain append-only (latest wins), but the same reviewer cannot record the same
 * decision twice — that is an idempotency conflict, not a new approval.
 */
export function assertCanDecide(input: DecisionInput): {decision: Decision; note: string} {
  const {actor, submission, priorDecisions = []} = input;
  if (actor.role !== 'ADMIN') deny('ADMIN_REQUIRED');
  if (actor.id === submission.submittedByUserRef) deny('REVIEWER_IS_SUBMITTER');
  const decision = String(input.decision ?? '').toUpperCase();
  if (!DECISIONS.includes(decision as Decision)) deny('DECISION_INVALID');
  const note = String(input.note ?? '').trim();
  if (note.length > 1000) deny('NOTE_TOO_LONG');
  if (decision === 'REJECTED' || decision === 'CORRECTION_REQUESTED') {
    if (!note) deny('REASON_REQUIRED');
  }
  const duplicate = priorDecisions.some((prior) =>
    prior.actorUserRef === actor.id && prior.decision === decision);
  if (duplicate) deny('DECISION_ALREADY_RECORDED');
  return {decision: decision as Decision, note};
}

/** Read-time projection shared with the SQL view semantics. */
export function projectReviewState(
  decisions: Array<{decision: Decision; decidedAt: string; id: string}>,
): 'PENDING_REVIEW' | 'ACTIVE_REVIEWED' | 'REJECTED' | 'CORRECTION_REQUESTED' {
  if (!decisions.length) return 'PENDING_REVIEW';
  const latest = [...decisions].sort((a, b) => {
    const time = String(b.decidedAt).localeCompare(String(a.decidedAt));
    return time !== 0 ? time : String(b.id).localeCompare(String(a.id));
  })[0];
  if (latest.decision === 'APPROVED') return 'ACTIVE_REVIEWED';
  if (latest.decision === 'REJECTED') return 'REJECTED';
  return 'CORRECTION_REQUESTED';
}

/** Migration dependency surfaced honestly by the API until 0031 is applied. */
export const SUBMISSION_SCHEMA_DEPENDENCY = 'MIGRATION_0031_CASH_SUBMISSIONS_NOT_APPLIED';
