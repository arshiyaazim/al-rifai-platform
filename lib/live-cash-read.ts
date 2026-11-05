import pg from 'pg';
import type {CashRow} from '@/lib/operations';
import {CASH_SCOPE_ACCOUNT,CASH_SCOPE_CHAT,CASH_SCOPE_NAME,CASH_CURRENT_EPOCH,CASH_ARCHIVE_EPOCH} from '@/lib/cash-scope';
import {createPool} from '../db/postgres.mjs';

let db: pg.Pool | undefined;

function pool(){
 if(db)return db;
 db=createPool({role:'review',max:3,applicationName:'al-rifai-accounts-live-read'});
 return db;
}

type LiveRow={
 id:string;source_time:string;block_order:number;employee_name:string;employee_mobile:string|null;
 payout_mobile:string|null;purpose:string;method:string;amount_minor:string;state:string;
 posting_id:string|null;message_id:string|null;original_sender_ref:string|null;
};

export async function liveCashRows(scope:'CURRENT'|'ARCHIVE'='CURRENT'):Promise<CashRow[]>{
 const result=await pool().query<LiveRow>(`
  SELECT i.id,i.source_time,i.block_order,i.employee_name,i.employee_mobile,i.payout_mobile,
         i.purpose,i.method,i.amount_minor::text,i.state,p.id AS posting_id,
         s.message_id,s.original_sender_ref
  FROM public.cash_instructions i
  LEFT JOIN public.cash_postings p
    ON p.scope_account=i.scope_account AND p.instruction_id=i.id
  LEFT JOIN public.source_refs s
    ON s.scope_account=i.scope_account AND s.id=i.source_ref
  WHERE i.scope_account=$1 AND i.cash_account=$2 AND i.dataset_epoch=$3
  ORDER BY i.source_time DESC,i.id DESC`,[CASH_SCOPE_ACCOUNT,CASH_SCOPE_NAME,scope==='ARCHIVE'?CASH_ARCHIVE_EPOCH:CASH_CURRENT_EPOCH]);
 return result.rows.map(r=>({
  id:r.id,date:new Date(r.source_time).toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}),
  time:new Date(r.source_time).toLocaleTimeString('en-GB',{timeZone:'Asia/Dhaka',hour12:false}),
  employeePhone:r.employee_mobile?.replace(/^\+880/,'0')||'',
  payoutPhone:r.payout_mobile?.replace(/^\+880/,'0')||'',name:r.employee_name,
  amountCents:Number(r.amount_minor),method:r.method,source:'WhatsApp live',
  sourceId:r.message_id||r.id,sourceLine:r.block_order+1,
  sourceText:'Original source text is retained by the WhatsApp bridge; this live ledger row exposes the linked source message ID.',
  sender:r.original_sender_ref||'Owner direct WhatsApp message',category:CASH_SCOPE_NAME,
  status:r.posting_id?'Posted':r.state,purpose:r.purpose,issues:[],identityVerified:true,
  identityRule:'Owner outgoing message in the exact owner → Accountant direct chat',
  senderPhone:r.original_sender_ref?.replace(/@.*$/,'').replace(/^880/,'0')||'',
  receiverIdentity:CASH_SCOPE_CHAT
 }));
}

export async function liveCashCoverage(scope:'CURRENT'|'ARCHIVE'='CURRENT'){
 const result=await pool().query<{messages:string;first_date:string|null;last_date:string|null}>(`
  SELECT count(*)::text AS messages,
         to_char(min(source_time) AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD') AS first_date,
         to_char(max(source_time) AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD') AS last_date
  FROM public.cash_instructions WHERE scope_account=$1 AND cash_account=$2 AND dataset_epoch=$3`,[CASH_SCOPE_ACCOUNT,CASH_SCOPE_NAME,scope==='ARCHIVE'?CASH_ARCHIVE_EPOCH:CASH_CURRENT_EPOCH]);
 return result.rows[0]??{messages:'0',first_date:null,last_date:null};
}
