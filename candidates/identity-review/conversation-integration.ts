import {digest,hash,bindingSchema,personSchema,relationshipSchema,grantSchema,CandidateError} from './contracts.ts';
import type {NativeMessageEnvelopeV1,ReviewItemV1} from './contracts.ts';
import type {CandidateState} from './repository.ts';
import type {Credentials} from './auth.ts';
import {processConversation,emptyWorkflow} from './conversation-workflow.ts';
import type {ConversationSource,Profile,WorkflowState} from './conversation-workflow.ts';
import {authorize,resolveIdentity,legacyRouteMessage} from './routing.ts';

function projection(s:CandidateState,accountId:string,chatJid:string,at:string):WorkflowState{
 const w=emptyWorkflow(),now=Date.parse(at);
 const records=Object.values(s.registry).filter(r=>r.status==='VERIFIED');
 const bindings=records.filter(r=>r.kind==='binding').map(r=>bindingSchema.parse(r.data)).filter(b=>b.accountId===accountId&&b.chatJid===chatJid&&Date.parse(b.validFrom)<=now&&(!b.validTo||now<Date.parse(b.validTo)));
 const relationships=records.filter(r=>r.kind==='relationship').map(r=>relationshipSchema.parse(r.data));
 const grants=records.filter(r=>r.kind==='grant').map(r=>grantSchema.parse(r.data));
 for(const r of records.filter(r=>r.kind==='person')){
  const person=personSchema.parse(r.data),phones=[...new Set(bindings.filter(b=>b.personId===r.id).map(b=>b.phone).filter(Boolean))];
  const rel=relationships.filter(v=>v.personId===r.id),services:NonNullable<Profile['serviceContexts']>=[];
  for(const client of rel.filter(v=>v.kind==='CLIENT')){
   for(const service of ['ESCORT','SECURITY_GUARD'] as const){
    const cap=service==='ESCORT'?'escort.order.intake':'security.order.intake';
    if(client.clientId&&(client.serviceKind===service||grants.some(g=>g.personId===r.id&&g.scope.accountId===accountId&&g.scope.domain===service&&g.capability===cap&&(g.scope.chatJid===null||g.scope.chatJid===chatJid)&&(g.scope.resourceId===null||g.scope.resourceId===client.clientId))))services.push({service,clientId:client.clientId,evidenceRef:client.evidenceRefs[0]});
   }
  }
  w.profiles[r.id]={personId:r.id,contactPhone:phones.length===1?phones[0]:null,
   classification:rel.some(v=>v.kind==='PERSONAL')?'PERSONAL_OTHER':rel.some(v=>v.kind==='EMPLOYEE')?'EMPLOYEE':'REGISTRY_VERIFIED',
   clientId:services.length===1?services[0].clientId:null,serviceContexts:services,
   evidenceRefs:person.employeeReferences.map(v=>({field:v.sourceRole==='ESCORT_MOBILE'?'escortMobile':'employee_id',role:v.sourceRole,phone:v.mobile,evidenceRef:v.evidenceRef}))};
 }
 for(const value of Object.values(s.observations)){
  const v=value as {type?:string;key?:string;receipt?:WorkflowState['receipts'][string]};
  if(v.type==='CONVERSATION_RECEIPT'&&v.key&&v.receipt)w.receipts[v.key]=structuredClone(v.receipt);
 }
 for(const r of Object.values(s.reviews)){
  const o=r.candidate?.conversation as {personId?:string;clientId?:string|null}|undefined;
  if(o?.personId)w.context.push({id:r.id,personId:o.personId,clientId:o.clientId??null,accountId:r.accountId,chatJid:r.chatJid,domain:r.domain,status:r.status,active:!s.nativeSuppression[r.sourceOccurrenceId]&&!['REVIEW','NEEDS_CLARIFICATION'].includes(r.status),sourceEventId:r.sourceOccurrenceId});
 }
 return w;
}
function save(s:CandidateState,w:WorkflowState){
 for(const [key,value] of Object.entries(w.receipts)){
  const r=structuredClone(value);
  if(r.source.channel==='WHATSAPP'){
   r.source.text='';const result=r.outcome as {source:{text:string}};result.source.text='';
  }
  s.observations['conversation:'+key]={type:'CONVERSATION_RECEIPT',key,receipt:r};
 }
}
export function sourceOf(m:NativeMessageEnvelopeV1,overrides:Record<string,unknown>={}):ConversationSource{return {
 channel:'WHATSAPP',accountId:m.accountId,eventId:m.nativeMessageId,chatJid:m.chatJid,senderJid:m.senderJid,
 senderPhone:m.senderPhone,direction:m.direction,kind:'MESSAGE',targetEventId:null,at:m.sourceTimestamp,observedAt:m.observedAt,
 text:m.payload.text,quotedEventId:m.quotedMessageId,forwarded:m.forwarded,call:null,...Object.fromEntries(Object.entries(overrides).filter(([key])=>key!=='origin'))} as ConversationSource;}
