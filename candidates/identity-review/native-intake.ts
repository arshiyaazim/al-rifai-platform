import {z} from 'zod';
import {CandidateError,digest,hash,nativeEnvelopeSchema} from './contracts.ts';
import type {Credentials} from './auth.ts';
import type {IdentityReviewService} from './service.ts';
const seq=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(s=>BigInt(s)<=9223372036854775807n);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const nativeBindingSchema=z.object({accountId:z.string().regex(/^(synthetic-[A-Za-z0-9_.-]+|wa-0[12])$/),streamId:z.string().uuid(),pairedJid:z.string().min(1).max(256),pairedLid:z.string().max(256)}).strict();
export type NativeBinding=z.infer<typeof nativeBindingSchema>;
export const nativeRecordSchema=z.object({sequence:seq,eventKey:sha,envelopeHash:sha,semanticHash:sha.nullable(),occurrenceKey:sha.nullable(),nativeEventId:z.string().max(256).nullable(),messageId:z.string().max(256).nullable(),chatJid:z.string().max(256),senderJid:z.string().max(256).nullable(),sourceTime:z.string().max(100).nullable(),observedAt:z.string().datetime({offset:true}),origin:z.enum(['live','history_sync','unavailable_response','api_send_result','legacy_projection','internal','unknown']),kind:z.enum(['message','edit','revoke','reaction','receipt','undecryptable','group_observation','call','control','unsupported','invalid_identity','projection_attempt']),priorSequence:seq.nullable(),status:z.enum(['CONTENT','HELD','CONTROL','SUPPRESSED']),reason:z.string().max(100).nullable(),envelope:nativeEnvelopeSchema.nullable(),target:z.object({messageId:z.string().max(256).nullable(),chatJid:z.string().max(256).nullable(),fromMe:z.boolean().nullable(),participantJid:z.string().max(256).nullable()}).strict().nullable(),participant:z.object({state:z.string().max(50),value:z.string().max(256).nullable()}).strict().optional(),quote:z.object({messageId:z.string().max(256).nullable(),participantJid:z.string().max(256).nullable(),chatJid:z.string().max(256).nullable()}).strict().nullable().optional()}).strict();
export const nativePageSchema=z.object({version:z.literal('native-read-page-v1'),accountId:z.enum(['wa-01','wa-02']),chatJid:z.string().min(1).max(256),nativeScope:nativeBindingSchema,previousCursor:z.string().max(200).nullable(),nextCursor:z.string().max(200),complete:z.boolean(),records:z.array(nativeRecordSchema).max(10)}).strict();
export type NativePage=z.infer<typeof nativePageSchema>;
export type NativeRecord=z.infer<typeof nativeRecordSchema>;
export function parseCursor(cursor:string|null,binding:NativeBinding,chat:string){
 if(cursor===null)return {after:0n,through:0n};
 const p=cursor.split(':');
 if(p.length!==5||p[0]!=='n1'||p[1]!==binding.streamId||p[2]!==hash(chat).slice(0,24)||!seq.safeParse(p[3]).success||!seq.safeParse(p[4]).success)throw new CandidateError('NATIVE_CURSOR_SCOPE_MISMATCH',409);
 const after=BigInt(p[3]),through=BigInt(p[4]);if(through!==0n&&after>through)throw new CandidateError('NATIVE_CURSOR_INVALID',409);
 return {after,through};
}
export function validatePage(raw:unknown,account:string,chat:string,cursor:string|null,binding:NativeBinding){
 const page=nativePageSchema.parse(raw);
 if(Buffer.byteLength(JSON.stringify(page))>80000)throw new CandidateError('NATIVE_PAGE_BUDGET',502);
 if(page.accountId!==account||page.chatJid!==chat||page.previousCursor!==cursor||digest(page.nativeScope)!==digest(binding))throw new CandidateError('NATIVE_ACCOUNT_OR_CHAT_MISMATCH',403);
 const previous=parseCursor(cursor,binding,chat),next=parseCursor(page.nextCursor,binding,chat);
 let last=previous.after;
 for(const r of page.records){
  if(BigInt(r.sequence)<=last||r.chatJid!==chat||r.envelope&&(r.envelope.accountId!==account||r.envelope.chatJid!==chat)||r.status==='CONTENT'&&!r.envelope||r.status!=='CONTENT'&&r.envelope)throw new CandidateError('NATIVE_EVENT_SCOPE_OR_ORDER_INVALID',502);
  if(r.envelope&&(r.envelope.senderJid!==r.senderJid||r.kind!=='edit'&&r.envelope.nativeMessageId!==r.messageId))throw new CandidateError('NATIVE_SOURCE_IDENTITY_MISMATCH',502);
  last=BigInt(r.sequence);
 }
 if(last!==next.after||!page.complete&&(!page.records.length||next.through===0n)||page.complete&&next.through!==0n||previous.through!==0n&&(!page.complete&&next.through!==previous.through||last>previous.through))throw new CandidateError('NATIVE_PROGRESS_INVALID',502);
 return page;
}
export type ReadToolCall=(account:string,name:'get_native_account_identity'|'list_native_events',args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
/** Existing MCP transport is injected. This class opens no socket/server/store. */
export class NativeMcpClient{
 #evidenceState:'DISPOSABLE_NATIVE'|'SIMULATED_NATIVE'|'LIVE_NATIVE';#pending=new Set<string>();#call:ReadToolCall;#bindings:Readonly<Record<string,NativeBinding>>;
 constructor(call:ReadToolCall,bindings:Record<string,NativeBinding>,evidenceState:'DISPOSABLE_NATIVE'|'SIMULATED_NATIVE'|'LIVE_NATIVE'='DISPOSABLE_NATIVE'){this.#evidenceState=evidenceState;if(Object.entries(bindings).some(([a,b])=>evidenceState==='LIVE_NATIVE'?b.accountId!==a:evidenceState==='DISPOSABLE_NATIVE'?!b.accountId.startsWith('synthetic-'):b.accountId!==a&&!b.accountId.startsWith('synthetic-')))throw new CandidateError('NATIVE_MODE_BINDING_MISMATCH',503);this.#call=call;this.#bindings=Object.freeze(Object.fromEntries(Object.entries(bindings).map(([a,b])=>[a,nativeBindingSchema.parse(b)])));}
 binding(account:string){const b=this.#bindings[account];if(!b)throw new CandidateError('NATIVE_ACCOUNT_NOT_MANAGED',403);return structuredClone(b);}
 async readNativePage(input:{accountId:string;chatJid:string;cursor:string|null;limit:10;signal:AbortSignal}){
  if(this.#pending.has(input.accountId))throw new CandidateError('ACCOUNT_READ_BUSY',409);
  this.#pending.add(input.accountId);
  try{
  const binding=this.binding(input.accountId);
  parseCursor(input.cursor,binding,input.chatJid);
  const identity=z.object({version:z.literal('native-account-v1'),accountId:z.string(),nativeScope:nativeBindingSchema,evidenceState:z.literal(this.#evidenceState),operationalAuthority:z.literal('NONE')}).strict().parse(await this.#call(input.accountId,'get_native_account_identity',{},input.signal));
  if(identity.accountId!==input.accountId||digest(identity.nativeScope)!==digest(binding))throw new CandidateError('NATIVE_ACCOUNT_MISMATCH',403);
  if(input.signal.aborted)throw new CandidateError('NATIVE_READ_TIMEOUT',504);
  return validatePage(await this.#call(input.accountId,'list_native_events',{chat_jid:input.chatJid,cursor:input.cursor,limit:10},input.signal),input.accountId,input.chatJid,input.cursor,binding);
  }finally{this.#pending.delete(input.accountId);}
 }
 async visibility(references:Array<{occurrenceId:string;accountId:string;chatJid:string;sequence:string}>){
  const output:Record<string,'VISIBLE'|'REVOKED'|'SUPPRESSED'|'UNKNOWN'>={};
  const grouped=new Map<string,typeof references>();
  for(const r of references){const key=digest([r.accountId,r.chatJid]);grouped.set(key,[...(grouped.get(key)??[]),r]);}
  for(const refs of grouped.values()){
   const {accountId,chatJid}=refs[0],binding=this.binding(accountId);
   if(this.#pending.has(accountId))continue;
   this.#pending.add(accountId);const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const pendingWork:Promise<unknown>[]=[];let visibilityCompleted=false;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new CandidateError('NATIVE_VISIBILITY_UNVERIFIED',503));},12000);});
   try{
    const numbers=[...new Set(refs.map(r=>r.sequence))];
    for(let i=0;i<numbers.length;i+=10){
     const requested=numbers.slice(i,i+10);
     const request=Promise.resolve().then(()=>this.#call(accountId,'list_native_events',{chat_jid:chatJid,visibility_sequences:requested},abort.signal));pendingWork.push(request);
     const value=z.object({version:z.literal('native-visibility-v1'),accountId:z.string(),chatJid:z.string(),nativeScope:nativeBindingSchema,results:z.array(z.object({sequence:seq,state:z.enum(['VISIBLE','REVOKED','SUPPRESSED','UNKNOWN'])}).strict()).max(10)}).strict().parse(await Promise.race([request,deadline]));
     if(abort.signal.aborted||value.accountId!==accountId||value.chatJid!==chatJid||digest(value.nativeScope)!==digest(binding)||value.results.length!==requested.length||value.results.some((r,j)=>r.sequence!==requested[j]))throw new CandidateError('NATIVE_VISIBILITY_UNVERIFIED',503);
     for(const r of refs.filter(r=>requested.includes(r.sequence))){const status=value.results.find(v=>v.sequence===r.sequence)!.state;const old=output[r.occurrenceId];output[r.occurrenceId]=old==='SUPPRESSED'||status==='SUPPRESSED'?'SUPPRESSED':old==='UNKNOWN'||status==='UNKNOWN'?'UNKNOWN':old==='REVOKED'||status==='REVOKED'?'REVOKED':'VISIBLE';}
    }
    visibilityCompleted=true;
   }catch{for(const r of refs)output[r.occurrenceId]='UNKNOWN';}finally{if(timer)clearTimeout(timer);if(visibilityCompleted)this.#pending.delete(accountId);else Promise.allSettled(pendingWork).then(()=>this.#pending.delete(accountId));}
  }
  return output;
 }
}

export class NativeReadAdapter{
 #service:IdentityReviewService;#client:NativeMcpClient;#busy=new Set<string>();#deadline:number;
 constructor(service:IdentityReviewService,client:NativeMcpClient,{deadlineMs=12000}={}){if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>12000)throw new CandidateError('DEADLINE_INVALID');this.#service=service;this.#client=client;this.#deadline=deadlineMs;}
 async pull(credentials:Credentials,input:{accountId:string;chatJid:string;cursor:string|null}){
  await this.#service.assertReadScope(credentials,input.accountId,input.chatJid);
  if(this.#busy.has(input.accountId))throw new CandidateError('ACCOUNT_READ_BUSY',409);
  this.#busy.add(input.accountId);const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const request=Promise.resolve().then(()=>this.#client.readNativePage({...input,limit:10,signal:abort.signal}));
  request.then(()=>undefined,()=>undefined).finally(()=>this.#busy.delete(input.accountId));
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new CandidateError('NATIVE_READ_TIMEOUT',504));},this.#deadline);});
   const page=await Promise.race([request,timeout]);
   if(abort.signal.aborted)throw new CandidateError('NATIVE_READ_TIMEOUT',504);
   return await this.#service.commitNativePage(credentials,input.accountId,input.chatJid,input.cursor,page,this.#client.binding(input.accountId));
  }catch(e){if(e instanceof CandidateError)throw e;throw new CandidateError('NATIVE_READ_UNAVAILABLE',502);}finally{if(timer)clearTimeout(timer);}
 }
}
