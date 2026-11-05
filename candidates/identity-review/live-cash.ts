import {parsePaymentBlocks} from '../../lib/history-extraction.mjs';
import {digest} from './contracts.ts';
import type {NativeLivePage,NativeLiveReader} from '../../lib/native-live-reader.ts';
import type pg from 'pg';
import {CASH_SCOPE_ACCOUNT as ACCOUNT,CASH_SCOPE_ACCOUNTANT,CASH_SCOPE_CHAT as CHAT,CASH_SCOPE_NAME as CASH_ACCOUNT,isCashScopeChat} from '../../lib/cash-scope.ts';
import {cashSourceEligibility} from '../../lib/cash-source-eligibility.ts';
import {publishCashBlock,CASH_EPOCH_CURRENT} from '../../lib/cash-publish.ts';

type PaymentFields={employeeId:string;employeeMobile:string;employeeName:string;payoutNumber:string;payoutMobile:string;methodMarker:string;method:'cash'|'bkash'|'nagad'|'bank'|'rocket';amount:string;amountMinor:string;purpose:string};
type PaymentBlock={blockKey:string;blockOrder:number;fields:PaymentFields};

// Keep the source ID as text for evidence while normalizing the existing
// employee_mobile key used by employee_master and cash_instructions.
export function parseLivePaymentBlocks(input:string):PaymentBlock[]{
 return parsePaymentBlocks(input).filter(block=>
  block.kind==='PAYMENT'&&block.reasons.length===0
  &&typeof block.fields.employeeId==='string'
  &&typeof block.fields.employeeMobile==='string'
  &&typeof block.fields.employeeName==='string'
  &&typeof block.fields.payoutNumber==='string'
  &&typeof block.fields.payoutMobile==='string'
  &&typeof block.fields.methodMarker==='string'
  &&typeof block.fields.method==='string'
  &&typeof block.fields.amount==='string'
  &&typeof block.fields.amountMinor==='string',
 ).map(block=>({
  blockKey:block.blockKey,
  blockOrder:block.blockOrder,
  fields:{
   employeeId:block.fields.employeeId,
   employeeMobile:block.fields.employeeMobile,
   employeeName:block.fields.employeeName,
   payoutNumber:block.fields.payoutNumber,
   payoutMobile:block.fields.payoutMobile,
   methodMarker:block.fields.methodMarker,
   method:block.fields.method as PaymentFields['method'],
   amount:block.fields.amount,
   amountMinor:block.fields.amountMinor,
   purpose:block.fields.purpose??'Owner direct payment instruction',
  },
 }));
}

export function employeeNameMatches(name:string,knownNames:unknown):boolean{
 const normalize=(value:string)=>value.normalize('NFKC').toLowerCase()
  .replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();
 const key=normalize(name);
 const names=Array.isArray(knownNames)?knownNames.filter((value):value is string=>typeof value==='string'):[];
 return !!key&&names.some(value=>normalize(value)===key);
}

export function employeeReviewReasons(
 employee:{state:string;preferred_name:string;name_aliases:string[]}|undefined,
 employeeName:string,
):string[]{
 if(!employee)return ['EMPLOYEE_ID_UNMATCHED'];
 if(employee.state!=='CONFIRMED')return ['EMPLOYEE_ID_NOT_CONFIRMED'];
 return employeeNameMatches(employeeName,[employee.preferred_name,...employee.name_aliases])
  ?[]:['EMPLOYEE_ID_NAME_CONFLICT'];
}

// Forwarding and quotation metadata do not change Cash eligibility: the verified
// account, direct chat, direction and endpoint identities are authoritative.
export function ownerOutgoing(record:{status:string;envelope:NativeLivePage['records'][number]['envelope']}):LiveMessage|null{
 const e=record.envelope;
 if(record.status!=='CONTENT'||!e)return null;
 if(e.version!=='native-message-envelope-v1'||e.provider!=='WHATSAPP'
  ||cashSourceEligibility({
    accountId:e.accountId,chatJid:e.chatJid,direct:e.chatType==='direct',direction:e.direction,
    senderJid:e.senderJid,recipientJid:e.chatJid,
   })!=='ELIGIBLE')return null;
 return {id:e.nativeMessageId,chatJid:e.chatJid,sender:e.senderJid,sourceTime:e.sourceTimestamp,text:e.payload?.text??'',direction:e.direction};
}

export const isLiveCashOwnerOutgoing=(record:{status:string;envelope:NativeLivePage['records'][number]['envelope']})=>ownerOutgoing(record)!==null;

export function liveSourceIdentity(messageId:string,blockKey:string,chatJid:string=CHAT){
 void chatJid;
 if(!messageId.trim()||messageId.length>200||!/^payment-block-\d+$/.test(blockKey))throw new Error('LIVE_CASH_SOURCE_IDENTITY_UNRESOLVED');
 // Canonical: the Accountant's PN and LID chats are ONE logical conversation, so
 // the source identity deliberately excludes chatJid. A message replayed through
 // the other addressing form collapses onto the same record instead of creating a
 // second financial instruction. Historical rows keep their original identifiers.
 return digest(['live-owner-accountant-source-v2',ACCOUNT,CASH_SCOPE_ACCOUNTANT,messageId,blockKey]);
}


type LiveMessage={id:string;chatJid:string;sender:string;sourceTime:string;text:string;direction:'INCOMING'|'OUTGOING'};

