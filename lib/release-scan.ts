// Release group scan — shared by the backfill script and the ingestion hook.
//
// Reads the Escort Release Slip group from whatsapp_messages_original, parses each
// message, assigns through the four-step matcher and returns rows ready to insert.
// No writes here: callers decide whether to persist.
//
// The whole group is rescanned on every call rather than only new messages,
// because Step D (orphan programs) needs the complete payment picture for an
// escort to decide which payment is a lump-sum release. The group is ~1,000
// messages, so this is cheap, and the dedupe index makes persistence idempotent.

import {createHash} from 'node:crypto';
import {parseMessage, assignReleases, normalisePhone, type RosterProgram, type Assignment} from './release-parser.ts';
import {analyseReleaseBundle, type ReleaseBundle} from './release-evidence.ts';
import {backwardSearch, extractFoodBillHint, type BackwardMatch, type FoodBillHint} from './food-bill-match.ts';

export const RELEASE_GROUP_JID = '120363408741101070@g.us';
export const RELEASE_ACCOUNT = 'wa-01';

export type ScanRow = {
  assignment: Assignment;
  msgId: string;
  msgAt: string;
  msgText: string;
  /** Roster context for the matched Program, used only for evidence enrichment. */
  roster?: {lighterVessel: string | null; startDate: string | null};
};

export type ScanResult = {
  messages: number;
  withPhone: number;
  phoneLess: number;
  payments: number;
  rows: ScanRow[];
  /**
   * Food Bill messages the parser could not turn into a payment (no ASCII
   * mobile) together with their backward Program search result. Computed always,
   * persisted only when the Owner enables the path.
   */
  backward: Array<{hint: FoodBillHint; match: BackwardMatch}>;
};

export type Queryable = {
  // Deliberately non-generic: the ingestion worker passes a thin adapter whose
  // rows are Record<string, unknown>, which a generic signature rejects.
  query(sql: string, values?: unknown[]): Promise<{rows: unknown[]}>;
};

export async function loadRoster(client: Queryable): Promise<RosterProgram[]> {
  const {rows} = await client.query(
    `SELECT id,
            "escortMobile" AS "escortPhone",
            "escortName"   AS "escortName",
            "lighterVessel" AS "lighterVessel",
            "motherVessel" AS "motherVessel",
            "masterMobile" AS "masterMobile",
            "startDate"    AS "startDate",
            nullif(btrim("endDate"), '') AS "endDate"
       FROM public.programs
      WHERE dataset_epoch = 'CANONICAL_BACKFILL_20261026'`,
  ) as {rows: Array<{id: string; escortPhone: string | null; escortName: string | null; startDate: string; endDate: string | null}>};
  return (rows as Array<{id: string; escortPhone: string | null; escortName: string | null; lighterVessel?: string | null; motherVessel?: string | null; masterMobile?: string | null; startDate: string; endDate: string | null}>).map((r) => ({
    id: r.id,
    escortPhone: r.escortPhone,
    escortName: r.escortName,
    startDate: String(r.startDate ?? '').slice(0, 10),
    endDate: r.endDate ? String(r.endDate).slice(0, 10) : null,
    lighterVessel: r.lighterVessel ?? null,
    motherVessel: r.motherVessel ?? null,
    masterMobile: r.masterMobile ?? null,
  }));
}

const HAS_PHONE = /(?<![\d@])(?:\+?88)?0?1[3-9]\d(?:[\s-]?\d){7}(?!\d)/;

