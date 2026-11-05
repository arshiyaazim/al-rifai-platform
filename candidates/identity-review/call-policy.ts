import {z} from 'zod';
import {CandidateError,digest} from './contracts.ts';
import type {CandidateState} from './repository.ts';
import {authorize,resolveIdentity} from './routing.ts';
import type {NativeMessageEnvelopeV1} from './contracts.ts';
export const CALL_POLICY_LEASE_MS=10000;
export const FALLBACK='এই মুহূর্তে WhatsApp কল নেওয়া যাচ্ছে না। অনুগ্রহ করে এখানে আপনার নাম ও প্রয়োজন লিখে পাঠান।';
const direct=z.string().regex(/^[0-9]{1,30}@(s\.whatsapp\.net|lid)$/);
export const callSettingInput=z.object({accountId:z.enum(['wa-01','wa-02']),operationId:z.string().min(1).max(128),expectedVersion:z.number().int().nonnegative(),enabled:z.boolean(),fallbackText:z.string().trim().min(1).max(2000),callers:z.array(direct).max(100),exceptions:z.array(direct).max(100),allTrustedDirect:z.boolean(),cooldownSeconds:z.number().int().min(0).max(86400)}).strict().superRefine((v,c)=>{if(Buffer.byteLength(v.fallbackText)>2000||/\{\{|\$\{|\b(payment posted|order confirmed|duty confirmed|payment confirmed)\b|(?:পেমেন্ট|অর্ডার|ডিউটি).{0,15}(?:নিশ্চিত|কনফার্ম|সম্পন্ন)/i.test(v.fallbackText))c.addIssue({code:'custom',message:'FALLBACK_MUST_BE_STATIC_CALL_CLARIFICATION'});});
export type CallSetting={accountId:'wa-01'|'wa-02';enabled:boolean;fallbackText:string;callers:string[];exceptions:string[];allTrustedDirect:boolean;cooldownSeconds:number;version:number;changedBy:string|null;changedAt:string|null;source:string;authorizationEpoch:number;authorizationChat:string|null};
export type CallGatewayStatus={accountId:string;connected:boolean;effectiveEnabled:boolean;appliedVersion:number;recent:Array<Record<string,unknown>>;[key:string]:unknown};
export interface CallGateway {sync(policy:CallSetting,validUntil:number):Promise<CallGatewayStatus>;status(account:string):Promise<CallGatewayStatus>;}
export const disabledCallGateway:CallGateway={sync:async p=>({accountId:p.accountId,connected:false,effectiveEnabled:false,appliedVersion:0,recent:[],reason:'CALL_BRIDGE_NOT_CONFIGURED'}),status:async account=>({accountId:account,connected:false,effectiveEnabled:false,appliedVersion:0,recent:[],reason:'CALL_BRIDGE_NOT_CONFIGURED'})};
export function callScope(accountId:string,chatJid:string|null=null){return {accountId,domain:'IDENTITY' as const,chatJid,resourceId:'call-policy-'+accountId};}
export function requireCallPolicyActor(s:CandidateState,actor:string|null,channel:'STAFF'|'WHATSAPP',accountId:string,action:'calls.policy.read'|'calls.policy.change',chatJid:string|null=null){
 const role=Object.values(s.registry).some(r=>r.kind==='relationship'&&r.status==='VERIFIED'&&'personId' in r.data&&r.data.personId===actor&&'kind' in r.data&&['SUPER_ADMIN','ADMIN'].includes(r.data.kind));
 const decision=authorize(s,actor,channel,action,callScope(accountId,chatJid));
 if(!role||!decision.allowed)throw new CandidateError('CALL_POLICY_PERMISSION_DENIED',403);return decision;
}
export function setting(s:CandidateState,accountId:string):CallSetting {
 if(!['wa-01','wa-02'].includes(accountId))throw new CandidateError('CALL_ACCOUNT_INVALID');
 const saved=s.observations['call-policy:'+accountId] as CallSetting|undefined;
 return saved??{accountId:accountId as 'wa-01',enabled:false,fallbackText:FALLBACK,callers:[],exceptions:[],allTrustedDirect:false,cooldownSeconds:600,version:0,changedBy:null,changedAt:null,source:'DEFAULT_OFF',authorizationEpoch:s.epoch,authorizationChat:null};
}
export function changeSetting(s:CandidateState,actor:string,channel:'STAFF'|'WHATSAPP',raw:unknown,now:number,source:string,chatJid:string|null=null){
 const input=callSettingInput.parse(raw);requireCallPolicyActor(s,actor,channel,input.accountId,'calls.policy.change',chatJid);
 const key=digest(['call-policy',input.accountId,actor,channel,input.operationId]),fingerprint=digest(input),previous=s.operations[key];
 if(previous){if(previous.payloadHash!==fingerprint)throw new CandidateError('CALL_POLICY_OPERATION_CONFLICT',409);return previous.result as {policy:CallSetting;operationId:string;replay:boolean};}
 const old=setting(s,input.accountId);if(old.version!==input.expectedVersion)throw new CandidateError('CALL_POLICY_VERSION_CONFLICT',409);
 const values={accountId:input.accountId,enabled:input.enabled,fallbackText:input.fallbackText,callers:input.callers,exceptions:input.exceptions,allTrustedDirect:input.allTrustedDirect,cooldownSeconds:input.cooldownSeconds};
 const policy:CallSetting={...values,version:old.version+1,changedBy:actor,changedAt:new Date(now).toISOString(),source,authorizationEpoch:s.epoch,authorizationChat:chatJid};
 s.observations['call-policy:'+input.accountId]=policy;
 const result={policy,operationId:key,replay:false};s.operations[key]={payloadHash:fingerprint,result};return result;
}
export function parseCallCommand(text:string,sourceAccount:string){
 if(!/কল|call|fallback/i.test(text)||!/auto.?reject|অটো.?রিজেক্ট|fallback/i.test(text))return null;
 const accounts=[...new Set(text.match(/wa-0[123]/g)??[])];
 if(accounts.length>1||accounts[0]&&accounts[0]!==sourceAccount||!/^(wa-01|wa-02)$/.test(sourceAccount))return {action:'CLARIFY' as const,reason:'EXACT_ACCOUNT_REQUIRED'};
 // An omitted account is the exact, trusted direct-chat transport account,
 // never a default account guessed from names or text.
 if(/অবস্থা|status/i.test(text))return {action:'STATUS' as const,accountId:sourceAccount};
 const fallback=/fallback\s*(?:message|মেসেজ)?\s*(?:বদলাও|change|set)\s*:\s*([\s\S]+)/i.exec(text)?.[1];
 if(fallback)return {action:'TEXT' as const,accountId:sourceAccount,text:fallback.trim()};
 const on=/চালু|\bon\b|enable/i.test(text),off=/বন্ধ|\boff\b|disable/i.test(text);
 if(on===off)return {action:'CLARIFY' as const,reason:'EXACT_ACTION_REQUIRED'};
 return {action:'TOGGLE' as const,accountId:sourceAccount,enabled:on};
}
export function applyCallCommand(s:CandidateState,m:NativeMessageEnvelopeV1,now:number,origin:string,eventKind='MESSAGE'){
 const command=parseCallCommand(m.payload.text,m.accountId);if(!command)return null;
 const identity=resolveIdentity(s,m);
 const timestamp=Date.parse(m.sourceTimestamp);
 if(origin!=='live'||eventKind!=='MESSAGE'||!Number.isFinite(timestamp)||!Number.isFinite(now)||now-timestamp>300000||timestamp-now>2000)return {action:'DENIED',reason:'FRESH_LIVE_CALL_COMMAND_REQUIRED',settingChanged:false};
 if(m.eventType!=='TEXT'||m.chatType!=='direct'||m.direction!=='INCOMING'||m.forwarded!==false||m.quotedMessageId!==null||identity.state!=='VERIFIED')return {action:'DENIED',reason:'CALL_COMMAND_ATTRIBUTABLE_DIRECT_IDENTITY_REQUIRED',settingChanged:false};
 if(command.action==='CLARIFY')return {...command,settingChanged:false};
 const person=identity.personId!;
 try{
  requireCallPolicyActor(s,person,'WHATSAPP',m.accountId,command.action==='STATUS'?'calls.policy.read':'calls.policy.change',m.chatJid);
  const current=setting(s,m.accountId);if(command.action==='STATUS')return {action:'STATUS',policy:current,effectiveState:'BRIDGE_STATUS_SEPARATE',settingChanged:false};
  const input={accountId:current.accountId,operationId:m.nativeMessageId,expectedVersion:current.version,enabled:command.action==='TOGGLE'?command.enabled:current.enabled,fallbackText:command.action==='TEXT'?command.text:current.fallbackText,callers:current.callers,exceptions:current.exceptions,allTrustedDirect:current.allTrustedDirect,cooldownSeconds:current.cooldownSeconds};
  // Repeated native messages are identified by source occurrence first, so a
  // retry must never compare an incremented expectedVersion and toggle again.
  const stable=digest(['call-native-command',m.accountId,m.chatJid,m.nativeMessageId]);
  if(s.operations[stable]){if(s.operations[stable].payloadHash!==digest(m.payload))return {action:'DENIED',reason:'CALL_COMMAND_SOURCE_CONFLICT',settingChanged:false};return {...s.operations[stable].result as object,replay:true};}
  const changed=changeSetting(s,person,'WHATSAPP',input,now,'WHATSAPP:'+m.chatJid+':'+m.nativeMessageId,m.chatJid);
  const result={action:command.action,policy:changed.policy,settingChanged:true};s.operations[stable]={payloadHash:digest(m.payload),result};return result;
 }catch(e){if(e instanceof CandidateError)return {action:'DENIED',reason:e.code,settingChanged:false};return {action:'CLARIFY',reason:'CALL_SETTING_CONTRACT_INVALID',settingChanged:false};}
}
export function callPolicyStillAuthorized(s:CandidateState,p:CallSetting){
 if(!p.changedBy)return false;
 try{requireCallPolicyActor(s,p.changedBy,p.source.startsWith('WHATSAPP:')?'WHATSAPP':'STAFF',p.accountId,'calls.policy.change',p.authorizationChat);return true;}catch{return false;}
}
export function mirrorCallEvidence(s:CandidateState,status:CallGatewayStatus){
 for(const op of status.recent){if(op.accountId!==status.accountId||typeof op.operationId!=='string')throw new CandidateError('CALL_TRANSPORT_ACCOUNT_MISMATCH',502);
  const key=digest(['call-transport',status.accountId,op.operationId,op]);if(!s.nativeReceipts[key])s.nativeReceipts[key]={id:key,source:{provider:'WHATSAPP',accountId:status.accountId,kind:'CALL_ACTION_RESULT',...op},sourceReference:'call-outbox:'+op.operationId,receiptHash:digest(op),operationalAuthority:false,statement:'কলের বক্তব্য জানা নেই'};
 }
}
