// AL-RIFA'I — resolve the one authorised recipient for a Vessel Draft.
//
// The delivery target is the SAME original authorised conversation that gave
// the order: a direct Escort Client chat or an approved ORDERS group. It is
// never an Admin JID fallback, never an unrelated group and never a guessed
// alias.
//
// The source conversation is accepted only when ALL of the following hold:
//   * the program has a source message id;
//   * exactly one chat contains that message (no ambiguous duplicate rows);
//   * the program's source chat matches that chat exactly;
//   * the chat is in the Owner-approved business allowlist for WA-01;
//   * the chat row is authorised with purpose ORDERS or BOTH;
//   * the message is INCOMING;
//   * for a group, the order sender is an active approved participant;
//   * for a direct chat, the incoming sender matches the chat identity.
//
// If any check fails the draft is not queued. A refusal is audited by the
// caller; this module is read-only and never opens a WhatsApp socket.

import {row, rows} from './db.ts';
import {jidsMatch} from '../whatsapp-identity.mjs';

export type RecipientResolution =
  | {
      status: 'RESOLVED';
      recipientJid: string;
      basis: 'SOURCE_CONVERSATION' | 'EXPLICIT_PIN_MATCH';
      sourceMessageId: string;
    }
  | {
      status: 'RECIPIENT_NOT_APPROVED' | 'SOURCE_CONVERSATION_NOT_FOUND';
      reason: string;
    };

export type ResolveRecipientInput = {
  programId: string;
  sourceMessageId?: string | null;
  sourceChatJid?: string | null;
  explicitRecipient?: string | null;
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const isGroup = (jid: string): boolean => jid.endsWith('@g.us');

async function businessAllowlist(): Promise<string[]> {
  const setting = await row<{value: unknown}>(
    "SELECT value FROM app_settings WHERE key = 'phase3_business_chats:wa-01'",
  ).catch(() => null);
  if (!Array.isArray(setting?.value)) return [];
  return setting.value.map(str).filter(Boolean);
}

/**
 * Resolve the recipient. Read-only: it performs no queue write and never opens
 * a WhatsApp socket.
 */
export async function resolveDraftRecipient(
  input: ResolveRecipientInput,
): Promise<RecipientResolution> {
  const sourceMessageId = str(input.sourceMessageId);
  if (!sourceMessageId) {
    return {status: 'SOURCE_CONVERSATION_NOT_FOUND', reason: 'SOURCE_MESSAGE_REQUIRED'};
  }

  const allowlist = await businessAllowlist();
  if (!allowlist.length) {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'BUSINESS_CONVERSATION_ALLOWLIST_UNAVAILABLE',
    };
  }

  const messages = await rows<{
    chat_jid: string;
    sender_jid: string | null;
    direction: 'INCOMING' | 'OUTGOING';
  }>(
    `SELECT chat_jid, sender_jid, direction
       FROM whatsapp_messages
      WHERE account_id = 'wa-01' AND message_id = $1`,
    [sourceMessageId],
  ).catch(() => []);

  if (!messages.length) {
    return {status: 'SOURCE_CONVERSATION_NOT_FOUND', reason: 'SOURCE_MESSAGE_NOT_FOUND'};
  }
  const chats = new Set(messages.map((message) => str(message.chat_jid)).filter(Boolean));
  if (chats.size !== 1) {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_CONVERSATION_AMBIGUOUS',
    };
  }
  const source = messages[0];
  const recipientJid = str(source.chat_jid);
  const programChat = str(input.sourceChatJid);
  if (programChat && programChat !== recipientJid) {
    // Do not alias-resolve a mismatch: that could deliver to a different chat.
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_CHAT_MISMATCH',
    };
  }

  if (!allowlist.includes(recipientJid)) {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_CONVERSATION_NOT_IN_BUSINESS_SCOPE',
    };
  }

  const chatRow = await row<{purpose: string | null; authorized: boolean}>(
    `SELECT purpose, authorized FROM whatsapp_chats
      WHERE account_id = 'wa-01' AND chat_jid = $1`,
    [recipientJid],
  ).catch(() => null);
  if (!chatRow || !chatRow.authorized) {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_CONVERSATION_NOT_AUTHORIZED',
    };
  }
  const purpose = chatRow.purpose ?? 'BOTH';
  if (purpose !== 'ORDERS' && purpose !== 'BOTH') {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_CONVERSATION_NOT_ORDERS',
    };
  }

  if (source.direction !== 'INCOMING') {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_MESSAGE_NOT_INCOMING',
    };
  }
  const sender = str(source.sender_jid);
  if (!sender) {
    return {status: 'SOURCE_CONVERSATION_NOT_FOUND', reason: 'SOURCE_SENDER_MISSING'};
  }

  if (isGroup(recipientJid)) {
    const participants = await rows<{participant_jid: string}>(
      `SELECT participant_jid
         FROM escort_client_group_authorizations
        WHERE account_id = 'wa-01'
          AND group_jid = $1
          AND active = true`,
      [recipientJid],
    ).catch(() => []);
    if (!participants.some((entry) => jidsMatch(entry.participant_jid, sender))) {
      return {
        status: 'RECIPIENT_NOT_APPROVED',
        reason: 'GROUP_PARTICIPANT_NOT_AUTHORIZED',
      };
    }
  } else if (!jidsMatch(sender, recipientJid)) {
    return {
      status: 'RECIPIENT_NOT_APPROVED',
      reason: 'DIRECT_SENDER_CHAT_MISMATCH',
    };
  }

  const explicit = str(input.explicitRecipient);
  if (explicit && explicit !== recipientJid) {
    return {
      status: 'RECIPIENT_NOT_APPROVED',
      reason: 'EXPLICIT_RECIPIENT_MISMATCH',
    };
  }

  return {
    status: 'RESOLVED',
    recipientJid,
    basis: explicit ? 'EXPLICIT_PIN_MATCH' : 'SOURCE_CONVERSATION',
    sourceMessageId,
  };
}
