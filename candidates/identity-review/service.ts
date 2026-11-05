import {manualRequest,prepareImport,confirmImport,downloadOriginalFile} from './reconciliation-imports.ts';
import {reconciliationRead,reconciliationDecision,manageOwnerEntity} from './reconciliation.ts';
import {cashAccess,createCashEntry,postCashEntry} from './cash-commands.ts';
import {readBusinessRegister} from './business-register.ts';
import {readHistoryExtractions,type HistorySourceVerifier} from './history-extractions.ts';
import {historyStatus,prepareHistoryPull,commitHistoryPull} from './history-sync.ts';
import type {StoredHistoryPage} from './stored-history-mcp.ts';
type HistoryReader=(accountId:string,chatJid:string,after:string)=>Promise<StoredHistoryPage>;
import {readWorkspace} from './workspace.ts';
import {conversationSubjects} from './conversation-subjects.ts';
import {CALL_POLICY_LEASE_MS,setting,changeSetting,requireCallPolicyActor,applyCallCommand,callPolicyStillAuthorized,mirrorCallEvidence,disabledCallGateway} from './call-policy.ts';
import type {CallGateway} from './call-policy.ts';
import {integrateFrontend,readConversationOutcome,revalidateConversationReceipts,suppressConversation} from './conversation-integration.ts';
import {parseEscortOrder} from '../../lib/escort-intake-candidate.mjs';
import {norm} from '../../lib/programs.ts';
const parseAllocationOrder=parseEscortOrder as unknown as (text:string,options:{messageDate:string})=>Array<{startLine:number;fields:Record<string,string>;reasons:string[]}>;
import type {ProgramCommand,ProgramCommandContext,ProgramCommandBoundary,ProgramPreview} from '../../lib/program-command-boundary.ts';
import type {CandidateSqlClient} from './repository.ts';
import {lifecycleIntent,normalizeEmployeeMobile as canonicalEmployeeMobile} from '../../lib/employee-program-validation.mjs';
import {committedRosterProjection,type RosterContextReader} from './roster-context.ts';
import {randomBytes} from 'node:crypto';
import {validatePage} from './native-intake.ts';
import type {NativeBinding,NativeRecord} from './native-intake.ts';
function nativeReceiptSource(r:NativeRecord,binding:NativeBinding,accountId:string){const {envelope,status,reason,...original}=r;void envelope;void status;void reason;return {...original,nativeScope:binding,accountId};}
import {z} from 'zod';
import {ACTIVATION,CandidateError,digest,hash,nativeEnvelopeSchema,occurrenceKey,occurrencePayload,ownerProof,registrySchemas,domains} from './contracts.ts';
import type {Domain,OwnerProof,RegistryKind,RegistryRecord,ReviewItemV1,Scope,NativeMessageEnvelopeV1} from './contracts.ts';
import {authenticate,issueSession,validPasswordHash,verifyPassword} from './auth.ts';
import type {Credentials} from './auth.ts';
import type {CandidateRepository,CandidateState,StaffAccount} from './repository.ts';
import {authorize,routeMessage,resolveIdentity,validateRegistryReferences} from './routing.ts';

export type NativeVisibilityResolver=(references:Array<{occurrenceId:string;accountId:string;chatJid:string;sequence:string}>)=>Promise<Record<string,'VISIBLE'|'REVOKED'|'SUPPRESSED'|'UNKNOWN'>>;
export type NativeSourceReader=(source:Record<string,unknown>)=>Promise<string|null>;
export type ApprovalVerifier=(proof:OwnerProof,payloadDigest:string,purpose:string)=>Promise<boolean>;
export const denyApproval:ApprovalVerifier=async()=>false;
export type Manifest={version:'identity-review-provisioning-v1';registry:Array<{kind:RegistryKind;data:unknown}>;staff:StaffAccount[]};
const usernameSchema=z.string().regex(/^[a-z][a-z0-9_.-]{2,39}$/);
function requireVersion(actual:number,expected:number){if(!Number.isSafeInteger(expected)||actual!==expected)throw new CandidateError('VERSION_CONFLICT',409);}
function audit(s:CandidateState,at:number,actor:string,action:string,resourceId:string,version:number,reason='COMMITTED'){
 const events=Object.values(s.audit).sort((a,b)=>a.id.localeCompare(b.id));const previousHash=events.at(-1)?.hash??'0'.repeat(64);
 const entry={id:String(events.length+1).padStart(12,'0'),at:new Date(at).toISOString(),actorId:actor,action,resourceId,version,reason,previousHash};s.audit[entry.id]={...entry,hash:digest(entry)};
}
function allowed(s:CandidateState,actorId:string,capability:string,scope:Scope,channel:'STAFF'|'WHATSAPP'='STAFF'){
 const result=authorize(s,actorId,channel,capability,scope);if(!result.allowed)throw new CandidateError(result.reason,403);return result;
}
function registryScope(accountId:string):Scope{return {accountId,domain:'IDENTITY',chatJid:null,resourceId:null};}
function reviewScope(r:ReviewItemV1):Scope{return {accountId:r.accountId,domain:r.domain,chatJid:r.chatJid,resourceId:r.id};}
function boundedState(s:CandidateState){
 if(Object.values(s).reduce<number>((n,v)=>n+(typeof v==='object'?Object.keys(v).length:0),0)>5000||Buffer.byteLength(JSON.stringify(s))>32*1024*1024)throw new CandidateError('CANDIDATE_CAPACITY_REVIEW_REQUIRED',503);
}
function checkRegistryAccount(data:RegistryRecord['data'],accountId:string){
 if('accountId' in data&&data.accountId!==accountId||'scope' in data&&data.scope.accountId!==accountId||'accountIds' in data&&!data.accountIds.includes(accountId))throw new CandidateError('REGISTRY_ACCOUNT_MISMATCH',403);
}
function registryVisible(s:CandidateState,r:RegistryRecord,accountId:string,actorId:string){
 const data=r.data;
 if('accountId' in data)return data.accountId===accountId;
 if('scope' in data)return data.scope.accountId===accountId;
 if('accountIds' in data)return data.accountIds.includes(accountId);
 const personId=r.kind==='person'?r.id:'personId' in data?data.personId:null;
 return r.createdBy===actorId||!!personId&&Object.values(s.registry).some(v=>v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===personId&&('accountId' in v.data&&v.data.accountId===accountId||'scope' in v.data&&v.data.scope.accountId===accountId));
}
function requireAffectedAccounts(s:CandidateState,actor:string,capability:string,r:RegistryRecord,requestedAccount:string){
 const accounts=new Set([requestedAccount]);
 if('accountIds' in r.data)for(const a of r.data.accountIds)accounts.add(a);
 const personId=r.kind==='person'?r.id:r.kind==='relationship'&&'personId' in r.data?r.data.personId:null;
 if(personId)for(const v of Object.values(s.registry).filter(v=>v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===personId)){
  if('accountId' in v.data)accounts.add(v.data.accountId);if('scope' in v.data)accounts.add(v.data.scope.accountId);
 }
 for(const accountId of accounts)allowed(s,actor,capability,registryScope(accountId));
}
function canReview(s:CandidateState,actorId:string,capability:string,r:ReviewItemV1){return r.requiredDomains.every(domain=>authorize(s,actorId,'STAFF',capability,{...reviewScope(r),domain}).allowed);}
function reviewDto(r:ReviewItemV1,s?:CandidateState,visibility?:Record<string,string>):ReviewItemV1{const item={...structuredClone(r),candidate:{}};if(s?.nativeSuppression[r.sourceOccurrenceId]){item.fields={};item.note='';item.identityClaimId=undefined;item.assignmentProposal=null;item.linkedDraftId=null;item.status='REVIEW';item.classification='REVIEW';item.reasons=['OWNER_CONTENT_SUPPRESSED'];}else if(s?.occurrences[r.sourceOccurrenceId]?.nativeReference&&(!visibility||!['VISIBLE','REVOKED'].includes(visibility[r.sourceOccurrenceId]))){item.fields={};item.note='';item.identityClaimId=undefined;item.candidate={};item.assignmentProposal=null;item.linkedDraftId=null;item.status='REVIEW';item.classification='REVIEW';item.reasons=['NATIVE_VISIBILITY_UNVERIFIED'];}else if(visibility?.[r.sourceOccurrenceId]==='REVOKED'){item.status='REVIEW';item.assignmentProposal=null;item.reasons=[...new Set([...item.reasons,'NATIVE_REVOKE_OBSERVED'])];}return item;}

