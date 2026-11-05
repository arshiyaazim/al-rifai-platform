const verified=(registry,kind)=>Object.values(registry).filter(r=>r.kind===kind&&r.status==='VERIFIED');
// Use the same mapping in the SQL projection and its final row admission.
export const extractionKindForDomain=domain=>({ACCOUNTS:'PAYMENT',ESCORT:'ESCORT',OFFICE:'RELEASE',RELEASE:'RELEASE'})[domain]??null;
export const HISTORY_GROUPS=new Set(['120363426895117693@g.us','120363408741101070@g.us','120363428977781821@g.us']);
export function historyGrant(registry,actor,account,capability,domain,chat){
 return verified(registry,'grant').some(r=>{const g=r.data,s=g.scope;return g.personId===actor&&g.channel==='STAFF'&&g.capability===capability&&s.accountId===account&&s.domain===domain&&(s.chatJid===null||s.chatJid===chat)&&s.resourceId===null;});
}
const active=b=>Date.parse(b.validFrom)<=Date.now()&&(b.validTo===null||Date.now()<Date.parse(b.validTo))&&b.evidenceRefs?.length;
export function extractionScopes(registry,actor,account){
 if(!['wa-01','wa-02'].includes(account)||registry[actor]?.kind!=='person'||registry[actor]?.status!=='VERIFIED'||!verified(registry,'relationship').some(r=>r.data.personId===actor&&r.data.kind==='SUPER_ADMIN'))return [];
 const scopes=new Map();
 const admit=c=>{if(!historyGrant(registry,actor,account,'intake.read','IDENTITY',c.chatJid)||!historyGrant(registry,actor,account,'evidence.read',c.domain,c.chatJid)||!historyGrant(registry,actor,account,'review.read',c.domain,c.chatJid))return;const prior=scopes.get(c.chatJid);if(prior&&(prior.subjectRef!==c.subjectRef||prior.subjectRole!==c.subjectRole)){scopes.set(c.chatJid,null);return;}if(prior!==null)scopes.set(c.chatJid,c);};
 for(const r of verified(registry,'relationship')){
  const subjectRole=r.data.kind;
  if(!['CLIENT','ACCOUNTANT'].includes(subjectRole)||subjectRole==='CLIENT'&&r.data.serviceKind!=='ESCORT')continue;
  const person=registry[r.data.personId];if(person?.kind!=='person'||person.status!=='VERIFIED')continue;
  for(const binding of verified(registry,'binding')){
   const b=binding.data;
   if(b.personId!==person.id||b.accountId!==account||b.direction!=='INCOMING'||b.purpose!=='SENDER'||!active(b)||b.chatJid.endsWith('@g.us'))continue;
   admit({allowed:true,chatJid:b.chatJid,subjectRef:person.id,senderLabel:person.data.displayName,subjectRole,domain:subjectRole==='ACCOUNTANT'?'ACCOUNTS':'ESCORT',clientId:r.data.clientId??null});
  }
 }
 for(const g of verified(registry,'group')){
  if(!g.data.accountIds.includes(account)||!HISTORY_GROUPS.has(g.data.nativeJid)||g.data.workflowScope!=='REVIEW_ONLY'||!g.data.evidenceRefs?.length)continue;
  admit({allowed:true,chatJid:g.data.nativeJid,subjectRef:g.id,senderLabel:g.data.displayName,subjectRole:'APPROVED_GROUP',domain:g.data.domain==='OFFICE'?'OFFICE':g.data.domain});
 }
 return [...scopes.values()].filter(Boolean).sort((a,b)=>a.chatJid.localeCompare(b.chatJid));
}
const senderKey=s=>s.replace(/(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/,'');
export function historyAdmission(registry,message,scope,nativeScope){
 const bindings=verified(registry,'binding').filter(r=>r.data.accountId===message.accountId&&active(r.data));
 const at=Date.parse(message.sourceTime);
 const effective=b=>Date.parse(b.validFrom)<=at&&(!b.validTo||at<Date.parse(b.validTo));
 const people=verified(registry,'person'),roles=verified(registry,'relationship');
 const personOk=id=>people.some(p=>p.id===id);
 const matching=bindings.filter(r=>r.data.direction===message.direction&&senderKey(r.data.senderJid)===senderKey(message.sender)&&personOk(r.data.personId));
 if(message.direction==='OUTGOING'){
  // ACCOUNT_OWNER binds the native account (often its self-chat), not the peer.
  const owner=bindings.filter(r=>r.data.direction==='OUTGOING'&&personOk(r.data.personId)&&r.data.purpose==='ACCOUNT_OWNER'&&roles.some(v=>v.data.personId===r.data.personId&&['ADMIN','SUPER_ADMIN'].includes(v.data.kind))&&nativeScope?.accountId===message.accountId&&[nativeScope.pairedJid,nativeScope.pairedLid].filter(Boolean).some(v=>senderKey(v)===senderKey(r.data.senderJid))&&[nativeScope.pairedJid,nativeScope.pairedLid].filter(Boolean).some(v=>senderKey(v)===senderKey(message.sender)));
  const ids=[...new Set(owner.map(r=>r.data.personId))];
  if(ids.length!==1)return {role:'UNRESOLVED',actorRef:null,bindingRefs:[],historical:false};
  return {role:'ADMIN',actorRef:ids[0],bindingRefs:owner.map(r=>r.id),historical:owner.some(r=>effective(r.data))};
 }
 const incoming=matching.filter(r=>r.data.purpose==='SENDER'&&r.data.chatJid===message.chatJid&&(scope.subjectRole==='APPROVED_GROUP'||r.data.personId===scope.subjectRef));
 const ids=[...new Set(incoming.map(r=>r.data.personId))];
 if(ids.length!==1)return {role:'UNRESOLVED',actorRef:null,bindingRefs:[],historical:false};
 const isClient=scope.subjectRole==='CLIENT'&&roles.some(r=>r.data.personId===ids[0]&&r.data.kind==='CLIENT'&&r.data.serviceKind==='ESCORT'&&r.data.clientId===scope.clientId);
 const role=isClient?'CLIENT':scope.subjectRole==='ACCOUNTANT'?'ACCOUNTANT':'PARTICIPANT';
 return {role,actorRef:ids[0],bindingRefs:incoming.map(r=>r.id),historical:incoming.some(r=>effective(r.data))};
}
