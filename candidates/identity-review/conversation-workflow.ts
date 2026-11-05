/** Inactive qualification adapter. No writer, provider, network, or send path. */
import {z} from 'zod';
import {CandidateError,digest,hash,normalizePhone,nativeEnvelopeSchema,bindingSchema} from './contracts.ts';
import {authenticate} from './auth.ts';
import {authorize,resolveIdentity} from './routing.ts';
import {parseEscortOrder} from '../../lib/escort-intake-candidate.mjs';
import {validDate} from '../../lib/employee-program-validation.mjs';
import type {CandidateState} from './repository.ts';
import type {Credentials} from './auth.ts';

const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const jid=z.string().regex(/^[A-Za-z0-9_.:+-]+@(s\.whatsapp\.net|lid|g\.us)$/);
const eventId=z.string().min(1).max(200);
const sourceSchema=z.object({channel:z.enum(['WHATSAPP','FRONTEND']),accountId:id,eventId,
 chatJid:jid,senderJid:jid.nullable(),direction:z.enum(['INCOMING','OUTGOING','SUBMITTED']),
 kind:z.enum(['MESSAGE','CALL','EDIT','REVOKE']),targetEventId:eventId.nullable(),
 at:z.string().datetime({offset:true}),observedAt:z.string().datetime({offset:true}),
 text:z.string().max(64000),senderPhone:z.string().max(80).nullable(),
 quotedEventId:eventId.nullable(),forwarded:z.boolean().nullable(),
 call:z.object({result:z.enum(['in_progress','answered','ended','missed','rejected','unknown']),
 endedAt:z.string().nullable(),reason:z.string().max(200).nullable()}).strict().nullable()}).strict();
export type ConversationSource=z.infer<typeof sourceSchema>;
type Source=ConversationSource;
export type Profile={personId:string;contactPhone:string|null;classification:string;clientId:string|null;
 serviceContexts?:Array<{service:'ESCORT'|'SECURITY_GUARD';clientId:string;evidenceRef:string}>;
 evidenceRefs:Array<{field:string;role:string;phone:string;evidenceRef:string}>};
type Context={id:string;personId:string;clientId:string|null;accountId:string;chatJid:string;
 domain:string;status:string;active:boolean;sourceEventId:string};
type Item={intent:string;domain:string;capability:string;authorization:unknown;workflow:string;
 clientId:string|null;linkedRecordId:string|null;fields:Record<string,unknown>;draft:string;outcome:string;reasons:string[]};
export type WorkflowState={profiles:Record<string,Profile>;context:Context[];
 receipts:Record<string,{source:Source;fingerprint:string;revision:number;epoch:number;outcome:unknown;history:unknown[];suppressed?:string}>};
