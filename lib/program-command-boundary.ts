import {assertDeploymentDatabase,programLedgerAuthority} from '../candidates/identity-review/deployment-profile.ts';
import {z} from 'zod';
import {validDate} from './vessel-data.ts';
// The existing Program boundary now has an injected, qualification-only transaction path.
// No pool, credentials, HTTP provider, operational migration or startup activation is created.
import {blankProgram,validateProgram,norm,type Program} from './programs.ts';
import {normalizeEmployeeMobile,lifecycleTransition} from './employee-program-validation.mjs';
import {CandidateError,digest} from '../candidates/identity-review/contracts.ts';
import type {CandidateSqlClient} from '../candidates/identity-review/repository.ts';
export const programCommandSchema=z.object({
 action:z.enum(['ALLOCATE_DRAFT','CONFIRM','ADD_EVIDENCE','RESTART','REGISTER','ASSIGN','START_DUTY','COMPLETION_PENDING','RELEASE','CANCEL','REPLACE','CORRECT']),programId:z.union([z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),z.literal('')]).default(''),employeePersonId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),evidenceReviewId:z.string().regex(/^[a-f0-9]{64}$/).optional(),effectiveDate:z.string().max(10).optional(),endShift:z.enum(['D','N']).optional(),releasePoint:z.string().trim().min(1).max(200).optional(),reason:z.string().trim().min(1).max(2000)
}).strict().refine(v=>v.action==='ALLOCATE_DRAFT'||!!v.programId,{message:'Program reference required'});
export type ProgramCommand=z.infer<typeof programCommandSchema>;
export type ProgramCommandContext={historySource?:{sourceRef:string;operationId:string;actorRef:string;role:'CLIENT'|'ADMIN';historical:boolean;bindingRefs:string[]};reviewId:string;reviewVersion:number;sourceOccurrenceId:string;sourceRevision:number;sourceHash:string;sourceReferences:string[];accountId:string;chatJid:string;actorId:string;epoch:number;fields:Record<string,unknown>;employee:{personId:string;employeeId:string;name:string;version:number}|null;allocation?:{clientPersonId:string;clientId:string;clientVersion:number;senderJid:string;participantJid:string|null;nativeMessageId:string;sourceTimestamp:string;orderKey:string;startLine:number;rawMother:string;rawLighter:string};support?:{reviewId:string;reviewVersion:number;reference:string;sourceHash:string;accountId:string;chatJid:string;senderJid:string;kind:string;effectiveDate:string;employeeId:string|null;endShift:string|null;releasePoint:string|null};expectedProgramVersion:number;command:ProgramCommand};
type ProgramLedger={schemaVersion:'alrifai-program-command-v1';authority:'ALRIFAI_OPERATIONAL_QUALIFICATION_ONLY'|'ALRIFAI_OPERATIONAL';scope:{accountId:string;chatJid:string};state:string;primaryReviewId:string|null;sourceOccurrenceId?:string;employeeId:string|null;allocation?:ProgramCommandContext['allocation'];employeePersonId?:string|null;dutyStartedOn?:string|null;completionPendingOn?:string|null;releasedOn?:string|null;events:Array<Record<string,unknown>>};
export type ProgramPreview={context:ProgramCommandContext;before:Program;after:Program;previousState:string;nextState:string;programHash:string;approvalDigest:string;ledger:ProgramLedger};
export type ProgramCommandBoundary={preview:(client:CandidateSqlClient,context:ProgramCommandContext)=>Promise<ProgramPreview>;execute:(client:CandidateSqlClient,preview:ProgramPreview,receiptId:string,approvedAt:string)=>Promise<Record<string,unknown>>};
const legacyCommandTransition=lifecycleTransition as unknown as (state:string,event:string,guards:Record<string,unknown>)=>{allowed:boolean;state:string};
const commandVersion='alrifai-program-command-v1';
const commandDate=(value:string)=>!!value&&validDate(value);
function denied(code:string):never{throw new CandidateError(code,409);}
export async function previewCanonicalProgramCommand(client:CandidateSqlClient,context:ProgramCommandContext):Promise<ProgramPreview>{
 if(!await assertDeploymentDatabase(client)){const db=await client.query('SELECT current_database() AS database');if(!/^alrifai_identity_qualification_[a-z0-9_]+$/.test(String(db.rows[0]?.database)))throw new CandidateError('QUALIFICATION_DATABASE_REQUIRED',503);}
 const command=programCommandSchema.parse(context.command);
 const found=await client.query("SELECT id, octet_length(row_to_json(p)::text)>64000 AS oversized, CASE WHEN octet_length(row_to_json(p)::text)<=64000 THEN row_to_json(p) ELSE NULL END AS record FROM public.programs p WHERE id=$1 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->'scope'->>'accountId'=$2 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->'scope'->>'chatJid'=$3 FOR UPDATE",[command.programId,context.accountId,context.chatJid]);
 if(found.rows[0]?.oversized)throw new CandidateError('PROGRAM_COMMAND_BUDGET',503);let before=found.rows[0]?.record as Program|undefined;
 const allocating=command.action==='ALLOCATE_DRAFT';
 if(allocating){
  if(!context.allocation||context.employee||context.support||command.employeePersonId||command.effectiveDate||command.evidenceReviewId||command.endShift||command.releasePoint)denied('DRAFT_ALLOCATION_CONTEXT_REQUIRED');
  if(before)denied('PROGRAM_REFERENCE_RECONCILIATION_REQUIRED');
  if(context.expectedProgramVersion!==0)denied('PROGRAM_VERSION_CONFLICT');
  // Names never establish business identity. A matching vessel pair is only a Review condition.
  const collision=await client.query("SELECT EXISTS(SELECT 1 FROM public.programs WHERE id=$1 OR (coalesce((CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->'scope'->>'accountId',(CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->>'accountId')=$2 AND coalesce((CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->'scope'->>'chatJid',(CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->>'chatJid')=$3 AND lower(regexp_replace(\"motherVessel\",'[^[:alnum:]]','','g'))=ANY($4::text[]) AND lower(regexp_replace(\"lighterVessel\",'[^[:alnum:]]','','g'))=ANY($5::text[]))) AS present",[command.programId,context.accountId,context.chatJid,[norm(String(context.fields.motherVessel)),'mv'+norm(String(context.fields.motherVessel))],[norm(String(context.fields.lighterVessel)),'mv'+norm(String(context.fields.lighterVessel))]]);
  if(collision.rows[0]?.present)denied('PROGRAM_REFERENCE_RECONCILIATION_REQUIRED');
  before={...blankProgram(),id:command.programId,status:'Draft',source:'Native approved Escort order',createdAt:context.allocation.sourceTimestamp,details:{}};
 }
 if(!before)denied('PROGRAM_REFERENCE_REQUIRED');
 if(before.revision!==context.expectedProgramVersion)denied('PROGRAM_VERSION_CONFLICT');
 let details:Record<string,unknown>;try{details=typeof before.details==='string'?JSON.parse(before.details):structuredClone(before.details??{});}catch{denied('PROGRAM_REFERENCE_UNVERIFIED');}
 const ledger=(allocating?{schemaVersion:commandVersion,authority:programLedgerAuthority(),scope:{accountId:context.accountId,chatJid:context.chatJid},state:'Draft',primaryReviewId:context.reviewId,sourceOccurrenceId:context.sourceOccurrenceId,employeeId:null,allocation:context.allocation,events:[]}:structuredClone(details.programCommand)) as ProgramLedger;
 if(!ledger||ledger.schemaVersion!==commandVersion||ledger.authority!==programLedgerAuthority())denied('PROGRAM_REFERENCE_UNVERIFIED');
 if(ledger.scope.accountId!==context.accountId||ledger.scope.chatJid!==context.chatJid)throw new CandidateError('PROGRAM_SCOPE_DENIED',403);
 if(!Array.isArray(ledger.events)||ledger.events.length>=128)throw new CandidateError('PROGRAM_COMMAND_BUDGET',503);
 if(!context.historySource&&ledger.primaryReviewId&&ledger.primaryReviewId!==context.reviewId)denied('PROGRAM_DRAFT_LINK_CONFLICT');
 if(context.sourceReferences.length<1||context.sourceReferences.length>20||!context.sourceHash)denied('SOURCE_REFERENCE_REQUIRED');
 const previousState=ledger.state;let nextState=previousState;const field=(name:string)=>typeof context.fields[name]==='string'?String(context.fields[name]):'';
 const phase=(from:string[],to:string)=>{if(!from.includes(previousState))denied('LIFECYCLE_STATE_CONFLICT');nextState=to;};
 const proof=(kind:string)=>{const s=context.support;if(!s||s.kind!==kind||s.effectiveDate!==command.effectiveDate||!commandDate(s.effectiveDate))denied('STAGE_EVIDENCE_REQUIRED');return s;};
 let after:Program={...structuredClone(before),revision:before.revision+1};
 if(command.action==='ALLOCATE_DRAFT'){
  phase(['Draft'],'Draft');
  if(!field('motherVessel')&&!field('lighterVessel'))denied('PROGRAM_FIELDS_INCOMPLETE');
  after={...after,motherVessel:field('motherVessel'),lighterVessel:field('lighterVessel'),masterMobile:field('masterMobile'),destination:field('destination'),escortName:'',escortMobile:'',startDate:field('startDate')||field('assignmentDate'),endDate:'',shift:field('shift')};
 }else if(command.action==='ADD_EVIDENCE'){
  if(!context.historySource)denied('SOURCE_REFERENCE_REQUIRED');
 }else if(command.action==='CONFIRM'){
  const h=context.historySource;
  if(!h||h.role!=='ADMIN'||!h.historical||!h.bindingRefs.length)denied('HISTORICAL_ADMIN_AUTHORITY_REQUIRED');
  phase(['Draft'],'Confirmed');
  const employeeId=normalizeEmployeeMobile(field('employeeMobile')||field('escortMobile'),'employee_id');
  if(!field('motherVessel')||!field('lighterVessel')||!field('escortName')||!employeeId||!commandDate(field('assignmentDate'))||!['D','N'].includes(field('shift')))denied('CONFIRMATION_FIELDS_INCOMPLETE');
  if(before.motherVessel&&norm(before.motherVessel)!==norm(field('motherVessel'))||before.lighterVessel&&norm(before.lighterVessel)!==norm(field('lighterVessel')))denied('WRONG_PROGRAM_VESSEL_REFERENCE');
  after={...after,motherVessel:field('motherVessel'),lighterVessel:field('lighterVessel'),masterMobile:field('masterMobile')||before.masterMobile,destination:field('destination')||before.destination,escortName:field('escortName'),escortMobile:employeeId,startDate:field('assignmentDate'),shift:field('shift')};
  ledger.employeeId=employeeId; // Source-role mobile, no invented verified Person/employment.
 }else if(command.action==='RESTART'){
  if(!context.historySource||context.historySource.role!=='ADMIN'||!context.historySource.historical)denied('HISTORICAL_ADMIN_AUTHORITY_REQUIRED');
  phase(['Cancelled'],'Draft');proof('PROGRAM_RESTART');
  ledger.employeeId=null;ledger.employeePersonId=null;ledger.dutyStartedOn=null;ledger.completionPendingOn=null;ledger.releasedOn=null;
  after={...after,escortMobile:'',escortName:'',startDate:'',endDate:'',shift:''};
  const mobile=normalizeEmployeeMobile(field('employeeMobile')||field('escortMobile'),'employee_id');
  if(mobile&&field('escortName')&&field('motherVessel')&&field('lighterVessel')&&commandDate(field('assignmentDate'))&&['D','N'].includes(field('shift'))){nextState='Confirmed';ledger.employeeId=mobile;after={...after,escortMobile:mobile,escortName:field('escortName'),motherVessel:field('motherVessel'),lighterVessel:field('lighterVessel'),startDate:field('assignmentDate'),shift:field('shift')};}
 }else if(command.action==='REGISTER'){
  phase(['Draft'],'Unassigned');
  if(!field('motherVessel')||!field('lighterVessel'))denied('PROGRAM_FIELDS_INCOMPLETE');
  if(norm(before.motherVessel)!==norm(field('motherVessel'))||norm(before.lighterVessel)!==norm(field('lighterVessel')))denied('WRONG_PROGRAM_VESSEL_REFERENCE');
  const duplicate=await client.query("SELECT EXISTS(SELECT 1 FROM public.programs WHERE id<>$1 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->>'primaryReviewId'=$2) AS present",[before.id,context.reviewId]);if(duplicate.rows[0]?.present)denied('SOURCE_ALREADY_REGISTERED');
  ledger.primaryReviewId=context.reviewId;ledger.sourceOccurrenceId=context.sourceOccurrenceId;
  after={...after,...Object.fromEntries(['motherVessel','lighterVessel','masterMobile','destination'].map(k=>[k,field(k)])),escortName:'',escortMobile:'',startDate:'',shift:'',endDate:''};
 }else if(command.action==='ASSIGN'||command.action==='REPLACE'){
  phase(command.action==='ASSIGN'?['Unassigned']:(context.historySource?['Confirmed','Assigned','In Duty']:['Assigned','In Duty']),'Assigned');
  if(norm(before.motherVessel)!==norm(field('motherVessel'))||norm(before.lighterVessel)!==norm(field('lighterVessel')))denied('WRONG_PROGRAM_VESSEL_REFERENCE');
  const employee=context.employee??(context.historySource?.role==='ADMIN'&&context.historySource.historical?{personId:'',employeeId:normalizeEmployeeMobile(field('employeeId')||field('escortMobile'),'employee_id'),name:field('escortName'),version:1}:null);if(!employee||!employee.employeeId||normalizeEmployeeMobile(field('employeeId')||field('escortMobile'),'employee_id')!==employee.employeeId)denied('EMPLOYEE_ID_REFERENCE_CONFLICT');
  if(!field('escortName')||!commandDate(field('dutyStart'))||!['D','N'].includes(field('shift'))||!commandDate(command.effectiveDate??'')||command.effectiveDate!==field('dutyStart'))denied('ASSIGNMENT_FIELDS_INCOMPLETE');
  if(command.action==='REPLACE'&&employee.employeeId===ledger.employeeId)denied('REPLACEMENT_EMPLOYEE_UNCHANGED');
  if(command.action==='REPLACE'){const s=proof('ESCORT_REPLACEMENT');if(s.employeeId!==employee.employeeId)denied('REPLACEMENT_EMPLOYEE_CONFLICT');if(ledger.dutyStartedOn&&s.effectiveDate<ledger.dutyStartedOn)denied('CHRONOLOGY_CONFLICT');}
  const busy=await client.query("SELECT EXISTS(SELECT 1 FROM public.programs WHERE id<>$1 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->>'schemaVersion'=$2 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->>'employeeId'=$3 AND (CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand'->>'state' IN ('Assigned','In Duty','Completion Pending')) AS present",[before.id,commandVersion,employee.employeeId]);if(busy.rows[0]?.present)denied('EMPLOYEE_CLOSURE_REVIEW_REQUIRED');
  // Unreconciled legacy open labels are a closure-review condition, never proof of duty.
  // EXISTS returns no private row/body; Bengali/local/international spellings match the same employee.
  const legacyBusy=await client.query("SELECT EXISTS(SELECT 1 FROM public.programs WHERE id<>$1 AND ((CASE WHEN pg_input_is_valid(details,'jsonb') THEN details::jsonb ELSE '{}'::jsonb END)->'programCommand') IS NULL AND status IN ('Active','Assigned','In Duty','Completion Pending') AND regexp_replace(translate(coalesce(\"escortMobile\",''),'০১২৩৪৫৬৭৮৯','0123456789'),'[^0-9]','','g') = ANY($2::text[])) AS present",[before.id,[employee.employeeId.replace(/\D/g,''),...(employee.employeeId.startsWith('+880')?['0'+employee.employeeId.slice(4)]:[])]]);if(legacyBusy.rows[0]?.present)denied('EMPLOYEE_CLOSURE_REVIEW_REQUIRED');
  const legacy=legacyCommandTransition(command.action==='ASSIGN'?'confirmed':'assigned',command.action==='ASSIGN'?'NEW_ASSIGNMENT':'ESCORT_REPLACEMENT',{role:'admin',linked:true,effectiveDate:command.effectiveDate,assignmentVerified:true,replacementVerified:true});if(!legacy.allowed)denied('LIFECYCLE_EVIDENCE_UNVERIFIED');
  after={...after,escortMobile:employee.employeeId,escortName:field('escortName'),startDate:field('dutyStart'),shift:field('shift')};ledger.employeeId=employee.employeeId;ledger.employeePersonId=employee.personId||null;if(command.action==='REPLACE'){ledger.dutyStartedOn=null;ledger.completionPendingOn=null;ledger.releasedOn=null;}
 }else if(command.action==='START_DUTY'){
  phase(context.historySource?['Confirmed','Assigned']:['Assigned'],'In Duty');const s=proof('DUTY_START');if(s.employeeId!==ledger.employeeId||s.effectiveDate<before.startDate)denied('DUTY_IDENTITY_OR_DATE_CONFLICT');ledger.dutyStartedOn=s.effectiveDate;
 }else if(command.action==='COMPLETION_PENDING'){
  phase(['In Duty'],'Completion Pending');const s=proof('COMPLETION_PENDING');if(s.employeeId!==ledger.employeeId||!ledger.dutyStartedOn||s.effectiveDate<ledger.dutyStartedOn)denied('COMPLETION_IDENTITY_OR_DATE_CONFLICT');ledger.completionPendingOn=s.effectiveDate;
 }else if(command.action==='RELEASE'){
  phase(context.historySource?['In Duty','Completion Pending']:['Completion Pending'],'Released');const s=proof('PROGRAM_RELEASE');if(s.employeeId!==ledger.employeeId||!(context.historySource?ledger.dutyStartedOn:ledger.completionPendingOn)||s.effectiveDate<(context.historySource?ledger.dutyStartedOn!:ledger.completionPendingOn!)||s.endShift!==command.endShift||s.releasePoint!==command.releasePoint)denied('RELEASE_EVIDENCE_CONFLICT');
  const legacy=legacyCommandTransition('active','PROGRAM_RELEASE',{role:'admin',linked:true,effectiveDate:s.effectiveDate,releaseVerified:true});if(!legacy.allowed)denied('RELEASE_EVIDENCE_CONFLICT');ledger.releasedOn=s.effectiveDate;after.endDate=s.effectiveDate;details.endShift=s.endShift;details.releasePoint=s.releasePoint;details.releaseConfirmed=true;
 }else if(command.action==='CANCEL'){
  phase(['Draft','Confirmed','Unassigned','Assigned','In Duty','Completion Pending'],'Cancelled');const s=proof('PROGRAM_CANCELLATION');if(ledger.employeeId&&s.employeeId!==ledger.employeeId)denied('CANCELLATION_EMPLOYEE_CONFLICT');if(ledger.dutyStartedOn&&s.effectiveDate<ledger.dutyStartedOn)denied('CHRONOLOGY_CONFLICT');
 }else if(command.action==='CORRECT'){
  if(['Released','Cancelled'].includes(previousState))denied('CORRECTION_TERMINAL_STATE');proof('PROGRAM_CORRECTION');
  if((field('employeeId')||field('escortMobile'))&&normalizeEmployeeMobile(field('employeeId')||field('escortMobile'),'employee_id')!==ledger.employeeId)denied('CORRECTION_CANNOT_REBIND_EMPLOYEE');
  const allowed=['motherVessel','lighterVessel','masterMobile','destination','escortName'];for(const k of allowed)if(field(k))after[k as keyof Pick<Program,'motherVessel'|'lighterVessel'|'masterMobile'|'destination'|'escortName'>]=field(k);
 }
 // Reuse established field/date/phone limits. New lifecycle states stay explicit outside its historical enum.
 const checked=validateProgram({...after,status:'Recorded',details:{}});after={...after,...Object.fromEntries(['motherVessel','lighterVessel','masterMobile','destination','escortName','escortMobile','startDate','endDate','shift'].map(k=>[k,checked[k as keyof Program]])),status:nextState};ledger.state=nextState;
 details.programCommand=ledger;after.details=details as unknown as Program['details'];
 const programHash=digest(before),payload={context,before,after,previousState,nextState,programHash,ledger};return {...payload,approvalDigest:digest(payload)};
}
export async function executeCanonicalProgramCommand(client:CandidateSqlClient,preview:ProgramPreview,receiptId:string,approvedAt:string){
 const latest=await previewCanonicalProgramCommand(client,preview.context);if(latest.approvalDigest!==preview.approvalDigest)denied('APPROVED_PROGRAM_CONTEXT_CHANGED');
 const {context,before,after,ledger,previousState,nextState}=latest;
 const event={id:receiptId,command:context.command,approvalActor:context.actorId,approvedAt,reviewId:context.reviewId,reviewVersion:context.reviewVersion,authorizationVersion:context.epoch,sourceOccurrenceId:context.sourceOccurrenceId,sourceRevision:context.sourceRevision,sourceHash:context.sourceHash,sourceReferences:context.sourceReferences,historySource:context.historySource??null,support:context.support??null,previousState,nextState,previousVersion:before.revision,newVersion:after.revision,previousHash:digest(before),fields:context.fields,employee:context.employee};
 ledger.events.push(event);after.details={...after.details,programCommand:ledger} as unknown as Program['details'];if(Buffer.byteLength(JSON.stringify(after))>64000)throw new CandidateError('PROGRAM_COMMAND_BUDGET',503);
 const columns=['motherVessel','lighterVessel','masterMobile','destination','escortName','escortMobile','startDate','endDate','shift','status','details','revision'] as const;
 const update=context.command.action==='ALLOCATE_DRAFT'?await client.query('INSERT INTO public.programs (id,'+columns.map(c=>'\"'+c+'\"').join(',')+',source,notes,\"duplicateOf\",\"createdAt\") VALUES ('+Array.from({length:17},(_,i)=>'$'+(i+1)).join(',')+') ON CONFLICT (id) DO NOTHING RETURNING *',[after.id,...columns.map(c=>c==='details'?JSON.stringify(after.details):after[c]),after.source,after.notes,after.duplicateOf,after.createdAt]):await client.query('UPDATE public.programs SET '+columns.map((c,i)=>'"'+c+'"=$'+(i+1)).join(',')+' WHERE id=$13 AND revision=$14 RETURNING *',[...columns.map(c=>c==='details'?JSON.stringify(after.details):after[c]),before.id,before.revision]);if(update.rows.length!==1)denied('PROGRAM_VERSION_CONFLICT');if(Buffer.byteLength(JSON.stringify(update.rows[0]))>64000)throw new CandidateError('PROGRAM_COMMAND_BUDGET',503);
 if(context.historySource&&after.escortMobile&&after.startDate&&['CONFIRM','RESTART','ASSIGN','START_DUTY','RELEASE','REPLACE'].includes(context.command.action)){
  const prior=await client.query('SELECT id FROM public.program_assignments WHERE program_id=$1 ORDER BY revision DESC LIMIT 1',[after.id]);
  await client.query('INSERT INTO public.program_assignments(id,scope_account,program_id,revision,employee_mobile,employee_person_id,start_date,start_shift,duty_started_on,released_on,predecessor_id,command_receipt,source_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)',[receiptId,context.accountId,after.id,after.revision,after.escortMobile,ledger.employeePersonId??null,after.startDate,after.shift,ledger.dutyStartedOn??null,ledger.releasedOn??null,prior.rows[0]?.id??null,receiptId,JSON.stringify(context.sourceReferences)]);
 }
 return {receiptId,programId:before.id,previousState,nextState,previousVersion:before.revision,newVersion:after.revision,employeeId:ledger.employeeId,approvalDigest:preview.approvalDigest,sourceReferences:context.sourceReferences,financialPostings:0,WhatsAppSends:0,previousHash:digest(before),newHash:digest(update.rows[0])};
}
export const canonicalProgramCommandBoundary:ProgramCommandBoundary={preview:previewCanonicalProgramCommand,execute:executeCanonicalProgramCommand};
