// Canonical Cash publication for the single verified Admin -> Accountant stream.
//
// One code path is used by live capture and by the historical backfill, so both
// produce identical source/operation/instruction identifiers for the same
// message. A message replayed through the Accountant's other addressing form
// (PN vs LID) therefore collapses onto one record instead of creating a second
// financial instruction.
//
// Financial safety: this module only writes REVIEW-state instructions. It never
// posts, confirms, approves or settles anything.

import type pg from 'pg';
import {digest} from '../candidates/identity-review/contracts.ts';
import {CASH_SCOPE_ACCOUNT,CASH_SCOPE_ACCOUNTANT,CASH_SCOPE_CHATS} from './cash-scope.ts';

export const CASH_EPOCH_CURRENT = 'CANONICAL_BACKFILL_20261026';
export const CASH_EPOCH_ARCHIVE = 'LEGACY_PRE_TRANSITION_20261026';
const normalizedPurpose=(value:string)=>value==='Owner direct payment instruction'?'':value.trim();

export type CashBlockFields = {
  employeeId?: string;
  employeeMobile: string;
  employeeName: string;
  payoutNumber?: string;
  payoutMobile: string;
  methodMarker?: string;
  method: 'cash' | 'bkash' | 'nagad' | 'bank' | 'rocket';
  amount?: string;
  amountMinor: string;
  purpose: string;
};

export type CashBlock = { blockKey: string; blockOrder: number; fields: CashBlockFields };

export type CashPublishInput = {
  account: string;
  chatJid: string;
  messageId: string;
  sender: string;
  sourceTime: string;
  sourceHash: string;
  cashAccount: string;
  epoch: string;
  block: CashBlock;
  reviewReasons?: string[];
  /** Verified Admin/Accountant binding reference; omitted only for backfill. */
  command?: { action: string; actorRef: string; actorBindingRef: string; authEpoch: number };
};

export function cashSourceIds(messageId: string, blockKey: string, account: string) {
  if (account !== CASH_SCOPE_ACCOUNT || !messageId.trim() || messageId.length > 200
    || !/^payment-block-\d+$/.test(blockKey)) {
    throw new Error('CASH_SOURCE_IDENTITY_UNRESOLVED');
  }
  const source = digest(['live-owner-accountant-source-v2', account, CASH_SCOPE_ACCOUNTANT, messageId, blockKey]);
  const operation = digest(['live-owner-accountant-operation-v2', account, CASH_SCOPE_ACCOUNTANT, messageId, blockKey]);
  return {
    source,
    operation,
    instruction: digest(['live-owner-accountant-instruction', operation]),
    command: digest(['live-owner-accountant-command', operation]),
  };
}

/**
 * Publishes one parsed payment block. Returns 'written', 'duplicate' (same epoch)
 * or throws on a source replay conflict. The caller owns no transaction.
 */
