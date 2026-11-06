// AL-RIFA'I — effective-dated authorized-contact registry.
//
// The configuration lives in `app_settings` under
// `phase3_authorized_contacts:<account>` as an array:
//
//   {role, jid, aliases?, status, effectiveFrom?, effectiveTo?, approvedBy?, reason?}
//
// Presence of a valid ACCOUNTANT entry is fail-closed: a Cash conversation not
// matching an active entry is rejected even if the chat purpose says CASH.
// When no registry is configured, the existing chat-purpose rule remains for
// backward compatibility.
import {row} from './standalone/db.ts';
import {jidsMatch} from './whatsapp-identity.mjs';
import {phoneForms, sameMobile} from './business-rules.mjs';

export type AuthorizedContact = {
  role: 'ACCOUNTANT' | 'ESCORT_CLIENT' | 'GROUP_PARTICIPANT' | string;
  jid: string;
  aliases?: string[];
  status?: 'ACTIVE' | 'REVOKED' | 'REPLACED';
  effectiveFrom?: string;
  effectiveTo?: string;
  approvedBy?: string;
  reason?: string;
};

function active(contact: AuthorizedContact, onDate: string): boolean {
  if ((contact.status ?? 'ACTIVE') !== 'ACTIVE') return false;
  if (contact.effectiveFrom && contact.effectiveFrom > onDate) return false;
  if (contact.effectiveTo && contact.effectiveTo < onDate) return false;
  return true;
}

export async function loadAuthorizedContacts(accountId: string): Promise<{
  configured: boolean;
  valid: boolean;
  contacts: AuthorizedContact[];
}> {
  const setting = await row<{value: unknown}>(
    'SELECT value FROM app_settings WHERE key = $1',
    [`phase3_authorized_contacts:${accountId}`],
  );
  if (!setting) return {configured: false, valid: true, contacts: []};
  if (!Array.isArray(setting.value)) return {configured: true, valid: false, contacts: []};
  const contacts = setting.value.filter((entry): entry is AuthorizedContact =>
    Boolean(entry && typeof entry === 'object' && typeof (entry as AuthorizedContact).role === 'string' && typeof (entry as AuthorizedContact).jid === 'string'));
  return {configured: true, valid: contacts.length === setting.value.length, contacts};
}

export async function isAuthorizedCashConversation(
  accountId: string,
  chatJid: string,
  onDate = new Date().toISOString().slice(0, 10),
): Promise<{configured: boolean; authorized: boolean; reason: string | null}> {
  const registry = await loadAuthorizedContacts(accountId);
  if (!registry.configured) return {configured: false, authorized: true, reason: null};
  if (!registry.valid) return {configured: true, authorized: false, reason: 'AUTHORIZED_CONTACT_REGISTRY_INVALID'};
  const accountants = registry.contacts.filter((contact) => contact.role === 'ACCOUNTANT' && active(contact, onDate));
  if (!accountants.length) return {configured: true, authorized: false, reason: 'ACCOUNTANT_NOT_AUTHORIZED'};
  const matched = accountants.some((contact) =>
    jidsMatch(contact.jid, chatJid) ||
    (contact.aliases ?? []).some((alias) => jidsMatch(alias, chatJid)) ||
    phoneForms(contact.jid).some((form) => phoneForms(chatJid).includes(form) || sameMobile(form, chatJid)));
  return {
    configured: true,
    authorized: matched,
    reason: matched ? null : 'ACCOUNTANT_NOT_AUTHORIZED',
  };
}
