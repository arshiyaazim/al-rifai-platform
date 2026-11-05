import {z} from 'zod';
import {CandidateError,digest} from './contracts.ts';
import {authenticate,type Credentials} from './auth.ts';
import type {CandidateSqlClient,CandidateState} from './repository.ts';
import {extractionScopes,extractionKindForDomain} from '../../lib/history-policy.mjs';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
export const extractionQuery=z.object({accountId:z.enum(['wa-01','wa-02']),kind:z.enum(['ALL','ESCORT','PAYMENT','RELEASE','OTHER']).default('ALL'),q:z.string().trim().max(100).default(''),dateFrom:date.optional(),dateTo:date.optional(),after:z.string().max(1200).default('')}).strict().refine(q=>!q.dateFrom||!q.dateTo||q.dateFrom<=q.dateTo);
const fields=z.record(z.string().max(500)).refine(f=>Object.keys(f).every(k=>['motherVessel','lighterVessel','masterMobile','destination','bookingDate','employeeName','escortName','employeeMobile','escortMobile','assignmentDate','shift','payoutMobile','method','amountMinor','purpose','cargo','importer','capacity','releaseDate','endShift','releasePoint','conveyanceMinor','programId','lifecycleAction','effectiveDate','actualStartDate','oldEmployeeId','newEmployeeId'].includes(k)));
const assertionV1=z.object({version:z.literal('history-extraction-v1'),parserVersion:z.literal('stored-history-extraction-v1'),kind:z.enum(['PAYMENT','ESCORT']),fields,reasons:z.array(z.string().max(100)).max(100),senderLabel:z.string().max(150),direction:z.enum(['INCOMING','OUTGOING']),subjectRef:z.string().max(128),authority:z.literal('REVIEW_ONLY'),rawBodyCopied:z.literal(false),posted:z.literal(false)}).strict();
const assertion=z.union([assertionV1,assertionV1.extend({version:z.literal('history-extraction-v2'),parserVersion:z.literal('stored-history-extraction-v2'),kind:z.enum(['PAYMENT','ESCORT','RELEASE']),operationId:z.string().regex(/^[a-f0-9]{64}$/),blockOrder:z.number().int().min(0).max(49),admission:z.object({role:z.string(),actorRef:z.string().nullable(),bindingRefs:z.array(z.string()),historical:z.boolean()}).strict()}).strict()]);
export type HistorySourceReference={sourceRef:string;accountId:string;chatJid:string;messageId:string;payloadHash:string};
// Provider must use the existing authorized source broker, check current privacy/
// deletion state and recompute history-extraction.mjs's exact sourceHash. Unknown
// or changed hashes never permit display. This dependency is deliberately unset
// in the host until its live broker contract has passed isolated qualification.
export type HistorySourceVerifier=(references:HistorySourceReference[],signal:AbortSignal)=>Promise<Record<string,{visibility:'VISIBLE'|'REVOKED'|'UNKNOWN';payloadHash:string|null}>>;
export async function readHistoryExtractions(state:CandidateState,credentials:Credentials,raw:unknown,clock:()=>number,client?:CandidateSqlClient,verifySources?:HistorySourceVerifier){
 const q=extractionQuery.parse(raw),actor=authenticate(state,credentials,clock());
 const scopes=extractionScopes(state.registry,actor.personId,q.accountId) as Array<{chatJid:string;subjectRef:string;domain:string}>;
 if(!scopes.length)throw new CandidateError('HISTORY_SCOPE_DENIED',403);
 if(!client)throw new CandidateError('HISTORY_DATABASE_NOT_CONFIGURED',503);
 if(!verifySources)throw new CandidateError('HISTORY_SOURCE_REVALIDATION_NOT_CONFIGURED',503);
 const pin=digest({accountId:q.accountId,kind:q.kind,q:q.q,dateFrom:q.dateFrom,dateTo:q.dateTo,scopes,epoch:state.epoch});
 let cursor:{time:string;id:string}|null=null;
 if(q.after){try{const c=JSON.parse(Buffer.from(q.after,'base64url').toString());if(c.pin!==pin||!/^\d{4}-\d\d-\d\dT/.test(c.time)||!Number.isFinite(Date.parse(c.time))||!/^[a-f0-9]{64}$/.test(c.id))throw Error();cursor={time:c.time,id:c.id};}catch{throw new CandidateError('HISTORY_CURSOR_SCOPE_MISMATCH',409);}}
 const values:unknown[]=[q.accountId],clauses=['e.scope_account=$1'];
 const param=(v:unknown)=>{values.push(v);return '$'+values.length;};
 clauses.push('('+scopes.map(s=>'(s.chat_jid='+param(s.chatJid)+" AND e.assertion->>'subjectRef'="+param(s.subjectRef)+" AND e.assertion->>'kind'="+param(extractionKindForDomain(s.domain))+')').join(' OR ')+')');
 if(q.kind!=='ALL')clauses.push("e.assertion->>'kind'="+param(q.kind));
 if(q.q)clauses.push("(e.assertion->>'senderLabel'||' '||COALESCE((SELECT string_agg(value,' ') FROM jsonb_each_text(e.assertion->'fields')),'')) ILIKE "+param('%'+q.q.replace(/[\\%_]/g,'\\$&')+'%'));
 if(q.dateFrom)clauses.push("(s.source_time AT TIME ZONE 'Asia/Dhaka')::date>="+param(q.dateFrom)+'::date');
 if(q.dateTo)clauses.push("(s.source_time AT TIME ZONE 'Asia/Dhaka')::date<="+param(q.dateTo)+'::date');
 const base="WITH latest AS (SELECT DISTINCT ON (scope_account,resource_id) * FROM public.domain_events WHERE scope_account=$1 AND resource_kind='WHATSAPP_EXTRACTION' ORDER BY scope_account,resource_id,created_at DESC,id DESC) SELECT ";
 const from=" FROM latest e JOIN public.source_refs s ON s.id=e.source_ref AND s.scope_account=e.scope_account WHERE e.event_type='MESSAGE_EXTRACTED' AND e.assertion->>'authority'='REVIEW_ONLY' AND s.visibility_state='PROJECTION_PRESENT' AND "+clauses.join(' AND ');
 try{

  const pageValues=[...values];let page='';
  if(cursor){pageValues.push(cursor.time,cursor.id);page=' AND (s.source_time,e.id)<($'+(values.length+1)+'::timestamptz,$'+(values.length+2)+')';}
  const result=await client.query(base+"e.id,e.assertion,s.id AS source_ref,s.payload_hash,s.chat_jid,s.message_id,to_char(s.source_time AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS source_time"+from+page+' ORDER BY s.source_time DESC,e.id DESC LIMIT 26',pageValues);
  const candidates=result.rows.slice(0,25);
  let proofs:Awaited<ReturnType<HistorySourceVerifier>>;
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new CandidateError('HISTORY_SOURCE_REVALIDATION_UNAVAILABLE',503));},12000);});
   proofs=await Promise.race([verifySources(candidates.map(row=>({sourceRef:String(row.source_ref),accountId:q.accountId,chatJid:String(row.chat_jid),messageId:String(row.message_id),payloadHash:String(row.payload_hash)})),abort.signal),deadline]);
  }catch{throw new CandidateError('HISTORY_SOURCE_REVALIDATION_UNAVAILABLE',503);}finally{if(timer)clearTimeout(timer);}
  const current=authenticate(state,credentials,clock());
  if(current.personId!==actor.personId||digest(extractionScopes(state.registry,actor.personId,q.accountId))!==digest(scopes))throw new CandidateError('HISTORY_SCOPE_DENIED',403);
  const rows=candidates.filter(row=>{const proof=proofs[String(row.source_ref)];return proof?.visibility==='VISIBLE'&&proof.payloadHash===row.payload_hash;}).map(row=>{
   const a=assertion.parse(row.assertion);
   if(!scopes.some(s=>s.chatJid===row.chat_jid&&s.subjectRef===a.subjectRef&&extractionKindForDomain(s.domain)===a.kind))throw new CandidateError('HISTORY_ROW_SCOPE_INVALID',503);
   return {id:String(row.id),sourceRef:String(row.source_ref),accountId:q.accountId,chatJid:String(row.chat_jid),messageId:String(row.message_id),sourceTime:String(row.source_time),senderLabel:a.direction==='OUTGOING'?'নিজের account → '+a.senderLabel:a.senderLabel,direction:a.direction,kind:a.kind,fields:a.fields,reasons:a.reasons,authority:a.authority,parserVersion:a.parserVersion};
  });
  const last=candidates.at(-1),nextAfter=result.rows.length>25&&last?Buffer.from(JSON.stringify({pin,time:String(last.source_time),id:String(last.id)})).toString('base64url'):null;
  if(Buffer.byteLength(JSON.stringify(rows))>180000)throw new CandidateError('HISTORY_RESPONSE_BUDGET',503);
  return {rows,nextAfter,total:String(rows.length),coverage:{basis:'STORED_HISTORY_PROJECTION',rawBodyCopied:false,posted:false,completeChatHistory:false,totalBasis:'VISIBLE_PAGE',currentSourceVisibility:'RECHECKED',},checkedAt:new Date(clock()).toISOString()};
 }catch(e){if(['42501','42P01'].includes(String((e as {code?:string}).code)))throw new CandidateError('HISTORY_DATABASE_NOT_ACTIVATED',503);throw e;}
}
