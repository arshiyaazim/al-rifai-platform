import {deploymentProfile,programLedgerAuthority} from './deployment-profile.ts';
import {normalizeEmployeeMobile} from '../../lib/employee-program-validation.mjs';
import {readFileSync,statSync} from 'node:fs';
import type pg from 'pg';
import {CandidateError,digest} from './contracts.ts';
export type RosterRequest={accountId:string;chatJid:string;employeeId:string;sourceReference:string;fields:Record<string,unknown>;transaction?:import('./repository.ts').CandidateSqlClient};
export type RosterContextReader=(request:RosterRequest)=>Promise<Record<string,unknown>[]>;
/** Fixed qualification host only. Trusted provenance is separate from message names/claims.
 * Query admission happens before materializing programs, using exact account/chat/mobile pins.
 * No historicalSnapshot(), seed, ambient DB URL, unscoped scan, provider or write fallback. */
export function qualificationRosterReader(pool:pg.Pool,project?:typeof import('../../lib/vessel-source').buildHistoricalRoster):RosterContextReader{
 return async input=>{
  if(statSync(deploymentProfile()?.rosterScope??'/qualification/disposable/roster-scope.json').size>32000)throw new CandidateError('ROSTER_SCOPE_BUDGET',503);
  const bytes=readFileSync(deploymentProfile()?.rosterScope??'/qualification/disposable/roster-scope.json');
  if(bytes.length>32000)throw new CandidateError('ROSTER_SCOPE_BUDGET',503);
  const bindings=JSON.parse(bytes.toString()) as Array<{id:string;accountId:string;chatJid:string;employeeId:string}>;
  if(!Array.isArray(bindings)||bindings.length>200||bindings.some(b=>!b||typeof b.id!=='string'||b.id.length>128||!/^wa-0[12]$/.test(b.accountId)||typeof b.chatJid!=='string'||!/^\+8801[3-9][0-9]{8}$/.test(b.employeeId))||new Set(bindings.map(b=>b.id)).size!==bindings.length)throw new CandidateError('ROSTER_PROVENANCE_INVALID',503);
  const admitted=bindings.filter(b=>b.accountId===input.accountId&&b.chatJid===input.chatJid&&b.employeeId===input.employeeId);
  if(admitted.length>50)throw new CandidateError('ROSTER_CONTEXT_BUDGET',503);
  const legacyQuery={text:'SELECT id, octet_length(row_to_json(p)::text)>64000 AS oversized, CASE WHEN octet_length(row_to_json(p)::text)<=64000 THEN row_to_json(p) ELSE NULL END AS record FROM public.programs p WHERE id = ANY($1::text[]) ORDER BY id LIMIT 51',values:[admitted.map(b=>b.id)]};
  const result=input.transaction?await input.transaction.query(legacyQuery.text,legacyQuery.values):await pool.query(legacyQuery);
  if(result.rows.length>50||result.rows.some(r=>r.oversized))throw new CandidateError('ROSTER_CONTEXT_BUDGET',503);
  const stored=result.rows.map(r=>{const pin=admitted.find(b=>b.id===r.id)!;const v=r.record as Record<string,unknown>;let details:Record<string,unknown>;try{details=typeof v.details==='string'?JSON.parse(v.details):v.details as Record<string,unknown>;}catch{throw new CandidateError('ROSTER_PROVENANCE_INVALID',503);}
   if(!details||details.accountId!==pin.accountId||details.chatJid!==pin.chatJid||normalizeEmployeeMobile(v.escortMobile,'escortMobile')!==pin.employeeId)throw new CandidateError('ROSTER_PROVENANCE_CHANGED',409);
   return {...v,accountId:pin.accountId,chatJid:pin.chatJid};});
  const fields=input.fields;
  const source={id:'review-'+digest(input.sourceReference).slice(0,24),accountId:input.accountId,chatJid:input.chatJid,employee_id:input.employeeId,sourceRole:'employee_id',escortName:typeof fields.escortName==='string'?fields.escortName:'',motherVessel:fields.motherVessel??'',lighterVessel:fields.lighterVessel??'',startDate:fields.dutyStart??'',shift:fields.shift??'',status:'Review',source:'Verified registry identity / native review reference',details:{sourceMessageId:input.sourceReference,identityBasis:'VERIFIED_REGISTRY_EMPLOYEE_REFERENCE'}};
  const buildHistoricalRoster=project??(await import('../../lib/vessel-source')).buildHistoricalRoster;
  const rows=buildHistoricalRoster(stored,[source],{scope:{accountId:input.accountId,chatJids:[input.chatJid],employeeIds:[input.employeeId]}});
  // Deliberate DTO allowlist: no arbitrary trace fields, notes, contact/payout or quoted bodies.
  return rows.map(r=>({id:r.id,employeeId:r.employeeId,name:r.escortName,aliases:r.employeeIdentity?.aliases??[],motherVessel:r.motherVessel,lighterVessel:r.lighterVessel,startDate:r.startDate,shift:r.shift,status:r.status,releaseConfirmed:false,authority:r.roster?.authority,resolution:r.roster?.state,reviewRequired:r.roster?.reviewRequired,candidateTargetIds:r.roster?.candidateTargetIds,issues:r.issues,sourceEvidence:r.roster?.history.map(h=>({id:h.id,origin:h.origin,sourceRef:h.sourceRef,sourceHash:h.sourceHash,sourceLine:h.sourceLine,rawName:h.rawName,rawMobile:h.rawMobile,employeeId:h.employeeId,originalStatus:h.originalStatus,revision:h.revision,reason:h.reason}))}));
 };
}