export class IdentityReviewService{
 async manualRequest(credentials:Credentials,input:unknown){return this.#repo.transaction((s,c)=>manualRequest(s,credentials,input,this.#clock(),c));}
 async prepareImport(credentials:Credentials,input:unknown){return this.#repo.transaction((s,c)=>prepareImport(s,credentials,input,this.#clock(),c));}
 async confirmImport(credentials:Credentials,input:unknown){return this.#repo.transaction((s,c)=>confirmImport(s,credentials,input,this.#clock(),c));}
 async downloadOriginalFile(credentials:Credentials,id:string){return this.#repo.transaction((s,c)=>downloadOriginalFile(s,credentials,id,this.#clock(),c));}

 async reconciliationRead(credentials:Credentials,input:unknown){return this.#repo.transaction((s,c)=>reconciliationRead(s,credentials,input,this.#clock(),c));}
 async reconciliationDecision(credentials:Credentials,input:unknown){return this.#repo.transaction((s,c)=>reconciliationDecision(s,credentials,input,this.#clock(),c));}
 async manageOwnerEntity(credentials:Credentials,input:unknown){return this.#repo.transaction((s,c)=>manageOwnerEntity(s,credentials,input,this.#clock(),c));}

 async cashAccess(credentials:Credentials){return this.#repo.transaction(s=>cashAccess(s,credentials,this.#clock()));}
 async createCashEntry(credentials:Credentials,input:unknown){return this.#repo.transaction((s,client)=>createCashEntry(s,credentials,input,this.#clock(),client));}
 async postCashEntry(credentials:Credentials,input:unknown){return this.#repo.transaction((s,client)=>postCashEntry(s,credentials,input,this.#clock(),client));}
 async historyStatus(credentials:Credentials,accountId:string){return this.#repo.transaction(s=>historyStatus(s,credentials,accountId,this.#clock()));}
 async historyPull(credentials:Credentials,input:{accountId:string;chatJid:string;rescan:boolean}){
  if(process.env.ALRIFAI_OWNER_RECONCILIATION==='1')throw new CandidateError('USE_OWNER_RECONCILIATION_NO_AUTOMATIC_HISTORICAL_WRITES',409);
  if(!this.#historyReader)throw new CandidateError('HISTORY_READER_UNAVAILABLE',503);
  const context=await this.#repo.transaction(s=>prepareHistoryPull(s,credentials,input,this.#clock()));
  const page=await this.#historyReader(input.accountId,input.chatJid,context.after);
  return this.#repo.transaction((s,client)=>commitHistoryPull(s,credentials,input,context,page,this.#clock(),client,this.#historySourceVerifier));
 }
 #historyReader?:HistoryReader;
 async historyExtractions(credentials:Credentials,input:unknown){return this.#repo.transaction((s,client)=>readHistoryExtractions(s,credentials,input,this.#clock,client,this.#historySourceVerifier));}
 #historySourceVerifier?:HistorySourceVerifier;
 async businessRegister(credentials:Credentials,input:unknown){return this.#repo.transaction((s,client)=>readBusinessRegister(s,credentials,input,this.#clock,client,this.#historySourceVerifier));}
 async workspaceData(credentials:Credentials,input:unknown){return this.#repo.transaction((s,client)=>readWorkspace(s,credentials,input,this.#clock,client));}
 async conversationSubjects(credentials:Credentials,accountId:string){return this.#repo.transaction(s=>conversationSubjects(s,credentials,accountId,this.#clock()));}

 #callWhatsAppControl:boolean;#callGateway:CallGateway;#commands?:ProgramCommandBoundary;#commandFresh:(accountId:string,chatJid:string,sequence:string)=>Promise<boolean>;#rosterReader:RosterContextReader;#sourceReader:NativeSourceReader;#visibility:NativeVisibilityResolver;#repo:CandidateRepository;#clock:()=>number;#verify:ApprovalVerifier;#dummyHash:string;
 constructor(repository:CandidateRepository,{clock=Date.now,verifyApproval=denyApproval,dummyPasswordHash,nativeVisibility=async()=>({}),nativeSource=async()=>null,rosterReader=async()=>{throw new CandidateError('ROSTER_CONTEXT_NOT_CONFIGURED',503);},programCommands,commandFresh=async()=>false,callGateway=disabledCallGateway,whatsappCallControl=false,historySourceVerifier,historyReader}:{clock?:()=>number;verifyApproval?:ApprovalVerifier;dummyPasswordHash:string;nativeVisibility?:NativeVisibilityResolver;nativeSource?:NativeSourceReader;rosterReader?:RosterContextReader;programCommands?:ProgramCommandBoundary;commandFresh?:(accountId:string,chatJid:string,sequence:string)=>Promise<boolean>;callGateway?:CallGateway;whatsappCallControl?:boolean;historySourceVerifier?:HistorySourceVerifier;historyReader?:HistoryReader}){
  if(!validPasswordHash(dummyPasswordHash))throw new CandidateError('VALID_DUMMY_HASH_REQUIRED');
  this.#historyReader=historyReader;this.#historySourceVerifier=historySourceVerifier;this.#callWhatsAppControl=whatsappCallControl;this.#callGateway=callGateway;this.#commands=programCommands;this.#commandFresh=commandFresh;this.#rosterReader=rosterReader;this.#sourceReader=nativeSource;this.#repo=repository;this.#visibility=nativeVisibility;this.#clock=clock;this.#verify=verifyApproval;this.#dummyHash=dummyPasswordHash;
 }
 /** Not an HTTP endpoint. No default bootstrap, implicit role, or live provisioning. */
 async provisionOffline(manifest:Manifest,proof:OwnerProof){
  if(manifest.version!=='identity-review-provisioning-v1'||manifest.registry.length>200||manifest.staff.length>10)throw new CandidateError('PROVISIONING_MANIFEST_INVALID');
  const parsedProof=ownerProof.parse(proof),pin=digest(manifest);
  if(!await this.#verify(parsedProof,pin,'PROVISION_OFFLINE'))throw new CandidateError('OWNER_APPROVAL_UNVERIFIED',403);
  return this.#repo.transaction(s=>{
   if(Object.keys(s.registry).length||Object.keys(s.staff).length)throw new CandidateError('BOOTSTRAP_ALREADY_EXISTS',409);
   for(const {kind,data} of manifest.registry){if(!Object.hasOwn(registrySchemas,kind))throw new CandidateError('REGISTRY_KIND_INVALID');const parsed=registrySchemas[kind].parse(data);if(s.registry[parsed.id])throw new CandidateError('DUPLICATE_REGISTRY_ID',409);const record:RegistryRecord={id:parsed.id,kind,data:parsed,version:1,status:'VERIFIED',createdBy:'OWNER_APPROVED_OFFLINE_PROVISIONING',updatedAt:new Date(this.#clock()).toISOString(),ownerProof:parsedProof};const conflict=validateRegistryReferences(s,record);if(conflict)throw new CandidateError(conflict,409);s.registry[record.id]=record;s.registryHistory[record.id+':1']=structuredClone(record);}
   for(const a of manifest.staff){usernameSchema.parse(a.username);if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(a.id)||['__proto__','constructor','prototype'].includes(a.id)||!validPasswordHash(a.passwordHash)||a.version!==1||!a.active||!a.approvalRef||s.registry[a.personId]?.kind!=='person'||s.registry[a.personId]?.status!=='VERIFIED'||Object.values(s.staff).some(old=>old.username===a.username)||Object.hasOwn(s.staff,a.id))throw new CandidateError('STAFF_PROVISIONING_INVALID');s.staff[a.id]=structuredClone(a);}
   audit(s,this.#clock(),'OWNER_APPROVED_OFFLINE_PROVISIONING','PROVISION',pin,1);boundedState(s);return {registryCount:Object.keys(s.registry).length,staffCount:Object.keys(s.staff).length,activation:ACTIVATION};
  });
 }
 async login(username:string,password:string,clientAddress:string){
  const now=this.#clock(),normalized=username.toLowerCase(),attemptKey=hash(normalized+'|'+clientAddress),ipKey=hash('ip|'+clientAddress);
  usernameSchema.parse(normalized);if(clientAddress.length>150)throw new CandidateError('LOGIN_CONTEXT_INVALID');
  return this.#repo.transaction(async s=>{
   for(const k of [attemptKey,ipKey])if(s.attempts[k]?.until>now&&s.attempts[k].failures>=5)return {ok:false as const,code:'LOGIN_THROTTLED',status:429};
   const account=Object.values(s.staff).find(a=>a.username===normalized);
   const valid=await verifyPassword(password,account?.passwordHash??this.#dummyHash);
   if(!valid||!account?.active||s.registry[account.personId]?.status!=='VERIFIED'){
    for(const k of [attemptKey,ipKey]){const prior=s.attempts[k];s.attempts[k]={failures:prior&&prior.until>now?prior.failures+1:1,until:prior&&prior.until>now?prior.until:now+15*60*1000};}
    audit(s,now,'UNAUTHENTICATED','LOGIN_DENIED',attemptKey,0,'CREDENTIALS_DENIED');boundedState(s);return {ok:false as const,code:'CREDENTIALS_DENIED',status:401};
   }
   delete s.attempts[attemptKey];
   for(const [key,session] of Object.entries(s.sessions))if(now>=session.expiresAt||now-session.lastSeen>=30*60*1000)delete s.sessions[key];
   const own=Object.values(s.sessions).filter(v=>v.accountId===account.id).sort((a,b)=>a.createdAt-b.createdAt);
   while(own.length>=3)delete s.sessions[own.shift()!.id];
   const session=issueSession(s,account,now);audit(s,now,account.personId,'LOGIN',session.personId,account.version);boundedState(s);return {ok:true as const,...session,authorizationVersion:s.epoch};
  });
 }
 async me(credentials:Credentials){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());return {personId:a.personId,username:a.username,authorizationVersion:s.epoch,activation:ACTIVATION,qualifiedProgramCommands:!!this.#commands&&Object.values(s.registry).some(v=>v.kind==='relationship'&&v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===a.personId&&'kind' in v.data&&['ADMIN','SUPER_ADMIN'].includes(v.data.kind))};});}
 async logout(credentials:Credentials){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);delete s.sessions[a.session.id];audit(s,this.#clock(),a.personId,'LOGOUT',a.personId,1);return {loggedOut:true};});}
 async registry(credentials:Credentials,accountId:string,offset=0){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());allowed(s,a.personId,'identity.read',registryScope(accountId));const records=Object.values(s.registry).filter(r=>registryVisible(s,r,accountId,a.personId));return {authorizationVersion:s.epoch,records:records.slice(offset,offset+25),total:records.length,nextOffset:offset+25<records.length?offset+25:null};});}
 async propose(credentials:Credentials,accountId:string,kind:RegistryKind,data:unknown,expectedVersion:number,expectedEpoch:number){
  if(!Object.hasOwn(registrySchemas,kind))throw new CandidateError('REGISTRY_KIND_INVALID');const parsed=registrySchemas[kind].parse(data);
  return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);allowed(s,a.personId,'identity.propose',registryScope(accountId));requireVersion(s.epoch,expectedEpoch);checkRegistryAccount(parsed,accountId);const old=s.registry[parsed.id];if(old){requireVersion(old.version,expectedVersion);if(old.kind!==kind)throw new CandidateError('REGISTRY_KIND_CONFLICT',409);checkRegistryAccount(old.data,accountId);if(!registryVisible(s,old,accountId,a.personId))throw new CandidateError('REGISTRY_ACCOUNT_MISMATCH',403);requireAffectedAccounts(s,a.personId,'identity.propose',old,accountId);}else requireVersion(0,expectedVersion);
   const r:RegistryRecord={id:parsed.id,kind,data:parsed,version:(old?.version??0)+1,status:'PENDING',createdBy:old?.createdBy??a.personId,updatedAt:new Date(this.#clock()).toISOString(),ownerProof:null};s.registry[r.id]=r;s.registryHistory[r.id+':'+r.version]=structuredClone(r);s.epoch++;audit(s,this.#clock(),a.personId,'REGISTRY_PROPOSE',r.id,r.version);boundedState(s);return {record:r,authorizationVersion:s.epoch,approvalDigest:digest({kind:r.kind,data:r.data,version:r.version})};});
 }
 async verify(credentials:Credentials,accountId:string,id:string,expectedVersion:number,expectedEpoch:number,proof:OwnerProof){
  const parsedProof=ownerProof.parse(proof);
  return this.#repo.transaction(async s=>{const a=authenticate(s,credentials,this.#clock(),true);allowed(s,a.personId,'identity.verify',registryScope(accountId));requireVersion(s.epoch,expectedEpoch);const r=s.registry[id];if(!r)throw new CandidateError('NOT_FOUND',404);requireVersion(r.version,expectedVersion);checkRegistryAccount(r.data,accountId);if(!registryVisible(s,r,accountId,a.personId))throw new CandidateError('REGISTRY_ACCOUNT_MISMATCH',403);requireAffectedAccounts(s,a.personId,'identity.verify',r,accountId);if(r.status!=='PENDING')throw new CandidateError('PENDING_PROPOSAL_REQUIRED',409);
   const pin=digest({kind:r.kind,data:r.data,version:r.version});if(!await this.#verify(parsedProof,pin,'REGISTRY_VERIFY'))throw new CandidateError('OWNER_APPROVAL_UNVERIFIED',403);const conflict=validateRegistryReferences(s,r);if(conflict)throw new CandidateError(conflict,409);
   r.status='VERIFIED';r.version++;r.ownerProof=parsedProof;r.updatedAt=new Date(this.#clock()).toISOString();s.registryHistory[r.id+':'+r.version]=structuredClone(r);s.epoch++;audit(s,this.#clock(),a.personId,'REGISTRY_VERIFY',r.id,r.version);return {record:r,authorizationVersion:s.epoch};});
 }
 async revoke(credentials:Credentials,accountId:string,id:string,expectedVersion:number,expectedEpoch:number){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);allowed(s,a.personId,'identity.revoke',registryScope(accountId));requireVersion(s.epoch,expectedEpoch);const r=s.registry[id];if(!r)throw new CandidateError('NOT_FOUND',404);requireVersion(r.version,expectedVersion);checkRegistryAccount(r.data,accountId);if(!registryVisible(s,r,accountId,a.personId))throw new CandidateError('REGISTRY_ACCOUNT_MISMATCH',403);requireAffectedAccounts(s,a.personId,'identity.revoke',r,accountId);r.status='REVOKED';r.version++;r.updatedAt=new Date(this.#clock()).toISOString();s.registryHistory[r.id+':'+r.version]=structuredClone(r);s.epoch++;audit(s,this.#clock(),a.personId,'REGISTRY_REVOKE',r.id,r.version);return {record:r,authorizationVersion:s.epoch};});}
 async reviews(credentials:Credentials,accountId:string,domain:Domain,offset=0){return this.#repo.transaction(async s=>{const a=authenticate(s,credentials,this.#clock());z.enum(domains).parse(domain);const items=Object.values(s.reviews).filter(r=>r.accountId===accountId&&r.domain===domain&&canReview(s,a.personId,'review.read',r));if(!authorize(s,a.personId,'STAFF','review.read',{accountId,domain,chatJid:null,resourceId:null}).allowed&&!items.length)throw new CandidateError('CAPABILITY_DENIED',403);const visibility=await this.#checkVisible(s,items.slice(offset,offset+25));authenticate(s,credentials,this.#clock());if(items.slice(offset,offset+25).some(r=>!canReview(s,a.personId,'review.read',r)))throw new CandidateError('CAPABILITY_DENIED',403);return {authorizationVersion:s.epoch,items:items.slice(offset,offset+25).map(r=>reviewDto(r,s,visibility)),total:items.length,nextOffset:offset+25<items.length?offset+25:null};});}
 async review(credentials:Credentials,id:string){return this.#repo.transaction(async s=>{const a=authenticate(s,credentials,this.#clock());const r=s.reviews[id];if(!r)throw new CandidateError('NOT_FOUND',404);if(!canReview(s,a.personId,'review.read',r))throw new CandidateError('CAPABILITY_DENIED',403);const visibility=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock());return {item:reviewDto(r,s,visibility),authorizationVersion:s.epoch};});}
 async reviewHistory(credentials:Credentials,id:string){return this.#repo.transaction(async s=>{const a=authenticate(s,credentials,this.#clock());const current=s.reviews[id];if(!current)throw new CandidateError('NOT_FOUND',404);if(!canReview(s,a.personId,'review.read',current))throw new CandidateError('CAPABILITY_DENIED',403);const visibility=await this.#checkVisible(s,[current]);authenticate(s,credentials,this.#clock());return {versions:Object.values(s.reviewHistory).filter(r=>r.id===id).sort((a,b)=>a.revision-b.revision).map(r=>reviewDto(r,s,visibility))};});}
 async registryHistory(credentials:Credentials,accountId:string,id:string){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());allowed(s,a.personId,'identity.read',registryScope(accountId));const r=s.registry[id];if(!r||!registryVisible(s,r,accountId,a.personId))throw new CandidateError('NOT_FOUND',404);return {versions:Object.values(s.registryHistory).filter(v=>v.id===id),groupObservations:r.kind==='group'?Object.values(s.observations).filter(o=>{const v=o as {accountId:string;nativeJid:string};return v.accountId===accountId&&'nativeJid' in r.data&&v.nativeJid===r.data.nativeJid;}):[]};});}
 async updateReview(credentials:Credentials,id:string,input:{expectedVersion:number;expectedEpoch:number;operationId:string;note:string}){
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId)||input.note.length>2000)throw new CandidateError('REVIEW_UPDATE_INVALID');
  return this.#repo.transaction(async s=>{const a=authenticate(s,credentials,this.#clock(),true);const r=s.reviews[id];if(!r)throw new CandidateError('NOT_FOUND',404);allowed(s,a.personId,'review.update',reviewScope(r));if(!canReview(s,a.personId,'review.read',r))throw new CandidateError('CAPABILITY_DENIED',403);if(r.createdBy!==a.personId)throw new CandidateError('OWN_PENDING_REVIEW_REQUIRED',403);const visibility=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock(),true);if(s.occurrences[r.sourceOccurrenceId]?.nativeReference&&visibility[r.sourceOccurrenceId]!=='VISIBLE'&&visibility[r.sourceOccurrenceId]!=='REVOKED')throw new CandidateError('NATIVE_VISIBILITY_UNVERIFIED',409);const operationKey=digest([a.personId,input.operationId]),pin=digest({id,...input}),prior=s.operations[operationKey];if(prior){if(prior.payloadHash!==pin)throw new CandidateError('OPERATION_PAYLOAD_CONFLICT',409);const previous=prior.result as {item:ReviewItemV1;authorizationVersion:number};return {replay:true,result:{...previous,item:reviewDto(previous.item,s,visibility)}};}
   requireVersion(s.epoch,input.expectedEpoch);requireVersion(r.revision,input.expectedVersion);r.revision++;r.note=input.note;r.status='UPDATED';r.authorizationVersion=s.epoch;s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);audit(s,this.#clock(),a.personId,'REVIEW_UPDATE',r.id,r.revision);const result={item:reviewDto(r,s,visibility),authorizationVersion:s.epoch};s.operations[operationKey]={payloadHash:pin,result:structuredClone(result)};boundedState(s);return {replay:false,result};});
 }
 /** A scoped source view; no candidate parser internals or quoted bodies are exposed. */
 async reviewSource(credentials:Credentials,id:string,includeContent=false){return this.#repo.transaction(async s=>{
  const a=authenticate(s,credentials,this.#clock()),r=s.reviews[id];if(!r)throw new CandidateError('NOT_FOUND',404);
  if(!canReview(s,a.personId,'review.read',r)||includeContent&&!canReview(s,a.personId,'evidence.read',r))throw new CandidateError('CAPABILITY_DENIED',403);
  const visibility=await this.#checkVisible(s,[r]),visible=!s.nativeSuppression[r.sourceOccurrenceId]&&['VISIBLE','REVOKED'].includes(visibility[r.sourceOccurrenceId]);
  const receipts=Object.values(s.nativeReceipts).filter(v=>v.occurrenceId===r.sourceOccurrenceId);
  const refs=receipts.slice(0,10).map(v=>{const x=v.source as Record<string,unknown>;return {reference:v.sourceReference,sequence:x.sequence,accountId:x.accountId,chatJid:x.chatJid,messageId:x.messageId,senderJid:x.senderJid,participant:x.participant,kind:x.kind,sourceTime:x.sourceTime,envelopeHash:x.envelopeHash};});
  const occurrence=s.occurrences[r.sourceOccurrenceId],identity=occurrence?resolveIdentity(s,occurrence.envelope):null;
  const identityAllowed=!!identity?.personId&&authorize(s,a.personId,'STAFF','identity.read',{accountId:r.accountId,domain:'IDENTITY',chatJid:r.chatJid,resourceId:identity.personId}).allowed;
  const claim=r.identityClaimId?s.identityClaims[r.identityClaimId]:undefined;
  let text:string|null=null;
  if(includeContent&&visible){const receipt=[...receipts].reverse().find(v=>(v.source as Record<string,unknown>).contentHash);if(receipt)text=await this.#sourceReader(receipt.source as Record<string,unknown>);}
  // The current source barrier and session must still hold after external I/O.
  const latest=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock());
  if(!canReview(s,a.personId,'review.read',r)||includeContent&&!canReview(s,a.personId,'evidence.read',r))throw new CandidateError('CAPABILITY_DENIED',403);
  const current=!s.nativeSuppression[r.sourceOccurrenceId]&&['VISIBLE','REVOKED'].includes(latest[r.sourceOccurrenceId]);
  return {references:refs,content:current?text:null,visibility:latest[r.sourceOccurrenceId]??'UNKNOWN',identity:current?{state:claim?(claim.status==='VERIFIED'?'VERIFIED_CLAIM':'CLAIMED'):identity?.state??'UNRESOLVED',transportPersonId:identityAllowed?identity?.personId:null,verifiedPersonId:claim?.verifiedPersonId&&authorize(s,a.personId,'STAFF','identity.read',{accountId:r.accountId,domain:'IDENTITY',chatJid:r.chatJid,resourceId:String(claim.verifiedPersonId)}).allowed?claim.verifiedPersonId:null,claimedLabel:claim?.claimedLabel??null,borrowedPhone:claim?.borrowedPhone??false}:null,authorizationVersion:s.epoch};
 });}
 /** Explicit program approval is distinct from Review correction. No default executor. */
 #commandActor(s:CandidateState,credentials:Credentials,r:ReviewItemV1,capability:string,mutation=true){
  const a=authenticate(s,credentials,this.#clock(),mutation);
  if(!this.#commands)throw new CandidateError('PROGRAM_COMMANDS_DISABLED',503);
  if(!Object.values(s.registry).some(v=>v.kind==='relationship'&&v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===a.personId&&'kind' in v.data&&['ADMIN','SUPER_ADMIN'].includes(v.data.kind)))throw new CandidateError('NAMED_ADMIN_REQUIRED',403);
  if(!canReview(s,a.personId,'review.read',r)||!canReview(s,a.personId,'evidence.read',r))throw new CandidateError('CAPABILITY_DENIED',403);
  allowed(s,a.personId,capability,reviewScope(r));
  if(r.domain!=='ESCORT'||r.requiredDomains.some(d=>d!=='ESCORT'))throw new CandidateError('ESCORT_DRAFT_REQUIRED',409);
  return a;
 }
 async #commandSource(s:CandidateState,credentials:Credentials,r:ReviewItemV1){
  const visibility=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock(),true);
  const occurrence=s.occurrences[r.sourceOccurrenceId];
  if(!occurrence?.nativeReference||occurrence.conflicted||occurrence.revision!==r.sourceRevision||s.nativeSuppression[r.sourceOccurrenceId]||visibility[r.sourceOccurrenceId]!=='VISIBLE')throw new CandidateError('COMMAND_SOURCE_NOT_CURRENT',409);
  const identity=resolveIdentity(s,occurrence.envelope),claim=r.identityClaimId?s.identityClaims[r.identityClaimId]:undefined;
  if(claim?claim.status!=='VERIFIED':identity.state!=='VERIFIED')throw new CandidateError('COMMAND_SOURCE_IDENTITY_UNVERIFIED',409);
  const personId=claim?String(claim.verifiedPersonId):identity.personId;
  if(!personId||s.registry[personId]?.status!=='VERIFIED')throw new CandidateError('COMMAND_SOURCE_IDENTITY_UNVERIFIED',409);
  const receipts=Object.values(s.nativeReceipts).filter(v=>v.occurrenceId===r.sourceOccurrenceId&&v.disposition!=='CONFLICT_REVIEW');
  const receipt=receipts.at(-1);if(!receipt||(receipt.source as Record<string,unknown>).contentHash==null)throw new CandidateError('SOURCE_REFERENCE_REQUIRED',409);
  return {occurrence,receipt,personId};
 }
 async #commandContext(s:CandidateState,credentials:Credentials,r:ReviewItemV1,command:ProgramCommand,expectedProgramVersion:number):Promise<ProgramCommandContext>{
  const a=this.#commandActor(s,credentials,r,'escort.command.approve'),src=await this.#commandSource(s,credentials,r);
  const nativeReceipts=Object.values(s.nativeReceipts).filter(v=>(v.source as Record<string,unknown>).accountId===r.accountId&&(v.source as Record<string,unknown>).chatJid===r.chatJid);
  const sequence=nativeReceipts.reduce((max,v)=>BigInt(String((v.source as Record<string,unknown>).sequence))>BigInt(max)?String((v.source as Record<string,unknown>).sequence):max,'0');
  if(!await this.#commandFresh(r.accountId,r.chatJid,sequence))throw new CandidateError('INTAKE_BEHIND_NATIVE_SOURCE',409);
  let allocation:ProgramCommandContext['allocation'];
  if(command.action==='ALLOCATE_DRAFT'){
   if(r.status==='NEEDS_CLARIFICATION'||src.occurrence.envelope.chatType!=='direct'||src.occurrence.envelope.direction!=='INCOMING'||src.occurrence.envelope.eventType!=='TEXT'||src.occurrence.envelope.media.length||!Object.values(s.reviewHistory).some(v=>v.id===r.id&&v.classification==='ORDER_DRAFT'))throw new CandidateError('REVIEWED_CLIENT_DRAFT_REQUIRED',409);
   allowed(s,a.personId,'identity.read',{accountId:r.accountId,domain:'IDENTITY',chatJid:r.chatJid,resourceId:src.personId});
   const relations=Object.values(s.registry).filter(v=>v.kind==='relationship'&&v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===src.personId&&'kind' in v.data&&v.data.kind==='CLIENT');
   if(relations.length!==1||!('clientId' in relations[0].data)||!relations[0].data.clientId)throw new CandidateError('VERIFIED_CLIENT_REQUIRED',409);
   allowed(s,src.personId,'escort.order.intake',reviewScope(r),'WHATSAPP');
   const text=await this.#sourceReader(src.receipt.source as Record<string,unknown>);if(text===null)throw new CandidateError('ORDER_EVIDENCE_UNAVAILABLE',409);
   const messageDate=new Date(Date.parse(src.occurrence.envelope.sourceTimestamp)+6*60*60*1000).toISOString().slice(0,10);
   const blocks=parseAllocationOrder(text,{messageDate});
   const selected=blocks.filter(b=>b.startLine===r.candidate.startLine);const block=selected[0];
   if(blocks.length>20||selected.length!==1||block.reasons.length||!block.fields.motherVessel||!block.fields.lighterVessel||blocks.filter(b=>norm(b.fields.lighterVessel??'')===norm(block.fields.lighterVessel)).length!==1)throw new CandidateError('AMBIGUOUS_ORDER_REVIEW_REQUIRED',409);
   if(/^\s*Program (?:ID|Reference)\s*:/im.test(text))throw new CandidateError('PROGRAM_REFERENCE_RECONCILIATION_REQUIRED',409);
   for(const k of ['motherVessel','lighterVessel'])if(typeof r.fields[k]!=='string'||norm(String(r.fields[k]))!==norm(block.fields[k]))throw new CandidateError('ORDER_VESSEL_EVIDENCE_CONFLICT',409);
   if(r.fields.clientId&&r.fields.clientId!==relations[0].data.clientId)throw new CandidateError('CLIENT_ORDER_REFERENCE_CONFLICT',409);
   const orderKey=digest(['canonical-escort-order-v1',r.accountId,r.chatJid,r.sourceOccurrenceId,block.startLine]);const programId='PRG-'+orderKey.slice(0,40);
   if(command.programId&&command.programId!==programId)throw new CandidateError('ALLOCATION_REFERENCE_CONFLICT',409);
   command={...command,programId};
   allocation={clientPersonId:src.personId,clientId:String(relations[0].data.clientId),clientVersion:s.registry[src.personId].version,senderJid:src.occurrence.envelope.senderJid,participantJid:src.occurrence.envelope.membershipEvidence?.participantJid??null,nativeMessageId:src.occurrence.envelope.nativeMessageId,sourceTimestamp:src.occurrence.envelope.sourceTimestamp,orderKey,startLine:block.startLine,rawMother:block.fields.motherVessel,rawLighter:block.fields.lighterVessel};
  }
  let employee:ProgramCommandContext['employee']=null;
  if(command.employeePersonId){
   allowed(s,a.personId,'identity.read',{accountId:r.accountId,domain:'IDENTITY',chatJid:r.chatJid,resourceId:command.employeePersonId});
   const person=s.registry[command.employeePersonId];
   if(person?.kind!=='person'||person.status!=='VERIFIED'||!('employeeReferences' in person.data)||!Object.values(s.registry).some(v=>v.kind==='relationship'&&v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===person.id&&'kind' in v.data&&v.data.kind==='EMPLOYEE'))throw new CandidateError('VERIFIED_EMPLOYEE_REQUIRED',409);
   const ids=[...new Set(person.data.employeeReferences.map(v=>v.mobile))];if(ids.length!==1)throw new CandidateError('EMPLOYEE_ID_UNRESOLVED',409);
   employee={personId:person.id,employeeId:ids[0],name:person.data.displayName,version:person.version};
  }
  let support:ProgramCommandContext['support'];
  if(command.evidenceReviewId){
   const proofReview=s.reviews[command.evidenceReviewId];if(!proofReview||proofReview.accountId!==r.accountId||!canReview(s,a.personId,'review.read',proofReview)||!canReview(s,a.personId,'evidence.read',proofReview))throw new CandidateError('STAGE_EVIDENCE_SCOPE_DENIED',403);
   if(proofReview.chatJid!==r.chatJid){const expectedDomain=command.action==='RELEASE'?'RELEASE':'ESCORT';const group=Object.values(s.registry).find(v=>v.kind==='group'&&v.status==='VERIFIED'&&'nativeJid' in v.data&&v.data.nativeJid===proofReview.chatJid&&'accountIds' in v.data&&v.data.accountIds.includes(r.accountId)&&'domain' in v.data&&v.data.domain===expectedDomain);if(!group)throw new CandidateError('STAGE_EVIDENCE_SCOPE_DENIED',403);
    const sequences=Object.values(s.nativeReceipts).filter(v=>(v.source as Record<string,unknown>).accountId===r.accountId&&(v.source as Record<string,unknown>).chatJid===proofReview.chatJid).map(v=>BigInt(String((v.source as Record<string,unknown>).sequence)));if(!await this.#commandFresh(r.accountId,proofReview.chatJid,String(sequences.reduce((a,b)=>a>b?a:b,0n))))throw new CandidateError('INTAKE_BEHIND_NATIVE_SOURCE',409);
   }
   const proof=await this.#commandSource(s,credentials,proofReview);if(proof.occurrence.envelope.media.length||proof.occurrence.envelope.eventType==='MEDIA')throw new CandidateError('STAGE_MEDIA_NOT_QUALIFIED',409);const text=await this.#sourceReader(proof.receipt.source as Record<string,unknown>);
   if(text===null)throw new CandidateError('STAGE_EVIDENCE_UNAVAILABLE',409);
   const line=(key:string)=>{const values=[...text.matchAll(new RegExp('^'+key+'\\s*:\\s*(.+)$','gim'))].map(m=>m[1].trim());if(values.length>1)throw new CandidateError('AMBIGUOUS_STAGE_EVIDENCE',409);return values[0]??'';};
   if(line('Program ID')!==command.programId)throw new CandidateError('WRONG_PROGRAM_EVIDENCE',409);
   const detected=lifecycleIntent(text),pending=/^\s*completion pending\s*$/im.test(text);const kind=pending?(detected?'AMBIGUOUS_LIFECYCLE_INTENT':'COMPLETION_PENDING'):detected;
   if(typeof kind!=='string'||!kind||kind==='AMBIGUOUS_LIFECYCLE_INTENT')throw new CandidateError('AMBIGUOUS_STAGE_EVIDENCE',409);
   support={reviewId:proofReview.id,reviewVersion:proofReview.revision,reference:String(proof.receipt.sourceReference),sourceHash:String((proof.receipt.source as Record<string,unknown>).contentHash),accountId:proofReview.accountId,chatJid:proofReview.chatJid,senderJid:proof.occurrence.envelope.senderJid,kind,effectiveDate:line('Effective Date'),employeeId:canonicalEmployeeMobile(line('Employee ID'),'employee_id'),endShift:line('End Shift')||null,releasePoint:line('Release Point')||null};
  }
  authenticate(s,credentials,this.#clock(),true);this.#commandActor(s,credentials,r,'escort.command.approve');
  return {reviewId:r.id,reviewVersion:r.revision,sourceOccurrenceId:r.sourceOccurrenceId,sourceRevision:src.occurrence.revision,sourceHash:String((src.receipt.source as Record<string,unknown>).contentHash),sourceReferences:[...r.sourceReferences??[]],accountId:r.accountId,chatJid:r.chatJid,actorId:a.personId,epoch:s.epoch,fields:structuredClone(r.fields),employee,...(allocation?{allocation}:{}),...(support?{support}:{}),expectedProgramVersion,command};
 }
 #programPeople(s:CandidateState,actorId:string,r:ReviewItemV1,preview:ProgramPreview){
  if(preview.context.allocation)allowed(s,actorId,'identity.read',{accountId:r.accountId,domain:'IDENTITY',chatJid:r.chatJid,resourceId:preview.context.allocation.clientPersonId});
  if(preview.context.support){const related=s.reviews[preview.context.support.reviewId];if(!related||!canReview(s,actorId,'review.read',related)||!canReview(s,actorId,'evidence.read',related))throw new CandidateError('STAGE_EVIDENCE_SCOPE_DENIED',403);}
  const ids=new Set([preview.ledger.employeePersonId,...preview.ledger.events.map(e=>(e.employee as {personId?:string}|null)?.personId),preview.context.employee?.personId].filter((v):v is string=>typeof v==='string'));
  for(const person of ids)allowed(s,actorId,'identity.read',{accountId:r.accountId,domain:'IDENTITY',chatJid:r.chatJid,resourceId:person});
 }
 async programHistory(credentials:Credentials,id:string,offset=0){return this.#repo.transaction(async s=>{
  const r=s.reviews[id];if(!r){authenticate(s,credentials,this.#clock());throw new CandidateError('NOT_FOUND',404);}const a=this.#commandActor(s,credentials,r,'escort.command.read',false);
  const approvals=Object.values(s.operations).map(o=>o.result as {kind?:string;id:string;reviewId:string;actorId:string;approvedAt:string;preview?:ProgramPreview}).filter(o=>o.kind==='EXPLICIT_PROGRAM_APPROVAL'&&o.reviewId===id);
  for(const approval of approvals)if(approval.preview)this.#programPeople(s,a.personId,r,approval.preview);
  const visibility=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock());this.#commandActor(s,credentials,r,'escort.command.read',false);
  if(s.nativeSuppression[r.sourceOccurrenceId]||!['VISIBLE','REVOKED'].includes(visibility[r.sourceOccurrenceId]))return {approvals:[],receipts:[],sourceUnavailable:true};
  return {approvals:approvals.slice(offset,offset+25).map(o=>({id:o.id,actorId:o.actorId,approvedAt:o.approvedAt,action:o.preview?.context.command.action,previousState:o.preview?.previousState,nextState:o.preview?.nextState,approvedVersion:o.preview?.context.reviewVersion,approvalDigest:o.preview?.approvalDigest})),receipts:Object.values(s.operations).map(o=>o.result as Record<string,unknown>).filter(o=>o.reviewId===id&&o.receiptId&&o.approvalId).sort((a,b)=>Number(a.newVersion)-Number(b.newVersion)).slice(offset,offset+25),nextOffset:Object.values(s.operations).filter(o=>(o.result as Record<string,unknown>).reviewId===id&&(o.result as Record<string,unknown>).receiptId).length>offset+25?offset+25:null};
 },{deadlineMs:18000});}
 async programPreview(credentials:Credentials,id:string,input:{expectedVersion:number;expectedEpoch:number;expectedProgramVersion:number;command:ProgramCommand}){
  return this.#repo.transaction(async(s,client)=>{const r=s.reviews[id];if(!r){authenticate(s,credentials,this.#clock(),true);throw new CandidateError('NOT_FOUND',404);}this.#commandActor(s,credentials,r,'escort.command.approve');requireVersion(s.epoch,input.expectedEpoch);requireVersion(r.revision,input.expectedVersion);if(!client)throw new CandidateError('PROGRAM_TRANSACTION_REQUIRED',503);
   if(input.command.action==='REGISTER'&&(r.status==='NEEDS_CLARIFICATION'||!Object.values(s.reviewHistory).some(v=>v.id===r.id&&v.classification==='ORDER_DRAFT')))throw new CandidateError('REVIEWED_CLIENT_DRAFT_REQUIRED',409);
   const context=await this.#commandContext(s,credentials,r,input.command,input.expectedProgramVersion),preview=await this.#commands!.preview(client,context);this.#programPeople(s,context.actorId,r,preview);return {preview,operationalWrites:false};},{deadlineMs:18000});
 }
 async approveProgram(credentials:Credentials,id:string,input:{expectedVersion:number;expectedEpoch:number;expectedProgramVersion:number;operationId:string;approvalDigest:string;command:ProgramCommand}){
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId))throw new CandidateError('OPERATION_ID_INVALID');
  return this.#repo.transaction(async(s,client)=>{const r=s.reviews[id];if(!r){authenticate(s,credentials,this.#clock(),true);throw new CandidateError('NOT_FOUND',404);}const a=this.#commandActor(s,credentials,r,'escort.command.approve');if(!client)throw new CandidateError('PROGRAM_TRANSACTION_REQUIRED',503);
   const key=digest(['program-approval',a.personId,input.operationId]),pin=digest({id,...input}),prior=s.operations[key];
   if(prior){if(prior.payloadHash!==pin)throw new CandidateError('OPERATION_PAYLOAD_CONFLICT',409);const previous=prior.result as {preview:ProgramPreview};this.#programPeople(s,a.personId,r,previous.preview);await this.#commandSource(s,credentials,r);return {replay:true,approval:prior.result};}
   requireVersion(s.epoch,input.expectedEpoch);requireVersion(r.revision,input.expectedVersion);
   if(input.command.action==='REGISTER'&&(r.status==='NEEDS_CLARIFICATION'||!Object.values(s.reviewHistory).some(v=>v.id===r.id&&v.classification==='ORDER_DRAFT')))throw new CandidateError('REVIEWED_CLIENT_DRAFT_REQUIRED',409);
   const context=await this.#commandContext(s,credentials,r,input.command,input.expectedProgramVersion),preview=await this.#commands!.preview(client,context);this.#programPeople(s,a.personId,r,preview);if(preview.approvalDigest!==input.approvalDigest)throw new CandidateError('APPROVAL_PREVIEW_CHANGED',409);
   const approval={id:key,kind:'EXPLICIT_PROGRAM_APPROVAL',reviewId:id,actorId:a.personId,approvedAt:new Date(this.#clock()).toISOString(),expiresAt:this.#clock()+30*60*1000,preview};s.operations[key]={payloadHash:pin,result:approval};audit(s,this.#clock(),a.personId,'PROGRAM_EXPLICIT_APPROVAL',id,r.revision);boundedState(s);return {replay:false,approval};},{deadlineMs:18000});
 }
 async executeProgram(credentials:Credentials,id:string,input:{approvalId:string;operationId:string}){
  if(!/^[a-f0-9]{64}$/.test(input.approvalId)||!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId))throw new CandidateError('COMMAND_EXECUTION_INVALID');
  return this.#repo.transaction(async(s,client)=>{const r=s.reviews[id];if(!r){authenticate(s,credentials,this.#clock(),true);throw new CandidateError('NOT_FOUND',404);}const a=this.#commandActor(s,credentials,r,'escort.command.execute');if(!client)throw new CandidateError('PROGRAM_TRANSACTION_REQUIRED',503);
   const approval=s.operations[input.approvalId]?.result as {kind:string;id:string;reviewId:string;actorId:string;approvedAt:string;expiresAt:number;preview:ProgramPreview}|undefined;
   if(!approval||approval.kind!=='EXPLICIT_PROGRAM_APPROVAL'||approval.reviewId!==id||approval.actorId!==a.personId)throw new CandidateError('EXPLICIT_APPROVAL_REQUIRED',409);
   this.#programPeople(s,a.personId,r,approval.preview);
   const requestKey=digest(['program-execution-request',a.personId,input.operationId]),requestPin=digest({id,approvalId:input.approvalId});if(s.operations[requestKey]&&s.operations[requestKey].payloadHash!==requestPin)throw new CandidateError('OPERATION_PAYLOAD_CONFLICT',409);
   const key=digest(['program-command',input.approvalId]),pin=digest({id,approvalId:input.approvalId}),prior=s.operations[key];
   if(prior){if(prior.payloadHash!==pin)throw new CandidateError('OPERATION_PAYLOAD_CONFLICT',409);const vis=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock(),true);if(s.nativeSuppression[r.sourceOccurrenceId]||!['VISIBLE','REVOKED'].includes(vis[r.sourceOccurrenceId]))return {replay:true,receipt:{receiptId:key,redacted:true}};return {replay:true,receipt:prior.result};}
   if(this.#clock()>=approval.expiresAt)throw new CandidateError('APPROVAL_EXPIRED',409);
   requireVersion(s.epoch,approval.preview.context.epoch);requireVersion(r.revision,approval.preview.context.reviewVersion);
   const current=await this.#commandContext(s,credentials,r,approval.preview.context.command,approval.preview.context.expectedProgramVersion);
   if(digest(current)!==digest(approval.preview.context))throw new CandidateError('APPROVED_SOURCE_VERSION_CHANGED',409);
   // Allocation identity is source-scoped, independent of the approval/request identity.
   // Competing exact approvals reconcile the original durable command, never insert another Draft.
   if(current.command.action==='ALLOCATE_DRAFT'){
    const existing=Object.values(s.operations).map(o=>o.result as Record<string,unknown>).find(v=>v.receiptId&&v.programId===current.command.programId&&v.action==='ALLOCATE_DRAFT');
    if(existing){
     const original=s.operations[String(existing.approvalId)]?.result as {preview?:ProgramPreview}|undefined;
     if(!original?.preview||digest(original.preview.context)!==digest(current))throw new CandidateError('ALLOCATION_PAYLOAD_CONFLICT',409);
     const projection=await committedRosterProjection(client,s,{accountId:r.accountId,chatJid:r.chatJid,programIds:[current.command.programId]});if(projection.some(p=>p.authority==='CONFLICT_REVIEW'))throw new CandidateError('ALLOCATION_COMMITTED_HISTORY_CONFLICT',409);
     s.operations[requestKey]={payloadHash:requestPin,result:{kind:'PROGRAM_EXECUTION_REQUEST',commandReceiptId:existing.receiptId,approvalId:approval.id,reviewId:id}};
     return {replay:true,receipt:existing};
    }
   }
   const receipt=await this.#commands!.execute(client,approval.preview,key,approval.approvedAt);
   // Last barrier still shares the SQL transaction: a late grant/source loss rolls back row + receipt.
   const latest=await this.#commandContext(s,credentials,r,current.command,current.expectedProgramVersion);if(digest(latest)!==digest(current))throw new CandidateError('APPROVED_SOURCE_VERSION_CHANGED',409);this.#commandActor(s,credentials,r,'escort.command.execute');
   s.operations[key]={payloadHash:pin,result:{...receipt,action:current.command.action,approvalId:approval.id,approvingAdmin:a.personId,reviewId:id,executionOperationId:input.operationId}};s.operations[requestKey]={payloadHash:requestPin,result:{kind:'PROGRAM_EXECUTION_REQUEST',commandReceiptId:key,approvalId:approval.id,reviewId:id}};audit(s,this.#clock(),a.personId,'PROGRAM_COMMAND_COMMIT',id,r.revision);boundedState(s);return {replay:false,receipt:s.operations[key].result};},{deadlineMs:18000});
 }
 async #committedContext(s:CandidateState,credentials:Credentials,r:ReviewItemV1,tx:CandidateSqlClient,programId?:string){
  const actor=authenticate(s,credentials,this.#clock());
  const approvals=Object.values(s.operations).map(o=>o.result as {kind?:string;preview?:ProgramPreview}).filter(o=>o.kind==='EXPLICIT_PROGRAM_APPROVAL'&&o.preview&&(o.preview.context.reviewId===r.id||o.preview.context.support?.reviewId===r.id));
  const selected=approvals.filter(o=>!programId||o.preview!.context.command.programId===programId);
  if(!selected.length){if(programId)throw new CandidateError('ROSTER_PROGRAM_SCOPE_DENIED',403);return null;}
  const bases=[...new Set(selected.map(o=>o.preview!.context.reviewId))].map(id=>s.reviews[id]);
  const related=new Map<string,ReviewItemV1>();related.set(r.id,r);
  for(const approval of selected){const p=approval.preview!;const base=s.reviews[p.context.reviewId];if(!base||base.accountId!==r.accountId)throw new CandidateError('ROSTER_PROGRAM_SCOPE_DENIED',403);this.#commandActor(s,credentials,base,'escort.command.read',false);this.#programPeople(s,actor.personId,base,p);related.set(base.id,base);if(p.context.support){const proof=s.reviews[p.context.support.reviewId];if(!proof||proof.accountId!==r.accountId)throw new CandidateError('ROSTER_PROGRAM_SCOPE_DENIED',403);related.set(proof.id,proof);}}
  // All historical participants/support chats and current person grants are admitted BEFORE row bodies.
  for(const proof of related.values())if(!canReview(s,actor.personId,'review.read',proof)||!canReview(s,actor.personId,'evidence.read',proof))throw new CandidateError('CAPABILITY_DENIED',403);
  const vis=await this.#checkVisible(s,[...related.values()]);authenticate(s,credentials,this.#clock());
  if([...related.values()].some(v=>s.nativeSuppression[v.sourceOccurrenceId]||!['VISIBLE','REVOKED'].includes(vis[v.sourceOccurrenceId])))return {state:'SOURCE_UNAVAILABLE',contextHash:null,employee:null,programs:[],authorizationVersion:s.epoch};
  const programs:Record<string,unknown>[]=[];
  for(const base of bases){const ids=[...new Set(selected.filter(a=>a.preview!.context.reviewId===base.id).map(a=>a.preview!.context.command.programId))];programs.push(...await committedRosterProjection(tx,s,{accountId:base.accountId,chatJid:base.chatJid,programIds:ids}));}
  const identities=new Map<string,Record<string,unknown>>();const legacy:Record<string,unknown>[]=[];
  for(const program of programs){
   const base=s.reviews[String((program.sourceEvidence as Record<string,unknown>).primaryReviewId)]??bases[0];
   const people=new Set<string>();if(typeof program.employeePersonId==='string')people.add(program.employeePersonId);for(const a of program.assignments as Record<string,unknown>[])if(typeof a.personId==='string')people.add(a.personId);
   for(const personId of people){allowed(s,actor.personId,'identity.read',{accountId:base.accountId,domain:'IDENTITY',chatJid:base.chatJid,resourceId:personId});const person=s.registry[personId];
    if(person?.kind!=='person'||person.status!=='VERIFIED'||!('employeeReferences' in person.data)||!Object.values(s.registry).some(v=>v.kind==='relationship'&&v.status==='VERIFIED'&&'personId' in v.data&&v.data.personId===personId&&'kind' in v.data&&v.data.kind==='EMPLOYEE'))throw new CandidateError('ROSTER_PERSON_NOT_CURRENT',409);
    const mobiles=[...new Set(person.data.employeeReferences.map(v=>canonicalEmployeeMobile(v.mobile,'employee_id')).filter(Boolean))];if(mobiles.length!==1||(program.assignments as Record<string,unknown>[]).some(a=>a.personId===personId&&a.employeeId!==mobiles[0]))throw new CandidateError('ROSTER_PERSON_NOT_CURRENT',409);
    const employee={personId,employeeId:mobiles[0],name:person.data.displayName,aliases:person.data.aliases,evidenceRefs:person.data.evidenceRefs,registryVersion:person.version,employmentStatus:'VERIFIED_REGISTRY_RELATIONSHIP'};identities.set(personId,employee);
    // Preserve admitted legacy evidence. Hidden other-scope conflicts remain content-free booleans.
    legacy.push(...await this.#rosterReader({accountId:base.accountId,chatJid:base.chatJid,employeeId:String(mobiles[0]),sourceReference:base.sourceReferences?.[0]??base.sourceOccurrenceId,fields:base.fields,transaction:tx}));
   }
   if(related.size&&[...related.values()].some(v=>s.occurrences[v.sourceOccurrenceId]?.conflicted)){program.reviewRequired=true;program.resolution='RECONCILIATION_REVIEW';(program.issues as string[]).push('SOURCE_CONFLICT_REQUIRES_REVIEW');}
  }
  const current=await this.#checkVisible(s,[...related.values()]);authenticate(s,credentials,this.#clock());for(const base of bases)this.#commandActor(s,credentials,base,'escort.command.read',false);
  if([...related.values()].some(v=>s.nativeSuppression[v.sourceOccurrenceId]||!['VISIBLE','REVOKED'].includes(current[v.sourceOccurrenceId])))return {state:'SOURCE_UNAVAILABLE',contextHash:null,employee:null,programs:[],authorizationVersion:s.epoch};
  const last=programs.at(-1),employee=last&&typeof last.employeePersonId==='string'?identities.get(last.employeePersonId)??null:null;
  const occurrence=s.occurrences[r.sourceOccurrenceId],claim=r.identityClaimId?s.identityClaims[r.identityClaimId]:undefined;
  const context={state:programs.some(p=>p.reviewRequired)?'RECONCILIATION_REVIEW':programs.every(p=>p.authority==='QUALIFIED_DRAFT_REFERENCE')?'DRAFT_REFERENCE':'COMMITTED_ROSTER',programId:programId??null,employee,employees:[...identities.values()],programs,legacyPrograms:legacy,originalSender:{accountId:r.accountId,chatJid:r.chatJid,senderJid:occurrence?.envelope.senderJid??null,occurrenceId:r.sourceOccurrenceId},claimedIdentity:claim?{status:claim.status,borrowedPhone:claim.borrowedPhone,verifiedPersonId:claim.verifiedPersonId}:null,reconciliation:{state:programs.some(p=>p.reviewRequired)?'REVIEW':'CLEAR',issues:[...new Set(programs.flatMap(p=>p.issues as string[]))],operationalChanges:false},reviewVersion:r.revision,authorizationVersion:s.epoch};
  if(programs.length>50||Buffer.byteLength(JSON.stringify(context))>160000)throw new CandidateError('ROSTER_CONTEXT_BUDGET',503);
  return {...context,contextHash:digest(context)};
 }
 /** Read current roster only after session, conversation, source and person admission. */
 async #rosterContext(s:CandidateState,credentials:Credentials,r:ReviewItemV1,tx?:CandidateSqlClient,programId?:string){
  const a=authenticate(s,credentials,this.#clock());
  if(!canReview(s,a.personId,'review.read',r)||!canReview(s,a.personId,'evidence.read',r))throw new CandidateError('CAPABILITY_DENIED',403);
  const visibility=await this.#checkVisible(s,[r]);
  if(s.nativeSuppression[r.sourceOccurrenceId]||!['VISIBLE','REVOKED'].includes(visibility[r.sourceOccurrenceId]))return {state:'SOURCE_UNAVAILABLE',contextHash:null,employee:null,programs:[],authorizationVersion:s.epoch};
  const occurrence=s.occurrences[r.sourceOccurrenceId],identity=occurrence?resolveIdentity(s,occurrence.envelope):null,claim=r.identityClaimId?s.identityClaims[r.identityClaimId]:undefined;
  // Provisional claims never authorize lookup by the claimed label or corrected fields.
  const personId=claim?(claim.status==='VERIFIED'?claim.verifiedPersonId:null):identity?.personId;
  const originalSender={accountId:r.accountId,chatJid:r.chatJid,senderJid:occurrence?.envelope.senderJid??null,occurrenceId:r.sourceOccurrenceId};
  if(!personId)return {state:'PROVISIONAL',contextHash:null,employee:null,programs:[],originalSender,authorizationVersion:s.epoch};
  const scope={accountId:r.accountId,domain:'IDENTITY' as const,chatJid:r.chatJid,resourceId:String(personId)};
  allowed(s,a.personId,'identity.read',scope);
  if(programId&&!this.#commands)throw new CandidateError('PROGRAM_COMMANDS_NOT_CONFIGURED',503);
  const person=s.registry[String(personId)],relations=Object.values(s.registry).filter(v=>v.status==='VERIFIED'&&v.kind==='relationship'&&'personId' in v.data&&v.data.personId===personId&&'kind' in v.data&&v.data.kind==='EMPLOYEE');
  if(this.#commands&&tx&&(programId||!relations.length)){const committed=await this.#committedContext(s,credentials,r,tx,programId);if(committed)return committed;}
  if(!person||person.kind!=='person'||person.status!=='VERIFIED'||!relations.length||!('employeeReferences' in person.data))return {state:'NO_VERIFIED_EMPLOYEE',contextHash:null,employee:null,programs:[],originalSender,authorizationVersion:s.epoch};
  const ids=[...new Set(person.data.employeeReferences.map(v=>v.mobile))];
  if(ids.length!==1)return {state:'IDENTITY_REVIEW_REQUIRED',contextHash:null,employee:null,programs:[],originalSender,authorizationVersion:s.epoch};
  const programs=await this.#rosterReader({accountId:r.accountId,chatJid:r.chatJid,employeeId:ids[0],sourceReference:r.sourceReferences?.[0]??r.sourceOccurrenceId,fields:r.fields,transaction:tx});
  if(!Array.isArray(programs)||programs.length>51||Buffer.byteLength(JSON.stringify(programs))>160000)throw new CandidateError('ROSTER_CONTEXT_BUDGET',503);
  const current=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock());allowed(s,a.personId,'identity.read',scope);
  if(!canReview(s,a.personId,'review.read',r)||!canReview(s,a.personId,'evidence.read',r))throw new CandidateError('CAPABILITY_DENIED',403);
  if(s.nativeSuppression[r.sourceOccurrenceId]||!['VISIBLE','REVOKED'].includes(current[r.sourceOccurrenceId]))return {state:'SOURCE_UNAVAILABLE',contextHash:null,employee:null,programs:[],authorizationVersion:s.epoch};
  const employee={personId,employeeId:ids[0],name:person.data.displayName,aliases:person.data.aliases,evidenceRefs:person.data.evidenceRefs,registryVersion:person.version,employmentStatus:'VERIFIED_REGISTRY_RELATIONSHIP'};
  let committed:{programs:Record<string,unknown>[];employee:unknown;reconciliation?:unknown}|null=null;
  if(this.#commands&&tx){try{committed=await this.#committedContext(s,credentials,r,tx);}catch(error){if(!(error instanceof CandidateError)||error.status!==403)throw error;}}
  const context={...(committed&&'reconciliation' in committed?{committedPrograms:committed.programs,committedEmployee:committed.employee,reconciliation:committed.reconciliation}:{}),state:'HISTORICAL_REFERENCE_ONLY',employee,programs,originalSender,claimedIdentity:claim?{status:claim.status,borrowedPhone:claim.borrowedPhone,verifiedPersonId:claim.verifiedPersonId}:null,reviewVersion:r.revision,authorizationVersion:s.epoch};
  return {...context,contextHash:digest(context)};
 }
 async reviewRoster(credentials:Credentials,id:string,programId?:string){return this.#repo.transaction(async(s,tx)=>{const r=s.reviews[id];if(!r){authenticate(s,credentials,this.#clock());throw new CandidateError('NOT_FOUND',404);}return this.#rosterContext(s,credentials,r,tx,programId);},{deadlineMs:18000});}
 /** Human review proposals only. No operational approval, actor rebinding or posting. */
 async actOnReview(credentials:Credentials,id:string,input:{expectedVersion:number;expectedEpoch:number;operationId:string;action:'CORRECT_FIELDS'|'MARK_REVIEW'|'NEEDS_CLARIFICATION';fields?:Record<string,string|number|null>;reason:string;rosterContextHash?:string;rosterProgramId?:string}){
  if(input.rosterProgramId&&(!input.rosterContextHash||!/^[A-Za-z0-9_-]{1,100}$/.test(input.rosterProgramId)))throw new CandidateError('ROSTER_CONTEXT_INVALID');
  const allowedFields=new Set(['motherVessel','lighterVessel','masterMobile','masterName','escortName','employeeId','escortMobile','dutyStart','shift','clientId']);
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId)||!input.reason.trim()||input.reason.length>2000||!['CORRECT_FIELDS','MARK_REVIEW','NEEDS_CLARIFICATION'].includes(input.action))throw new CandidateError('REVIEW_ACTION_INVALID');
  if(input.action==='CORRECT_FIELDS'&&(!input.fields||Object.keys(input.fields).length===0)||input.action!=='CORRECT_FIELDS'&&input.fields!==undefined)throw new CandidateError('REVIEW_ACTION_INVALID');
  if(input.fields&&(Buffer.byteLength(JSON.stringify(input.fields))>8000||Object.entries(input.fields).some(([k,v])=>!allowedFields.has(k)||!(v===null||typeof v==='string'&&v.length<=500||typeof v==='number'&&Number.isFinite(v)))))throw new CandidateError('REVIEW_FIELDS_INVALID');
  return this.#repo.transaction(async(s,tx)=>{
   const a=authenticate(s,credentials,this.#clock(),true),r=s.reviews[id];if(!r)throw new CandidateError('NOT_FOUND',404);
   if(!canReview(s,a.personId,'review.read',r)||!canReview(s,a.personId,'review.update',r))throw new CandidateError('CAPABILITY_DENIED',403);
   const visibility=await this.#checkVisible(s,[r]);authenticate(s,credentials,this.#clock(),true);
   if(s.nativeSuppression[r.sourceOccurrenceId]||s.occurrences[r.sourceOccurrenceId]?.nativeReference&&visibility[r.sourceOccurrenceId]!=='VISIBLE')throw new CandidateError('REVIEW_SOURCE_NOT_CURRENT',409);
   if(input.rosterContextHash!==undefined&&!/^[a-f0-9]{64}$/.test(input.rosterContextHash))throw new CandidateError('ROSTER_CONTEXT_INVALID');
   const context=input.rosterContextHash?await this.#rosterContext(s,credentials,r,tx,input.rosterProgramId):null;
   if(input.rosterContextHash&&context?.state==='SOURCE_UNAVAILABLE')throw new CandidateError('REVIEW_SOURCE_NOT_CURRENT',409);
   const key=digest([a.personId,input.operationId]),pin=digest({id,...input}),prior=s.operations[key];
   if(prior){if(prior.payloadHash!==pin)throw new CandidateError('OPERATION_PAYLOAD_CONFLICT',409);return {replay:true,result:prior.result};}
   if(input.rosterContextHash&&context?.contextHash!==input.rosterContextHash)throw new CandidateError('ROSTER_CONTEXT_CHANGED',409);
   requireVersion(s.epoch,input.expectedEpoch);requireVersion(r.revision,input.expectedVersion);
   if(input.fields)r.fields={...r.fields,...input.fields};r.revision++;r.status=input.action==='NEEDS_CLARIFICATION'?'NEEDS_CLARIFICATION':'REVIEW';r.classification=r.status;r.note=input.reason;r.assignmentProposal=null;r.linkedDraftId=null;r.assignmentState='REVIEW';r.authorizationVersion=s.epoch;r.reasons=[...new Set([...r.reasons,'HUMAN_REVIEW_PROPOSAL'])];r.rosterContextHash=input.rosterContextHash;
   s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);audit(s,this.#clock(),a.personId,'REVIEW_'+input.action,r.id,r.revision);
   const result={item:reviewDto(r,s,visibility),authorizationVersion:s.epoch,operationalWrites:false,financialPostings:0,...(context&&'reconciliation' in context?{rosterReconciliation:context}: {})};s.operations[key]={payloadHash:pin,result:structuredClone(result)};boundedState(s);return {replay:false,result};
  });
 }
 async evidence(credentials:Credentials,id:string){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());const r=s.occurrences[id];if(!r)throw new CandidateError('NOT_FOUND',404);const related=Object.values(s.reviews).filter(v=>v.sourceOccurrenceId===id);if(!related.length||!related.every(v=>canReview(s,a.personId,'evidence.read',v)))throw new CandidateError('CAPABILITY_DENIED',403);if(r.referenceOnly||Object.values(s.nativeReceipts).some(v=>v.occurrenceId===id))return {referenceOnly:true,contentOwner:'NATIVE_SQLITE',suppressed:!!s.nativeSuppression[id],references:Object.values(s.nativeReceipts).filter(v=>v.occurrenceId===id).map(v=>({sourceReference:v.sourceReference,source:(v.source as Record<string,unknown>)}))};return {occurrence:r,revisions:Object.entries(s.sourceRevisions).filter(([k])=>k.startsWith(id+':')).map(([,v])=>v)};});}
 #ingest(s:CandidateState,actor:string,m:NativeMessageEnvelopeV1,sourceOverrides:Record<string,unknown>={}){
  allowed(s,actor,'intake.read',{accountId:m.accountId,domain:'IDENTITY',chatJid:m.chatJid,resourceId:null});
  const id=occurrenceKey(m),payloadHash=occurrencePayload(m),existing=s.occurrences[id];
  const callCommand=applyCallCommand(s,m,this.#clock(),this.#callWhatsAppControl?String(sourceOverrides.origin??'offline'):'DISABLED_OWNER_ATTRIBUTION_UNPROVED',String(sourceOverrides.kind??'MESSAGE'));if(callCommand)s.observations['call-command:'+id]={accountId:m.accountId,chatJid:m.chatJid,result:callCommand};
  if(m.chatType==='group'){const observationId=digest([id,m.observedAt,m.groupDisplayName,m.membershipEvidence]);s.observations[observationId]={id:observationId,occurrenceId:id,accountId:m.accountId,nativeJid:m.chatJid,displayName:m.groupDisplayName,membership:m.membershipEvidence,observedAt:m.observedAt,grantsAuthority:false};}
  if(existing?.payloadHash===payloadHash){revalidateConversationReceipts(s,m.accountId,m.chatJid);return {occurrenceId:id,replay:true,conflict:existing.conflicted,reviewIds:Object.values(s.reviews).filter(r=>r.sourceOccurrenceId===id).map(r=>r.id)};}
  const revision=(existing?.revision??0)+1;
  const item={id,accountId:m.accountId,chatJid:m.chatJid,nativeMessageId:m.nativeMessageId,provider:m.provider,revision,payloadHash,envelope:m,conflicted:!!existing&&m.eventType!=='EDIT'};
  s.occurrences[id]=item;s.sourceRevisions[id+':'+revision]=m;
  let reviews=routeMessage(s,m,id,revision,actor,sourceOverrides);
  if(existing&&m.eventType!=='EDIT'){reviews=reviews.map(r=>({...r,classification:'REVIEW',status:'REVIEW',linkedDraftId:null,assignmentProposal:null,assignmentState:'REVIEW',reasons:[...r.reasons,'SOURCE_OCCURRENCE_CONFLICT']}));for(const r of Object.values(s.reviews).filter(r=>r.sourceOccurrenceId===id)){r.revision++;r.classification='REVIEW';r.status='REVIEW';r.assignmentState='REVIEW';r.assignmentProposal=null;r.reasons=[...new Set([...r.reasons,'SOURCE_OCCURRENCE_CONFLICT'])];s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);}}
  for(const r of reviews){const prior=s.reviews[r.id];r.revision=prior?prior.revision+1:1;s.reviews[r.id]=r;s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);}
  audit(s,this.#clock(),actor,existing?'SOURCE_CONFLICT':'SOURCE_INGEST',id,revision);boundedState(s);return {occurrenceId:id,replay:false,conflict:!!existing,reviewIds:reviews.map(r=>r.id)};
 }
 async refreshCallPolicies(){const snapshots=await this.#repo.transaction(s=>['wa-01','wa-02'].map(account=>{const p=setting(s,account);return {p,valid:callPolicyStillAuthorized(s,p)};}).filter(v=>v.p.version>0));for(const {p,valid} of snapshots){try{const status=await this.#callGateway.sync(p,valid?this.#clock()+CALL_POLICY_LEASE_MS:0);await this.#repo.transaction(s=>{mirrorCallEvidence(s,status);s.observations['call-bridge:'+p.accountId]={...status,checkedAt:new Date(this.#clock()).toISOString()};});}catch{await this.#repo.transaction(s=>{s.observations['call-bridge:'+p.accountId]={accountId:p.accountId,connected:false,effectiveEnabled:false,appliedVersion:0,recent:[],reason:'CALL_GATEWAY_UNAVAILABLE'};});}}}
 async changeCallSetting(credentials:Credentials,input:unknown){const result=await this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);const changed=changeSetting(s,a.personId,'STAFF',input,this.#clock(),'FRONTEND');audit(s,this.#clock(),a.personId,'CALL_POLICY_CHANGE',changed.operationId,changed.policy.version);boundedState(s);return changed;});await this.refreshCallPolicies();return {...result,status:await this.callSettingStatus(credentials,result.policy.accountId)};}
 async callSettingStatus(credentials:Credentials,account:string){await this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());requireCallPolicyActor(s,a.personId,'STAFF',account,'calls.policy.read');});await this.refreshCallPolicies();try{const status=await this.#callGateway.status(account);await this.#repo.transaction(s=>{mirrorCallEvidence(s,status);s.observations['call-bridge:'+account]={...status,checkedAt:new Date(this.#clock()).toISOString()};});}catch{}return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());requireCallPolicyActor(s,a.personId,'STAFF',account,'calls.policy.read');const policy=setting(s,account);const bridge=s.observations['call-bridge:'+account] as {connected?:boolean;effectiveEnabled?:boolean;appliedVersion?:number;recent?:unknown[]}|undefined;return {whatsappControlEnabled:this.#callWhatsAppControl,whatsappControlReason:this.#callWhatsAppControl?null:'OWNER_COMMAND_ATTRIBUTION_UNPROVED',policy,bridge:bridge??{connected:false,effectiveEnabled:false,appliedVersion:0,recent:[]},savedEnabled:policy.enabled,effectiveEnabled:!!bridge?.connected&&!!bridge.effectiveEnabled&&bridge.appliedVersion===policy.version,effectiveState:!bridge||'reason' in bridge?'UNKNOWN':bridge.appliedVersion!==policy.version?(bridge.effectiveEnabled?'STOP_PENDING':'UNKNOWN'):bridge.connected&&bridge.effectiveEnabled?'ON':'OFF'};});}
 async submitConversation(credentials:Credentials,input:{accountId:string;chatJid:string;personId:string;eventId:string;text:string;kind?:'MESSAGE'|'EDIT';targetEventId?:string}){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);const result=integrateFrontend(s,credentials,input,this.#clock(),a.personId);audit(s,this.#clock(),a.personId,'FRONTEND_CONVERSATION',result.receiptId,result.revision);boundedState(s);return result;});}
 async conversationOutcome(credentials:Credentials,accountId:string,chatJid:string,eventId:string,channel:'FRONTEND'|'WHATSAPP'){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());return readConversationOutcome(s,a.personId,accountId,chatJid,eventId,channel);});}
 async ingestOffline(credentials:Credentials,envelope:unknown){const m=nativeEnvelopeSchema.parse(envelope);return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);return this.#ingest(s,a.personId,m);});}
 async commitReadPage(credentials:Credentials,accountId:string,chatJid:string,expectedCursor:string|null,nextCursor:string|null,envelopes:unknown[]){
  if(envelopes.length>10||(nextCursor?.length??0)>500||(expectedCursor?.length??0)>500)throw new CandidateError('PAGE_BUDGET_INVALID');
  const parsed=envelopes.map(v=>nativeEnvelopeSchema.parse(v));if(parsed.some(m=>m.accountId!==accountId||m.chatJid!==chatJid))throw new CandidateError('MCP_SCOPE_MISMATCH',403);
  return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);allowed(s,a.personId,'intake.read',{accountId,domain:'IDENTITY',chatJid,resourceId:null});const key=digest([accountId,chatJid]);if((s.progress[key]??null)!==expectedCursor)throw new CandidateError('CURSOR_CONFLICT',409);const results=parsed.map(m=>this.#ingest(s,a.personId,m));s.progress[key]=nextCursor;audit(s,this.#clock(),a.personId,'READ_PAGE_COMMIT',key,results.length);return {results,cursor:nextCursor,persisted:true};});
 }
 async assertReadScope(credentials:Credentials,accountId:string,chatJid:string){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock(),true);return allowed(s,a.personId,'intake.read',{accountId,domain:'IDENTITY',chatJid,resourceId:null});});}
 async #checkVisible(s:CandidateState,reviews:ReviewItemV1[]){
  const ids=new Set(reviews.map(r=>r.sourceOccurrenceId));
  const references=Object.values(s.nativeReceipts).filter(r=>ids.has(String(r.occurrenceId))).map(r=>{const source=r.source as Record<string,unknown>;return {occurrenceId:String(r.occurrenceId),accountId:String(source.accountId),chatJid:String(source.chatJid),sequence:String(source.sequence)};});
  let result:Record<string,'VISIBLE'|'REVOKED'|'SUPPRESSED'|'UNKNOWN'>={};
  try{result=await this.#visibility(references);}catch{}
  for(const [id,status] of Object.entries(result))if(ids.has(id)&&status==='SUPPRESSED')s.nativeSuppression[id]=true;
  return result;
 }
 async commitNativePage(credentials:Credentials,accountId:string,chatJid:string,expectedCursor:string|null,raw:unknown,binding:NativeBinding){
  const page=validatePage(raw,accountId,chatJid,expectedCursor,binding);
  return this.#repo.transaction(s=>{
   const a=authenticate(s,credentials,this.#clock(),true);allowed(s,a.personId,'intake.read',{accountId,domain:'IDENTITY',chatJid,resourceId:null});
   const progressKey=digest([accountId,chatJid]),bindingKey=accountId;
   revalidateConversationReceipts(s,accountId,chatJid);
   if((s.progress[progressKey]??null)!==expectedCursor){
    if(!page.records.length)throw new CandidateError('CURSOR_CONFLICT',409);
    const results=page.records.map(record=>{const id=digest([accountId,binding.streamId,record.sequence]),prior=s.nativeReceipts[id];if(!prior||prior.receiptHash!==digest(nativeReceiptSource(record,binding,accountId))||(record.status==='CONTENT'&&(prior.source as Record<string,unknown>).contentHash!==record.envelope?.payload.sha256))throw new CandidateError('CURSOR_CONFLICT',409);return {receiptId:id,replay:true,reviewIds:prior.reviewIds};});
    return {results,cursor:s.progress[progressKey],complete:page.complete,persisted:true,replay:true,sendAuthorized:false,operationalWrites:false,financialPostings:0};
   }
   if(s.nativeBindings[bindingKey]&&digest(s.nativeBindings[bindingKey])!==digest(binding))throw new CandidateError('NATIVE_ACCOUNT_REBIND_REQUIRED',409);
   s.nativeBindings[bindingKey]=structuredClone(binding);
   const results=[];
   for(const record of page.records){
    const receiptId=digest([accountId,binding.streamId,record.sequence]);
    const contentHash=record.envelope?.payload.sha256??null;
    const source={...record,envelope:null,contentHash,nativeScope:binding,accountId};const receiptHash=digest(nativeReceiptSource(record,binding,accountId)),prior=s.nativeReceipts[receiptId];
    if(prior){if(prior.receiptHash!==receiptHash||(record.status==='CONTENT'&&((prior.source as Record<string,unknown>).contentHash!==contentHash)))throw new CandidateError('NATIVE_RECEIPT_CONFLICT',409);results.push({receiptId,replay:true,reviewIds:prior.reviewIds});continue;}
    const sourceReference='native:'+binding.streamId+':'+record.sequence;
    let occurrenceId=record.messageId?digest([accountId,'WHATSAPP',chatJid,record.messageId]):digest([accountId,binding.streamId,record.eventKey]);
    let reviewIds:string[]=[];let conflict=false,replay=false;
    if(record.envelope){
     const result=this.#ingest(s,a.personId,record.envelope,{origin:record.origin,eventId:record.kind==='edit'?(record.nativeEventId??record.eventKey):record.envelope.nativeMessageId,kind:record.kind==='edit'?'EDIT':'MESSAGE',targetEventId:record.kind==='edit'?record.target?.messageId??null:null});occurrenceId=result.occurrenceId;reviewIds=result.reviewIds;conflict=result.conflict;replay=result.replay;
     const m=record.envelope,identity=resolveIdentity(s,m),borrowed=/\bborrow(?:ed|ing)?\b|lost\s+(?:my\s+)?phone|using\s+(?:someone|another)|অন্যের|ধার|ফোন.*(?:হারিয়ে|নেই)/iu.test(m.payload.text);
     const role=/(?:employee|client|office staff|accountant|admin|অ্যাডমিন|একাউন্টেন্ট|অ্যাকাউন্টেন্ট|কর্মচারী|ক্লায়েন্ট|ক্লায়েন্ট|অফিস)/iu.exec(m.payload.text)?.[0]??null;
     const roleMap:Record<string,string>={employee:'EMPLOYEE',client:'CLIENT','office staff':'OFFICE_STAFF',accountant:'ACCOUNTANT',admin:'ADMIN','অ্যাডমিন':'ADMIN','একাউন্টেন্ট':'ACCOUNTANT','অ্যাকাউন্টেন্ট':'ACCOUNTANT','কর্মচারী':'EMPLOYEE','ক্লায়েন্ট':'CLIENT','ক্লায়েন্ট':'CLIENT','অফিস':'OFFICE_STAFF'};
     const explicitClaim=/\b(?:I am|my name is)\b|আমি/iu.test(m.payload.text);const claimedRoleConflict=!!role&&explicitClaim&&!!roleMap[role.toLowerCase()]&&!identity.relationships.some(r=>r.kind===roleMap[role.toLowerCase()]);
     const unverified=identity.state!=='VERIFIED'||borrowed||claimedRoleConflict;
     let claimId:string|undefined;
     if(unverified){
      claimId=digest([occurrenceId,record.envelopeHash]);
      const label=/(?:\bI am\s+|\bmy name is\s+|আমি\s+)([^\n,.]{1,80})/iu.exec(m.payload.text)?.[1]??null;
      const claim={id:claimId,accountId,chatJid,occurrenceId,originalSenderJid:m.senderJid,originalParticipant:record.participant??null,transportPersonId:identity.personId,claimedLabel:label,claimedRole:role,claimedRoleConflict,borrowedPhone:borrowed,status:'PROVISIONAL',version:1,verifiedPersonId:null,sourceReference,sourceHash:contentHash,authorizationVersion:s.epoch,operationalAuthority:false};
      if(!s.identityClaims[claimId]){s.identityClaims[claimId]=claim;s.claimHistory[claimId+':1']=structuredClone(claim);}
     }
     for(const id of reviewIds){
      const r=s.reviews[id];
      if(r.sourceReferences?.includes(sourceReference))continue;
      r.sourceReferences=[...(r.sourceReferences??[]),sourceReference];
      if(r.candidate.evidence&&typeof r.candidate.evidence==='object')delete (r.candidate.evidence as Record<string,unknown>).text;
      if(Buffer.byteLength(JSON.stringify(r.candidate))>20000)r.candidate={};
      if(Buffer.byteLength(JSON.stringify(r.fields))>8000){r.fields={};r.reasons.push('DERIVED_FIELD_BUDGET');r.status='REVIEW';r.classification='REVIEW';r.assignmentProposal=null;}
      if(claimId){r.identityClaimId=claimId;r.status='NEEDS_CLARIFICATION';r.classification='NEEDS_CLARIFICATION';r.assignmentProposal=null;r.linkedDraftId=null;r.reasons=[...new Set([...r.reasons,borrowed?'BORROWED_PHONE_VERIFICATION_REQUIRED':claimedRoleConflict?'CLAIMED_ROLE_UNVERIFIED':'PROVISIONAL_SENDER_IDENTITY'])];}
      // Replace this transaction's first snapshot only before it has been committed.
      if(r.revision===1&&s.reviewHistory[id+':1']&&!prior&&!replay)s.reviewHistory[id+':1']=structuredClone(r);
      else{r.revision++;s.reviewHistory[id+':'+r.revision]=structuredClone(r);}
     }
     const stored=s.occurrences[occurrenceId];const legacyReplay=replay&&!stored.referenceOnly;stored.referenceOnly=!legacyReplay;stored.nativeReference={sourceReference,originalSenderJid:record.senderJid,originalParticipant:record.participant??null,envelopeHash:record.envelopeHash};if(!legacyReplay)stored.envelope={...stored.envelope,payload:{...stored.envelope.payload,text:''}};
     const key=occurrenceId+':'+stored.revision;
     if(!legacyReplay&&s.sourceRevisions[key])s.sourceRevisions[key]={...s.sourceRevisions[key],payload:{...s.sourceRevisions[key].payload,text:''}};
    }else{
     const target=record.target;const targetId=target?.messageId??record.messageId;
     const targetChat=target?.chatJid??chatJid;
     if(targetChat!==chatJid)throw new CandidateError('NATIVE_CONTROL_TARGET_SCOPE_MISMATCH',403);
     const targetOccurrence=targetId?digest([accountId,'WHATSAPP',chatJid,targetId]):null;
     if(record.status==='SUPPRESSED'||record.reason==='PRIVACY_ACTION'){
      if(targetOccurrence)s.nativeSuppression[targetOccurrence]=true;
     }
     if(record.kind==='revoke'||record.status==='SUPPRESSED'||record.reason==='PRIVACY_ACTION'){
      if(targetId)suppressConversation(s,accountId,chatJid,targetId);if(targetOccurrence)s.nativeSuppression[targetOccurrence]=true;
      for(const r of Object.values(s.reviews).filter(r=>r.accountId===accountId&&r.chatJid===chatJid&&r.sourceOccurrenceId===targetOccurrence)){
       r.revision++;r.status='REVIEW';r.classification='REVIEW';r.assignmentProposal=null;r.linkedDraftId=null;r.reasons=[...new Set([...r.reasons,record.status==='SUPPRESSED'?'OWNER_CONTENT_SUPPRESSED':'NATIVE_REVOKE_OBSERVED'])];
       if(s.nativeSuppression[r.sourceOccurrenceId]){r.fields={};r.candidate={};}
       s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);
      }
     }
     const id=digest([receiptId,'held-review']);
     const r:ReviewItemV1={version:'review-item-v1',id,revision:1,accountId,chatJid,domain:'IDENTITY',requiredDomains:['IDENTITY'],sourceOccurrenceId:occurrenceId,sourceRevision:1,classification:'REVIEW',status:'REVIEW',fields:{},reasons:[record.reason??'TYPED_NATIVE_EVENT'],linkedDraftId:null,assignmentProposal:null,assignmentState:'REVIEW',clientDeliveryState:'NOT_SENT',createdBy:a.personId,authorizationVersion:s.epoch,note:'',candidate:{},sourceReferences:[sourceReference]};
     s.reviews[id]=r;s.reviewHistory[id+':1']=structuredClone(r);reviewIds=[id];
    }
    s.nativeReceipts[receiptId]={id:receiptId,receiptHash,source,sourceReference,occurrenceId,reviewIds,disposition:record.status==='CONTENT'?(conflict?'CONFLICT_REVIEW':replay?'REPLAY':'REVIEW_DURABLE'):record.status,committedBy:a.personId,authorizationVersion:s.epoch};
    audit(s,this.#clock(),a.personId,'NATIVE_RECEIPT',receiptId,1,record.status);results.push({receiptId,replay,conflict,reviewIds});
   }
   // Same transaction owns review/claims/immutable receipts and the cursor.
   s.progress[progressKey]=page.nextCursor;
   authenticate(s,credentials,this.#clock(),true);allowed(s,a.personId,'intake.read',{accountId,domain:'IDENTITY',chatJid,resourceId:null});
   if(page.records.length)audit(s,this.#clock(),a.personId,'NATIVE_PAGE_COMMIT',progressKey,page.records.length);
   boundedState(s);return {results,cursor:page.nextCursor,complete:page.complete,persisted:true,sendAuthorized:false,operationalWrites:false,financialPostings:0};
  });
 }
 async claim(credentials:Credentials,id:string){return this.#repo.transaction(async s=>{
  const a=authenticate(s,credentials,this.#clock()),claim=s.identityClaims[id];if(!claim)throw new CandidateError('NOT_FOUND',404);
  const reviews=Object.values(s.reviews).filter(r=>r.identityClaimId===id);if(!reviews.length||!reviews.every(r=>canReview(s,a.personId,'review.read',r)))throw new CandidateError('CAPABILITY_DENIED',403);
  const visibility=await this.#checkVisible(s,reviews);authenticate(s,credentials,this.#clock());
  if(s.nativeSuppression[String(claim.occurrenceId)])return {claim:{id,status:'SUPPRESSED'},history:[]};
  if(!['VISIBLE','REVOKED'].includes(visibility[String(claim.occurrenceId)]))return {claim:{id,status:'NEEDS_CLARIFICATION',reason:'NATIVE_VISIBILITY_UNVERIFIED'},history:[]};
  const scoped=(value:Record<string,unknown>)=>{const safe=structuredClone(value);for(const key of ['transportPersonId','verifiedPersonId'])if(safe[key]&&!authorize(s,a.personId,'STAFF','identity.read',{accountId:String(claim.accountId),domain:'IDENTITY',chatJid:String(claim.chatJid),resourceId:String(safe[key])}).allowed)safe[key]=null;return safe;};
  return {claim:scoped(claim),history:Object.values(s.claimHistory).filter(v=>v.id===id).map(scoped)};
 });}
 async verifyClaim(credentials:Credentials,id:string,input:{personId:string;expectedVersion:number;expectedEpoch:number;proof:OwnerProof}){
  return this.#repo.transaction(async s=>{
   const a=authenticate(s,credentials,this.#clock(),true),claim=s.identityClaims[id];if(!claim)throw new CandidateError('NOT_FOUND',404);
   const scope:Scope={accountId:String(claim.accountId),domain:'IDENTITY',chatJid:String(claim.chatJid),resourceId:input.personId};
   allowed(s,a.personId,'identity.verify',scope);allowed(s,a.personId,'identity.read',scope);requireVersion(s.epoch,input.expectedEpoch);requireVersion(Number(claim.version),input.expectedVersion);
   const related=Object.values(s.reviews).filter(r=>r.identityClaimId===id);if(!related.length||!related.every(r=>canReview(s,a.personId,'review.read',r)))throw new CandidateError('CAPABILITY_DENIED',403);
   const visibility=await this.#checkVisible(s,related);if(visibility[String(claim.occurrenceId)]!=='VISIBLE')throw new CandidateError('CLAIM_SOURCE_NOT_CURRENT',409);
   if(s.nativeSuppression[String(claim.occurrenceId)]||s.occurrences[String(claim.occurrenceId)]?.conflicted||claim.status!=='PROVISIONAL')throw new CandidateError('CLAIM_SOURCE_NOT_CURRENT',409);
   const person=s.registry[input.personId];if(!person||person.kind!=='person'||person.status!=='VERIFIED'||!registryVisible(s,person,scope.accountId,a.personId))throw new CandidateError('VERIFIED_PERSON_REQUIRED',409);
   const pin=digest({claimId:id,sourceHash:claim.sourceHash,personId:input.personId,personVersion:person.version,expectedVersion:input.expectedVersion,expectedEpoch:input.expectedEpoch});
   if(!await this.#verify(ownerProof.parse(input.proof),pin,'CLAIM_VERIFY'))throw new CandidateError('CLAIM_VERIFICATION_UNPROVEN',403);
   authenticate(s,credentials,this.#clock(),true);requireVersion(s.epoch,input.expectedEpoch);allowed(s,a.personId,'identity.verify',scope);
   claim.status='VERIFIED';claim.version=Number(claim.version)+1;claim.verifiedPersonId=input.personId;claim.verifiedBy=a.personId;claim.verificationEvidence=pin;claim.authorizationVersion=s.epoch;s.claimHistory[id+':'+claim.version]=structuredClone(claim);
   for(const r of related){r.revision++;r.status='REVIEW';r.classification='REVIEW';r.reasons=[...new Set([...r.reasons,'CLAIM_VERIFIED_NO_OPERATIONAL_AUTHORITY'])];s.reviewHistory[r.id+':'+r.revision]=structuredClone(r);}
   audit(s,this.#clock(),a.personId,'CLAIM_VERIFY',id,Number(claim.version));boundedState(s);return {claim:{...claim,transportPersonId:claim.transportPersonId&&authorize(s,a.personId,'STAFF','identity.read',{...scope,resourceId:String(claim.transportPersonId)}).allowed?claim.transportPersonId:null},phoneRebound:false,employeeCreated:false,operationalAuthority:false};
  });
 }
 async scopedKnowledge(credentials:Credentials,accountId:string,documents:Array<{id:string;accountId:string;personId:string|null;text:string;approved:boolean}>){return this.#repo.transaction(s=>{const a=authenticate(s,credentials,this.#clock());allowed(s,a.personId,'knowledge.read',{accountId,domain:'KNOWLEDGE',chatJid:null,resourceId:null});return {documents:documents.filter(d=>d.approved&&d.accountId===accountId&&(d.personId===null||d.personId===a.personId)).slice(0,10).map(d=>({id:d.id,text:d.text.slice(0,4000)})),providerExecuted:false};});}
 async revokeStaffOffline(accountId:string,proof:OwnerProof){
  if(!await this.#verify(ownerProof.parse(proof),digest({accountId,action:'REVOKE_STAFF'}),'REVOKE_STAFF_OFFLINE'))throw new CandidateError('OWNER_APPROVAL_UNVERIFIED',403);
  return this.#repo.transaction(s=>{const account=s.staff[accountId];if(!account)throw new CandidateError('NOT_FOUND',404);account.active=false;account.version++;s.epoch++;audit(s,this.#clock(),'OWNER_APPROVED_OFFLINE_PROVISIONING','STAFF_REVOKE',accountId,account.version);return {revoked:true};});
 }
}
export function newOperationId(){return randomBytes(16).toString('hex');}
