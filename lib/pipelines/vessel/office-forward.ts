// Office Group escort assignment → Bridge-1 → client forward (Step 15).
// Only live messages after the recorded cutover may be forwarded. The flag and
// the outbound env switch must both be enabled; historical messages never send.

import {existsSync} from 'node:fs';
import {row} from '../../standalone/db.ts';
import {getFeatureFlag} from '../../feature-flags.ts';
import {callSocketTool} from '../../standalone/whatsapp.ts';

export type OfficeAssignmentMessage = {
  message_id: string;
  account_id: string;
  source_rowid?: number | string | null;
};

export type OfficeProgram = {
  id: string;
  source_chat_jid?: string | null;
  draft_text?: string | null;
};

export async function forwardOfficeAssignment(
  message: OfficeAssignmentMessage,
  program: OfficeProgram,
): Promise<{forwarded: boolean; reason: string}> {
  const flag = await getFeatureFlag('vessel.office_forward', {enabled: false});
  if (!flag.enabled) return {forwarded: false, reason: 'FLAG_DISABLED'};
  if (process.env.ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED !== '1') {
    return {forwarded: false, reason: 'OUTBOUND_DISABLED'};
  }
  const cutoverRow = await row<{freeze_cutover_rowid_wa01: string | null}>(
    `SELECT freeze_cutover_rowid_wa01::text
       FROM vessel_backlog_progress
      ORDER BY created_at DESC
      LIMIT 1`,
  ).catch(() => null);
  const cutover = Number(cutoverRow?.freeze_cutover_rowid_wa01 ?? 20006);
  const rowid = Number(message.source_rowid ?? 0);
  if (!Number.isFinite(rowid) || rowid <= cutover) {
    return {forwarded: false, reason: 'HISTORICAL_MESSAGE_BLOCKED'};
  }
  if (!program.source_chat_jid || !program.draft_text) {
    return {forwarded: false, reason: 'PROGRAM_TARGET_MISSING'};
  }
  const socket = process.env.ALRIFAI_VESSEL_DRAFT_SENDER_SOCKET?.trim();
  const tokenFile = process.env.ALRIFAI_VESSEL_DRAFT_SENDER_TOKEN_FILE?.trim();
  if (!socket || !tokenFile || !existsSync(socket) || !existsSync(tokenFile)) {
    return {forwarded: false, reason: 'TRANSPORT_NOT_CONFIGURED'};
  }
  try {
    const result = await callSocketTool(socket, tokenFile, 'send_message', {
      recipient: program.source_chat_jid,
      message: program.draft_text,
    });
    return result.success === true
      ? {forwarded: true, reason: 'SENT'}
      : {forwarded: false, reason: 'BRIDGE_REJECTED'};
  } catch (error) {
    return {forwarded: false, reason: error instanceof Error ? error.message : 'BRIDGE_ERROR'};
  }
}
