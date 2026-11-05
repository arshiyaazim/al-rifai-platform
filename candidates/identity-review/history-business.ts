import {visibleHistorySources} from './source-visibility.ts';
import type {Credentials} from './auth.ts';
import type {HistorySourceReference,HistorySourceVerifier} from './history-extractions.ts';
import {CandidateError,digest} from './contracts.ts';
import type {CandidateState,CandidateSqlClient} from './repository.ts';
import {canonicalProgramCommandBoundary,type ProgramCommandContext,type ProgramCommand} from '../../lib/program-command-boundary.ts';
import {norm} from '../../lib/programs.ts';
import {employeeMobile} from '../../lib/history-extraction.mjs';

type Extracted={id:string;source:{id:string;accountId:string;chatJid:string;messageId:string;sourceTime:string;sourceHash:string;blockKey:string;senderRef:string};assertion:{operationId:string;blockOrder:number;kind:string;direction:string;fields:Record<string,string>;reasons:string[];admission:{role:string;actorRef:string|null;historical:boolean;bindingRefs:string[]};subjectRef:string}};
const day=(s:string)=>new Date(Date.parse(s)+21600000).toISOString().slice(0,10);
const days=(a:string,b:string)=>Math.abs(Date.parse(day(a))-Date.parse(day(b)))/86400000;
export function compatibleDraft(fields:Record<string,string>,row:Record<string,unknown>){
 return ['motherVessel','lighterVessel','masterMobile'].every(k=>!fields[k]||!row[k]||norm(fields[k])===norm(String(row[k])))&&['motherVessel','lighterVessel'].some(k=>fields[k]&&row[k]&&norm(fields[k])===norm(String(row[k])));
}
export async function projectHistoryBusiness(s:CandidateState,client:CandidateSqlClient,row:Extracted,actorId:string,commandId:string,clientId:string|null,credentials:Credentials,clock:()=>number,verify?:HistorySourceVerifier){
 const a=row.assertion,f=a.fields,src=row.source;
 const existing=await client.query('SELECT 1 FROM public.roster_source_links WHERE scope_account=$1 AND event_id=$2',[src.accountId,row.id]);
 if(a.kind!=='PAYMENT'&&existing.rows.length)return;
 if(a.kind==='PAYMENT'){
  if(a.direction!=='OUTGOING'||a.admission.role!=='ADMIN')return;
  const mobile=employeeMobile(f.employeeMobile??''),payout=employeeMobile(f.payoutMobile??''),reasons=[...a.reasons];
  // Parsing never supplies historical transport success. Intent, confirmation,
  // posting and external transfer remain separate facts.
  const state=reasons.some(r=>!['FORWARDING_STATE_UNKNOWN','STORED_PROJECTION_NOT_SEND_SUCCESS'].includes(r))?'REVIEW':'INTENT';
  await client.query('INSERT INTO public.cash_instructions(id,operation_id,scope_account,source_ref,command_id,source_time,block_order,employee_mobile,employee_name,payout_mobile,purpose,method,amount_minor,state,reasons,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) ON CONFLICT(id) DO NOTHING',[row.id,a.operationId,src.accountId,src.id,commandId,src.sourceTime,a.blockOrder,mobile,f.employeeName??'',payout,f.purpose??'',f.method??'',f.amountMinor??null,state,JSON.stringify(reasons),digest(a)]);
  if(mobile)await client.query('INSERT INTO public.employee_mobile_evidence(scope_account,mobile,name,source_ref,source_role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[src.accountId,mobile,f.employeeName??'',src.id,'EMPLOYEE_MOBILE']);
  return;
 }
 let programId:string|null=null,outcome='REVIEW';const reasons:string[]=[];
 const link=async()=>client.query('INSERT INTO public.roster_source_links(scope_account,operation_id,source_ref,event_id,program_id,outcome,reasons) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[src.accountId,a.operationId,src.id,row.id,programId,outcome,JSON.stringify(reasons)]);
 if(a.kind==='ESCORT'&&a.direction==='INCOMING'&&a.admission.role!=='CLIENT'){reasons.push('CLIENT_SOURCE_AUTHORITY_UNRESOLVED');await link();return;}
 // Current content proof was obtained outside the repository lock and admission
 // rechecked at commit. Every read also verifies all contributing source hashes.
 const candidates=await client.query("SELECT id,revision,\"motherVessel\",\"lighterVessel\",\"masterMobile\",\"escortMobile\",\"startDate\",\"endDate\",details::jsonb AS details FROM public.programs WHERE pg_input_is_valid(details,'jsonb') AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb END)->'programCommand'->'scope'->>'accountId'=$1 ORDER BY id LIMIT 201 FOR UPDATE",[src.accountId]);
 if(candidates.rows.length>200)throw new CandidateError('ROSTER_RECONCILIATION_SCOPE_REQUIRED',409);
 const scoped=candidates.rows.filter(p=>{const l=(p.details as {programCommand?:{scope:{chatJid:string};allocation?:{clientPersonId:string}}})?.programCommand;return l?.allocation?.clientPersonId===a.subjectRef;});
 const prior=await client.query('SELECT program_id FROM public.roster_source_links WHERE scope_account=$1 AND operation_id=$2 AND program_id IS NOT NULL LIMIT 1',[src.accountId,a.operationId]);
 if(prior.rows.length){programId=String(prior.rows[0].program_id);reasons.push('CHANGED_SOURCE_REQUIRES_LINKED_CORRECTION');await link();return;}
 let target:Record<string,unknown>|undefined;
 if(a.kind==='ESCORT'&&f.programId){
  const matches=scoped.filter(p=>p.id===f.programId);
  if(matches.length===1){target=matches[0];programId=String(target.id);}else reasons.push('EXACT_PROGRAM_REFERENCE_UNRESOLVED');
 }else if(a.kind==='ESCORT'){
  const matches=scoped.filter(p=>{const l=(p.details as {programCommand:{allocation:{sourceTimestamp:string}}}).programCommand;return compatibleDraft(f,p)&&(a.direction==='INCOMING'||Date.parse(src.sourceTime)>=Date.parse(l.allocation.sourceTimestamp))&&days(src.sourceTime,l.allocation.sourceTimestamp)<=3;});
  if(matches.length>1)reasons.push('AMBIGUOUS_DRAFT_MATCH');
  else if(matches.length===1){target=matches[0];programId=String(target.id);}
  else if(a.direction==='INCOMING'&&a.admission.role==='CLIENT'&&clientId&&(f.motherVessel||f.lighterVessel)){
   const nearby=scoped.some(p=>norm(String(p.lighterVessel))===norm(f.lighterVessel??'')&&days(src.sourceTime,(p.details as {programCommand:{allocation:{sourceTimestamp:string}}}).programCommand.allocation.sourceTimestamp)<=5);
   if(nearby)reasons.push('FIVE_DAY_PROGRAM_RECONCILIATION');
   else programId='hist_'+a.operationId.slice(0,48);
  }else reasons.push(a.direction==='OUTGOING'?'UNMATCHED_ADMIN_CONFIRMATION':'CLIENT_AUTHORITY_OR_ORDER_FIELDS_REQUIRED');
 }else{
  // A group cannot select by vessel/name alone. Require mobile, assignment
  // window and (when supplied) exact master. Ambiguous evidence stays Review.
  const mobile=employeeMobile(f.employeeMobile??'');
  const matches=candidates.rows.filter(p=>mobile&&p.escortMobile===mobile&&p.startDate&&String(p.startDate)<=String(f.releaseDate??'')&&(!p.endDate||String(p.endDate)>=String(f.releaseDate??''))&&(!f.masterMobile||p.masterMobile===f.masterMobile));
  if(matches.length===1){target=matches[0];programId=String(target.id);}
  else reasons.push(matches.length?'AMBIGUOUS_RELEASE_ASSIGNMENT':'RELEASE_ASSIGNMENT_UNRESOLVED');
  if(a.admission.role!=='ADMIN'||!a.admission.historical)reasons.push('RELEASE_AUTHORITY_REVIEW');
 }
 const parsedReasons=a.reasons.filter(r=>!['STORED_PROJECTION_NOT_SEND_SUCCESS','FORWARDING_STATE_UNKNOWN','HISTORICAL_ROLE_NOT_ESTABLISHED'].includes(r));
 reasons.push(...parsedReasons);
 if(a.direction==='OUTGOING'&&(a.admission.role!=='ADMIN'||!a.admission.historical))reasons.push('HISTORICAL_ADMIN_AUTHORITY_REQUIRED');
 if(target){
  const ledger=(target.details as {programCommand:{events:Array<{sourceReferences:string[]}>}}).programCommand;
  const ids=[...new Set(ledger.events.flatMap(e=>e.sourceReferences))];
  const refs=ids.length?(await client.query('SELECT id AS "sourceRef",scope_account AS "accountId",chat_jid AS "chatJid",message_id AS "messageId",payload_hash AS "payloadHash" FROM public.source_refs WHERE scope_account=$1 AND id=ANY($2::text[])',[src.accountId,ids])).rows as HistorySourceReference[]:[];
  const visible=await visibleHistorySources(s,credentials,src.accountId,refs,clock,verify);
  if(!ids.length||ids.some(id=>!visible.has(id)))reasons.push('PRIOR_PROGRAM_SOURCE_UNAVAILABLE');
 }
 if(programId&&!reasons.length){
  const ledger=target?(target.details as {programCommand:Record<string,unknown>}).programCommand:null;
  let action:ProgramCommand['action']=!target?'ALLOCATE_DRAFT':a.kind==='RELEASE'?'RELEASE':a.direction==='INCOMING'?'ADD_EVIDENCE':'CONFIRM';
  const transitions:Record<string,ProgramCommand['action']>={PROGRAM_CANCELLATION:'CANCEL',PROGRAM_CORRECTION:'CORRECT',PROGRAM_RESTART:'RESTART',ESCORT_REPLACEMENT:'REPLACE',DUTY_START:'START_DUTY',NEW_ASSIGNMENT:'ASSIGN'};
  if(f.lifecycleAction&&transitions[f.lifecycleAction]){
   action=transitions[f.lifecycleAction];
   if(!target||!f.programId)reasons.push('EXACT_PROGRAM_REFERENCE_REQUIRED');
   if(a.direction!=='OUTGOING'||a.admission.role!=='ADMIN'||!a.admission.historical)reasons.push('SOURCE_ADMIN_TRANSITION_AUTHORITY_REQUIRED');
  }
  if(action==='CONFIRM'&&ledger?.state==='Confirmed'){
   if(['motherVessel','lighterVessel','escortMobile','startDate','shift'].every(k=>String(target?.[k]??'')===String(({escortMobile:f.employeeMobile??f.escortMobile,startDate:f.assignmentDate} as Record<string,string>)[k]??f[k]??'')))action='ADD_EVIDENCE';
   else reasons.push('CONFIRMATION_CORRECTION_REVIEW');
  }
  if(!reasons.length){
   const reviewId=String(ledger?.primaryReviewId??row.id),references=[src.id];
   const context:ProgramCommandContext={reviewId,reviewVersion:1,sourceOccurrenceId:src.id,sourceRevision:1,sourceHash:src.sourceHash,sourceReferences:references,accountId:src.accountId,chatJid:target?String((ledger?.scope as {chatJid:string}).chatJid):src.chatJid,actorId,epoch:s.epoch,fields:f,employee:null,expectedProgramVersion:Number(target?.revision??0),historySource:{sourceRef:src.id,operationId:a.operationId,actorRef:a.admission.actorRef!,role:a.admission.role as 'CLIENT'|'ADMIN',historical:a.admission.historical,bindingRefs:a.admission.bindingRefs},command:{action,programId,reason:'Source-linked stored history '+a.operationId}};
   if(!target)context.allocation={clientPersonId:a.subjectRef,clientId:clientId!,clientVersion:1,senderJid:src.senderRef,participantJid:null,nativeMessageId:src.messageId,sourceTimestamp:src.sourceTime,orderKey:a.operationId,startLine:a.blockOrder,rawMother:f.motherVessel??'',rawLighter:f.lighterVessel??''};
   if(['CANCEL','CORRECT','RESTART','REPLACE','START_DUTY','ASSIGN'].includes(action)){
    const kinds:Record<string,string>={CANCEL:'PROGRAM_CANCELLATION',CORRECT:'PROGRAM_CORRECTION',RESTART:'PROGRAM_RESTART',REPLACE:'ESCORT_REPLACEMENT',START_DUTY:'DUTY_START',ASSIGN:'NEW_ASSIGNMENT'};
    const effectiveDate=action==='START_DUTY'?f.actualStartDate:f.effectiveDate;
    const mobile=action==='REPLACE'?f.newEmployeeId:f.employeeMobile??f.escortMobile??String(ledger?.employeeId??'');
    if(action==='REPLACE'&&(f.oldEmployeeId!==ledger?.employeeId||!f.newEmployeeId))reasons.push('REPLACEMENT_PREDECESSOR_REQUIRED');
    context.fields={...f,employeeId:mobile,escortMobile:mobile,dutyStart:f.assignmentDate??effectiveDate??''};
    context.command={...context.command,effectiveDate};
    context.support={reviewId:row.id,reviewVersion:1,reference:src.id,sourceHash:src.sourceHash,accountId:src.accountId,chatJid:src.chatJid,senderJid:src.senderRef,kind:kinds[action],effectiveDate:effectiveDate??'',employeeId:mobile,endShift:null,releasePoint:null};
   }
   if(action==='RELEASE'){context.command={...context.command,effectiveDate:f.releaseDate,endShift:f.endShift as 'D'|'N',releasePoint:f.releasePoint};context.support={reviewId:row.id,reviewVersion:1,reference:src.id,sourceHash:src.sourceHash,accountId:src.accountId,chatJid:src.chatJid,senderJid:src.senderRef,kind:'PROGRAM_RELEASE',effectiveDate:f.releaseDate,employeeId:f.employeeMobile,endShift:f.endShift,releasePoint:f.releasePoint};}
   // Savepoint keeps a valid sibling if this business fact requires reconciliation.
   await client.query('SAVEPOINT source_business');
   try{if(reasons.length)throw new CandidateError(reasons[0],409);const preview=await canonicalProgramCommandBoundary.preview(client,context);await canonicalProgramCommandBoundary.execute(client,preview,row.id,src.sourceTime);outcome=action==='ALLOCATE_DRAFT'?'DRAFT':action==='CONFIRM'?'CONFIRMED':action==='RELEASE'?'RELEASED':'EVIDENCE';}
   catch(e){await client.query('ROLLBACK TO SAVEPOINT source_business');if(!(e instanceof CandidateError))throw e;reasons.push(e.code);if(!target)programId=null;}
   finally{await client.query('RELEASE SAVEPOINT source_business');}
  }
 }
 if(!a.admission.historical)reasons.push('HISTORICAL_ROLE_NOT_ESTABLISHED');
 await link();
}