export const emptyWorkflow=():WorkflowState=>({profiles:{},context:[],receipts:{}});
const routes:Record<string,{domain:string;capability:string;workflow:string}>={
 ESCORT:{domain:'ESCORT',capability:'escort.order.intake',workflow:'ESCORT_ORDER_REVIEW'},
 SECURITY_GUARD:{domain:'SECURITY_GUARD',capability:'security.order.intake',workflow:'SECURITY_SERVICE_REQUEST_REVIEW'},
 DUTY:{domain:'ATTENDANCE',capability:'employee.duty.intake',workflow:'DUTY_REVIEW'},
 RECRUITMENT:{domain:'RECRUITMENT',capability:'recruitment.intake',workflow:'RECRUITMENT_REVIEW'},
 ACCOUNTS:{domain:'ACCOUNTS',capability:'accounts.intake',workflow:'ACCOUNTS_REVIEW'},
 PERSONAL:{domain:'PERSONAL',capability:'personal.context',workflow:'PERSONAL_CONTEXT'},
};
export function detectIntents(text:string){
 const a:string[]=[];
 if(/escort|mother\s*vessel|lighter\s*vessel|\bm\/?v\b|এসকর্ট|স্কট/i.test(text))a.push('ESCORT');
 if(/security\s*guard|নিরাপত্তা|সিকিউরিটি|গার্ড/i.test(text))a.push('SECURITY_GUARD');
 if(/duty|attendance|হাজিরা|ডিউটি|উপস্থিত/i.test(text))a.push('DUTY');
 if(/applicant|application|recruit|job|চাকরি|আবেদন|নিয়োগ|নিয়োগ/i.test(text))a.push('RECRUITMENT');
 if(/\b(cash|payment|paid|bkash|nagad|accounts?|salary)\b|টাকা|বিকাশ|নগদ|হিসাব|বেতন/i.test(text))a.push('ACCOUNTS');
 if(!a.length&&/hello|family|wife|dinner|বাসা|খাবার|মা|বাবা|কেমন|হ্যালো/i.test(text))a.push('PERSONAL');
 return [...new Set(a)];
}
export function referenceMatches(phone:string,refs:Profile['evidenceRefs']){
 const normalized=normalizePhone(phone);
 // An exact number is a reference hit, not proof of a person's unique ownership.
 return refs.filter(r=>normalized&&normalizePhone(r.phone)===normalized&&r.evidenceRef)
   .map(r=>({field:r.field,role:r.role,evidenceRef:r.evidenceRef,employeeProof:
    ['EMPLOYEE_LEDGER','EMPLOYEE_MOBILE','ESCORT_MOBILE'].includes(r.role)&&['employee_id','employeePhone','escortMobile'].includes(r.field)}));
}
function serviceFacts(text:string){
 const ascii=text.replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
 const dates=[...new Set(ascii.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[])];
 const shift=[...new Set([...ascii.matchAll(/(?:shift|শিফট)\s*[:=]?\s*([A-Za-z]+)|\b([DN])\s*(?:shift|শিফট)/gi)].map(m=>(m[1]??m[2]).toUpperCase()))];
 const count=ascii.match(/\b([0-9]{1,3})\s*(?:জন|guards?\b)/i);
 const location=ascii.match(/(?:location|স্থান)\s*[:=]\s*([^\n,;]+)/i);
 const reasons:string[]=[];
 if(dates.length!==1)reasons.push('EXACT_SERVICE_DATE_REQUIRED');
 else if(!validDate(dates[0]))reasons.push('SERVICE_DATE_INVALID');
 if(shift.length!==1||!['D','N'].includes(shift[0]))reasons.push('SERVICE_SHIFT_REQUIRED_OR_INVALID');
 return {fields:{requestedDate:dates.length===1&&validDate(dates[0])?dates[0]:null,
  requestedShift:shift.length===1&&['D','N'].includes(shift[0])?shift[0]:null,
  guardCount:count&&Number(count[1])>0?Number(count[1]):null,location:location?.[1].trim()??null},reasons};
}
function canAct(state:CandidateState,personId:string,channel:'STAFF'|'WHATSAPP',route:typeof routes[string],source:Source,resourceId:string|null){
 return authorize(state,personId,channel,route.capability,{accountId:source.accountId,
  chatJid:source.chatJid,domain:route.domain as never,resourceId});
}
function identity(state:CandidateState,source:Source,credentials:Credentials|undefined,now:number,subjectPersonId?:string){
 if(source.channel==='FRONTEND'){
  if(source.direction!=='SUBMITTED'||source.senderJid!==null||source.senderPhone!==null)throw new CandidateError('WEB_PROVENANCE_INVALID');
  const actor=authenticate(state,credentials??{token:''},now,true);
  const subject=subjectPersonId??actor.personId;
  if(state.registry[subject]?.kind!=='person'||state.registry[subject]?.status!=='VERIFIED')throw new CandidateError('SUBJECT_UNVERIFIED',403);
  return {personId:subject,state:'VERIFIED',conflicts:[],operatorId:actor.personId};
 }
 if(source.direction==='SUBMITTED'||!source.senderJid)throw new CandidateError('TRANSPORT_PROVENANCE_INVALID');
 const m=nativeEnvelopeSchema.parse({version:'native-message-envelope-v1',provider:'WHATSAPP',
  accountId:source.accountId,nativeMessageId:source.eventId,chatJid:source.chatJid,
  chatType:source.chatJid.endsWith('@g.us')?'group':'direct',senderJid:source.senderJid,
  senderPhone:source.senderPhone,senderLid:source.senderJid.endsWith('@lid')?source.senderJid:null,
  direction:source.direction,sourceTimestamp:source.at,sourceTimestampOriginal:source.at,
  observedAt:source.observedAt,eventType:'TEXT',payload:{text:source.text,sha256:hash(source.text),reference:'qualification-source:'+source.eventId},
  quotedMessageId:source.quotedEventId,forwarded:source.forwarded,media:[],groupDisplayName:null,membershipEvidence:null});
 // The existing message resolver is used only for its binding lookup. CALL
 // remains CALL in source/outcome; an empty lookup payload is not a transcript.
 return {...resolveIdentity(state,m),operatorId:null};
}
function clarification(reason:string){return {intent:'UNKNOWN',domain:'IDENTITY',capability:null,
 authorization:{allowed:false,reason},workflow:'CLARIFICATION_REVIEW',clientId:null,linkedRecordId:null,
 fields:{},draft:'আপনি কোন সেবা বা কাজের বিষয়ে বলছেন, এবং সংশ্লিষ্ট তথ্যটি জানাবেন?',outcome:'CLARIFICATION',reasons:[reason]};}
