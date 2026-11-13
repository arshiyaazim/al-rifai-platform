// AL-RIFA'I — Escort Release review read model (server only).
//
// No new table: a slip is derived from the release-group messages, and its state
// is derived from evidence that already exists:
//   * APPROVED  -> programs.release_message_id points at the message, or the
//                  review queue row was resolved as APPROVED by this page;
//   * DECLINED  -> message_review_queue row with resolved_workflow
//                  'release-review' and status REJECTED/IGNORED;
//   * PENDING   -> everything else.
//
// Parsing is pure (lib/release-slip.ts + lib/release-parser.ts). Cash matching is
// read-only: it never creates a cash instruction.

import {row, rows, tx} from './db.ts';
import type {Actor} from './db.ts';
import {assertCapability} from './authz.ts';
import {releaseProgram} from './programs.ts';
import {parseReleaseSlips} from '../release-slip.ts';
import {parseMessage} from '../release-parser.ts';

export const RELEASE_CHAT_JID = '120363408741101070@g.us';
export const RELEASE_ACCOUNT_ID = 'wa-01';

export type ReleaseStatus = 'PENDING' | 'APPROVED' | 'DECLINED';

export type ReleaseSlipRow = {
  messageId: string;
  messageAt: string;
  slipDate: string;
  escortMobile: string | null;
  escortName: string | null;
  lighterVessel: string | null;
  lighterMaster: string | null;
  motherVessel: string | null;
  startDate: string | null;
  endDate: string | null;
  endShift: string | null;
  dutyDays: number | null;
  foodBillMinor: number | null;
  destination: string | null;
  structured: boolean;
  imageLink: string | null;
  status: ReleaseStatus;
  cashVerified: boolean;
  cashAmountMinor: string | null;
  programId: string | null;
};

