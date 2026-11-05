import {CandidateError} from './contracts.ts';
import type {Credentials} from './auth.ts';
import type {IdentityReviewService} from './service.ts';
export type ReadPage={messages:unknown[];nextCursor:string|null;complete:boolean;accountId:string;chatJid:string};
export interface ScopedReadClient{
 readMessages(input:{accountId:string;chatJid:string;cursor:string|null;limit:10;signal:AbortSignal}):Promise<ReadPage>;
}
/** Prepared adapter only: no sockets, token loader, fetch, bridge paths or default client. */
export class CandidateMcpReadAdapter{
 #client:ScopedReadClient;#service:IdentityReviewService;#busy=new Set<string>();#deadline:number;
 constructor(service:IdentityReviewService,client:ScopedReadClient,{deadlineMs=12000}={}){if(deadlineMs<1||deadlineMs>12000)throw new CandidateError('DEADLINE_INVALID');this.#client=client;this.#service=service;this.#deadline=deadlineMs;}
 async pull(credentials:Credentials,input:{accountId:string;chatJid:string;cursor:string|null}){
  await this.#service.assertReadScope(credentials,input.accountId,input.chatJid);
  if(this.#busy.has(input.accountId))throw new CandidateError('ACCOUNT_READ_BUSY',409);
  this.#busy.add(input.accountId);const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const request=Promise.resolve().then(()=>this.#client.readMessages({...input,limit:10,signal:abort.signal}));
  // Retain the slot until the underlying client finishes, even if it ignores abort.
  request.then(()=>undefined,()=>undefined).finally(()=>this.#busy.delete(input.accountId));
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new CandidateError('MCP_READ_TIMEOUT',504));},this.#deadline);});
   const page=await Promise.race([request,timeout]);
   if(page.accountId!==input.accountId||page.chatJid!==input.chatJid)throw new CandidateError('MCP_SCOPE_MISMATCH',403);
   if(!Array.isArray(page.messages)||page.messages.length>10||typeof page.complete!=='boolean'||!(page.nextCursor===null||typeof page.nextCursor==='string')||!page.complete&&page.nextCursor===null||!page.complete&&page.nextCursor===input.cursor||Buffer.byteLength(JSON.stringify(page))>250000)throw new CandidateError('MCP_PAGE_INVALID_OR_TOO_LARGE',502);
   const result=await this.#service.commitReadPage(credentials,input.accountId,input.chatJid,input.cursor,page.nextCursor,page.messages);
   return {...result,complete:page.complete,readOnlyTransport:true,sendAuthorized:false};
  }catch(error){if(error instanceof CandidateError)throw error;throw new CandidateError('MCP_READ_UNAVAILABLE',502);}finally{if(timer)clearTimeout(timer);}
 }
}