async function writeBlock(pool:pg.Pool,message:LiveMessage,sourceHash:string,block:PaymentBlock){
 // Eligibility is unchanged: only a verified Owner/Admin outgoing message in the
 // approved Accountant direct chat can become a Cash instruction candidate, and
 // only while the verified ACCOUNTANT binding exists for that exact chat.
 const epoch=(await pool.query("SELECT (payload->>'epoch')::bigint AS epoch FROM identity_review_candidate.records WHERE collection='meta' AND id='epoch' FOR SHARE")).rows[0]?.epoch;
 if(epoch===undefined||epoch===null)throw new Error('LIVE_CASH_AUTH_EPOCH_UNAVAILABLE');
 const accountantBinding=(await pool.query(`SELECT EXISTS(
  SELECT 1 FROM identity_review_candidate.records b
  JOIN identity_review_candidate.records r
    ON r.collection='registry' AND r.payload->>'kind'='relationship' AND r.payload->>'status'='VERIFIED'
   AND r.payload->'data'->>'kind'='ACCOUNTANT'
   AND r.payload->'data'->>'personId'=b.payload->'data'->>'personId'
  WHERE b.collection='registry' AND b.payload->>'kind'='binding' AND b.payload->>'status'='VERIFIED'
    AND b.payload->'data'->>'accountId'=$1
    AND b.payload->'data'->>'chatJid'=$2
    AND b.payload->'data'->>'direction'='INCOMING'
    AND b.payload->'data'->>'purpose'='SENDER') AS allowed`,[ACCOUNT,message.chatJid])).rows[0]?.allowed;
 if(accountantBinding!==true)throw new Error('LIVE_CASH_ACCOUNTANT_BINDING_REQUIRED');
 const employee=(await pool.query<{state:string;preferred_name:string;name_aliases:string[]}>(
  `SELECT state,preferred_name,name_aliases FROM public.employee_master
    WHERE scope_account=$1 AND employee_mobile=$2`,
  [ACCOUNT,block.fields.employeeMobile],
 )).rows[0];
 const reviewReasons=employeeReviewReasons(employee,block.fields.employeeName);
 return publishCashBlock(pool,{
  account:ACCOUNT,
  chatJid:message.chatJid,
  messageId:message.id,
  sender:message.sender,
  sourceTime:message.sourceTime,
  sourceHash,
  cashAccount:CASH_ACCOUNT,
  epoch:CASH_EPOCH_CURRENT,
  block,
  reviewReasons,
  command:{
   action:'CASH_OWNER_ACCOUNTANT_INTENT_CAPTURE',
   actorRef:process.env.ALRIFAI_CASH_OWNER_PERSON_REF||'unbound-owner',
   actorBindingRef:process.env.ALRIFAI_CASH_OWNER_BINDING_REF||'unbound-owner-binding',
   authEpoch:Number(epoch),
  },
 });
}

export function startLiveOwnerAccountantCashSync(pool:pg.Pool,reader:NativeLiveReader){
 const mode=process.env.ALRIFAI_LIVE_CASH_INTENT_CAPTURE;
 if(mode!=='APPROVED_REVIEW_ONLY')throw new Error('LIVE_CASH_REVIEW_ONLY_MODE_REQUIRED');
 let running=false;
 const run=async()=>{
  if(running)return;running=true;
  try{
   const channels=(await pool.query('SELECT chat_jid,after_rowid,native_cursor,enabled FROM public.cash_live_sync_channels WHERE scope_account=$1 ORDER BY chat_jid',[ACCOUNT])).rows as {chat_jid:string;after_rowid:string;native_cursor:string|null;enabled:boolean}[];
   for(const channel of channels){
    if(!channel.enabled||!isCashScopeChat(channel.chat_jid))continue;
    try{
     // Activation deliberately returns only a boundary cursor: history comes from
     // the approved backfill, and live continuation starts from the boundary.
     let cursor=channel.native_cursor&&/^n1:[0-9a-f-]{36}:[0-9a-f]{24}:[0-9]+:[0-9]+$/.test(channel.native_cursor)
      ?channel.native_cursor
      :(await reader.activate(ACCOUNT,channel.chat_jid)).nextCursor;
     for(let pageNumber=0;pageNumber<250;pageNumber++){
      const page=await reader.page(ACCOUNT,channel.chat_jid,cursor);
      for(const record of page.records){
       const message=ownerOutgoing(record);
       if(!message)continue;
       const blocks=parseLivePaymentBlocks(message.text);
       const sourceHash=record.envelope?.payload?.sha256??record.semanticHash;
       if(!sourceHash)throw new Error('LIVE_CASH_SOURCE_HASH_UNAVAILABLE');
       for(const block of blocks){
        try{await writeBlock(pool,message,sourceHash,block);}
        catch(error){if(error instanceof Error&&error.message==='LIVE_CASH_ACCOUNTANT_BINDING_REQUIRED')continue;throw error;}
       }
      }
      cursor=page.nextCursor;
      await pool.query('UPDATE public.cash_live_sync_channels SET native_cursor=$3,last_error=NULL,last_processed_at=now(),updated_at=now() WHERE scope_account=$1 AND chat_jid=$2',[ACCOUNT,channel.chat_jid,cursor]);
      if(page.complete)break;
     }
    }catch(error){
     const message=error instanceof Error?error.message:'LIVE_CASH_SYNC_FAILED';
     await pool.query('UPDATE public.cash_live_sync_channels SET last_error=$3,updated_at=now() WHERE scope_account=$1 AND chat_jid=$2',[ACCOUNT,channel.chat_jid,message.slice(0,1000)]).catch(()=>undefined);
    }
   }
  }catch(error){
   const message=error instanceof Error?error.message:'LIVE_CASH_SYNC_FAILED';
   await pool.query('UPDATE public.cash_live_sync_channels SET last_error=$2,updated_at=now() WHERE scope_account=$1',[ACCOUNT,message.slice(0,1000)]).catch(()=>undefined);
  }finally{running=false;}
 };
 void run();
 const timer=setInterval(()=>void run(),5000);timer.unref();
 return {stop:()=>clearInterval(timer)};
}
