import {authenticate} from './auth.ts';
import type {Credentials} from './auth.ts';
import {authorize} from './routing.ts';
import {bindingSchema,personSchema,CandidateError,digest} from './contracts.ts';
import type {CandidateState} from './repository.ts';

/** View current verified subject/chat choices; never creates identity or grants. */
export function conversationSubjects(s:CandidateState,credentials:Credentials,accountId:string,now:number){
 const actor=authenticate(s,credentials,now);
 if(!authorize(s,actor.personId,'STAFF','identity.read',{accountId,domain:'IDENTITY',chatJid:null,resourceId:null}).allowed)throw new CandidateError('CAPABILITY_DENIED',403);
 const bindings=Object.values(s.registry).filter(r=>r.kind==='binding'&&r.status==='VERIFIED').map(r=>bindingSchema.parse(r.data)).filter(b=>b.accountId===accountId&&b.direction==='INCOMING'&&b.purpose==='SENDER'&&!b.chatJid.endsWith('@g.us')&&Date.parse(b.validFrom)<=now&&(!b.validTo||now<Date.parse(b.validTo)));
 const choices=[];
 for(const chatJid of [...new Set(bindings.map(b=>b.chatJid))]){
  const people=[...new Set(bindings.filter(b=>b.chatJid===chatJid).map(b=>b.personId))];if(people.length!==1)continue;
  const person=s.registry[people[0]];if(person?.kind!=='person'||person.status!=='VERIFIED')continue;
  if(!authorize(s,actor.personId,'STAFF','intake.read',{accountId,domain:'IDENTITY',chatJid,resourceId:null}).allowed)continue;
  const phones=[...new Set(bindings.filter(b=>b.chatJid===chatJid).map(b=>b.phone))];if(phones.length!==1||!phones[0])continue;
  choices.push({personId:person.id,name:personSchema.parse(person.data).displayName,phone:phones[0],chatJid,cursor:s.progress[digest([accountId,chatJid])]??null,identityState:'VERIFIED' as const,savedState:'UNKNOWN' as const});
 }
 return {accountId,authorizationVersion:s.epoch,subjects:choices.sort((a,b)=>a.name.localeCompare(b.name)||a.chatJid.localeCompare(b.chatJid)),coverage:{basis:'CURRENT_AUTHORIZED_BINDINGS',completeContactDirectory:false,nativeChatInventory:'NOT_CONFIGURED',unregisteredContacts:'UNKNOWN',checkedAt:new Date(now).toISOString()}};
}