/** Passive projection of the SAME canonical row and immutable command receipts. No writer. */
export async function committedRosterProjection(tx:import('./repository.ts').CandidateSqlClient,s:import('./repository.ts').CandidateState,scope:{accountId:string;chatJid:string;programIds:string[]}){
 if(scope.programIds.length>50)throw new CandidateError('ROSTER_CONTEXT_BUDGET',503);
 const found=await tx.query("SELECT id, octet_length(row_to_json(p)::text)>64000 AS oversized, CASE WHEN octet_length(row_to_json(p)::text)<=64000 THEN row_to_json(p) ELSE NULL END AS record FROM public.programs p WHERE id=ANY($1::text[]) AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->'scope'->>'accountId'=$2 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->'scope'->>'chatJid'=$3 ORDER BY id LIMIT 51 FOR SHARE",[scope.programIds,scope.accountId,scope.chatJid]);
 if(found.rows.length!==scope.programIds.length)throw new CandidateError('ROSTER_PROVENANCE_CHANGED',409);
 const output:Record<string,unknown>[]=[];
 for(const item of found.rows){
  if(item.oversized)throw new CandidateError('ROSTER_CONTEXT_BUDGET',503);
  const row=item.record as Record<string,unknown>,details=JSON.parse(String(row.details)),l=details.programCommand;
  const history:Record<string,unknown>[]=[],receipts:Record<string,unknown>[]=[],assignments:Record<string,unknown>[]=[],aliases:Array<{name:string;employeeId:string;sourceReference:unknown}> = [];const issues:string[]=[];
  let state='Draft',employeeId:string|null=null,employeePersonId:string|null=null,duty:string|null=null,pending:string|null=null;
  try{
   if(l.schemaVersion!=='alrifai-program-command-v1'||l.authority!==programLedgerAuthority()||!Array.isArray(l.events)||l.events.length>128||l.events.length!==row.revision)throw Error('VERSION_HISTORY_CONFLICT');
   let previousHash:string|null=null;
   for(const [i,e] of l.events.entries()){
    const receipt=s.operations[e.id]?.result as Record<string,unknown>|undefined;const approval=receipt?s.operations[String(receipt.approvalId)]?.result as {kind:string;actorId:string;approvedAt:string;preview:import('../../lib/program-command-boundary.ts').ProgramPreview}|undefined:undefined;
    if(!receipt||!approval||approval.kind!=='EXPLICIT_PROGRAM_APPROVAL'||receipt.programId!==row.id||receipt.receiptId!==e.id||receipt.newVersion!==i+1||receipt.previousVersion!==i||e.newVersion!==i+1||e.previousVersion!==i||receipt.previousState!==state||e.previousState!==state||receipt.nextState!==e.nextState||receipt.previousHash!==e.previousHash||previousHash&&receipt.previousHash!==previousHash||receipt.approvingAdmin!==approval.actorId||e.approvalActor!==approval.actorId||e.approvedAt!==approval.approvedAt||receipt.approvalDigest!==approval.preview.approvalDigest||digest(e.fields)!==digest(approval.preview.context.fields)||digest(e.employee)!==digest(approval.preview.context.employee)||digest(e.command)!==digest(approval.preview.context.command)||e.reviewId!==approval.preview.context.reviewId||e.reviewId!==l.primaryReviewId||e.sourceOccurrenceId!==approval.preview.context.sourceOccurrenceId||e.sourceHash!==approval.preview.context.sourceHash||digest(e.sourceReferences)!==digest(approval.preview.context.sourceReferences)||digest(e.support??null)!==digest(approval.preview.context.support??null))throw Error('COMMAND_RECEIPT_CONFLICT');
    const action=e.command.action as string;let next=state;
    const person=e.employee as {personId:string;employeeId:string}|null;
    const proof=(kind:string)=>{if(e.support?.kind!==kind||e.support.effectiveDate!==e.command.effectiveDate||!/^\d{4}-\d\d-\d\d$/.test(e.command.effectiveDate??''))throw Error('STAGE_PROOF_CONFLICT');};
    if(action==='ALLOCATE_DRAFT'){if(i!==0||state!=='Draft'||person||!approval.preview.context.allocation||digest(l.allocation)!==digest(approval.preview.context.allocation)||row.id!==e.command.programId)throw Error('ALLOCATION_PROVENANCE_CONFLICT');next='Draft';}
    else if(action==='REGISTER'){if(state!=='Draft')throw Error('LIFECYCLE_CONFLICT');next='Unassigned';}
    else if(action==='ASSIGN'||action==='REPLACE'){
     if(!person||normalizeEmployeeMobile(person.employeeId,'employee_id')!==person.employeeId||normalizeEmployeeMobile(e.fields.employeeId||e.fields.escortMobile,'employee_id')!==person.employeeId)throw Error('EMPLOYEE_REFERENCE_CONFLICT');
     if(action==='ASSIGN'&&state!=='Unassigned'||action==='REPLACE'&&!['Assigned','In Duty'].includes(state))throw Error('LIFECYCLE_CONFLICT');
     if(action==='REPLACE'){proof('ESCORT_REPLACEMENT');if(person.employeeId===employeeId||e.support.employeeId!==person.employeeId)throw Error('REPLACEMENT_CONFLICT');if(assignments.length)assignments.at(-1)!.status='Replaced';}
     employeeId=person.employeeId;employeePersonId=person.personId;next='Assigned';duty=null;pending=null;assignments.push({assignmentReference:e.id,programId:row.id,employeeId,personId:employeePersonId,status:'Assigned',assignedOn:e.command.effectiveDate,sourceReferences:e.sourceReferences});
    }else if(action==='START_DUTY'){proof('DUTY_START');if(state!=='Assigned'||e.support.employeeId!==employeeId)throw Error('LIFECYCLE_CONFLICT');next='In Duty';duty=e.command.effectiveDate;assignments.at(-1)!.status=next;}
    else if(action==='COMPLETION_PENDING'){proof('COMPLETION_PENDING');if(state!=='In Duty'||e.support.employeeId!==employeeId||!duty||e.command.effectiveDate<duty)throw Error('LIFECYCLE_CONFLICT');next='Completion Pending';pending=e.command.effectiveDate;assignments.at(-1)!.status=next;}
    else if(action==='RELEASE'){proof('PROGRAM_RELEASE');if(state!=='Completion Pending'||e.support.employeeId!==employeeId||!pending||e.command.effectiveDate<pending||e.command.endShift!==e.support.endShift||e.command.releasePoint!==e.support.releasePoint)throw Error('LIFECYCLE_CONFLICT');next='Released';assignments.at(-1)!.status=next;}
    else if(action==='CANCEL'){proof('PROGRAM_CANCELLATION');if(['Released','Cancelled'].includes(state))throw Error('LIFECYCLE_CONFLICT');next='Cancelled';if(assignments.length)assignments.at(-1)!.status=next;}
    else if(action==='CORRECT'){proof('PROGRAM_CORRECTION');if(['Released','Cancelled'].includes(state))throw Error('LIFECYCLE_CONFLICT');}
    else throw Error('COMMAND_ACTION_CONFLICT');
    if(next!==e.nextState)throw Error('LIFECYCLE_CONFLICT');
    if(employeeId&&typeof e.fields.escortName==='string'&&e.fields.escortName)aliases.push({name:e.fields.escortName,employeeId,sourceReference:e.sourceReferences[0]});
    history.push({id:e.id,action,reason:e.command.reason,effectiveDate:e.command.effectiveDate??null,previousState:state,nextState:next,previousVersion:i,newVersion:i+1,approvingAdmin:e.approvalActor,approvedAt:e.approvedAt,employeeId,originalFields:{escortName:e.fields.escortName??null,employeeId:e.fields.employeeId??null},sourceReferences:e.sourceReferences,sourceHash:e.sourceHash,support:e.support??null});
    receipts.push({receiptId:receipt.receiptId,approvalId:receipt.approvalId,newVersion:receipt.newVersion,previousHash:receipt.previousHash,newHash:receipt.newHash,approvingAdmin:receipt.approvingAdmin});state=next;previousHash=String(receipt.newHash);
   }
   if(state!==l.state||state!==row.status||employeeId!==(l.employeeId??null)||employeeId!==(normalizeEmployeeMobile(row.escortMobile,'employee_id')??null)||l.events.length&&previousHash!==digest(row))throw Error('CANONICAL_STATE_CONFLICT');
  }catch(error){issues.push(error instanceof Error?error.message:'COMMITTED_HISTORY_CONFLICT');}
  const allIds=[...new Set(assignments.map(a=>String(a.employeeId)))];let legacyOpen=false,otherOpen=false;
  for(const mobile of allIds){
   const normal=[mobile.replace(/\D/g,''),'0'+mobile.slice(4)];
   const conflicts=await tx.query("SELECT EXISTS(SELECT 1 FROM public.programs WHERE id<>$1 AND ((CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand') IS NULL AND status IN ('Active','Assigned','In Duty','Completion Pending') AND regexp_replace(translate(coalesce(\"escortMobile\",''),'০১২৩৪৫৬৭৮৯','0123456789'),'[^0-9]','','g')=ANY($2::text[])) AS legacy, EXISTS(SELECT 1 FROM public.programs WHERE id<>$1 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->>'employeeId'=$3 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->>'state' IN ('Assigned','In Duty','Completion Pending')) AS current",[row.id,normal,mobile]);
   legacyOpen ||= conflicts.rows[0]?.legacy===true;otherOpen ||= ['Assigned','In Duty','Completion Pending'].includes(state)&&mobile===employeeId&&conflicts.rows[0]?.current===true;
  }
  if(legacyOpen)issues.push('LEGACY_OPEN_REFERENCE_REQUIRES_REVIEW');if(otherOpen)issues.push('OTHER_OPEN_ASSIGNMENT_REQUIRES_REVIEW');
  const integrity=issues.some(x=>!x.endsWith('_REQUIRES_REVIEW'));
  output.push({id:row.id,employeeId:integrity?null:employeeId,employeePersonId:integrity?null:employeePersonId,status:integrity?'Review':state,observedStatus:row.status,revision:row.revision,authority:integrity?'CONFLICT_REVIEW':history.length?'COMMITTED_CANONICAL_COMMAND':'QUALIFIED_DRAFT_REFERENCE',releaseConfirmed:!integrity&&state==='Released',financialCompletion:false,reviewRequired:issues.length>0,resolution:issues.length?'RECONCILIATION_REVIEW':history.length?'COMMITTED':'DRAFT_NOT_COMMITTED',issues,currentAssignment:!integrity&&['Assigned','In Duty','Completion Pending'].includes(state)?assignments.at(-1):null,assignments:integrity?[]:assignments,aliases:integrity?[]:aliases,commandHistory:integrity?[]:history,receipts:integrity?[]:receipts,orderProvenance:l.allocation??null,sourceEvidence:{primaryReviewId:l.primaryReviewId,accountId:scope.accountId,chatJid:scope.chatJid,rowHash:digest(row)},motherVessel:row.motherVessel,lighterVessel:row.lighterVessel});
 }
 return output;
}
