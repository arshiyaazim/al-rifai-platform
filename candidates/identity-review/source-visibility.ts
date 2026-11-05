import {CandidateError,digest} from './contracts.ts';
import {authenticate,type Credentials} from './auth.ts';
import type {CandidateState} from './repository.ts';
import type {HistorySourceReference,HistorySourceVerifier} from './history-extractions.ts';
import {extractionScopes} from '../../lib/history-policy.mjs';
export async function visibleHistorySources(s:CandidateState,credentials:Credentials,accountId:string,refs:HistorySourceReference[],clock:()=>number,verify?:HistorySourceVerifier){
 if(!verify)throw new CandidateError('HISTORY_SOURCE_REVALIDATION_NOT_CONFIGURED',503);
 const actor=authenticate(s,credentials,clock()),scopes=extractionScopes(s.registry,actor.personId,accountId),pin=digest(scopes);
 if(refs.length>400)throw new CandidateError('BUSINESS_SCOPE_TOO_LARGE_SELECT_DATES',422);
 const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const proofs=await Promise.race([verify(refs,abort.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new CandidateError('HISTORY_SOURCE_REVALIDATION_UNAVAILABLE',503));},12000);})]);
  if(authenticate(s,credentials,clock()).personId!==actor.personId||digest(extractionScopes(s.registry,actor.personId,accountId))!==pin)throw new CandidateError('HISTORY_SCOPE_DENIED',403);
  return new Set(refs.filter(r=>r.accountId===accountId&&scopes.some((v:{chatJid:string})=>v.chatJid===r.chatJid)&&proofs[r.sourceRef]?.visibility==='VISIBLE'&&proofs[r.sourceRef].payloadHash===r.payloadHash).map(r=>r.sourceRef));
 }finally{if(timer)clearTimeout(timer);abort.abort();}
}
