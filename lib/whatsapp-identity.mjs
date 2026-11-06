// AL-RIFA'I — shared WhatsApp identity classification helpers.
//
// One rule set for both accounts. These functions only classify what the bridge
// actually persisted; they never turn a LID into a phone number, and they never
// invent a name.
//
// Terms:
//   PN      a phone-number JID (`<digits>@s.whatsapp.net`)
//   LID     a WhatsApp local identifier (`<digits>@lid`); NOT a phone number
//   GROUP   a group JID (`<id>@g.us`)
//   OTHER   anything else (newsletters, broadcast lists, malformed values)

const PN_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';
const GROUP_SUFFIX = '@g.us';

/** Chat/participant kind from the JID suffix. */
export function jidKind(jid) {
  const value = String(jid ?? '').trim();
  if (value.endsWith(GROUP_SUFFIX)) return 'GROUP';
  if (value.endsWith(LID_SUFFIX)) return 'LID';
  if (value.endsWith(PN_SUFFIX)) return 'PN';
  return 'OTHER';
}

/**
 * Canonical PN JID: strips the `:<device>` suffix the bridge may add
 * (`<number>:27@s.whatsapp.net` -> `<number>@s.whatsapp.net`). Returns null for
 * anything else, including LIDs.
 */
export function canonicalPnJid(jid) {
  const value = String(jid ?? '').trim();
  if (!value.endsWith(PN_SUFFIX)) return null;
  const local = value.slice(0, -PN_SUFFIX.length).split(':')[0];
  return /^\d{6,20}$/.test(local) ? `${local}${PN_SUFFIX}` : null;
}

/**
 * Phone number for a PN JID, or null. A LID deliberately returns null: the
 * bridge may later link it to a PN, and that link is the only basis for a
 * phone number.
 */
export function phoneFromJid(jid) {
  const canonical = canonicalPnJid(jid);
  return canonical ? canonical.slice(0, -PN_SUFFIX.length) : null;
}

/**
 * Account identity normalisation. The bridge may persist the account as a
 * device-qualified PN or as a bare number; both are the same account. A LID
 * stays a LID — it is never turned into a phone number.
 */
export function normalizeAccountJid(jid) {
  const value = String(jid ?? '').trim();
  if (!value) return null;
  const pn = canonicalPnJid(value);
  if (pn) return pn;
  if (/^\d{6,20}$/.test(value)) return `${value}${PN_SUFFIX}`;
  return value;
}

/**
 * Identity confidence:
 *   EXACT       the JID is itself a stable identifier (PN or group), or the
 *               bridge linked this JID to one (`canonicalJid`)
 *   VARIANT     a display name is known but the identifier is not linked
 *   UNRESOLVED  neither a stable identifier nor a name
 */
export function identityConfidence({kind, canonicalJid, displayName}) {
  if (kind === 'GROUP' || kind === 'PN') return 'EXACT';
  if (kind === 'LID') return canonicalJid ? 'EXACT' : (displayName ? 'VARIANT' : 'UNRESOLVED');
  return canonicalJid ? 'EXACT' : (displayName ? 'VARIANT' : 'UNRESOLVED');
}

/** The identity a JID ultimately belongs to; falls back to the JID itself. */
export function personKey(canonicalJid, jid) {
  const canonical = String(canonicalJid ?? '').trim();
  if (canonical) return canonical;
  const own = String(jid ?? '').trim();
  return own || null;
}

/** Human label, preferring a resolved name and never showing a fake number. */
export function identityLabel({displayName, canonicalJid, jid}) {
  const name = String(displayName ?? '').trim();
  if (name) return name;
  const canonical = String(canonicalJid ?? '').trim();
  if (canonical) return canonical;
  const own = String(jid ?? '').trim();
  return own || null;
}

/**
 * Identity comparison forms for one WhatsApp JID.
 *
 * A full PN/LID/device-qualified value contributes its exact form, its
 * device-stripped form and its bare numeric form. A bare value contributes only
 * itself. This lets a bare bridge sender match a full configured participant,
 * without turning a LID into a PN or inventing a phone number.
 */
export function jidForms(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const forms = new Set([raw]);
  const noDevice = raw.replace(/^(\d{6,20}):\d+@(.+)$/, '$1@$2');
  forms.add(noDevice);
  const local = noDevice.split('@')[0];
  if (/^\d{6,20}$/.test(local)) forms.add(local);
  return [...forms];
}

/** True when two configured/observed WhatsApp identities refer to the same exact numeric identity form. */
export function jidsMatch(a, b) {
  const left = jidForms(a);
  if (!left.length) return false;
  const right = new Set(jidForms(b));
  return left.some((form) => right.has(form));
}
