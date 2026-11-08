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
import {row, rows} from './standalone/db.ts';
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

export type EscortClientAuthorization = {
  configured: boolean;
  authorized: boolean;
  reason: string | null;
  clientRef: string | null;
  method: 'REGISTRY' | 'VERIFIED_IDENTITY' | null;
};

const identityForms = (value: string | null | undefined): string[] => {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const forms = new Set([raw]);
  const noDevice = raw.replace(/^(\d{6,20}):\d+@(.+)$/, '$1@$2');
  forms.add(noDevice);
  const local = noDevice.split('@')[0];
  if (/^\d{6,20}$/.test(local)) forms.add(local);
  return [...forms];
};

/**
 * Authorise one direct Escort Client order conversation.
 *
 * Two evidence sources, in order:
 *   1. the effective-dated `phase3_authorized_contacts:<account>` registry with
 *      an active `ESCORT_CLIENT` entry (existing structure, reused);
 *   2. when that registry is absent, a verified identity link: the chat and the
 *      sender must resolve through `identity_aliases` to the same EXACT
 *      canonical PN JID. A display name or a bare LID with no PN link is never
 *      enough.
 *
 * The caller must still verify that the chat is DIRECT and that its
 * `source_role` is ORDER_INTAKE. This function answers only "is the person in
 * this conversation a verified Escort Client?".
 */
export async function isAuthorizedEscortClientConversation(
  accountId: string,
  chatJid: string,
  senderJid: string | null,
  onDate = new Date().toISOString().slice(0, 10),
): Promise<EscortClientAuthorization> {
  const registry = await loadAuthorizedContacts(accountId);
  if (registry.configured) {
    if (!registry.valid) {
      return {configured: true, authorized: false, reason: 'AUTHORIZED_CONTACT_REGISTRY_INVALID', clientRef: null, method: null};
    }
    const clients = registry.contacts.filter((contact) => contact.role === 'ESCORT_CLIENT' && active(contact, onDate));
    if (!clients.length) {
      return {configured: true, authorized: false, reason: 'ESCORT_CLIENT_NOT_REGISTERED', clientRef: null, method: null};
    }
    const matches = (contact: AuthorizedContact): boolean =>
      jidsMatch(contact.jid, chatJid) ||
      (contact.aliases ?? []).some((alias) => jidsMatch(alias, chatJid));
    const matched = clients.find(matches);
    if (!matched) {
      return {configured: true, authorized: false, reason: 'ESCORT_CLIENT_CONVERSATION_NOT_AUTHORIZED', clientRef: null, method: null};
    }
    if (senderJid && !jidsMatch(matched.jid, senderJid) && !(matched.aliases ?? []).some((alias) => jidsMatch(alias, senderJid))) {
      return {configured: true, authorized: false, reason: 'ESCORT_CLIENT_SENDER_MISMATCH', clientRef: null, method: null};
    }
    return {configured: true, authorized: true, reason: null, clientRef: matched.jid, method: 'REGISTRY'};
  }

  const forms = [...new Set([...identityForms(chatJid), ...identityForms(senderJid)])];
  if (!forms.length) {
    return {configured: false, authorized: false, reason: 'ESCORT_CLIENT_IDENTITY_MISSING', clientRef: null, method: null};
  }
  const aliases = await rows<{jid: string; canonical_jid: string; person_key: string | null}>(
    `SELECT jid, canonical_jid, person_key
       FROM identity_aliases
      WHERE account_id = $1
        AND confidence = 'EXACT'
        AND canonical_jid IS NOT NULL
        AND (jid = ANY($2::text[]) OR canonical_jid = ANY($2::text[]))`,
    [accountId, forms],
  );
  const verifiedPn = (value: string | null): string | null => {
    const canonical = String(value ?? '');
    return /^\d{6,20}@s\.whatsapp\.net$/.test(canonical) ? canonical : null;
  };
  const chatIdentity = aliases
    .map((alias) => verifiedPn(alias.canonical_jid))
    .find((canonical): canonical is string => Boolean(canonical));
  if (!chatIdentity) {
    return {configured: false, authorized: false, reason: 'ESCORT_CLIENT_CONVERSATION_UNVERIFIED', clientRef: null, method: null};
  }
  if (senderJid) {
    const senderAliases = aliases.filter((alias) => identityForms(senderJid).some((form) => jidsMatch(alias.jid, form)));
    const senderIdentity = senderAliases
      .map((alias) => verifiedPn(alias.canonical_jid))
      .find((canonical): canonical is string => Boolean(canonical));
    if (!senderIdentity) {
      return {configured: false, authorized: false, reason: 'ESCORT_CLIENT_SENDER_UNVERIFIED', clientRef: null, method: null};
    }
    if (senderIdentity !== chatIdentity) {
      return {configured: false, authorized: false, reason: 'ESCORT_CLIENT_SENDER_MISMATCH', clientRef: null, method: null};
    }
  }
  return {configured: false, authorized: true, reason: null, clientRef: chatIdentity, method: 'VERIFIED_IDENTITY'};
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
