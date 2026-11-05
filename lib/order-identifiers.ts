// Owner-visible Order and Draft numbers (decision D6).
//
// The identifiers are DERIVED from identities that already exist and are already
// unique in the database — no new sequence, no new table, no parallel business
// identity:
//
//   Order number  VO-<12 hex>  ← escort_order_register.source_hash
//   Draft number  VD-<12 hex>  ← escort_order_register.id
//
// Both source columns are SHA-256 hex written by the intake pipeline:
//   * source_hash = hash(account, chat, message id, sender, direction, time, text)
//     → one value per source WhatsApp message, stable on replay.
//   * id          = hash(account, source_hash, block key)
//     → one value per Lighter block inside that message.
//
// Therefore one multi-Lighter Order has ONE Order number and one Draft number per
// Lighter, and replaying the same message reproduces both exactly.
//
// Pure functions: no database, no clock. Persistence keeps using the existing
// columns; these are display identities only.

const SHA256_HEX = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^(VO|VD)-([a-f0-9]{12})$/;

export const ORDER_NUMBER_PREFIX = 'VO-';
export const DRAFT_NUMBER_PREFIX = 'VD-';
/** 12 hex characters = 48 bits. Collisions are checked against the register. */
export const IDENTIFIER_HEX_LENGTH = 12;

function shortId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!SHA256_HEX.test(trimmed)) return null;
  return trimmed.slice(0, IDENTIFIER_HEX_LENGTH);
}

/** `VO-…` for one source Order message, or null when the hash is not a SHA-256. */
export function orderNumber(sourceHash: string): string | null {
  const short = shortId(sourceHash);
  return short ? `${ORDER_NUMBER_PREFIX}${short}` : null;
}

/** `VD-…` for one Lighter Draft, or null when the row id is not a SHA-256. */
export function draftNumber(registerId: string): string | null {
  const short = shortId(registerId);
  return short ? `${DRAFT_NUMBER_PREFIX}${short}` : null;
}

export type DraftIdentifiers = {order: string; draft: string};

/** The pair shown to the Owner for one Lighter Draft. */
export function draftIdentifiers(sourceHash: string, registerId: string): DraftIdentifiers | null {
  const order = orderNumber(sourceHash);
  const draft = draftNumber(registerId);
  return order && draft ? {order, draft} : null;
}

/** Parse a displayed identifier back to its kind and short value. */
export function parseIdentifier(value: string): {kind: 'order' | 'draft'; short: string} | null {
  const match = typeof value === 'string' ? IDENTIFIER.exec(value.trim()) : null;
  if (!match) return null;
  return {kind: match[1] === 'VO' ? 'order' : 'draft', short: match[2]};
}

/** True when the identifier the Owner quotes is the one this row displays. */
export function identifierMatches(displayed: string, quoted: string): boolean {
  const a = parseIdentifier(displayed);
  const b = parseIdentifier(quoted);
  return !!a && !!b && a.kind === b.kind && a.short === b.short;
}
