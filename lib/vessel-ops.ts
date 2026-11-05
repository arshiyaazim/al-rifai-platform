// Persistence for derived vessel register operations and confirmed programs.
//
// Shared by the live vessel processor and the approved backfill so both produce
// identical rows for identical evidence. Register rows are DRAFT/REVIEW only.
// A confirmed program is created only from an Owner-rule confirmation (the actual
// outgoing Admin message in the same client conversation) and is idempotent.

import {createHash} from 'node:crypto';
import type {IngestionDbClient} from '../scripts/ingestion-db.ts';
import {programIdFor, vesselKey, type MatchState} from './vessel-match.ts';

type DbClient = IngestionDbClient;

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export type VesselOperation = {
  kind: 'DRAFT' | 'REVIEW';
  row: Record<string, unknown> & {
    id: string; accountId: string; clientContactId: string; clientPhone: string;
    chatJid: string; sourceMessageId: string; sourceHash: string; blockKey: string;
    sourceTime: string; motherVessel: string; lighterVessel: string; masterMobile: string;
    cargo: string; capacity: string; importer: string; destination: string;
    bookingDate: string | null; escortName: string; escortMobile: string;
    dutyDate: string | null; shift: string; releasePoint: string; status: string;
    reasons: unknown[]; parsed: unknown; sourceText: string; businessKey: string | null;
    confirmationMessageId?: string | null; confirmationSourceHash?: string | null;
  };
  event: {
    id: string; orderId: string; eventType: string; sourceMessageId: string;
    sourceHash: string; payload: Record<string, unknown>;
  };
};

export async function persistOperation(client: DbClient, operation: VesselOperation): Promise<void> {
  if (operation.kind !== 'DRAFT' && operation.kind !== 'REVIEW') {
    throw new Error('UNSAFE_VESSEL_TRANSITION_BLOCKED');
  }
  const row = operation.row;
  await client.query(
    `INSERT INTO public.escort_order_register
     (id,account_id,client_contact_id,client_phone,chat_jid,source_message_id,source_hash,
      block_key,source_time,mother_vessel,lighter_vessel,master_mobile,cargo,capacity,importer,
      destination,booking_date,escort_name,escort_mobile,duty_date,shift,release_point,status,
      reasons,parsed,source_text,business_key,confirmation_message_id,confirmation_source_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
     $24::jsonb,$25::jsonb,$26,$27,$28,$29)
     ON CONFLICT DO NOTHING`,
    [row.id, row.accountId, row.clientContactId, row.clientPhone, row.chatJid, row.sourceMessageId, row.sourceHash,
      row.blockKey, row.sourceTime, row.motherVessel, row.lighterVessel, row.masterMobile, row.cargo, row.capacity,
      row.importer, row.destination, row.bookingDate, row.escortName, row.escortMobile, row.dutyDate, row.shift,
      row.releasePoint, row.status, JSON.stringify(row.reasons), JSON.stringify(row.parsed), row.sourceText,
      row.businessKey, row.confirmationMessageId ?? null, row.confirmationSourceHash ?? null],
  );
  await client.query(
    `INSERT INTO public.escort_order_sources
     (account_id,source_hash,block_key,order_id,client_contact_id,source_message_id,chat_jid,source_time,provenance)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT(account_id,dataset_epoch,source_hash,block_key) DO NOTHING`,
    [row.accountId, row.sourceHash, row.blockKey, row.id, row.clientContactId, row.sourceMessageId, row.chatJid,
      row.sourceTime, JSON.stringify(operation.event.payload.source)],
  );
  await client.query(
    `INSERT INTO public.escort_order_events
     (id,order_id,event_type,source_message_id,source_hash,payload)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(order_id,event_type,source_hash) DO NOTHING`,
    [operation.event.id, operation.event.orderId, operation.event.eventType,
      operation.event.sourceMessageId, operation.event.sourceHash, JSON.stringify(operation.event.payload)],
  );
}

export type ConfirmedProgramInput = {
  account: string;
  clientChat: string;
  mother: string;
  lighter: string;
  masterMobile: string;
  destination: string;
  escortName: string;
  escortMobile: string;
  startDate: string;
  shift: 'D' | 'N';
  orderId: string;
  orderMessageId: string;
  confirmationMessageId: string;
  confirmationSourceHash: string;
  reviewRowId: string;
  matchState: MatchState;
  mobileEvidence: string;
  employeeLink?: {state: 'RESOLVED' | 'UNRESOLVED'; employeeId: string; name: string | null} | null;
  /**
   * "Escort Change" link between two separately recorded duties. The link is
   * recorded on both sides; the release date is never inferred, so
   * program_assignments.released_on stays NULL.
   */
  replacementOf?: string;
  replacedBy?: string;
  replacementReason?: string;
};

export type ConfirmedProgramResult = {programId: string; created: boolean};

