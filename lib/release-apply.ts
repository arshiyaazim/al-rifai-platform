// Apply / reject a release candidate (R1 Step 4).
//
// Applying a release does NOT write to programs directly. It goes through
// public.apply_release_candidate(), which releases the program, recalculates pay,
// marks the candidate applied and writes the release_auto_apply_log row in ONE
// transaction. Releasing through several pools/statements (the previous shape)
// could commit the release and lose the audit row, which is exactly how candidate
// 2093 was applied without an audit record. If the function is absent the apply
// fails closed instead of falling back to the non-atomic path.
//
// Rejecting a candidate never touches programs.

import {database} from '@/db/raw';
import {createPool} from '@/db/postgres.mjs';
import {commandActorFromEnv} from '@/lib/vessel-command-policy';

export type Candidate = {
  id: string;
  program_id: string | null;
  end_date: string;
  end_shift: string | null;
  amount_bdt: number | null;
  confidence: string | null;
  match_status: string;
  applied: boolean;
  escort_phone: string;
};

let writer: ReturnType<typeof createPool> | null = null;
function commandPool() {
  if (!writer) writer = createPool({readOnly: false, role: 'review'});
  return writer;
}

// db/raw's pool is read-only, so candidate bookkeeping needs its own writer.
let bookkeeping: ReturnType<typeof createPool> | null = null;
function writePool() {
  if (!bookkeeping) bookkeeping = createPool({readOnly: false, role: 'app'});
  return bookkeeping;
}

export class ApplyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function loadCandidate(id: string): Promise<Candidate> {
  const result = await database().all<Candidate>(
    'SELECT id, program_id, end_date::text AS end_date, end_shift, amount_bdt, confidence, match_status, applied, escort_phone FROM public.release_candidates WHERE id = $1',
    [id],
  );
  const row = result.results[0];
  if (!row) throw new ApplyError('CANDIDATE_NOT_FOUND', 404);
  return row;
}

/** Apply one candidate. Idempotent: an already-applied row returns its state. */
export async function applyCandidate(id: string, reviewedBy: string): Promise<{programId: string; alreadyApplied: boolean}> {
  if (!/^\d+$/.test(id)) throw new ApplyError('CANDIDATE_NOT_FOUND', 404);
  const candidate = await loadCandidate(id);
  if (candidate.applied) return {programId: candidate.program_id ?? '', alreadyApplied: true};
  if (candidate.match_status !== 'MATCHED') throw new ApplyError('CANDIDATE_NOT_MATCHED', 409);
  if (!candidate.program_id) throw new ApplyError('CANDIDATE_WITHOUT_PROGRAM', 409);
  if (!candidate.end_shift) throw new ApplyError('CANDIDATE_WITHOUT_SHIFT', 409);

  // Fail closed until the atomic function is installed (migration 0071).
  const probe = await database().all<{atomic: boolean}>(
    `SELECT to_regprocedure('public.apply_release_candidate(bigint,text,text,text)') IS NOT NULL AS atomic`,
  );
  if (!probe.results[0]?.atomic) throw new ApplyError('ATOMIC_APPLY_REQUIRED_BUT_MISSING', 503);

  const actor = commandActorFromEnv(process.env as Record<string, string | undefined>).ref;
  const result = await commandPool().query(
    'SELECT public.apply_release_candidate($1::bigint,$2,$3,$4) AS result',
    [id, actor, reviewedBy, 'release-review'],
  );
  const value = (result.rows[0]?.result ?? {}) as {programId?: string; alreadyApplied?: boolean};
  return {
    programId: String(value.programId ?? candidate.program_id),
    alreadyApplied: value.alreadyApplied === true,
  };
}

/** Reject one candidate. Never touches programs. */
export async function rejectCandidate(id: string, reviewedBy: string): Promise<void> {
  const candidate = await loadCandidate(id);
  if (candidate.applied) throw new ApplyError('CANDIDATE_ALREADY_APPLIED', 409);
  await writePool().query(
    `UPDATE public.release_candidates
        SET applied = true, match_status = 'REJECTED', reviewed_by = $2, reviewed_at = now()
      WHERE id = $1`,
    [id, reviewedBy],
  );
}

/** Apply every high-confidence MATCHED candidate. Returns per-program outcome. */
export async function applyAllHigh(reviewedBy: string): Promise<{applied: number; failed: Array<{id: string; error: string}>}> {
  // Several candidates can describe one duty (a food bill and a same-day partial).
  // Releasing a program twice would append duplicate RELEASE_PROGRAM events and
  // rewrite the same end date, so only the first candidate per program is applied;
  // the rest are annotated for the reviewer instead of being issued again.
  const rows = await database().all<{id: string}>(
    `SELECT DISTINCT ON (program_id) id
       FROM public.release_candidates
      WHERE applied = false AND match_status = 'MATCHED' AND confidence = 'high'
        AND program_id IS NOT NULL
      ORDER BY program_id, end_date, id`,
  );
  let applied = 0;
  const failed: Array<{id: string; error: string}> = [];
  for (const row of rows.results) {
    try {
      await applyCandidate(row.id, reviewedBy);
      applied += 1;
    } catch (error) {
      failed.push({id: row.id, error: error instanceof Error ? error.message : String(error)});
    }
  }
  const appliedIds = rows.results.map((r) => r.id);
  if (appliedIds.length) {
    await writePool().query(
      `UPDATE public.release_candidates
          SET notes = coalesce(notes || ' · ', '') || 'duplicate for a program already released by apply-all-high'
        WHERE applied = false AND match_status = 'MATCHED' AND confidence = 'high'
          AND program_id IS NOT NULL AND id <> ALL($1::bigint[])`,
      [appliedIds],
    );
  }
  return {applied, failed};
}
