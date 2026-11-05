import {integrateConversation} from './conversation-integration.ts';
import {qualifyEscortIntake,parseEscortOrder} from '../../lib/escort-intake-candidate.mjs';
import {blockedCapabilities,digest,normalizePhone,personSchema,bindingSchema,relationshipSchema,grantSchema,groupSchema,vesselAliasSchema} from './contracts.ts';
import type {AuthorizationDecisionV1,Capability,Domain,IdentityResolutionV1,NativeMessageEnvelopeV1,RegistryRecord,Scope,ReviewItemV1} from './contracts.ts';
import type {CandidateState} from './repository.ts';
const verified=(s:CandidateState,kind:string)=>Object.values(s.registry).filter(r=>r.kind===kind&&r.status==='VERIFIED');
export function authorize(state:CandidateState,personId:string|null,channel:'STAFF'|'WHATSAPP',capability:string,scope:Scope):AuthorizationDecisionV1{
 const decision=(allowed:boolean,reason:string):AuthorizationDecisionV1=>({version:'authorization-decision-v1',allowed,reason,actorId:personId,capability,scope,authorizationVersion:state.epoch});
 if(blockedCapabilities.has(capability))return decision(false,'OWNER_DECISION_OR_ACTIVATION_REQUIRED');
 if(!personId||state.registry[personId]?.kind!=='person'||state.registry[personId]?.status!=='VERIFIED')return decision(false,'IDENTITY_UNVERIFIED');
 const grants=verified(state,'grant').map(r=>grantSchema.parse(r.data));
 const allowed=grants.some(g=>g.personId===personId&&g.channel===channel&&g.capability===capability&&g.scope.accountId===scope.accountId&&g.scope.domain===scope.domain&&(g.scope.chatJid===null||g.scope.chatJid===scope.chatJid)&&(g.scope.resourceId===null||g.scope.resourceId===scope.resourceId));
 return decision(allowed,allowed?'EXPLICIT_SCOPED_GRANT':'CAPABILITY_DENIED');
}
function nativePhoneOf(sender:string){const m=/^([0-9]+)(?::[0-9]+)?@s\.whatsapp\.net$/.exec(sender);return normalizePhone(m?m[1]:sender);}
export function resolveIdentity(state:CandidateState,m:NativeMessageEnvelopeV1):IdentityResolutionV1{
 const nativePhone=nativePhoneOf(m.senderJid);
 const suppliedPhone=m.senderPhone?normalizePhone(m.senderPhone):null;
 const conflicts:string[]=[];
 if(m.senderPhone&&!suppliedPhone)conflicts.push('SENDER_PHONE_UNRESOLVED');
 if(nativePhone&&suppliedPhone&&nativePhone!==suppliedPhone)conflicts.push('NATIVE_PHONE_CONFLICT');
 if(m.senderLid&&m.senderJid.endsWith('@lid')&&m.senderLid!==m.senderJid)conflicts.push('LID_CONFLICT');
 const current=Date.parse(m.sourceTimestamp);
 const bindings=verified(state,'binding').filter(r=>{const b=bindingSchema.parse(r.data);return b.accountId===m.accountId&&b.chatJid===m.chatJid&&b.senderJid===m.senderJid&&b.direction===m.direction&&Date.parse(b.validFrom)<=current&&(!b.validTo||current<Date.parse(b.validTo))&&state.registry[b.personId]?.kind==='person'&&state.registry[b.personId]?.status==='VERIFIED'&&(nativePhone?b.phone===nativePhone:m.senderJid.endsWith('@lid')&&!!b.phone&&!!b.lidMappingRef)&&(!suppliedPhone||b.phone===suppliedPhone);});
 const people=[...new Set(bindings.map(r=>bindingSchema.parse(r.data).personId))];
 const stateName=conflicts.length||bindings.length!==1||people.length!==1?(people.length>1||bindings.length>1?'AMBIGUOUS':'UNRESOLVED'):'VERIFIED';
 const personId=stateName==='VERIFIED'?people[0]:null;
 const relationships=personId?verified(state,'relationship').map(r=>relationshipSchema.parse(r.data)).filter(r=>r.personId===personId):[];
 return {version:'identity-resolution-v1',personId,state:stateName,relationships,bindings:stateName==='VERIFIED'?bindings:[],authorizationVersion:state.epoch,conflicts};
}
type EscortItem={id:string;classification:string;fields:Record<string,unknown>;reasons:string[];linkedDraftId:string|null;assignmentProposal:Record<string,unknown>|null;assignmentState:string;[key:string]:unknown};
type EscortResult={items:EscortItem[]};
const qualify=qualifyEscortIntake as unknown as (m:Record<string,unknown>,options:Record<string,unknown>)=>EscortResult;
const parseOrder=parseEscortOrder as unknown as (text:string,options?:Record<string,unknown>)=>Array<{fields:Record<string,unknown>}>;
function messageDate(m:NativeMessageEnvelopeV1){return new Date(Date.parse(m.sourceTimestamp)+6*3600000).toISOString().slice(0,10);}
function escortedBindings(identity:IdentityResolutionV1,m:NativeMessageEnvelopeV1,state:CandidateState){
 if(identity.state!=='VERIFIED'||identity.bindings.length!==1)return [];
 const record=identity.bindings[0],b=bindingSchema.parse(record.data),client=identity.relationships.filter(r=>r.kind==='CLIENT');
 const role=m.direction==='INCOMING'&&client.length===1&&authorize(state,identity.personId,'WHATSAPP','escort.order.intake',messageScope(m,'ESCORT')).allowed?'client':m.direction==='OUTGOING'&&identity.relationships.some(r=>['ADMIN','SUPER_ADMIN'].includes(r.kind))&&authorize(state,identity.personId,'WHATSAPP','escort.assignment.propose',messageScope(m,'ESCORT')).allowed?'admin':null;
 if(!role)return [];
 return [{id:record.id,version:String(record.version),active:true,decision:'APPROVED',approver:record.ownerProof!.decisionId,evidenceKind:'OWNER_VERIFIED_MESSAGE_ROLE',evidenceSha:record.ownerProof!.evidenceSha,role,clientId:role==='client'?client[0].clientId:null,accountId:b.accountId,chatJid:b.chatJid,senderJid:b.senderJid,direction:b.direction,chatType:'direct',resolvedPhone:b.phone,validFrom:new Date(Date.parse(b.validFrom)+6*3600000).toISOString().slice(0,10),validTo:null}];
}
export function messageScope(m:NativeMessageEnvelopeV1,domain:Domain):Scope{return {accountId:m.accountId,domain,chatJid:m.chatJid,resourceId:null};}
export function classifyDomains(text:string):Domain[]{
 const found:Domain[]=[];
 if(/release|রিলিজ|slip/i.test(text))found.push('RELEASE');
 if(/payroll|salary|বেতন/i.test(text))found.push('PAYROLL');
 if(/settlement|নিষ্পত্তি/i.test(text))found.push('SETTLEMENT');
 if(/\b(food|conveyance|payment|paid|cash|advance|bkash|nagad|accounts?)\b|টাকা|খাবার|ভাড়া|বিকাশ|নগদ/i.test(text))found.push('ACCOUNTS');
 if(/attendance|হাজিরা|vessel duty/i.test(text))found.push('ATTENDANCE');
 if(/\brecruit(?:ment)?\b|\bjob(?:s)?\b|\b(?:apply|applying)\s+(?:for|to)\s+(?:work|a?\s*job|employment)\b|\bjob\s+application\b|চাকরি|নিয়োগ|নিয়োগ|কাজ\s*(?:চাই|দরকার|খুঁজ)/iu.test(text)||/\bapplication\b/i.test(text)&&!/(release|রিলিজ|slip)/iu.test(text))found.push('RECRUITMENT');
 if(/complaint|অভিযোগ/i.test(text))found.push('OFFICE');
 if(/knowledge|policy|hermes|নীতিমালা/i.test(text))found.push('KNOWLEDGE');
 if(!found.length&&/mother vessel|lighter vessel|assignment|escort|m\/?v\b|স্কট/i.test(text))found.push('ESCORT');
 return [...new Set(found.length?found:['OFFICE' as const])];
}
export function legacyRouteMessage(state:CandidateState,m:NativeMessageEnvelopeV1,occurrenceId:string,sourceRevision:number,actorId:string):ReviewItemV1[]{
 // Forwarded and copy-pasted content is ordinary content (Owner rule). The
 // forwarding flag is evidence, never an authority claim and never a review
 // reason: the sender binding and direction below still decide authority.
 const identity=resolveIdentity(state,m),domainCandidates=classifyDomains(m.payload.text);
 const groups=verified(state,'group').filter(r=>{const g=groupSchema.parse(r.data);return g.nativeJid===m.chatJid&&g.accountIds.includes(m.accountId);});
 const group=groups.length===1?groupSchema.parse(groups[0].data):null;
 const groupDomain=group?.domain as Domain|undefined;
 const domain=m.chatType==='group'?(groupDomain??'IDENTITY'):domainCandidates.length===1?domainCandidates[0]:'OFFICE';
 const reasons=[...(identity.state!=='VERIFIED'?['SENDER_IDENTITY_'+identity.state]:[]),...identity.conflicts,...(m.media.length?['MEDIA_NOT_QUALIFIED']:[]),...(domainCandidates.length>1?['MULTIPLE_DOMAINS_REVIEW_REQUIRED']:[]),...(m.chatType==='group'?['GROUP_REVIEW_ONLY',...(!group?['GROUP_BINDING_UNVERIFIED']:[])]:[])];
 if(m.eventType!=='TEXT'||m.direction==='OUTGOING'&&domain!=='ESCORT')reasons.push('EVIDENCE_EVENT_NOT_AUTHORIZED_ACTION');
 const base=(fields:Record<string,unknown>,classification='REVIEW',extra:string[]=[],candidate:Record<string,unknown>={},index=0):ReviewItemV1=>({version:'review-item-v1',id:digest([occurrenceId,sourceRevision,index]),revision:1,accountId:m.accountId,chatJid:m.chatJid,domain,requiredDomains:[...new Set([domain,...domainCandidates])],sourceOccurrenceId:occurrenceId,sourceRevision,classification,status:classification==='ORDER_DRAFT'?'DRAFT':'REVIEW',fields,reasons:[...new Set([...reasons,...extra])],linkedDraftId:null,assignmentProposal:null,assignmentState:classification==='ORDER_DRAFT'?'UNASSIGNED':'REVIEW',clientDeliveryState:'NOT_SENT',createdBy:actorId,authorizationVersion:state.epoch,note:'',candidate});
 if(domain==='ESCORT'&&m.eventType==='TEXT'){
  if(m.chatType==='group'){
   const blocks=parseOrder(m.payload.text,{messageDate:messageDate(m)});
   return blocks.length?blocks.map((b,i)=>base(b.fields,'REVIEW',['UNASSIGNED_GROUP_PROPOSAL'],{},i)):[base({})];
  }
  const bindings=reasons.length?[]:escortedBindings(identity,m,state);
  // Prior drafts must still reference currently verified bindings and the same account/chat.
  const existingDrafts=Object.values(state.reviews).filter(r=>r.accountId===m.accountId&&r.chatJid===m.chatJid&&r.classification==='ORDER_DRAFT'&&!state.occurrences[r.sourceOccurrenceId]?.conflicted&&r.authorizationVersion===state.epoch).map(r=>r.candidate);
  const existingAssignments=Object.values(state.reviews).filter(r=>r.accountId===m.accountId&&r.chatJid===m.chatJid&&r.assignmentProposal).map(r=>r.assignmentProposal);
  const approvedVesselAliases=verified(state,'vesselAlias').filter(r=>vesselAliasSchema.parse(r.data).accountId===m.accountId).map(r=>({...vesselAliasSchema.parse(r.data),decision:'APPROVED',approver:r.ownerProof!.decisionId,evidenceSha:r.ownerProof!.evidenceSha}));
  const result=qualify({accountId:m.accountId,chatJid:m.chatJid,senderJid:m.senderJid,nativeMessageId:m.nativeMessageId,text:m.payload.text,direction:m.direction,timestamp:m.sourceTimestamp,quotedMessageId:m.quotedMessageId,forwarded:m.forwarded,media:m.media},{bindings,existingDrafts,existingAssignments,approvedVesselAliases});
  return result.items.map((item,i)=>{const review=base(item.fields??{},item.classification,item.reasons,item,i);review.linkedDraftId=Object.values(state.reviews).find(r=>r.candidate.id===item.linkedDraftId)?.id??null;review.assignmentProposal=item.assignmentProposal;review.assignmentState=item.assignmentState;return review;});
 }
 return [base({},'REVIEW',m.direction==='OUTGOING'&&['ACCOUNTS','PAYROLL','SETTLEMENT'].includes(domain)?['SEND_SUCCESS_UNVERIFIED','FINANCIAL_WRITER_DISABLED']:[])];
}