/**
 * Create exactly one program per Lighter. The id is derived from account, client
 * conversation, vessel pair, start date and shift, so replay cannot duplicate it.
 * No message is sent and no payment is posted.
 */
export async function persistConfirmedProgram(client: DbClient, input: ConfirmedProgramInput): Promise<ConfirmedProgramResult> {
  if (!input.startDate || !['D', 'N'].includes(input.shift)) throw new Error('CONFIRMATION_FIELDS_INCOMPLETE');
  if (!input.escortName || !input.escortMobile) throw new Error('CONFIRMATION_FIELDS_INCOMPLETE');
  const programId = programIdFor({
    account: input.account,
    clientChat: input.clientChat,
    mother: input.mother,
    lighter: input.lighter,
    startDate: input.startDate,
    shift: input.shift,
  });
  const createdAt = new Date().toISOString();
  const details = {
    version: 'alrifai-vessel-program-v1',
    clientChat: input.clientChat,
    orderId: input.orderId,
    orderMessageId: input.orderMessageId,
    confirmationMessageId: input.confirmationMessageId,
    confirmationSourceHash: input.confirmationSourceHash,
    sourceMessageId: input.orderMessageId || null,
    matchState: input.matchState,
    mobileEvidence: input.mobileEvidence,
    motherKey: vesselKey(input.mother),
    lighterKey: vesselKey(input.lighter),
    employeeLink: input.employeeLink ?? {state: 'UNRESOLVED', employeeId: input.escortMobile, name: null},
    ownerRule: 'ADMIN_OUTGOING_MESSAGE_IS_CONFIRMATION',
    ...(input.replacementOf
      ? {replacementOf: input.replacementOf, replacementReason: input.replacementReason ?? 'ESCORT_CHANGE'}
      : {}),
    ...(input.replacedBy ? {replacedBy: input.replacedBy} : {}),
  };
  const inserted = await client.query(
    `INSERT INTO public.programs
     (id,"motherVessel","lighterVessel","masterMobile",destination,"escortName","escortMobile",
      "startDate","endDate",shift,status,source,notes,"duplicateOf","createdAt",revision,details,dataset_epoch)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'',$9,'Confirmed','WA-01 Admin confirmation','',NULL,$10,0,$11,'CANONICAL_BACKFILL_20261026')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [programId, input.mother, input.lighter, input.masterMobile, input.destination, input.escortName,
      input.escortMobile, input.startDate, input.shift, createdAt, JSON.stringify(details)],
  );
  const created = (inserted.rows?.length ?? 0) > 0;
  await client.query(
    `INSERT INTO public.program_assignments
     (id,scope_account,program_id,revision,employee_mobile,employee_person_id,start_date,start_shift,
      duty_started_on,released_on,predecessor_id,command_receipt,source_refs)
     VALUES($1,$2,$3,1,$4,NULL,$5,$6,NULL,NULL,$7::text,$8,$9::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [hash(['vessel-assignment', programId]), input.account, programId, input.escortMobile, input.startDate,
      input.shift, input.replacementOf ? hash(['vessel-assignment', input.replacementOf]) : null,
      hash(['vessel-confirmation', programId, input.confirmationMessageId]),
      JSON.stringify([input.orderMessageId, input.confirmationMessageId])],
  );
  // Link the intake evidence row to the program it produced and close its
  // review state in the SAME statement, so the row can never be left as an
  // actionable review item after a Program exists. 'CONFIRMED' is the terminal
  // value the schema CHECK already allows and the API/UI already render; no new
  // status and no migration are introduced. Parsed evidence, reasons, source
  // text and the original Draft fields are preserved; only status advances.
  // `programCreatedAt` is written once, so re-processing is idempotent.
  //
  // The link is fail-closed: when a review row is named it must be exactly one
  // row belonging to this order and confirmation, otherwise the caller's
  // transaction aborts instead of leaving a Program without its evidence row.
  // Callers that legitimately have no register row pass an empty reviewRowId.
  if (input.reviewRowId) {
    const linked = await client.query(
      `UPDATE public.escort_order_register
          SET status='CONFIRMED',
              parsed=parsed||$2::jsonb||CASE WHEN parsed ? 'programCreatedAt' THEN '{}'::jsonb
                                             ELSE jsonb_build_object('programCreatedAt',now()) END,
              updated_at=now()
        WHERE id=$1 AND account_id=$3 AND dataset_epoch='CANONICAL_BACKFILL_20261026'
          AND (confirmation_message_id IS NULL OR confirmation_message_id=$4)
          AND (source_message_id IS NULL OR source_message_id=$4 OR source_message_id=$5)
        RETURNING id`,
      [input.reviewRowId, JSON.stringify({programId, confirmationMatch: {state: input.matchState, mobileEvidence: input.mobileEvidence}}), input.account, input.confirmationMessageId, input.orderMessageId],
    );
    if ((linked.rowCount ?? 0) !== 1) throw new Error('REGISTER_ROW_NOT_MATCHED');
  }
  return {programId, created};
}

// ════════════════════════════════════════════════════════════════════════════
// Business-identity duplicate guard (backfill preparation).
//
// The live processor and the historical backfill derive DIFFERENT row ids for
// the same evidence: the backfill salts the hash with the dataset epoch, the
// live processor does not, while both write dataset_epoch = the column default.
// The register has no unique business index (329 duplicate groups already exist
// across the two epoch labels), so only the writer can prevent a new duplicate.
//
// Two identities are compared, because neither one alone is safe:
//
//  1. BUSINESS identity — account + source message id + normalized Lighter +
//     duty date. Human-meaningful, and it catches a row that was written with a
//     different generated id (the epoch salt) but the same evidence.
//
//  2. BLOCK identity — account + source message id + the block's start line
//     (the leading integer of block_key). Stable across parser corrections: the
//     line a Lighter starts on does not move when a name, capacity, date or
//     shift is parsed better, whereas the business key does. Measured on the
//     current corpus: of the 18 blocks a backfill derives, 5 would re-insert a
//     Draft whose name the older parser had polluted. The business key alone
//     catches none of them, because the name is exactly what changed; the block
//     identity catches all five.
//
// Both are checked, both are advisory-locked, and the lock is transaction-
// scoped, so two concurrent writers of the same evidence serialize instead of
// both inserting. It is additive: the live path keeps calling persistOperation()
// unchanged.
// ════════════════════════════════════════════════════════════════════════════

/** Same normalization as vesselKey(): case, punctuation, spacing and MV prefix. */
export function normalizeVesselIdentity(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^m\.?\s*v\.?\s*[:.]?\s*/i, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function businessIdentityKey(operation: VesselOperation): string {
  const row = operation.row;
  return [
    row.accountId,
    row.sourceMessageId,
    normalizeVesselIdentity(row.lighterVessel),
    row.dutyDate ?? '',
  ].join('|');
}

/**
 * Identity of the parsed block inside its source message. Returns '' when the
 * operation carries no block key, in which case only the business key applies.
 */
export function blockIdentityKey(operation: VesselOperation): string {
  const row = operation.row;
  const ordinal = String(row.blockKey ?? '').split(':')[0].trim();
  return ordinal ? [row.accountId, row.sourceMessageId, ordinal].join('|') : '';
}

export type PersistResult = 'inserted' | 'skipped_duplicate';

/** The identity columns the guard needs. Register rows match this shape. */
export type RegisterIdentityRow = {
  lighter_vessel?: string | null;
  duty_date?: string | null;
  block_key?: string | null;
};

/**
 * A DATE column arrives as a JS Date from `SELECT *` but as text from the
 * guard's own `duty_date::text` projection. Normalise both to YYYY-MM-DD so the
 * predicate cannot fail open just because of the driver's representation.
 */
function identityDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Pure duplicate predicate, shared by the writer and by the backfill dry run so
 * that both report the same insert/skip split.
 */
export function isDuplicateRegisterRow(
  existing: readonly RegisterIdentityRow[],
  operation: VesselOperation,
): boolean {
  const targetLighter = normalizeVesselIdentity(operation.row.lighterVessel);
  const targetDate = identityDate(operation.row.dutyDate);
  const targetOrdinal = blockIdentityKey(operation).split('|')[2] ?? '';
  return existing.some((row) => {
    const existingOrdinal = String(row.block_key ?? '').split(':')[0].trim();
    if (targetOrdinal && existingOrdinal === targetOrdinal) return true;
    return normalizeVesselIdentity(row.lighter_vessel) === targetLighter
      && identityDate(row.duty_date) === targetDate;
  });
}

/**
 * Insert only when no row with the same business or block identity exists.
 *
 * Preconditions: the caller is inside a transaction (both the ingestion
 * processor and the backfill begin one per message). The advisory locks are
 * transaction-scoped, so the check and the insert cannot interleave with another
 * guarded writer for the same key. The two lock keys are sorted so that two
 * writers can never acquire them in opposite order.
 */
export async function persistOperationIfNew(
  client: DbClient,
  operation: VesselOperation,
): Promise<PersistResult> {
  const keys = [businessIdentityKey(operation), blockIdentityKey(operation)]
    .filter((key) => key !== '')
    .sort();
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1)), pg_advisory_xact_lock(hashtext($2))',
    [keys[0], keys[1] ?? keys[0]],
  );
  const {rows} = await client.query(
    `SELECT lighter_vessel, duty_date::text AS duty_date, block_key
       FROM public.escort_order_register
      WHERE account_id = $1 AND source_message_id = $2`,
    [operation.row.accountId, operation.row.sourceMessageId],
  );
  if (isDuplicateRegisterRow((rows ?? []) as RegisterIdentityRow[], operation)) return 'skipped_duplicate';
  await persistOperation(client, operation);
  return 'inserted';
}