export async function scanReleaseGroup(client: Queryable, roster?: RosterProgram[]): Promise<ScanResult> {
  const effectiveRoster = roster ?? (await loadRoster(client));
  const {rows: messages} = await client.query(
    `SELECT coalesce(message_id, id::text) AS id,
            timestamp::text AS timestamp,
            text_content AS text
       FROM public.whatsapp_messages_original
      WHERE wa_account = $1 AND chat_jid = $2
      ORDER BY timestamp`,
    [RELEASE_ACCOUNT, RELEASE_GROUP_JID],
  ) as {rows: Array<{id: string; timestamp: string; text: string | null}>};

  let withPhone = 0;
  let phoneLess = 0;
  const payments: Array<ReturnType<typeof parseMessage>[number]> = [];
  const meta: Array<{msgId: string; msgAt: string; msgText: string}> = [];

  for (const msg of messages) {
    const body = msg.text ?? '';
    const hasPhone = HAS_PHONE.test(body);
    if (hasPhone) withPhone += 1;

    const parsed = parseMessage(body, msg.timestamp);
    if (!parsed.length) {
      if (!hasPhone) phoneLess += 1;
      continue;
    }
    for (const payment of parsed) {
      payments.push(payment);
      meta.push({msgId: msg.id, msgAt: msg.timestamp, msgText: body});
    }
  }

  // Messages the parser produced nothing for. A Food Bill without an ASCII
  // mobile lands here; it is searched backwards against the same roster.
  const backward: Array<{hint: FoodBillHint; match: BackwardMatch}> = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    const body = msg.text ?? '';
    if (!body) continue;
    if (parseMessage(body, msg.timestamp).length > 0) continue;
    const hint = extractFoodBillHint(body, msg.timestamp, msg.id);
    if (!hint) continue;
    const match = backwardSearch(hint, effectiveRoster);
    if (match.status === 'NO_MATCH') continue;
    backward.push({hint, match});
  }

  const assignments = assignReleases(payments, effectiveRoster);
  const rosterById = new Map(effectiveRoster.map((program) => [program.id, program]));
  const rows: ScanRow[] = assignments.map((assignment, i) => ({
    assignment,
    ...(meta[i] ?? {msgId: '', msgAt: '', msgText: ''}),
    roster: assignment.programId
      ? {lighterVessel: rosterById.get(assignment.programId)?.lighterVessel ?? null,
         startDate: rosterById.get(assignment.programId)?.startDate ?? null}
      : undefined,
  }));

  return {messages: messages.length, withPhone, phoneLess, payments: payments.length, rows, backward};
}

/** Insert rows, ignoring ones already present (dedupe index on message/escort/day/amount). */
export async function persistRows(client: Queryable, rows: readonly ScanRow[]): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const a = row.assignment;
    const result = await client.query(
      `INSERT INTO public.release_candidates
         (escort_phone, escort_name, program_id, end_date, end_shift,
          amount_bdt, duty_days, calc_start, conveyance, match_status,
          match_pass, mismatch_kind, confidence, notes, source_msg_id, source_date, source_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING`,
      [
        a.escortPhone, a.escortName, a.programId, a.endDate, a.endShift,
        a.amountBdt, a.dutyDays, a.calcStart, a.conveyance, a.status,
        a.matchPass, a.mismatchKind, a.confidence, a.note,
        row.msgId, row.msgAt, row.msgText.slice(0, 4000),
      ],
    );
    inserted += (result as unknown as {rowCount?: number}).rowCount ?? 0;
  }
  return inserted;
}

/** Trigger conditions from §Step 5 — used by the hook to decide whether to scan. */
export function messageTriggersParse(body: string | null | undefined, mediaType?: string | null): boolean {
  const text = body ?? '';
  if (HAS_PHONE.test(text)) return true;
  if (/\b\d{3,6}\b/.test(text)) return true;
  if ((mediaType ?? '').toLowerCase() === 'image') return true;
  return /release|conv|conveyance|খালাস/i.test(text);
}

/**
 * Auto-apply high-confidence releases from the ingestion hook (R2 Action 4).
 *
 * Safety rails, all enforced here rather than trusted to the caller:
 *   - confidence 'high' only (Step D lump sums are medium and always reviewed)
 *   - match_pass 1 or 2 only (Step D leaves match_pass NULL)
 *   - program status is 'confirmed'
 *   - program has no endDate yet, so an already-released duty is never rewritten
 * Any failure is collected and returned; it never throws into the worker.
 */
export type AtomicApplyMode = 'required' | 'off';
export type AutoApplyResult = {
  applied: number;
  skipped: number;
  failed: number;
  /** Which apply path ran. */
  path: 'atomic' | 'blocked';
  /** Why nothing was applied. */
  blocked?: 'ATOMIC_APPLY_REQUIRED_BUT_MISSING' | 'AUTO_APPLY_DISABLED';
};