/** Adapted conflict-safe field merge; confidence can suggest a correction, not approve it. */
export function mergeEvidenceField(fields:Record<string,{value:unknown;explicit:boolean;sourceRef:string}>,name:string,incoming:{value:unknown;explicit:boolean;sourceRef:string},systemGenerated=false){
 if(systemGenerated)return {fields:structuredClone(fields),conflict:false,reason:'SYSTEM_GENERATED_REJECTED'};
 const previous=fields[name];
 if(!previous)return {fields:{...structuredClone(fields),[name]:structuredClone(incoming)},conflict:false,reason:'FIRST_SOURCE_VALUE'};
 if(digest(previous.value)===digest(incoming.value))return {fields:structuredClone(fields),conflict:false,reason:'UNCHANGED'};
 return {fields:structuredClone(fields),conflict:true,reason:'CONFLICTING_SOURCE_VALUES',proposed:structuredClone(incoming)};
}
export function validateRegistryReferences(state:CandidateState,record:RegistryRecord){
 const personId='personId' in record.data?record.data.personId:null;
 if(personId){const p=state.registry[personId];if(!p||p.kind!=='person'||p.status!=='VERIFIED')return 'VERIFIED_PERSON_REQUIRED';personSchema.parse(p.data);}
 if(record.kind==='binding'){
  const b=bindingSchema.parse(record.data),native=nativePhoneOf(b.senderJid);
  if(!b.senderJid.endsWith('@lid')&&(!native||native!==b.phone))return 'NATIVE_PHONE_BINDING_CONFLICT';
  if(verified(state,'binding').some(r=>{const other=bindingSchema.parse(r.data);return r.id!==record.id&&other.accountId===b.accountId&&other.chatJid===b.chatJid&&other.senderJid===b.senderJid&&other.direction===b.direction&&Date.parse(other.validFrom)<(b.validTo?Date.parse(b.validTo):Infinity)&&Date.parse(b.validFrom)<(other.validTo?Date.parse(other.validTo):Infinity);}))return 'OVERLAPPING_BINDING_REVIEW_REQUIRED';
 }
 if(record.kind==='group'){const g=groupSchema.parse(record.data);if(verified(state,'group').some(r=>{const other=groupSchema.parse(r.data);return r.id!==record.id&&other.nativeJid===g.nativeJid&&other.accountIds.some(a=>g.accountIds.includes(a));}))return 'GROUP_ACCOUNT_BINDING_CONFLICT';}
 return null;
}
export type {Capability,RegistryRecord};

export function routeMessage(state:CandidateState,m:NativeMessageEnvelopeV1,occurrenceId:string,sourceRevision:number,actorId:string,sourceOverrides:Record<string,unknown>={}){return integrateConversation(state,m,occurrenceId,sourceRevision,actorId,sourceOverrides).reviews;}
