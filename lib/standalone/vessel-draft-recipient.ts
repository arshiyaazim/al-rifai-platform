// AL-RIFA'I — resolve the one authorised recipient for a Vessel Draft.
//
// The Owner-approved direction is one direct Admin conversation, never a client
// or release group. This module resolves the Admin identity from the original
// order conversation in two bounded ways:
//
//   1. ALRIFAI_VESSEL_DRAFT_RECIPIENT_JID (explicit Owner pin) — used verbatim,
//      except that a group JID is always refused;
//   2. otherwise, the ADMIN identity that participates in the original order
//      conversation (an OUTGOING sender in that chat), matched against
//      whatsapp_accounts.admin_jids for WA-01. The client who sent the order is
//      NOT the recipient. If no Admin participates, an INCOMING order sender is
//      used only when that sender is itself an authorised, non-self Admin.
//
// Nothing is invented. A LID is never turned into a phone number, a group is
// never used as a recipient, an ambiguous Admin set is refused rather than
// guessed, and the sending account's own phone-number identity is excluded.

import {row, rows} from './db.ts';
import {jidKind, jidsMatch} from '../whatsapp-identity.mjs';

export type RecipientResolution =
  | {
      status: 'RESOLVED';
      recipientJid: string;
      basis: 'EXPLICIT' | 'SOURCE_CONVERSATION' | 'SOURCE_CHAT';
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

function adminList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter(Boolean);
}

/** Prefer a suffixed form of the same identity that matches the observed kind. */
function preferredAdminForm(admins: string[], observed: string): string | null {
  const matches = admins.filter((admin) => jidsMatch(admin, observed));
  if (!matches.length) return null;
  const suffixed = matches.filter((admin) => admin.includes('@'));
  const kind = jidKind(observed);
  return suffixed.find((admin) => jidKind(admin) === kind) ?? suffixed[0] ?? matches[0];
}

function dedupe(forms: string[]): string[] {
  const unique: string[] = [];
  for (const form of forms) {
    if (!unique.some((seen) => jidsMatch(seen, form))) unique.push(form);
  }
  return unique;
}

/**
 * Resolve the recipient. Read-only: it performs no queue write and never opens
 * a WhatsApp socket.
 */
export async function resolveDraftRecipient(
  input: ResolveRecipientInput,
): Promise<RecipientResolution> {
  const explicit = str(input.explicitRecipient);
  if (explicit) {
    if (jidKind(explicit) === 'GROUP') {
      return {status: 'RECIPIENT_NOT_APPROVED', reason: 'EXPLICIT_RECIPIENT_IS_GROUP'};
    }
    return {status: 'RESOLVED', recipientJid: explicit, basis: 'EXPLICIT'};
  }

  const account = await row<{
    account_jid: string | null;
    admin_jids: unknown;
  }>(
    "SELECT account_jid, admin_jids FROM whatsapp_accounts WHERE id = 'wa-01'",
  ).catch(() => null);
  const admins = adminList(account?.admin_jids);
  if (!admins.length) {
    return {status: 'RECIPIENT_NOT_APPROVED', reason: 'ADMIN_JIDS_EMPTY'};
  }
  const self = str(account?.account_jid);
  const approvedForm = (observed: string): string | null => {
    if (!observed || jidKind(observed) === 'GROUP') return null;
    const form = preferredAdminForm(admins, observed);
    if (!form) return null;
    // The sending account's own phone-number identity is never a recipient.
    if (self && jidsMatch(self, form)) return null;
    return form;
  };

  const sourceMessageId = str(input.sourceMessageId);
  let sourceChatJid = str(input.sourceChatJid);
  const sourceMessage = sourceMessageId
    ? await row<{
        sender_jid: string | null;
        chat_jid: string;
        direction: 'INCOMING' | 'OUTGOING';
      }>(
        `SELECT sender_jid, chat_jid, direction
           FROM whatsapp_messages
          WHERE account_id = 'wa-01' AND message_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [sourceMessageId],
      ).catch(() => null)
    : null;
  if (sourceMessage?.chat_jid) sourceChatJid = sourceMessage.chat_jid;

  // 1. The Admin who participates in the original order conversation. This is
  //    the normal case: a client sends the order into the conversation and the
  //    Admin's own identity also appears as an OUTGOING sender there.
  if (sourceChatJid) {
    const outgoing = await rows<{sender_jid: string | null}>(
      `SELECT DISTINCT sender_jid
         FROM whatsapp_messages
        WHERE account_id = 'wa-01'
          AND chat_jid = $1
          AND direction = 'OUTGOING'
          AND sender_jid IS NOT NULL`,
      [sourceChatJid],
    ).catch(() => []);
    const observed = [
      ...outgoing.map((entry) => str(entry.sender_jid)),
      ...(sourceMessage?.direction === 'OUTGOING' ? [str(sourceMessage.sender_jid)] : []),
    ].filter(Boolean);
    const candidates = dedupe(
      observed.map(approvedForm).filter((form): form is string => Boolean(form)),
    );
    if (candidates.length === 1) {
      return {
        status: 'RESOLVED',
        recipientJid: candidates[0],
        basis: 'SOURCE_CONVERSATION',
      };
    }
    if (candidates.length > 1) {
      return {status: 'RECIPIENT_NOT_APPROVED', reason: 'ADMIN_AMBIGUOUS'};
    }
  }

  if (sourceMessage) {
    const sender = str(sourceMessage.sender_jid);
    if (!sender) {
      return {
        status: 'SOURCE_CONVERSATION_NOT_FOUND',
        reason: 'SOURCE_SENDER_MISSING',
      };
    }
    if (sourceMessage.direction !== 'INCOMING') {
      return {
        status: 'RECIPIENT_NOT_APPROVED',
        reason: 'SOURCE_MESSAGE_NOT_INCOMING',
      };
    }
    const form = approvedForm(sender);
    if (!form) {
      return {
        status: 'RECIPIENT_NOT_APPROVED',
        reason: 'SOURCE_SENDER_NOT_ADMIN',
      };
    }
    return {status: 'RESOLVED', recipientJid: form, basis: 'SOURCE_CONVERSATION'};
  }

  if (sourceMessageId) {
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_MESSAGE_NOT_FOUND',
    };
  }

  // No source message id: a direct source chat may resolve only when it is
  // itself an authorised Admin identity. A group chat is never a fallback.
  if (sourceChatJid) {
    const form = approvedForm(sourceChatJid);
    if (form && jidKind(sourceChatJid) !== 'GROUP') {
      return {status: 'RESOLVED', recipientJid: form, basis: 'SOURCE_CHAT'};
    }
    return {
      status: 'SOURCE_CONVERSATION_NOT_FOUND',
      reason: 'SOURCE_CHAT_NOT_ADMIN',
    };
  }

  return {
    status: 'SOURCE_CONVERSATION_NOT_FOUND',
    reason: 'SOURCE_CONVERSATION_UNRESOLVED',
  };
}
