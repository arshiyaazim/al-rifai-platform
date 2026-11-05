import {calculateSourceDuty} from '../../lib/duty-calculation.mjs';
import {employeeMobile} from '../../lib/history-extraction.mjs';
import {z} from 'zod';
import {authenticate,type Credentials} from './auth.ts';
import {authorizeWorkspace} from './workspace.ts';
import {CandidateError} from './contracts.ts';
import type {CandidateState,CandidateSqlClient} from './repository.ts';
import {validDate} from '../../lib/vessel-data.ts';
import {extractionScopes} from '../../lib/history-policy.mjs';
import {visibleHistorySources} from './source-visibility.ts';
import type {HistorySourceReference,HistorySourceVerifier} from './history-extractions.ts';
const date=z.string().max(10).default('').refine(validDate,'Invalid date');
export const businessQuery=z.object({accountId:z.literal('wa-01'),view:z.enum(['cash','roster']),basis:z.enum(['source','archive']).default('source'),report:z.enum(['register','statement','cancelled','replaced','incomplete','missing']).default('register'),q:z.string().trim().max(150).default(''),from:date,to:date,payee:z.string().trim().max(100).default(''),method:z.enum(['','cash','bkash','nagad','bank','rocket','unknown']).default(''),status:z.string().max(40).default(''),sort:z.enum(['date','source','mother','lighter','name','mobile']).default('date'),offset:z.coerce.number().int().min(0).max(5000).default(0)}).strict().refine(v=>!v.from||!v.to||v.from<=v.to,'Invalid date range');
export async function readBusinessRegister(s:CandidateState,credentials:Credentials,raw:unknown,clock:()=>number,client?:CandidateSqlClient,verify?:HistorySourceVerifier){
 const q=businessQuery.parse(raw),actor=authorizeWorkspace(s,credentials,{accountId:q.accountId,view:q.view==='cash'?'cash':'programs'},clock());
 if(!client)throw new CandidateError('WORKSPACE_DATABASE_NOT_CONFIGURED',503);
 const scopes=extractionScopes(s.registry,actor.personId,q.accountId) as Array<{chatJid:string;subjectRef:string;domain:string}>;
 const mobileFilter=q.payee?(employeeMobile(q.payee)??q.payee):'';
 const allowedChats=scopes.filter(v=>q.view==='cash'?v.domain==='ACCOUNTS':v.domain!=='ACCOUNTS').map(v=>v.chatJid);
 if(q.basis==='source'&&!allowedChats.length)throw new CandidateError('HISTORY_SCOPE_DENIED',403);
 let rows:Array<Record<string,unknown>>=[];
 try{
  if(q.basis==='archive'){
   if(q.view!=='cash')throw new CandidateError('ARCHIVE_VIEW_NOT_AVAILABLE',400);
   rows=(await client.query('SELECT id,date,name,"employeePhone",method,"amountCents"::text AS "amountMinor",source FROM public.site_cash_archive ORDER BY date DESC,id LIMIT 201')).rows.map(r=>({...r,status:'HISTORICAL_REFERENCE',references:[]}));
  }else if(q.view==='cash'){
   rows=(await client.query(`WITH latest AS (SELECT DISTINCT ON (scope_account,operation_id) * FROM public.cash_instructions WHERE scope_account=$1 ORDER BY scope_account,operation_id,created_at DESC,id DESC)
    SELECT i.id,i.operation_id AS "operationId",i.employee_mobile AS "employeePhone",i.employee_name AS name,i.payout_mobile AS "payoutMobile",i.purpose,i.method,i.amount_minor::text AS "amountMinor",i.state AS status,i.reasons,i.payload_hash AS "payloadHash",i.cash_account AS "cashAccount",i.reverses_id AS "requestedReversal",i.block_order AS "blockOrder",i.source_time AS "sourceTime",i.source_ref AS "sourceRef",s.chat_jid AS "chatJid",s.message_id AS "messageId",s.payload_hash AS "sourceHash",p.id AS "postingId",p.amount_minor::text AS "postedMinor",p.reverses_id AS "reversesId"
    FROM latest i LEFT JOIN public.source_refs s ON s.id=i.source_ref AND s.scope_account=i.scope_account LEFT JOIN public.cash_postings p ON p.scope_account=i.scope_account AND p.operation_id=i.operation_id
    WHERE (s.chat_jid=ANY($2::text[]) OR i.source_ref IS NULL) AND ($3='' OR (i.source_time AT TIME ZONE 'Asia/Dhaka')::date>=nullif($3,'')::date) AND ($4='' OR (i.source_time AT TIME ZONE 'Asia/Dhaka')::date<=nullif($4,'')::date)
    AND ($5='' OR i.employee_mobile=$5) AND ($6='' OR i.method=$6) AND ($7='' OR strpos(lower(concat_ws(' ',i.employee_name,i.employee_mobile,i.payout_mobile,i.purpose,i.method,i.state)),lower($7))>0) ORDER BY i.source_time DESC,i.operation_id LIMIT 201`,[q.accountId,allowedChats,q.from,q.to,mobileFilter,q.method,q.q])).rows.map(r=>({...r,status:r.postingId?'POSTED':r.status,references:r.sourceRef?[String(r.sourceRef)]:[]}));
  }else{
   // Only canonical programs, plus explicitly labelled unlinked source reviews.
   rows=(await client.query(`SELECT p.*,p.details::jsonb AS ledger,
    coalesce((SELECT jsonb_agg(DISTINCT l.source_ref) FROM public.roster_source_links l WHERE l.scope_account=$1 AND l.program_id=p.id),'[]'::jsonb) AS references,
    coalesce((SELECT jsonb_agg(DISTINCT reason.value) FROM public.roster_source_links l CROSS JOIN LATERAL jsonb_array_elements_text(l.reasons) AS reason(value) WHERE l.scope_account=$1 AND l.program_id=p.id),'[]'::jsonb) AS "sourceReasons"
    FROM public.programs p WHERE (CASE WHEN pg_input_is_valid(p.details,'jsonb') THEN p.details::jsonb END)->'programCommand'->'scope'->>'accountId'=$1
    AND (CASE WHEN pg_input_is_valid(p.details,'jsonb') THEN p.details::jsonb END)->'programCommand'->'scope'->>'chatJid'=ANY($2::text[]) AND ($5='' OR strpos(lower(concat_ws(' ',p."motherVessel",p."lighterVessel",p."escortName",p."escortMobile",p.destination)),lower($5))>0) AND ($6='' OR p."escortMobile"=$6) AND ($3='' OR p."startDate"<=$3) AND ($4='' OR p."endDate"='' OR p."endDate">=$4) ORDER BY p.id LIMIT 201`,[q.accountId,allowedChats,q.to,q.from,q.q,mobileFilter])).rows.map(p=>{const l=(p.ledger as {programCommand:Record<string,unknown>}).programCommand;const ev=(l.events??[]) as Array<Record<string,unknown>>;return {...p,events:ev,sourceTime:(l.allocation as {sourceTimestamp?:string})?.sourceTimestamp??p.createdAt,source:'SOURCE_LINKED_CANONICAL_PROGRAM',basis:'CANONICAL_PROGRAM',calculation:calculateSourceDuty({assignment:{employeeMobile:p.escortMobile,actualStart:l.dutyStartedOn,releaseDate:l.releasedOn},attendance:[],rates:[],policy:null}),references:[...new Set([...(p.references as string[]),...ev.flatMap(e=>(e.sourceReferences??[]) as string[])])],reasons:p.sourceReasons??[]};});
   const review=(await client.query(`SELECT l.event_id AS id,l.source_ref AS "sourceRef",l.reasons,s.source_time AS "sourceTime",e.assertion->'fields' AS fields FROM public.roster_source_links l JOIN public.source_refs s ON s.id=l.source_ref AND s.scope_account=l.scope_account JOIN public.domain_events e ON e.id=l.event_id WHERE l.scope_account=$1 AND l.program_id IS NULL AND s.chat_jid=ANY($2::text[]) ORDER BY s.source_time DESC LIMIT 201`,[q.accountId,allowedChats])).rows;
   rows.push(...review.map(r=>({...r,...r.fields as Record<string,string>,escortMobile:(r.fields as Record<string,string>).employeeMobile??'',startDate:(r.fields as Record<string,string>).assignmentDate??'',status:'Review',basis:'UNLINKED_SOURCE_REVIEW',references:[String(r.sourceRef)]})));
  }
  if(rows.length>200)throw new CandidateError('BUSINESS_SCOPE_TOO_LARGE_SELECT_DATES',422);
  if(q.basis==='source'){
   const ids=[...new Set(rows.flatMap(r=>r.references as string[]))];
   const refs=ids.length?(await client.query('SELECT id AS "sourceRef",scope_account AS "accountId",chat_jid AS "chatJid",message_id AS "messageId",payload_hash AS "payloadHash" FROM public.source_refs WHERE scope_account=$1 AND id=ANY($2::text[])',[q.accountId,ids])).rows as HistorySourceReference[]:[];
   const visible=await visibleHistorySources(s,credentials,q.accountId,refs,clock,verify);
   rows=rows.filter(r=>(r.references as string[]).every(id=>visible.has(id)));
  }
  const text=(v:unknown)=>String(v??'').toLocaleLowerCase();
  rows=rows.map((r):Record<string,unknown>=>({...r,sourceTime:r.sourceTime?new Date(String(r.sourceTime)).toISOString():'',date:r.sourceTime?new Date(Date.parse(String(r.sourceTime))+21600000).toISOString().slice(0,10):r.date,sourceOrder:r.operationId?String(r.sourceTime)+' / '+String(r.messageId)+' / '+String(Number(r.blockOrder)+1):r.id})).filter(r=>{
   if(mobileFilter&&q.view==='roster'&&!text(r.escortMobile).includes(text(mobileFilter)))return false;
   if(q.status&&r.status!==q.status)return false;
   if(q.q&&!text([r.id,r.name,r.employeePhone,r.payoutMobile,r.purpose,r.method,r.motherVessel,r.lighterVessel,r.escortName,r.escortMobile,r.masterMobile,r.destination,r.status].join(' ')).includes(text(q.q)))return false;
   if(q.view==='cash')return (!q.from||String(r.date)>=q.from)&&(!q.to||String(r.date)<=q.to)&&(!q.method||r.method===q.method);
   if(q.report==='missing')return r.basis==='UNLINKED_SOURCE_REVIEW';
   if(['cancelled','replaced'].includes(q.report))return ((r.events??[]) as Array<{command:{action:string;effectiveDate?:string}}>).some(e=>e.command.action===(q.report==='cancelled'?'CANCEL':'REPLACE')&&(!q.from||String(e.command.effectiveDate)>=q.from)&&(!q.to||String(e.command.effectiveDate)<=q.to));
   if(q.report==='incomplete'&&r.motherVessel&&r.lighterVessel&&r.escortMobile&&r.startDate)return false;
   return (!q.to||!!r.startDate&&String(r.startDate)<=q.to)&&(!q.from||!!r.startDate&&(!r.endDate||String(r.endDate)>=q.from));
  });
  const sortKey=({source:'sourceOrder',date:q.view==='cash'?'sourceTime':'startDate',mother:'motherVessel',lighter:'lighterVessel',name:q.view==='cash'?'name':'escortName',mobile:q.view==='cash'?'employeePhone':'escortMobile'} as const)[q.sort];
  rows.sort((a,b)=>(q.sort==='date'?-1:1)*String(a[sortKey]??'').localeCompare(String(b[sortKey]??''))||Number(a.blockOrder??0)-Number(b.blockOrder??0)||String(a.id).localeCompare(String(b.id)));
  const total=String(rows.length),selected=rows.slice(q.offset,q.offset+25),sum=(key:string)=>selected.reduce((n,r)=>n+(r[key]&&/^-?\d+$/.test(String(r[key]))?BigInt(String(r[key])):0n),0n).toString();
  // Send only structured columns, never the stored details blob/body or stale history.
  const aliases=new Map<string,string[]>();for(const r of rows){const mobile=String(r.employeePhone??r.escortMobile??'');if(mobile){const a=aliases.get(mobile)??[];const name=String(r.name??r.escortName??'');if(name&&!a.includes(name))a.push(name);aliases.set(mobile,a);}}
  const safe=selected.map(row=>{const r=Object.fromEntries(Object.entries(row).filter(([key])=>!['details','ledger','notes'].includes(key)));return ({...r,events:((r.events??[]) as Array<Record<string,unknown>>).map(e=>({id:e.id,command:e.command,approvedAt:e.approvedAt,previousState:e.previousState,nextState:e.nextState})),cashAccount:r.cashAccount??null,aliases:aliases.get(String(r.employeePhone??r.escortMobile??''))??[]});});
  authenticate(s,credentials,clock());authorizeWorkspace(s,credentials,{accountId:q.accountId,view:q.view==='cash'?'cash':'programs'},clock());
  return {view:q.view,rows:safe,metadata:{},total,nextOffset:q.offset+25<rows.length?q.offset+25:null,filters:q,checkedAt:new Date(clock()).toISOString(),summary:q.view==='cash'?{amountMinor:sum('amountMinor'),postedMinor:sum('postedMinor'),basis:'VISIBLE_PAGE',firstDate:selected[0]?.date??null,lastDate:selected.at(-1)?.date??null,openingBalance:null,balance:null}:null,coverage:{basis:q.basis==='archive'?'HISTORICAL_REFERENCE':'SOURCE_REVALIDATED',totalBasis:'ALL_VISIBLE_FILTERED',completeChatHistory:false,editSync:'RESCAN_REQUIRED'},readOnly:true};
 }catch(e){if(['42501','42P01'].includes(String((e as {code?:string}).code)))throw new CandidateError('WORKSPACE_DATABASE_SCOPE_NOT_READY',503);throw e;}
}