function reviewsOf(s:CandidateState,result:ReturnType<typeof processConversation>,occurrenceId:string,sourceRevision:number,actor:string,legacy:ReviewItemV1[]=[]){
 return result.items.map((item,i):ReviewItemV1=>{
  const authorized=(item.authorization as {allowed?:boolean}).allowed===true;
  const compatible=legacy[i];
  const r:ReviewItemV1={version:'review-item-v1',id:digest([occurrenceId,'conversation',i]),revision:1,
   accountId:result.source.accountId,chatJid:result.source.chatJid,domain:item.domain as never,requiredDomains:[item.domain as never],
   sourceOccurrenceId:occurrenceId,sourceRevision,classification:authorized&&item.intent==='ESCORT'&&compatible?.classification==='ORDER_DRAFT'?'ORDER_DRAFT':'REVIEW',
   status:'REVIEW',fields:item.fields,reasons:item.reasons,linkedDraftId:item.linkedRecordId,assignmentProposal:null,
   assignmentState:'UNASSIGNED',clientDeliveryState:'NOT_SENT',createdBy:actor,authorizationVersion:s.epoch,note:'',
   candidate:{...(authorized?compatible?.candidate??{}:{}),conversation:{personId:result.identity.personId,clientId:item.clientId,intent:item.intent,capability:item.capability,operatorId:result.identity.operatorId,channel:result.source.channel,authorization:item.authorization,draft:item.draft,outcome:item.outcome}}};
  if(r.classification==='ORDER_DRAFT')r.status='DRAFT';return r;
 });
}
export function integrateConversation(s:CandidateState,m:NativeMessageEnvelopeV1,occurrenceId:string,sourceRevision:number,actor:string,overrides:Record<string,unknown>={}){
 const source=sourceOf(m,overrides),w=projection(s,m.accountId,m.chatJid,m.sourceTimestamp),result=processConversation(s,w,source,{now:Date.parse(m.observedAt)});
 const legacy=result.items.some(i=>i.domain==='ESCORT'&&(i.authorization as {allowed?:boolean}).allowed===true)?legacyRouteMessage(s,m,occurrenceId,sourceRevision,actor):[];
 const reviews=reviewsOf(s,result,occurrenceId,sourceRevision,actor,legacy);save(s,w);
 const key=digest([source.channel,source.accountId,source.chatJid,source.eventId]);
 const receipt=w.receipts[key];
 s.operations[digest(['conversation-result',key,sourceRevision])]={payloadHash:receipt.fingerprint,result:{sourceChannel:'WHATSAPP',receiptId:key,occurrenceId,sourceRevision,reviewIds:reviews.map(r=>r.id),sourceHash:hash(source.text),businessWrite:'NOT_ATTEMPTED',send:'NOT_ATTEMPTED'}};
 return {result,reviews,receiptId:key};
}
export function integrateFrontend(s:CandidateState,credentials:Credentials,input:{accountId:string;chatJid:string;personId:string;eventId:string;text:string;kind?:'MESSAGE'|'EDIT';targetEventId?:string},now:number,actor:string){
 const w=projection(s,input.accountId,input.chatJid,new Date(now).toISOString());
 if(!w.profiles[input.personId]?.contactPhone)throw new CandidateError('SUBJECT_CHAT_BINDING_REQUIRED',403);
 const key=digest(['FRONTEND',input.accountId,input.chatJid,input.eventId]),previous=w.receipts[key];
 const source:ConversationSource={channel:'FRONTEND',accountId:input.accountId,eventId:input.eventId,chatJid:input.chatJid,senderJid:null,senderPhone:null,direction:'SUBMITTED',kind:input.kind??'MESSAGE',targetEventId:input.targetEventId??null,at:previous?.source.at??new Date(now).toISOString(),observedAt:new Date(now).toISOString(),text:input.text,quotedEventId:null,forwarded:false,call:null};
 const result=processConversation(s,w,source,{credentials,now,subjectPersonId:input.personId});
 const reviews=reviewsOf(s,result,key,result.revision,actor);
 if(result.replay==='EVENT_ID_CONFLICT'){const conflict=digest(['frontend-conflict',key,hash(input.text)]);if(!s.operations[conflict])s.operations[conflict]={payloadHash:hash(input.text),result:{type:'SOURCE_CONFLICT',receiptId:key,originalFingerprint:previous?.fingerprint,incomingHash:hash(input.text),sourceChannel:'FRONTEND',operatorId:actor}};}
 if(result.replay!=='EVENT_ID_CONFLICT'){
  save(s,w);
  for(const r of reviews){const prior=s.reviews[r.id];const comparable=(v:ReviewItemV1)=>({...v,revision:0});if(prior&&digest(comparable(prior))===digest(comparable(r)))continue;r.revision=prior?prior.revision+1:1;s.reviews[r.id]=r;s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);}
  const op=digest(['frontend-conversation',key,result.revision]);
  if(!s.operations[op])s.operations[op]={payloadHash:w.receipts[key].fingerprint,result:{receiptId:key,operatorId:actor,sourceChannel:'FRONTEND',reviewIds:reviews.map(r=>r.id),sourceHash:hash(source.text),businessWrite:'NOT_ATTEMPTED',send:'NOT_ATTEMPTED'}};
 }
 return {receiptId:key,revision:result.revision,replay:result.replay,result,reviewIds:reviews.map(r=>r.id)};
}
export function revalidateConversationReceipts(s:CandidateState,account:string,chat:string){
 for(const [id,value] of Object.entries(s.observations)){
  const v=value as {type?:string;receipt?:WorkflowState['receipts'][string]};
  if(v.type!=='CONVERSATION_RECEIPT'||!v.receipt||v.receipt.source.accountId!==account||v.receipt.source.chatJid!==chat)continue;
  const result=v.receipt.outcome as ReturnType<typeof processConversation>;
  const source=v.receipt.source;let personId=result.identity.personId;
  if(source.channel==='WHATSAPP'){
   const lookup={accountId:account,chatJid:chat,senderJid:source.senderJid!,senderPhone:source.senderPhone,senderLid:source.senderJid?.endsWith('@lid')?source.senderJid:null,direction:source.direction as 'INCOMING',sourceTimestamp:source.at} as NativeMessageEnvelopeV1;
   personId=resolveIdentity(s,lookup).personId;
  }
  for(const item of result.items){
   if(!item.capability)continue;
   const actor=source.channel==='FRONTEND'?result.identity.operatorId:personId;
   const resource=item.clientId??personId;
   const decision=authorize(s,actor,source.channel==='FRONTEND'?'STAFF':'WHATSAPP',item.capability,{accountId:account,chatJid:chat,domain:item.domain as never,resourceId:resource});
   if(v.receipt.suppressed||!personId||personId!==result.identity.personId||s.registry[personId]?.status!=='VERIFIED')decision.allowed=false;
   item.authorization=decision;
   if(!decision.allowed){item.outcome='DENIED';item.workflow='CLARIFICATION_REVIEW';item.fields={};item.linkedRecordId=null;item.draft='এই কাজের জন্য বর্তমান অনুমোদিত পরিচয় ও অধিকার যাচাই প্রয়োজন।';}
  }
  result.authorizationEpoch=s.epoch;v.receipt.epoch=s.epoch;s.observations[id]=v;
  for(const r of Object.values(s.reviews).filter(r=>r.accountId===account&&r.chatJid===chat&&r.candidate?.conversation)){
   const c=r.candidate.conversation as {personId:string;authorization:{allowed:boolean};capability:string;clientId:string|null;channel:string;operatorId:string|null};
   const decision=authorize(s,c.channel==='FRONTEND'?c.operatorId:c.personId,c.channel==='FRONTEND'?'STAFF':'WHATSAPP',c.capability,{accountId:account,chatJid:chat,domain:r.domain,resourceId:c.clientId??c.personId});
   if(!decision.allowed||s.registry[c.personId]?.status!=='VERIFIED'||s.nativeSuppression[r.sourceOccurrenceId]){
    if(r.classification==='ORDER_DRAFT'||c.authorization.allowed){r.revision++;r.classification='REVIEW';r.status='REVIEW';r.fields={};r.assignmentProposal=null;r.linkedDraftId=null;c.authorization={allowed:false};r.reasons=[...new Set([...r.reasons,'CURRENT_AUTHORIZATION_DENIED'])];s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);}
   }
  }
 }
}
export function readConversationOutcome(s:CandidateState,actor:string,account:string,chat:string,event:string,channel:'FRONTEND'|'WHATSAPP'){
 revalidateConversationReceipts(s,account,chat);const key=digest([channel,account,chat,event]);
 const v=s.observations['conversation:'+key] as {receipt?:WorkflowState['receipts'][string]}|undefined;
 if(!v?.receipt)throw new CandidateError('NOT_FOUND',404);
 const r=v.receipt.outcome as ReturnType<typeof processConversation>;
 for(const item of r.items)if(!authorize(s,actor,'STAFF','review.read',{accountId:account,chatJid:chat,domain:item.domain as never,resourceId:null}).allowed)throw new CandidateError('CAPABILITY_DENIED',403);
 return {receiptId:key,revision:v.receipt.revision,result:r};
}
export function suppressConversation(s:CandidateState,account:string,chat:string,event:string){
 const key=digest(['WHATSAPP',account,chat,event]);const v=s.observations['conversation:'+key] as {receipt?:WorkflowState['receipts'][string]}|undefined;
 if(v?.receipt){v.receipt.suppressed='SOURCE_REVOKED';s.observations['conversation:'+key]=v;}
 for(const [id,value] of Object.entries(s.observations)){const r=value as {receipt?:WorkflowState['receipts'][string]};if(r.receipt?.source.accountId===account&&r.receipt.source.chatJid===chat&&r.receipt.source.targetEventId===event){r.receipt.suppressed='SOURCE_REVOKED';s.observations[id]=r;}}
 revalidateConversationReceipts(s,account,chat);
}
