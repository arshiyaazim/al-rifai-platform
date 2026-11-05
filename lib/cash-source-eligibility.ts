import {
  CASH_SCOPE_ACCOUNT,
  isCashScopeAccountant,
  isCashScopeChat,
  isCashScopeOwner,
} from './cash-scope.ts';

export type CashSourceEvidence = {
  accountId: string;
  chatJid: string;
  direct: boolean;
  direction: string;
  senderJid: string | null;
  recipientJid: string | null;
};

export type CashSourceEligibility =
  | 'ELIGIBLE'
  | 'NOT_CASH_SCOPE'
  | 'NOT_OWNER_OUTGOING'
  | 'OWNER_IDENTITY_UNRESOLVED'
  | 'CASH_RECIPIENT_IDENTITY_UNRESOLVED'
  | 'SOURCE_PROVENANCE_UNRESOLVED';

export function cashSourceEligibility(source: CashSourceEvidence): CashSourceEligibility {
  if (source.accountId !== CASH_SCOPE_ACCOUNT || !isCashScopeChat(source.chatJid) || !source.direct) {
    return 'NOT_CASH_SCOPE';
  }
  if (source.direction !== 'OUTGOING') return 'NOT_OWNER_OUTGOING';
  if (!source.senderJid || !isCashScopeOwner(source.senderJid)) return 'OWNER_IDENTITY_UNRESOLVED';
  if (!source.recipientJid || !isCashScopeAccountant(source.recipientJid)) {
    return 'CASH_RECIPIENT_IDENTITY_UNRESOLVED';
  }
  return 'ELIGIBLE';
}