/**
 * `ALRIFAI_RELEASE_APPLY_ATOMIC`:
 *   required (default) — apply only through apply_release_candidate(); refuse and
 *                        hold the candidates when it is absent;
 *   off                — do not apply automatically at all.
 *
 * There is deliberately no non-atomic mode. The old legacy path released the
 * program on one connection, updated the candidate on another and only then
 * inserted the audit row, so a failure in the audit insert left an applied
 * candidate without a record (candidate 2093, 2026-11-04). 'auto' is accepted as
 * a synonym for 'required' so an existing environment cannot re-enable it.
 */
export function atomicApplyMode(env: Record<string, string | undefined>): AtomicApplyMode {
  const raw = (env.ALRIFAI_RELEASE_APPLY_ATOMIC ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  return 'required';
}

/**
 * Eligibility query. The review_reasons gate is appended only when migration
 * 0074/0075 are present, so an environment without them behaves exactly as before.
 */
function eligibilitySql(withReviewReasons: boolean): string {
  return `SELECT rc.id::text AS id, rc.program_id, rc.end_date::text AS end_date, rc.end_shift,
            rc.source_msg_id, p.revision
       FROM public.release_candidates rc
       JOIN public.programs p ON p.id = rc.program_id
      WHERE rc.applied = false
        AND rc.match_status = 'MATCHED'
        AND rc.confidence = 'high'
        AND rc.match_pass IN (1, 2)
        AND rc.program_id IS NOT NULL
        AND rc.end_shift IS NOT NULL
        AND lower(btrim(p.status)) = 'confirmed'
        AND btrim(coalesce(p."endDate", '')) = ''${withReviewReasons ? `
        AND coalesce(jsonb_array_length(rc.review_reasons), 0) = 0` : ''}
      ORDER BY rc.end_date, rc.id`;
}

type AtomicProbe = {atomic: boolean; reviewReasonsColumn: boolean};

async function probeApplyPath(client: Queryable): Promise<AtomicProbe> {
  const {rows} = await client.query(
    `SELECT to_regprocedure('public.apply_release_candidate(bigint,text,text,text)') IS NOT NULL AS atomic,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'release_candidates'
                       AND column_name = 'review_reasons') AS review_cols`,
  ) as {rows: Array<{atomic: boolean; review_cols: boolean}>};
  const row = rows[0];
  return {atomic: row?.atomic === true, reviewReasonsColumn: row?.review_cols === true};
}

/**
 * Auto-apply high-confidence releases.
 *
 * When `apply_release_candidate()` exists the atomic path is used: one call per
 * candidate covers release, pay recalculation, candidate status and the audit
 * row in a single transaction. There is deliberately no per-candidate fallback
 * to the legacy path — a failure leaves the candidate MATCHED so the next pass
 * retries it, and the error is reported.
 *
 * When the function is absent and the mode is `required`, nothing is applied at
 * all and the candidates are preserved for review. In `auto` mode the legacy
 * path runs, but it announces itself so a missing migration cannot go unnoticed.
 */
export async function autoApplyHigh(
  client: Queryable,
  command: {query(sql: string, values?: unknown[]): Promise<{rows: unknown[]}>},
  actor: string,
  options: {mode?: AtomicApplyMode; probe?: AtomicProbe} = {},
): Promise<AutoApplyResult> {
  const mode = options.mode ?? atomicApplyMode(process.env as Record<string, string | undefined>);
  const probe = options.probe ?? (await probeApplyPath(client));
  let applied = 0;
  let failed = 0;

  const rows = (await client.query(eligibilitySql(probe.reviewReasonsColumn))).rows as Array<{
    id: string; program_id: string; end_date: string; end_shift: string | null;
    source_msg_id: string | null; revision: number;
  }>;

  if (!probe.atomic) {
    // Without the function an apply cannot be audited atomically, so nothing is
    // applied. This is the fail-closed replacement for the removed legacy path.
    console.error(`Release apply: ATOMIC_APPLY_REQUIRED_BUT_MISSING — ${rows.length} candidate(s) held for review.`);
    return {applied: 0, skipped: rows.length, failed: 0, path: 'blocked', blocked: 'ATOMIC_APPLY_REQUIRED_BUT_MISSING'};
  }
  if (mode === 'off') {
    console.error(`Release apply: automatic application disabled by configuration (ALRIFAI_RELEASE_APPLY_ATOMIC=off); ${rows.length} candidate(s) held for review.`);
    return {applied: 0, skipped: rows.length, failed: 0, path: 'blocked', blocked: 'AUTO_APPLY_DISABLED'};
  }

  for (const row of rows) {
    try {
      await command.query(
        'SELECT public.apply_release_candidate($1::bigint,$2,$3,$4) AS result',
        [row.id, actor, 'auto-apply', 'ingestion-auto-apply'],
      );
      applied += 1;
    } catch (error) {
      failed += 1;
      const code = error instanceof Error && /^[A-Z][A-Z0-9_:-]{1,80}$/.test(error.message) ? error.message : 'APPLY_FAILED';
      // The function is one transaction: the candidate stays MATCHED and the next
      // pass retries it. Never fall back to a non-atomic path here.
      console.error(`Release apply: candidate ${row.id} not applied (${code}); held for retry.`);
    }
  }

  const remaining = await client.query(
    `SELECT count(*)::text AS n FROM public.release_candidates
      WHERE applied = false AND match_status = 'MATCHED' AND confidence = 'high'`,
  ) as {rows: Array<{n: string}>};
  const skipped = Number(remaining.rows[0]?.n ?? 0);
  return {applied, skipped, failed, path: 'atomic'};
}

// ════════════════════════════════════════════════════════════════════════════
// Evidence enrichment (Owner rules B and C).
//
// The candidate row keeps its original columns and its dedupe identity. The
// evidence lives in additional columns added by candidate migrations 0074/0075,
// so this writer is deploy-safe: when those columns are not present it does
// nothing at all and the existing behaviour is unchanged. It never applies a
// release, never touches pay and never writes Cash.
// ════════════════════════════════════════════════════════════════════════════

/** Every column this writer needs. Missing any of them means "migrations not applied yet". */
export const RELEASE_EVIDENCE_COLUMNS = [
  'extraction_status', 'release_date_source', 'conveyance_date', 'office_return_date',
  'food_bill_date', 'food_bill_amount_bdt', 'food_bill_source_msg_id',
  'additional_amount_bdt', 'additional_source_msg_id',
  'conveyance_purpose', 'conveyance_status', 'travel_date', 'travel_date_source',
  'payment_instruction_date', 'employee_identity_source', 'sukani_mentioned',
  'evidence_message_ids', 'review_reasons', 'rule_trace',
] as const;

export type EvidenceCapability = {columns: boolean; events: boolean};

export async function detectEvidenceCapability(client: Queryable): Promise<EvidenceCapability> {
  const {rows} = await client.query(
    `SELECT (SELECT count(*)::int
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'release_candidates'
                AND column_name = ANY($1::text[])) AS cols,
            (SELECT to_regclass('public.vessel_conveyance_event') IS NOT NULL) AS events`,
    [[...RELEASE_EVIDENCE_COLUMNS]],
  ) as {rows: Array<{cols: number | string; events: boolean}>};
  const row = rows[0];
  return {
    columns: Number(row?.cols ?? 0) === RELEASE_EVIDENCE_COLUMNS.length,
    events: row?.events === true,
  };
}

export type EvidencePersistResult = {updated: number; events: number; skipped: boolean};

const evidenceId = (parts: Array<string | number | null>) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);