function evaluateConversation(state:CandidateState,workflow:WorkflowState,raw:unknown,
 {credentials,now=Date.now(),subjectPersonId}:{credentials?:Credentials;now?:number;subjectPersonId?:string}={}){
 const source=sourceSchema.parse(raw);
 if(Buffer.byteLength(source.text)>64000)throw new CandidateError('TEXT_BUDGET');
 if((source.kind==='CALL')!==!!source.call||source.kind==='CALL'&&source.text!==''||
   ['EDIT','REVOKE'].includes(source.kind)!==!!source.targetEventId)throw new CandidateError('EVENT_PROVENANCE_INVALID');
 const actor=identity(state,source,credentials,now,subjectPersonId),profile=actor.personId?workflow.profiles[actor.personId]:null;
 const resolvedPhone=source.channel==='WHATSAPP'&&actor.state==='VERIFIED'&&'bindings' in actor&&actor.bindings.length===1?bindingSchema.parse(actor.bindings[0].data).phone:null;
 const contactPhone=source.channel==='WHATSAPP'?source.senderPhone??resolvedPhone??(source.senderJid?.endsWith('@s.whatsapp.net')?source.senderJid.slice(0,-15):''):profile?.contactPhone??'';
 const contactMatch=!!profile?.contactPhone&&normalizePhone(contactPhone)===normalizePhone(profile.contactPhone);
 const hits=profile?referenceMatches(contactPhone,profile.evidenceRefs):[];
 const relationships=actor.personId?Object.values(state.registry).filter(r=>r.kind==='relationship'&&r.status==='VERIFIED'&&'personId' in r.data&&r.data.personId===actor.personId):[];
 const roles=relationships.map(r=>(r.data as {kind:string}).kind);
 const key=digest([source.channel,source.accountId,source.chatJid,source.eventId]);
 const fingerprint=digest({...source,observedAt:undefined});
 const previous=workflow.receipts[key];
 // Revalidate current identity/grants on every replay. An old receipt is history,
 // never a surviving authorization after revocation.
 const verified=actor.state==='VERIFIED'&&!!actor.personId&&!!profile&&contactMatch;
 let items:Array<Item|ReturnType<typeof clarification>>=[];
 if(!verified)items=[clarification(actor.state==='VERIFIED'?'CONTACT_PERSON_CONFLICT':'SENDER_'+actor.state)];
 else if(previous?.suppressed)items=[clarification(previous.suppressed)];
 else if(source.kind==='REVOKE')items=[clarification('SOURCE_REVOKED')];
 else if(source.kind==='CALL')items=[{...clarification('CALL_STATEMENT_UNKNOWN'),
  draft:'আপনার কলের বক্তব্য জানা নেই। কোন বিষয়ে যোগাযোগ করেছিলেন, জানাবেন?',workflow:'CALL_CALLBACK_DRAFT',
  fields:{observedResult:source.call!.result,endedAt:source.call!.endedAt,stateConfidence:'LOCAL_OBSERVATION_ONLY',statement:'কলের বক্তব্য জানা নেই'}}];
 else if(source.direction==='OUTGOING')items=[clarification('OUTGOING_NOT_INCOMING_INTENT')];
 // Forwarded / copy-pasted content from a verified sender is ordinary content
 // (Owner rule). The verified-sender check above still decides authority.
 else {
  const intents=detectIntents(source.text);
  if(!intents.length)items=[clarification('INTENT_CONTEXT_REQUIRED')];
  for(const intent of intents){
   const services=profile!.serviceContexts??(profile!.clientId?[{service:profile!.classification==='ESCORT_CLIENT'?'ESCORT':profile!.classification==='SECURITY_GUARD_CLIENT'?'SECURITY_GUARD':'UNKNOWN',clientId:profile!.clientId,evidenceRef:'server-profile'}]:[]);
   const matches=services.filter(v=>v.service===intent&&v.evidenceRef);
   const clientId=['ESCORT','SECURITY_GUARD'].includes(intent)?(matches.length===1?matches[0].clientId:null):profile!.clientId;
   const route=routes[intent];const resourceId=['ESCORT','SECURITY_GUARD'].includes(intent)?clientId:actor.personId;
   let decision=canAct(state,source.channel==='FRONTEND'?(actor.operatorId as string):actor.personId! ,source.channel==='FRONTEND'?'STAFF':'WHATSAPP',route,source,resourceId);
   const reasons:string[]=[];
   const relOk=intent==='DUTY'?roles.includes('EMPLOYEE')&&hits.some(h=>h.employeeProof):
    intent==='ESCORT'||intent==='SECURITY_GUARD'?relationships.some(r=>(r.data as {kind:string;clientId:string|null}).kind==='CLIENT'&&(r.data as {clientId:string|null}).clientId===clientId)&&!!clientId&&matches.length===1:
    intent==='ACCOUNTS'?roles.some(r=>['ACCOUNTANT','ADMIN','SUPER_ADMIN'].includes(r)):
    intent==='PERSONAL'?roles.includes('PERSONAL'):
    intent==='RECRUITMENT'?true:false;
   if(!relOk)decision={...decision,allowed:false,reason:'ROLE_EVIDENCE_SCOPE_MISMATCH'};
   if(intents.length>1)reasons.push('MULTIPLE_INTENTS_SEPARATE_REVIEW_ITEMS');
   if(source.quotedEventId)reasons.push('QUOTED_ORIGIN_HAS_NO_AUTHORITY');
   const followup=/আগেরটা|আগের|previous|same as|cancel|বাতিল|correction|সংশোধন/i.test(source.text);
   let linked:Context|null=null;
   if(followup||intent==='DUTY'){
    const context=workflow.context.filter(r=>r.active&&(intent!=='DUTY'||r.status==='APPROVED')&&r.personId===actor.personId&&r.clientId===clientId&&r.accountId===source.accountId&&r.chatJid===source.chatJid&&r.domain===route.domain&&
     authorize(state,actor.personId!,source.channel==='FRONTEND'?'STAFF':'WHATSAPP','evidence.read',{accountId:r.accountId,domain:r.domain as never,chatJid:r.chatJid,resourceId:r.id}).allowed);
    if(context.length===1)linked=context[0];else reasons.push('AUTHORIZED_CONTEXT_REQUIRED');
   }
   let fields:Record<string,unknown>={};
   if(intent==='ESCORT'&&!followup){
    const date=new Date(Date.parse(source.at)+6*3600000).toISOString().slice(0,10);
    const parseOrder=parseEscortOrder as unknown as (text:string,options:{messageDate:string})=>unknown;
    const blocks=parseOrder(source.text,{messageDate:date}) as Array<{fields:Record<string,unknown>;reasons:string[];bookingDate:string|null;masterMobile:string|null}>;
    if(blocks.length===1){fields={...blocks[0].fields,normalizedBookingDate:blocks[0].bookingDate,normalizedMasterMobile:blocks[0].masterMobile};reasons.push(...blocks[0].reasons);}
    else reasons.push(blocks.length?'MULTIPLE_ESCORT_BLOCKS_REVIEW':'ORDER_FIELDS_REQUIRED');
    if(!fields.motherVessel||!fields.lighterVessel||!fields.masterMobile)reasons.push('ORDER_FIELDS_REQUIRED');
   }
   if(['SECURITY_GUARD','DUTY'].includes(intent)){
    const facts=serviceFacts(source.text);fields=facts.fields;reasons.push(...facts.reasons);
    if(intent==='SECURITY_GUARD'&&(!facts.fields.guardCount||!facts.fields.location))reasons.push('SERVICE_COUNT_LOCATION_REQUIRED');
   }
   if(followup)fields.requestedOperation=/cancel|বাতিল/i.test(source.text)?'CANCELLATION':/correction|সংশোধন/i.test(source.text)?'CORRECTION':'FOLLOWUP';
   const draft=!decision.allowed?'এই কাজের জন্য আপনার অনুমোদিত পরিচয় বা অধিকার যাচাই প্রয়োজন।':
    reasons.includes('AUTHORIZED_CONTEXT_REQUIRED')?'কোন আগের অর্ডার বা রেকর্ডটি বোঝাচ্ছেন? তার নম্বর বা তথ্য জানাবেন?':
    intent==='ESCORT'?'Escort সেবার জন্য Mother vessel, Lighter vessel, Master-এর নম্বর এবং প্রয়োজনীয় তারিখ/shift জানাবেন?':
    intent==='SECURITY_GUARD'?'Security Guard সেবার স্থান, গার্ডের সংখ্যা, তারিখ ও shift জানাবেন?':
    intent==='DUTY'?'কোন অনুমোদিত duty/assignment, তারিখ ও shift-এর বিষয়ে বলছেন?':
    intent==='RECRUITMENT'?'কোন পদে আবেদন করতে চান এবং আপনার অভিজ্ঞতা কী?':
    intent==='ACCOUNTS'?'কোন হিসাব বা লেনদেনের reference এবং কী তথ্য দরকার, জানাবেন?':
    'কোন বিষয়ে কথা বলতে চান, জানাবেন?';
   items.push({intent,domain:route.domain,capability:route.capability,authorization:decision,
    workflow:decision.allowed?route.workflow:'CLARIFICATION_REVIEW',clientId:decision.allowed?clientId:null,
    linkedRecordId:decision.allowed?linked?.id??null:null,fields:decision.allowed?fields:{},draft,
    outcome:decision.allowed?(reasons.length?'CLARIFICATION':'SCOPED_REVIEW_DRAFT'):'DENIED',reasons});
  }
 }
 let revision=previous?.revision??0;
 let replay='NEW';
 if(previous){
  if(previous.fingerprint===fingerprint)replay=previous.epoch===state.epoch?'REVALIDATED_DUPLICATE':'REVALIDATED_AFTER_AUTH_CHANGE';
  else {replay='EVENT_ID_CONFLICT';items=[clarification('EVENT_ID_CONTENT_CONFLICT')];}
 }
 if(!previous||previous.fingerprint!==fingerprint)revision++;
 const target=source.targetEventId?workflow.receipts[digest([source.channel,source.accountId,source.chatJid,source.targetEventId])]:undefined;
 if(source.targetEventId){
  const targetActor=target?(target.outcome as {identity:{personId:string|null}}).identity.personId:null;
  if(!verified||!target||targetActor!==actor.personId||source.kind==='EDIT'&&target.suppressed==='SOURCE_REVOKED'){items=[clarification('REVISION_TARGET_SCOPE_DENIED')];}
  else if(!previous){revision=target.revision+1;target.history.push({kind:source.kind,eventId:source.eventId,at:source.at});
   target.epoch=-1; // Prior action/draft is stale; no canonical compensation occurs.
   target.suppressed=source.kind==='REVOKE'?'SOURCE_REVOKED':'SOURCE_SUPERSEDED';
   target.outcome={...target.outcome as object,stale:true,supersededBy:source.eventId};}
 }
 const result={evidenceState:'DISPOSABLE_CANDIDATE',source:{...source,textHash:hash(source.text)},
  identity:{personId:verified?actor.personId:null,state:verified?'VERIFIED':'UNRESOLVED',
   operatorId:actor.operatorId,contactExactMatch:contactMatch,roles,referenceHits:hits,conflicts:actor.conflicts},
  items,revision,replay,draftGeneration:'LOCAL_TEMPLATE',providerCalled:false,
  businessWrite:'NOT_ATTEMPTED',whatsappSend:'NOT_ATTEMPTED',delivery:'UNKNOWN',authorizationEpoch:state.epoch};
 if(replay!=='EVENT_ID_CONFLICT')workflow.receipts[key]={source:structuredClone(source),fingerprint,revision,
  epoch:state.epoch,outcome:structuredClone(result),history:previous?.history??[],suppressed:previous?.suppressed};
 return result;
}
export function processConversation(state:CandidateState,workflow:WorkflowState,raw:unknown,options:{credentials?:Credentials;now?:number;subjectPersonId?:string}={}){
 const next=structuredClone(workflow);
 const result=evaluateConversation(state,next,raw,options);
 if(Object.keys(next.receipts).length>5000||Buffer.byteLength(JSON.stringify(next))>32*1024*1024)throw new CandidateError('WORKFLOW_CAPACITY_REVIEW_REQUIRED',503);
 Object.assign(workflow,next);
 return result;
}