export async function publishCashBlock(
  pool: pg.Pool,
  input: CashPublishInput,
): Promise<'written' | 'duplicate'> {
  if (input.account !== CASH_SCOPE_ACCOUNT
    || !CASH_SCOPE_CHATS.some((chatJid) => chatJid === input.chatJid)) {
    throw new Error('CASH_SOURCE_SCOPE_REQUIRED');
  }
  const ids = cashSourceIds(input.messageId, input.block.blockKey, input.account);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ids.operation]);

    // A linked instruction in either epoch owns this source identity. A changed
    // interpretation is a conflict for review, never a second instruction.
    const duplicates = (await client.query(
      `SELECT ci.employee_mobile,ci.employee_name,ci.payout_mobile,ci.purpose,
              ci.method,ci.amount_minor::text AS amount_minor
         FROM public.source_refs s
         JOIN public.cash_instructions ci
           ON ci.scope_account=s.scope_account AND ci.source_ref=s.id
        WHERE s.scope_account=$1 AND s.chat_jid=ANY($4::text[])
          AND s.message_id=$2 AND s.block_key=$3
      `,
      [input.account, input.messageId, input.block.blockKey, [...CASH_SCOPE_CHATS]],
    )).rows;
    if (duplicates.length) {
      if (duplicates.some((duplicate)=>duplicate.employee_mobile!==input.block.fields.employeeMobile
        ||duplicate.employee_name!==input.block.fields.employeeName
        ||duplicate.payout_mobile!==input.block.fields.payoutMobile
        ||normalizedPurpose(duplicate.purpose)!==normalizedPurpose(input.block.fields.purpose)
        ||duplicate.method!==input.block.fields.method
        ||duplicate.amount_minor!==input.block.fields.amountMinor)) {
        throw new Error('LIVE_SOURCE_REPLAY_CONFLICT');
      }
      await client.query('ROLLBACK');
      return 'duplicate';
    }

    const payload = {
      accountId: input.account,
      chatJid: input.chatJid,
      messageId: input.messageId,
      sender: input.sender,
      direction: 'OUTGOING' as const,
      recipientChatJid: CASH_SCOPE_ACCOUNTANT,
      sourceHash: input.sourceHash,
      blockKey: input.block.blockKey,
      ...input.block.fields,
      cashAccount: input.cashAccount,
    };
    const payloadHash = digest(payload);

    const command = input.command ?? {
      action: 'CASH_OWNER_ACCOUNTANT_INTENT_CAPTURE',
      actorRef: process.env.ALRIFAI_CASH_OWNER_PERSON_REF || 'unbound-owner',
      actorBindingRef: process.env.ALRIFAI_CASH_OWNER_BINDING_REF || 'unbound-owner-binding',
      authEpoch: 1,
    };
    await client.query(
      `INSERT INTO public.business_commands
       (id,scope_account,source_ref,operation_key,payload_hash,action,actor_ref,actor_binding_ref,auth_epoch,expected_resource_version,confirmation_basis,result_ref,result_hash,committed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'ADMIN_DIRECT',$10,$5,$11)
       ON CONFLICT (scope_account,operation_key) DO NOTHING`,
      [ids.command, input.account, ids.source, `cash-owner-accountant:${ids.operation}`, payloadHash,
        command.action, command.actorRef, command.actorBindingRef, command.authEpoch, ids.instruction, input.sourceTime],
    );
    // A changed body for an already-recorded source must conflict, never silently
    // revise financial evidence.
    const prior=(await client.query('SELECT payload_hash FROM public.source_refs WHERE scope_account=$1 AND id=$2',[input.account,ids.source])).rows[0] as {payload_hash:string}|undefined;
    if(prior&&prior.payload_hash!==payloadHash)throw new Error('LIVE_SOURCE_REPLAY_CONFLICT');
    await client.query(
      `INSERT INTO public.source_refs
       (id,scope_account,created_command_id,channel,provider,chat_jid,message_id,source_kind,external_ref,block_key,payload_hash,source_time,observed_at,original_sender_ref,submitted_by_ref,origin_state,visibility_state)
       VALUES ($1,$2,$3,'WHATSAPP','WHATSAPP_NATIVE_BRIDGE',$4,$5,'LIVE_OWNER_ACCOUNTANT_PAYMENT',$6,$7,$8,$9,now(),$10,$10,'PROVEN','VISIBLE')
       ON CONFLICT (scope_account,id) DO NOTHING`,
      [ids.source, input.account, ids.command, input.chatJid, input.messageId,
        `${input.account}|${CASH_SCOPE_ACCOUNTANT}|${input.messageId}`, input.block.blockKey, payloadHash,
        input.sourceTime, input.sender],
    );
    await client.query(
      `INSERT INTO public.cash_instructions
       (id,operation_id,scope_account,source_ref,command_id,source_time,block_order,employee_mobile,employee_name,payout_mobile,purpose,method,amount_minor,state,reasons,payload_hash,cash_account,dataset_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'REVIEW',$14::jsonb,$15,$16,$17)
       ON CONFLICT (id) DO NOTHING`,
      [ids.instruction, ids.operation, input.account, ids.source, ids.command, input.sourceTime,
        input.block.blockOrder, input.block.fields.employeeMobile, input.block.fields.employeeName,
        input.block.fields.payoutMobile, input.block.fields.purpose, input.block.fields.method,
        input.block.fields.amountMinor,
        JSON.stringify([...new Set(['FINANCIAL_POSTING_REQUIRES_SEPARATE_APPROVAL',...(input.reviewReasons??[])])]),
        payloadHash, input.cashAccount, input.epoch],
    );
    await client.query('COMMIT');
    return 'written';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