function extractionStatusOf(bundle: ReleaseBundle): string {
  if (bundle.reviewReasons.includes('INVALID_STATED_DATE') || bundle.releaseDateSource === 'NONE') return 'INVALID_DATES';
  // A known amount with no verified travel date is the actionable state: it is
  // preserved and never allocated, so it must be visible as its own status.
  if (bundle.conveyanceStatus === 'UNRESOLVED') return 'UNRESOLVED_CONVEYANCE';
  return 'COMPLETE';
}

/**
 * Write the evidence for the rows just persisted. Idempotent: the candidate is
 * updated by its own dedupe key and the conveyance event is unique per candidate.
 */
export async function persistEvidence(
  client: Queryable,
  rows: readonly ScanRow[],
): Promise<EvidencePersistResult> {
  if (!rows.length) return {updated: 0, events: 0, skipped: false};
  const capability = await detectEvidenceCapability(client);
  if (!capability.columns) return {updated: 0, events: 0, skipped: true};

  let updated = 0;
  let events = 0;
  for (const row of rows) {
    const a = row.assignment;
    const phone = normalisePhone(a.escortPhone);
    if (!phone || !row.msgId || !row.msgAt || !row.msgText) continue;

    const bundles = analyseReleaseBundle(
      [{text: row.msgText, timestamp: row.msgAt, messageId: row.msgId}],
      {
        status: a.status,
        programId: a.programId,
        confidence: a.confidence,
        lighterVessel: row.roster?.lighterVessel ?? null,
        programStartDate: row.roster?.startDate ?? null,
      },
    );
    const bundle = bundles.find((item) => normalisePhone(item.employeeMobile) === phone);
    if (!bundle) continue;

    const result = await client.query(
      `UPDATE public.release_candidates SET
         extraction_status = $1,
         release_date_source = $2,
         conveyance_date = $3::date,
         office_return_date = $4::date,
         food_bill_date = $5::date,
         food_bill_amount_bdt = $6,
         food_bill_source_msg_id = $7,
         additional_amount_bdt = $8,
         additional_source_msg_id = $9,
         conveyance_purpose = $10,
         conveyance_status = $11,
         travel_date = $12::date,
         travel_date_source = $13,
         payment_instruction_date = $14::date,
         employee_identity_source = $15,
         sukani_mentioned = $16,
         evidence_message_ids = $17::jsonb,
         review_reasons = $18::jsonb,
         rule_trace = $19::jsonb
       WHERE source_msg_id = $20
         AND escort_phone = $21
         AND end_date = $22::date
         AND coalesce(amount_bdt, -1) = coalesce($23, -1)`,
      [
        extractionStatusOf(bundle),
        bundle.releaseDateSource === 'NONE' ? null : bundle.releaseDateSource,
        bundle.travelDateSource === 'EXPLICIT_TRAVEL_DATE' ? bundle.travelDate : null,
        bundle.officeReturnDate,
        bundle.foodBillDate,
        bundle.foodBillAmount,
        bundle.foodBillAmount !== null ? row.msgId : null,
        bundle.additionalAmount,
        bundle.additionalAmount !== null ? row.msgId : null,
        bundle.conveyancePurpose,
        bundle.conveyanceStatus,
        bundle.travelDate,
        bundle.travelDateSource,
        bundle.paymentInstructionDate,
        bundle.employeeIdentitySource,
        bundle.sukaniMentioned,
        JSON.stringify(bundle.evidenceMessageIds),
        JSON.stringify(bundle.reviewReasons),
        JSON.stringify([...bundle.ruleTrace, ...bundle.evidenceFlags]),
        row.msgId, a.escortPhone, a.endDate, a.amountBdt,
      ],
    );
    updated += (result as unknown as {rowCount?: number}).rowCount ?? 0;

    if (!capability.events || bundle.additionalAmount === null) continue;
    // One row per candidate. `verified` is true only for VERIFIED evidence, so a
    // candidate can never reach a payroll month.
    await client.query(
      `INSERT INTO public.vessel_conveyance_event
         (id, program_id, event_date, amount_minor, verified, source_ref, evidence, candidate_id)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7::jsonb,
               (SELECT rc.id FROM public.release_candidates rc
                 WHERE rc.source_msg_id=$8 AND rc.escort_phone=$9
                   AND rc.end_date=$10::date
                   AND coalesce(rc.amount_bdt,-1)=coalesce($11,-1)))
       ON CONFLICT DO NOTHING`,
      [
        `ce-${evidenceId([row.msgId, a.escortPhone, a.endDate, bundle.additionalAmount])}`,
        a.programId,
        bundle.travelDate,
        bundle.additionalAmount * 100, // BDT → paisa
        bundle.conveyanceStatus === 'VERIFIED',
        row.msgId,
        JSON.stringify({
          purpose: bundle.conveyancePurpose,
          status: bundle.conveyanceStatus,
          travelDateSource: bundle.travelDateSource,
          paymentInstructionDate: bundle.paymentInstructionDate,
          foodBillDate: bundle.foodBillDate,
          ruleTrace: bundle.ruleTrace,
          evidenceFlags: bundle.evidenceFlags,
          evidenceMessageIds: bundle.evidenceMessageIds,
          reviewReasons: bundle.reviewReasons,
          cashPosting: false,
        }),
        row.msgId, a.escortPhone, a.endDate, a.amountBdt,
      ],
    );
    events += (result as unknown as {rowCount?: number}).rowCount ?? 0;
  }
  return {updated, events, skipped: false};
}

