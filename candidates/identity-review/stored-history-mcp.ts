import {z} from 'zod';
import {CandidateError,digest} from './contracts.ts';
import {nativeBindingSchema,type NativeBinding} from './native-intake.ts';
import {sha} from '../../lib/history-extraction.mjs';
import {validateArchivePage,type ArchivePage} from '../../lib/whatsapp-archive.ts';
import type {HistorySourceReference,HistorySourceVerifier} from './history-extractions.ts';
const seq=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const state=z.enum(['VISIBLE','REVOKED','SUPPRESSED','UNKNOWN']);
const message=z.object({accountId:z.enum(['wa-01','wa-02']),chatJid:z.string().max(256),id:z.string().min(1).max(256),sender:z.string().max(256),text:z.string().refine(v=>Buffer.byteLength(v)<=64000),sourceTime:z.string().datetime(),direction:z.enum(['INCOMING','OUTGOING']),deletedAt:z.null()}).strict();
const record=z.object({rowid:seq,messageId:z.string().min(1).max(256),state,sourceHash:hash.nullable(),message:message.nullable()}).strict();
const page=z.object({version:z.literal('stored-history-page-v1'),accountId:z.enum(['wa-01','wa-02']),nativeScope:nativeBindingSchema,chatJid:z.string().max(256),previousAfter:seq,nextAfter:seq,complete:z.boolean(),records:z.array(record).max(10)}).strict();
export type StoredHistoryPage=z.infer<typeof page>;
type Call=(account:string,name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
export class StoredHistoryMcp{
 private readonly call:Call;
 private readonly bindings:Record<string,NativeBinding>;
 constructor(call:Call,bindings:Record<string,NativeBinding>){this.call=call;this.bindings=bindings;}
 private scope(accountId:string,chatJid:string,binding:NativeBinding){if(!this.bindings[accountId]||digest(binding)!==digest(this.bindings[accountId])||!/@(?:lid|s\.whatsapp\.net|g\.us)$/.test(chatJid))throw new CandidateError('HISTORY_NATIVE_SCOPE_MISMATCH',403);}
 async readPage(accountId:string,chatJid:string,after:string):Promise<StoredHistoryPage>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),12000);
  try{
   const p=page.parse(await this.call(accountId,'list_stored_messages',{chat_jid:chatJid,after_rowid:seq.parse(after),limit:10},abort.signal));
   this.scope(accountId,chatJid,p.nativeScope);
   if(p.accountId!==accountId||p.chatJid!==chatJid||p.previousAfter!==after)throw new CandidateError('HISTORY_PAGE_SCOPE_MISMATCH',403);
   let last=BigInt(after);
   for(const r of p.records){
    if(BigInt(r.rowid)<=last||r.state==='VISIBLE'&&(!r.message||!r.sourceHash)||r.state!=='VISIBLE'&&r.message!==null)throw new CandidateError('HISTORY_PAGE_CONTRACT_INVALID',502);
    if(r.message&&(r.message.accountId!==accountId||r.message.chatJid!==chatJid||r.message.id!==r.messageId||sha(r.message)!==r.sourceHash))throw new CandidateError('HISTORY_MESSAGE_HASH_MISMATCH',502);
    last=BigInt(r.rowid);
   }
   if(p.nextAfter!==last.toString()||!p.complete&&!p.records.length)throw new CandidateError('HISTORY_PAGE_PROGRESS_INVALID',502);
   return p;
  }catch(e){if(e instanceof CandidateError)throw e;throw new CandidateError('HISTORY_READER_UNAVAILABLE',503);}finally{clearTimeout(timer);}
 }
 async readArchivePage(accountId:string,chatJid:string,after:string):Promise<ArchivePage>{
  const binding=this.bindings[accountId];
  if(!binding)throw new CandidateError('HISTORY_NATIVE_SCOPE_MISMATCH',403);
  this.scope(accountId,chatJid,binding);
  if(!seq.safeParse(after).success)throw new CandidateError('ARCHIVE_CURSOR_INVALID',400);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),12000);
  try{
   let raw:unknown;
   try{
    raw=await this.call(accountId,'list_archive_messages',{chat_jid:chatJid,after_rowid:after,limit:10},abort.signal);
   }catch{
    if(abort.signal.aborted)throw new CandidateError('ARCHIVE_READ_TIMEOUT',504);
    throw new CandidateError('ARCHIVE_READER_UNAVAILABLE',503);
   }
   try{return validateArchivePage(raw,{accountId,chatJid,nativeScope:binding});}
   catch{throw new CandidateError('ARCHIVE_PAGE_CONTRACT_INVALID',502);}
  }finally{clearTimeout(timer);}
 }
 verify:HistorySourceVerifier=async(references:HistorySourceReference[],signal:AbortSignal)=>{
  const out:Awaited<ReturnType<HistorySourceVerifier>>={},groups=new Map<string,HistorySourceReference[]>();
  for(const r of references){const key=JSON.stringify([r.accountId,r.chatJid]);groups.set(key,[...(groups.get(key)??[]),r]);}
  for(const refs of groups.values()){
   const {accountId,chatJid}=refs[0],ids=[...new Set(refs.map(r=>r.messageId))];
   for(let i=0;i<ids.length;i+=10){
    const requested=ids.slice(i,i+10);
    const proofs=z.object({version:z.literal('stored-history-proofs-v1'),accountId:z.string(),nativeScope:nativeBindingSchema,chatJid:z.string(),results:z.array(z.object({messageId:z.string(),state,sourceHash:hash.nullable()}).strict()).max(10)}).strict().parse(await this.call(accountId,'get_stored_message_proofs',{chat_jid:chatJid,message_ids:requested},signal));
    this.scope(accountId,chatJid,proofs.nativeScope);
    if(proofs.accountId!==accountId||proofs.chatJid!==chatJid||proofs.results.length!==requested.length||proofs.results.some((p,j)=>p.messageId!==requested[j]))throw new CandidateError('HISTORY_PROOF_SCOPE_INVALID',502);
    for(const r of refs.filter(r=>requested.includes(r.messageId))){const proof=proofs.results.find(p=>p.messageId===r.messageId)!;out[r.sourceRef]={visibility:proof.state==='VISIBLE'?'VISIBLE':proof.state==='REVOKED'||proof.state==='SUPPRESSED'?'REVOKED':'UNKNOWN',payloadHash:proof.sourceHash};}
   }
  }
  return out;
 };
}
