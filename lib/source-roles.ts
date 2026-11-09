// Explicit business role of a WhatsApp conversation.
//
// This module is pure: no database access and no authorization side effects.
// It is shared by the router (which enforces the role) and by the read models
// (which display it), so the two can never disagree.
//
//   ORDER_INTAKE   verified direct Escort Client order conversation
//   CASH_ONLY      authorised Cash/Accountant conversation
//   SUPPORT_ONLY   Escort Support / operational group — supporting evidence only
//   RELEASE_ONLY   Escort Release Information group
//   OTHER_APPROVED approved group with a context-only purpose
//   REVIEW_REQUIRED unresolved role — state-changing work is blocked

export type SourceRole =
  | 'ORDER_INTAKE'
  | 'CASH_ONLY'
  | 'SUPPORT_ONLY'
  | 'RELEASE_ONLY'
  | 'OTHER_APPROVED'
  | 'REVIEW_REQUIRED';

export const SOURCE_ROLES: readonly SourceRole[] = [
  'ORDER_INTAKE',
  'CASH_ONLY',
  'SUPPORT_ONLY',
  'RELEASE_ONLY',
  'OTHER_APPROVED',
  'REVIEW_REQUIRED',
];

/**
 * The approved group roles, keyed by the stable group JID. A display name is
 * never authorization. An explicit `whatsapp_chats.source_role` always wins.
 *
 * Evidence:
 *   - Escort support / Office group: operational support traffic, including
 *     free-text order-shaped messages, which must never become Drafts.
 *   - Release Information group: structured release slips and release chatter.
 *   - Escort Program group: AdminOUTGOING assignment/notification traffic.
 */
const APPROVED_GROUP_ROLES: Record<string, {role: SourceRole; purpose: string}> = {
  '120363426895117693@g.us': {role: 'SUPPORT_ONLY', purpose: 'Escort support / operational office group'},
  '120363408741101070@g.us': {role: 'RELEASE_ONLY', purpose: 'Escort release information'},
  '120363428977781821@g.us': {role: 'OTHER_APPROVED', purpose: 'Escort program assignment notifications (context only)'},
};

export function approvedGroupRole(chatJid: string): {role: SourceRole; purpose: string} | null {
  return APPROVED_GROUP_ROLES[chatJid] ?? null;
}

/** Stable JID → role map for read-model SQL (no display names). */
export function approvedGroupRoleMap(): Record<string, SourceRole> {
  return Object.fromEntries(Object.entries(APPROVED_GROUP_ROLES).map(([jid, value]) => [jid, value.role]));
}

export function isSourceRole(value: unknown): value is SourceRole {
  return typeof value === 'string' && (SOURCE_ROLES as readonly string[]).includes(value);
}

/**
 * Resolve the effective role for a chat.
 *
 * @param chatJid    stable chat JID
 * @param purpose    operator-configured `whatsapp_chats.purpose`
 * @param storedRole explicit `whatsapp_chats.source_role` (wins)
 * @param releaseConfigured whether the explicit release-group setting includes it
 */
export function resolveSourceRole(input: {
  chatJid: string;
  purpose?: string | null;
  storedRole?: string | null;
  releaseConfigured?: boolean;
}): SourceRole | null {
  if (isSourceRole(input.storedRole)) return input.storedRole;
  if (input.chatJid.endsWith('@g.us')) {
    if (input.releaseConfigured) return 'RELEASE_ONLY';
    const approved = approvedGroupRole(input.chatJid);
    return approved?.role ?? 'REVIEW_REQUIRED';
  }
  if (input.purpose === 'ORDERS') return 'ORDER_INTAKE';
  if (input.purpose === 'CASH') return 'CASH_ONLY';
  return null;
}

export function sourceRoleLabel(role: string | null | undefined): string {
  return isSourceRole(role) ? role : 'REVIEW_REQUIRED';
}

export function sourceRoleTone(role: string | null | undefined): string {
  switch (role) {
    case 'ORDER_INTAKE': return 'ok';
    case 'CASH_ONLY': return 'info';
    case 'SUPPORT_ONLY': return 'warn';
    case 'RELEASE_ONLY': return 'info';
    case 'OTHER_APPROVED': return 'warn';
    default: return 'bad';
  }
}