const dhakaDate = (value: string | null | undefined): string => {
  const at = new Date(String(value ?? ''));
  if (!Number.isFinite(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Dhaka'})
    .format(at);
};

const addDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

type MessageRow = {
  message_id: string;
  account_id: string;
  chat_jid: string;
  source_timestamp: string;
  text_content: string | null;
  media_type: string | null;
};

export async function listReleaseSlips(): Promise<ReleaseSlipRow[]> {
  const messages = await rows<MessageRow>(
    `SELECT message_id, account_id, chat_jid, source_timestamp::text AS source_timestamp,
            text_content, media_type
       FROM whatsapp_messages
      WHERE chat_jid = $1 AND deleted_at IS NULL
      ORDER BY source_timestamp DESC`,
    [RELEASE_CHAT_JID],
  );

  const parsed: Array<Omit<ReleaseSlipRow, 'status' | 'cashVerified' | 'cashAmountMinor' | 'programId' | 'imageLink'> & {
    accountId: string; chatJid: string; mediaType: string | null;
  }> = [];

  for (const message of messages) {
    const text = String(message.text_content ?? '');
    if (!text.trim()) continue;
    const slip = parseReleaseSlips(text)[0];
    if (slip) {
      parsed.push({
        messageId: message.message_id,
        accountId: message.account_id,
        chatJid: message.chat_jid,
        mediaType: message.media_type,
        messageAt: message.source_timestamp,
        slipDate: dhakaDate(message.source_timestamp),
        escortMobile: slip.fields.escortMobile,
        escortName: slip.fields.escortName,
        lighterVessel: slip.fields.lighterVessel,
        lighterMaster: slip.fields.masterMobile,
        motherVessel: slip.fields.motherVessel,
        startDate: slip.fields.startDate,
        endDate: slip.fields.endDate,
        endShift: slip.fields.endShift,
        dutyDays: slip.fields.totalDays,
        foodBillMinor: slip.fields.foodBillMinor,
        destination: slip.fields.destination,
        structured: true,
      });
      continue;
    }
    const payment = parseMessage(text, message.source_timestamp)[0];
    if (!payment) continue;
    parsed.push({
      messageId: message.message_id,
      accountId: message.account_id,
      chatJid: message.chat_jid,
      mediaType: message.media_type,
      messageAt: message.source_timestamp,
      slipDate: dhakaDate(message.source_timestamp),
      escortMobile: payment.escortPhone,
      escortName: payment.escortName,
      lighterVessel: null,
      lighterMaster: null,
      motherVessel: null,
      startDate: payment.statedStartDate ?? payment.calcStart,
      endDate: payment.statedReleaseDate ?? payment.endDate,
      endShift: payment.statedReleaseShift ?? payment.endShift,
      dutyDays: payment.explicitDayCount ?? payment.dutyDays,
      foodBillMinor: payment.amountBdt === null ? null : Math.round(payment.amountBdt * 100),
      destination: null,
      structured: false,
    });
  }

  const messageIds = parsed.map((item) => item.messageId);
  const mobiles = [...new Set(parsed.map((item) => item.escortMobile).filter(Boolean))] as string[];
  const plusMobiles = mobiles.map((mobile) => `+88${mobile}`);

  // Approved evidence: the program was released from this message.
  const released = messageIds.length
    ? await rows<{release_message_id: string}>(
      `SELECT release_message_id FROM programs WHERE release_message_id = ANY($1::text[])`,
      [messageIds],
    )
    : [];
  const approvedMessages = new Set(released.map((item) => item.release_message_id));

  // Decline evidence: review rows resolved by this page.
  const decisions = messageIds.length
    ? await rows<{source_message_id: string; status: string}>(
      `SELECT source_message_id, status FROM message_review_queue
        WHERE source_message_id = ANY($1::text[]) AND resolved_workflow = 'release-review'`,
      [messageIds],
    )
    : [];
  const decisionByMessage = new Map(decisions.map((item) => [item.source_message_id, item.status]));

  // Program enrichment (lighter/mother/master) for payment-only slips.
  const programs = plusMobiles.length
    ? await rows<{
      id: string; escort_mobile: string | null; lighter_vessel: string | null;
      mother_vessel: string | null; master_mobile: string | null;
      start_date: string; end_date: string | null; release_message_id: string | null;
    }>(
      `SELECT id, escort_mobile, lighter_vessel, mother_vessel, master_mobile,
              start_date::text AS start_date, end_date::text AS end_date, release_message_id
         FROM programs
        WHERE escort_mobile = ANY($1::text[])
        ORDER BY start_date DESC`,
      [plusMobiles],
    )
    : [];
  const programsByMobile = new Map<string, typeof programs>();
  for (const program of programs) {
    const key = String(program.escort_mobile ?? '').replace(/^\+?88/, '');
    const list = programsByMobile.get(key) ?? [];
    list.push(program);
    programsByMobile.set(key, list);
  }

  // Cash cross-check: posted payments to the escort on the release day or the
  // day after. Read-only; no instruction is created here.
  const cash = plusMobiles.length
    ? await rows<{employee_mobile: string; day: string; amount: string}>(
      `SELECT i.employee_mobile,
              (i.event_at AT TIME ZONE 'Asia/Dhaka')::date::text AS day,
              sum(p.amount_minor)::bigint::text AS amount
         FROM cash_instructions i
         JOIN cash_postings p ON p.instruction_id = i.id
        WHERE i.state = 'POSTED' AND i.employee_mobile = ANY($1::text[])
        GROUP BY 1, 2`,
      [plusMobiles],
    )
    : [];
  const cashByKey = new Map(cash.map((item) => [`${item.employee_mobile}|${item.day}`, item.amount]));

  // Attachments that are actually stored (the media route only serves those).
  const stored = messageIds.length
    ? await rows<{message_id: string}>(
      `SELECT message_id FROM whatsapp_media
        WHERE chat_jid = $1 AND message_id = ANY($2::text[]) AND status = 'STORED'`,
      [RELEASE_CHAT_JID, messageIds],
    )
    : [];
  const storedMessages = new Set(stored.map((item) => item.message_id));

  return parsed.map((item) => {
    const slipEnd = item.endDate;
    const slipStart = item.startDate;
    const program = item.escortMobile
      ? (programsByMobile.get(item.escortMobile) ?? []).find((candidate) => {
        if (!slipEnd) return true;
        return candidate.start_date <= slipEnd
          && (!candidate.end_date || !slipStart || candidate.end_date >= slipStart);
      }) ?? null
      : null;

    const mobileKey = item.escortMobile ? `+88${item.escortMobile}` : '';
    const end = item.endDate;
    const amount = end ? cashByKey.get(`${mobileKey}|${end}`) ?? cashByKey.get(`${mobileKey}|${addDays(end, 1)}`) ?? null : null;

    const decision = decisionByMessage.get(item.messageId);
    const status: ReleaseStatus = approvedMessages.has(item.messageId)
      ? 'APPROVED'
      : decision === 'REJECTED' || decision === 'IGNORED'
        ? 'DECLINED'
        : 'PENDING';

    const imageLink = item.mediaType === 'image' && storedMessages.has(item.messageId)
      ? `/api/media?account=${encodeURIComponent(item.accountId)}&chat=${encodeURIComponent(item.chatJid)}&message=${encodeURIComponent(item.messageId)}`
      : null;

    return {
      messageId: item.messageId,
      messageAt: item.messageAt,
      slipDate: item.slipDate,
      escortMobile: item.escortMobile,
      escortName: item.escortName,
      lighterVessel: item.lighterVessel ?? program?.lighter_vessel ?? null,
      lighterMaster: item.lighterMaster ?? program?.master_mobile ?? null,
      motherVessel: item.motherVessel ?? program?.mother_vessel ?? null,
      startDate: item.startDate,
      endDate: item.endDate,
      endShift: item.endShift,
      dutyDays: item.dutyDays,
      foodBillMinor: item.foodBillMinor,
      destination: item.destination,
      structured: item.structured,
      imageLink,
      status,
      cashVerified: Boolean(amount),
      cashAmountMinor: amount,
      programId: program?.id ?? null,
    };
  });
}

type ReleaseDecisionInput = {messageId: string; action: 'approve' | 'decline'; reason?: string};

export async function decideReleaseSlip(actor: Actor, input: ReleaseDecisionInput) {
  assertCapability(actor, 'vessel.release');
  const slips = await listReleaseSlips();
  const slip = slips.find((item) => item.messageId === input.messageId);
  if (!slip) throw new Error('RELEASE_SLIP_NOT_FOUND');

  const message = await row<{sender_jid: string | null}>(
    'SELECT sender_jid FROM whatsapp_messages WHERE chat_jid = $1 AND message_id = $2',
    [RELEASE_CHAT_JID, input.messageId],
  );

  if (input.action === 'decline') {
    await tx(async (client) => {
      await client.query(
        `INSERT INTO message_review_queue
           (id, source_account_id, source_chat_jid, source_message_id, status,
            resolved_workflow, admin_comment, resolved_by, resolved_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'REJECTED', 'release-review', $4, $5, now(), now())
         ON CONFLICT (source_account_id, source_chat_jid, source_message_id)
         DO UPDATE SET status = 'REJECTED', resolved_workflow = 'release-review',
                       admin_comment = EXCLUDED.admin_comment,
                       resolved_by = EXCLUDED.resolved_by, resolved_at = now()`,
        [RELEASE_ACCOUNT_ID, RELEASE_CHAT_JID, input.messageId, input.reason ?? null, actor.id],
      );
    });
    return {status: 'DECLINED' as const};
  }

  if (!slip.escortMobile || !slip.endDate) throw new Error('RELEASE_SLIP_INCOMPLETE');
  if (!slip.programId) throw new Error('RELEASE_PROGRAM_NOT_MATCHED');

  await releaseProgram(actor, slip.programId, {
    endDate: slip.endDate,
    endShift: slip.endShift ?? 'D',
    note: `Released from review page · WhatsApp ${input.messageId}`,
    release: {
      messageId: input.messageId,
      chatJid: RELEASE_CHAT_JID,
      senderJid: message?.sender_jid ?? null,
      accountId: RELEASE_ACCOUNT_ID,
      timestamp: slip.messageAt,
    },
  });

  await tx(async (client) => {
    await client.query(
      `INSERT INTO message_review_queue
         (id, source_account_id, source_chat_jid, source_message_id, status,
          resolved_workflow, resolved_by, resolved_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'APPROVED', 'release-review', $4, now(), now())
       ON CONFLICT (source_account_id, source_chat_jid, source_message_id)
       DO UPDATE SET status = 'APPROVED', resolved_workflow = 'release-review',
                     resolved_by = EXCLUDED.resolved_by, resolved_at = now()`,
      [RELEASE_ACCOUNT_ID, RELEASE_CHAT_JID, input.messageId, actor.id],
    );
  });

  return {status: 'APPROVED' as const, programId: slip.programId};
}
