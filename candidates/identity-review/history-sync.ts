import {visibleHistorySources} from './source-visibility.ts';
import type {HistorySourceVerifier} from './history-extractions.ts';
import {projectHistoryBusiness} from './history-business.ts';
import {HISTORY_GROUPS} from '../../lib/history-policy.mjs';
import {CandidateError,digest} from './contracts.ts';
import {authenticate,type Credentials} from './auth.ts';
import type {CandidateState,CandidateSqlClient} from './repository.ts';
import {extractionScopes,historyAdmission} from '../../lib/history-policy.mjs';
import {extractStoredMessage,sha} from '../../lib/history-extraction.mjs';
import type {StoredHistoryPage} from './stored-history-mcp.ts';
const progressKey=(accountId:string,chatJid:string)=>digest(['stored-history-backfill-v1',accountId,chatJid]);
export function historyStatus(s:CandidateState,credentials:Credentials,accountId:string,now:number){
 const a=authenticate(s,credentials,now),scopes=extractionScopes(s.registry,a.personId,accountId);
 if(!scopes.length)throw new CandidateError('HISTORY_SCOPE_DENIED',403);
 return {accountId,scopes:scopes.map((v:{chatJid:string;senderLabel:string;domain:string})=>({chatJid:v.chatJid,senderLabel:v.senderLabel,domain:v.domain,cursor:s.progress[progressKey(accountId,v.chatJid)]??null,coverage:'PARTIAL_STORED_HISTORY',editSync:'RESCAN_REQUIRED'})),unavailableScopes:[...HISTORY_GROUPS].filter(chat=>!scopes.some(v=>v.chatJid===chat)).map(chatJid=>({chatJid,state:'SCOPE_NOT_CONFIGURED',message:'এই group-এর অনুমোদিত participant/domain scope এখনও সক্রিয় নয়।'}))};
}
export function prepareHistoryPull(s:CandidateState,credentials:Credentials,input:{accountId:string;chatJid:string;rescan:boolean},now:number){
 const a=authenticate(s,credentials,now,true),scope=extractionScopes(s.registry,a.personId,input.accountId).find((v:{chatJid:string})=>v.chatJid===input.chatJid);
 if(!scope)throw new CandidateError('HISTORY_SCOPE_DENIED',403);
 const key=progressKey(input.accountId,input.chatJid),previous=s.progress[key]??null;
 return {actor:a.personId,epoch:s.epoch,scope,key,previous,after:input.rescan?'0':previous??'0'};
}
export async function commitHistoryPull(s:CandidateState,credentials:Credentials,input:{accountId:string;chatJid:string;rescan:boolean},context:ReturnType<typeof prepareHistoryPull>,page:StoredHistoryPage,now:number,client?:CandidateSqlClient,verify?:HistorySourceVerifier){
 const current=prepareHistoryPull(s,credentials,input,now);
 if(current.actor!==context.actor||current.epoch!==context.epoch||current.previous!==context.previous||digest(current.scope)!==digest(context.scope))throw new CandidateError('HISTORY_PULL_CONFLICT',409);
 if(!client)throw new CandidateError('HISTORY_DATABASE_NOT_CONFIGURED',503);
 if(page.accountId!==input.accountId||page.chatJid!==input.chatJid||page.previousAfter!==context.after)throw new CandidateError('HISTORY_PAGE_SCOPE_MISMATCH',403);
 const currentRefs=page.records.filter(r=>r.state==='VISIBLE'&&r.message).map(r=>({sourceRef:r.messageId,accountId:input.accountId,chatJid:input.chatJid,messageId:r.messageId,payloadHash:r.sourceHash!}));
 const visible=await visibleHistorySources(s,credentials,input.accountId,currentRefs,()=>now,verify);
 const candidates=page.records.filter(r=>visible.has(r.messageId)).filter(r=>r.state==='VISIBLE'&&r.message).flatMap(r=>extractStoredMessage(r.message,{...context.scope,admission:historyAdmission(s.registry,r.message,context.scope,page.nativeScope)}));
 if(candidates.length>200)throw new CandidateError('HISTORY_BATCH_BLOCK_BUDGET',422);
 let extracted=0,replayed=0;
 for(const row of candidates){
  const commandId=sha(['history-command',row.id]),operation='history-extract:'+row.id,payloadHash=sha({source:row.source,assertion:row.assertion});
  const previous=await client.query('SELECT payload_hash FROM public.business_commands WHERE scope_account=$1 AND operation_key=$2',[input.accountId,operation]);
  if(previous.rows.length){if(previous.rows[0].payload_hash!==payloadHash)throw new CandidateError('HISTORY_REPLAY_CONFLICT',409);replayed++;continue;}
  await client.query('INSERT INTO public.business_commands(id,scope_account,source_ref,operation_key,payload_hash,action,actor_ref,auth_epoch,confirmation_basis,result_ref,result_hash,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())',[commandId,input.accountId,row.source.id,operation,payloadHash,'HISTORY_EXTRACT',current.actor,String(s.epoch),'NONFINANCIAL',row.id,sha(row.assertion)]);
  await client.query('INSERT INTO public.source_refs(id,scope_account,created_command_id,channel,provider,chat_jid,message_id,source_kind,external_ref,block_key,payload_hash,source_time,observed_at,original_sender_ref,submitted_by_ref,origin_state,visibility_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$16) ON CONFLICT(id) DO NOTHING',[row.source.id,input.accountId,commandId,'WHATSAPP',row.source.provider,row.source.chatJid,row.source.messageId,'SQLITE_HISTORY',row.source.externalRef,row.source.blockKey,row.source.sourceHash,row.source.sourceTime,row.source.senderRef,current.actor,'UNKNOWN','PROJECTION_PRESENT']);
  await client.query('INSERT INTO public.domain_events(id,scope_account,source_ref,created_command_id,resource_kind,resource_id,event_type,effective_at,reason,assertion,event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)',[row.id,input.accountId,row.source.id,commandId,'WHATSAPP_EXTRACTION',sha([input.accountId,row.source.chatJid,row.source.messageId,row.source.blockKey]),'MESSAGE_EXTRACTED',row.source.sourceTime,'Stored history parsed; business authority not inferred',JSON.stringify(row.assertion),sha(row.assertion)]);
  await projectHistoryBusiness(s,client,row,current.actor,commandId,current.scope.clientId??null,credentials,()=>now,verify);
  extracted++;
 }
 s.progress[context.key]=page.nextAfter;
 return {scanned:page.records.length,extracted,replayed,cursor:page.nextAfter,complete:page.complete,held:page.records.filter(r=>r.state!=='VISIBLE').length};
}
