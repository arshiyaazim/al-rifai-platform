import {z} from 'zod';
import {authenticate,type Credentials} from './auth.ts';
import {CandidateError,digest} from './contracts.ts';
import type {CandidateState,CandidateSqlClient} from './repository.ts';
import {historyGrant} from '../../lib/history-policy.mjs';
import {employeeMobile,exactMinor} from '../../lib/history-extraction.mjs';
const id=z.string().regex(/^[a-f0-9]{64}$/);
const entry=z.object({accountId:z.literal('wa-01'),operationId:z.string().uuid(),employeeMobile:z.string().max(30),employeeName:z.string().trim().min(1).max(150),payoutMobile:z.string().max(30),purpose:z.string().trim().min(1).max(500),method:z.enum(['cash','bkash','nagad','bank','rocket']),amount:z.string().max(30),at:z.string().datetime(),cashAccount:z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),reversesId:id.optional()}).strict();
export function cashAccess(s:CandidateState,credentials:Credentials,now:number){
 const a=authenticate(s,credentials,now);
 const role=Object.values(s.registry).filter(r=>r.kind==='relationship'&&r.status==='VERIFIED'&&(r.data as {personId:string}).personId===a.personId).map(r=>(r.data as {kind:string}).kind);
 const admin=role.some(r=>['ADMIN','SUPER_ADMIN'].includes(r));
 return {actorId:a.personId,admin,create:historyGrant(s.registry,a.personId,'wa-01','cash.entry.create','ACCOUNTS',null),post:admin&&historyGrant(s.registry,a.personId,'wa-01','cash.post','ACCOUNTS',null)&&process.env.ALRIFAI_CASH_POSTING_ENABLED==='APPROVED_MANUAL_V1',reverse:admin&&historyGrant(s.registry,a.personId,'wa-01','cash.reverse','ACCOUNTS',null)&&process.env.ALRIFAI_CASH_POSTING_ENABLED==='APPROVED_MANUAL_V1'};
}
export async function createCashEntry(s:CandidateState,credentials:Credentials,raw:unknown,now:number,client?:CandidateSqlClient){
 const q=entry.parse(raw),actor=authenticate(s,credentials,now,true),access=cashAccess(s,credentials,now);
 if(!access.create||q.reversesId&&!access.reverse)throw new CandidateError('CASH_ENTRY_SCOPE_DENIED',403);
 if(!client)throw new CandidateError('WORKSPACE_DATABASE_NOT_CONFIGURED',503);
 const mobile=employeeMobile(q.employeeMobile),payout=q.payoutMobile?employeeMobile(q.payoutMobile):null,minor=exactMinor(q.amount);
 if(!mobile||q.payoutMobile&&!payout||q.method!=='cash'&&!payout||!minor)throw new CandidateError('CASH_COMPONENTS_INVALID',422);
 const fields={...q,employeeMobile:mobile,payoutMobile:payout,amountMinor:minor},payloadHash=digest(fields),instructionId=digest(['cash-manual',q.accountId,q.operationId]),operation=digest(['cash-operation',q.accountId,q.operationId]);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[q.accountId+operation]);
 const existing=(await client.query('SELECT id,payload_hash FROM public.cash_instructions WHERE scope_account=$1 AND operation_id=$2',[q.accountId,operation])).rows[0];
 if(existing){if(existing.payload_hash!==payloadHash)throw new CandidateError('CASH_REPLAY_CONFLICT',409);return {id:existing.id,replay:true,posted:!!(await client.query('SELECT id FROM public.cash_postings WHERE scope_account=$1 AND operation_id=$2',[q.accountId,operation])).rows.length};}
 const commandId=digest(['cash-entry',instructionId]);
 await client.query('INSERT INTO public.business_commands(id,scope_account,operation_key,payload_hash,action,actor_ref,auth_epoch,expected_resource_version,confirmation_basis,result_ref,result_hash,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$4,$10)',[commandId,q.accountId,'cash-entry:'+operation,payloadHash,'CASH_ENTRY',actor.personId,s.epoch,'NONFINANCIAL',instructionId,new Date(now).toISOString()]);
 await client.query('INSERT INTO public.cash_instructions(id,operation_id,scope_account,command_id,source_time,block_order,employee_mobile,employee_name,payout_mobile,purpose,method,amount_minor,state,reasons,payload_hash,cash_account,reverses_id) VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)',[instructionId,operation,q.accountId,commandId,q.at,mobile,q.employeeName,payout,q.purpose,q.method,minor,access.admin?'MANUAL_READY':'PENDING_ADMIN',JSON.stringify(access.admin?[]:['EXACT_VERSION_ADMIN_APPROVAL_REQUIRED']),payloadHash,q.cashAccount,q.reversesId??null]);
 if(!access.post)return {id:instructionId,payloadHash,state:access.admin?'MANUAL_READY':'PENDING_ADMIN',posted:false};
 return postCashEntry(s,credentials,{accountId:q.accountId,instructionId,payloadHash,cashAccount:q.cashAccount,reversesId:q.reversesId},now,client);
}
export async function postCashEntry(s:CandidateState,credentials:Credentials,raw:unknown,now:number,client?:CandidateSqlClient){
 const q=z.object({accountId:z.literal('wa-01'),instructionId:id,payloadHash:id,cashAccount:z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),reversesId:id.optional()}).strict().parse(raw),actor=authenticate(s,credentials,now,true),access=cashAccess(s,credentials,now);
 if(!access.post||q.reversesId&&!access.reverse)throw new CandidateError('CASH_POSTING_NOT_ACTIVATED_OR_DENIED',403);
 if(!client)throw new CandidateError('WORKSPACE_DATABASE_NOT_CONFIGURED',503);
 const instruction=(await client.query('SELECT * FROM public.cash_instructions WHERE id=$1 AND scope_account=$2 FOR SHARE',[q.instructionId,q.accountId])).rows[0];
 if(!instruction||instruction.payload_hash!==q.payloadHash||instruction.source_ref||instruction.cash_account!==q.cashAccount||(instruction.reverses_id??null)!==(q.reversesId??null))throw new CandidateError('CASH_EXACT_MANUAL_VERSION_REQUIRED',409);
 const commandId=digest(['cash-post',q.accountId,instruction.operation_id]),hash=digest(q),basis=instruction.state==='PENDING_ADMIN'?'STAFF_APPROVED':'ADMIN_DIRECT';
 const existing=(await client.query('SELECT payload_hash FROM public.business_commands WHERE id=$1',[commandId])).rows[0];
 if(existing&&existing.payload_hash!==hash)throw new CandidateError('CASH_REPLAY_CONFLICT',409);
 if(!existing)await client.query('INSERT INTO public.business_commands(id,scope_account,operation_key,payload_hash,action,actor_ref,auth_epoch,expected_resource_version,approval_ref,approval_hash,confirmation_basis,result_ref,result_hash,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13)',[commandId,q.accountId,'cash-post:'+instruction.operation_id,hash,'CASH_POST',actor.personId,s.epoch,basis==='STAFF_APPROVED'?commandId:null,basis==='STAFF_APPROVED'?q.payloadHash:null,basis,q.instructionId,q.payloadHash,new Date(now).toISOString()]);
 const result=await client.query('SELECT public.alrifai_post_cash($1,$2,$3,$4,$5) AS id',[q.instructionId,q.payloadHash,commandId,q.cashAccount,q.reversesId??null]);
 return {id:q.instructionId,postingId:result.rows[0].id,posted:true,externalDisbursement:'NOT_ESTABLISHED',openingBalance:null,balance:null};
}