// ════════════════════════════════════════════════════════════════════════════
// Food Bill → backward search → candidate (Owner finishing task).
//
// Disabled by default. When enabled, a Food Bill that carries no ASCII mobile
// becomes a review-grade candidate: MATCHED + confidence 'medium' (so the
// high-confidence auto-apply gate can never pick it up) or PENDING_REVIEW when
// the evidence is ambiguous. The release date is the explicit stated date when
// present, otherwise the verified Food Bill event date.
//
// Nothing here creates a Program, applies a release or touches Cash.
// ════════════════════════════════════════════════════════════════════════════

export function backwardSearchEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env.ALRIFAI_RELEASE_FOOD_BILL_SEARCH ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export type BackwardPersistResult = {inserted: number; blocked: number; skipped: boolean};

/**
 * Persist the backward-search candidates. Idempotent through the existing
 * candidate dedupe index (source message + phone + date + amount).
 */
export async function persistBackwardMatches(
  client: Queryable,
  backward: ScanResult['backward'],
  options: {enabled?: boolean} = {},
): Promise<BackwardPersistResult> {
  const enabled = options.enabled ?? backwardSearchEnabled(process.env as Record<string, string | undefined>);
  if (!enabled || !backward.length) return {inserted: 0, blocked: 0, skipped: !enabled};

  let inserted = 0;
  let blocked = 0;
  for (const {hint, match} of backward) {
    const releaseDate = hint.explicitReleaseDate ?? hint.messageDate;
    const phone = hint.escortMobile ?? '';
    try {
      const result = await client.query(
        `INSERT INTO public.release_candidates
           (escort_phone, escort_name, program_id, end_date, end_shift,
            amount_bdt, duty_days, calc_start, conveyance, match_status,
            match_pass, mismatch_kind, confidence, notes, source_msg_id, source_date, source_text)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::date,NULL,$9,NULL,NULL,$10,$11,$12,$13::timestamptz,$14)
         ON CONFLICT DO NOTHING`,
        [
          phone, hint.escortName ?? '', match.programId, releaseDate, hint.shift,
          hint.amountBdt, hint.estimatedDays, hint.estimatedStart,
          match.status === 'MATCHED' ? 'MATCHED' : 'PENDING_REVIEW',
          match.confidence, `backward-search:${match.signals.join('+') || match.reasons.join('+')}`,
          hint.messageId, hint.messageDate, hint.messageId,
        ],
      );
      inserted += (result as unknown as {rowCount?: number}).rowCount ?? 0;
    } catch (error) {
      // The candidate table requires a valid mobile. A phone-less ambiguous match
      // needs candidate migration 0076; report it instead of hiding it.
      const code = (error as {code?: string})?.code;
      if (code === '23514') {
        blocked += 1;
        console.error('Release backward search: phone-less candidate needs migration 0076 (escort_phone CHECK); held out.');
        continue;
      }
      throw error;
    }
  }
  return {inserted, blocked, skipped: false};
}
