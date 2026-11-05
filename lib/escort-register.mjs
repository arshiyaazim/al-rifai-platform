import {createHash} from 'node:crypto';
import {parseEscortOrder} from './escort-intake-candidate.mjs';
import {matchConfirmation,motherFamily,orderBusinessDay,orderIdentity} from './vessel-match.ts';
import {classifyProgramDuplicate} from './duplicate-identity.ts';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const digits=value=>String(value??'').replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
const clean=value=>digits(value).trim();
const phone=value=>{
 const raw=clean(value).replace(/(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/,'').replace(/[\s()+.-]/g,'');
 let n=raw;
 if(n.startsWith('880'))n='0'+n.slice(3);
 if(n.startsWith('+880'))n='0'+n.slice(4);
 return /^01[3-9]\d{8}$/.test(n)?'+88'+n:null;
};
const vesselKey=value=>clean(value).toLowerCase().replace(/^m\.?\s*v\.?\s*/i,'').replace(/[^\p{L}\p{N}]/gu,'');
const dhakaDate=value=>{const t=Date.parse(value??'');return Number.isFinite(t)?new Date(t+6*60*60*1000).toISOString().slice(0,10):null;};
const direct=jid=>typeof jid==='string'&&/@(?:s\.whatsapp\.net|lid)$/.test(jid);

export const OWNER_ESCORT_CLIENTS=Object.freeze([
 {id:'escort-client-hridoy-wa01',accountId:'wa-01',displayName:'Escort Hridoy',username:'@nhhridoyvau',phone:'+8801670535255'},
 {id:'escort-client-rezaul-karim-wa01',accountId:'wa-01',displayName:'Escort REZAUL KARIM',username:null,phone:'+8801836743754'},
 {id:'escort-client-tcis-wa01',accountId:'wa-01',displayName:'TCIS W/A',username:null,phone:'+8801757622300'},
]);
const ownerContactPhones=new Map(OWNER_ESCORT_CLIENTS.map(contact=>[contact.id,contact.phone]));

// Verified PN/LID aliases of an approved conversation resolve to that
// conversation's own phone number. Only Owner-approved scope rows are used, so a
// LID-addressed direct chat is attributed to the same person as its PN chat.
export function scopePhoneAliases(scopeRows){
 const out={};
 for(const row of scopeRows??[]){
  const canonical=String(value(row,'canonical_chat_jid','canonicalChatJid')??'');
  const canonicalPhone=phone(canonical);
  if(!canonicalPhone)continue;
  const aliases=value(row,'alias_chat_jids','aliasChatJids');
  for(const alias of Array.isArray(aliases)?aliases:[]){
   const key=String(alias).split('@')[0];
   if(key&&key!==canonical.split('@')[0])out[key]=canonicalPhone;
  }
 }
 return out;
}

function mappedPhone(value,aliases){
 const directPhone=phone(value);if(directPhone)return directPhone;
 const key=String(value??'').split('@')[0];return phone(aliases?.[key]??'');
}
function peerPhone(message,aliases){
 const candidate=message.direction==='INCOMING'?message.nativeSenderJid||message.sender||message.senderPhoneTransport:message.chatJid;
 return mappedPhone(candidate,aliases)||mappedPhone(message.senderPhoneTransport,aliases);
}
function releasePoint(text){return /(?:^|\n)\s*(?:release\s*point|release\s*place|রিলিজ\s*পয়েন্ট|রিলিজ\s*পয়েন্ট)\s*[:=.-]\s*(.+)\s*$/im.exec(text??'')?.[1]?.trim()??'';}
function sourceHash(account,message){return hash({accountId:account.accountId,chatJid:message.chatJid,id:message.id,sender:message.sender,direction:message.direction,sourceTime:message.sourceTime,text:message.text,nativeRevision:message.nativeRevision??null});}
function blockData(block){
 const f=block.fields??{};
 // A destination must come from a label or from text before the capacity. The
 // old inlineContext fallback could persist "/1000 m.t" as a destination; the
 // parser now refuses separator-only text, so no fallback is needed.
 return {motherVessel:f.motherVessel??'',lighterVessel:f.lighterVessel??'',masterMobile:block.masterMobile??'',masterMobileRaw:block.masterMobileRaw??String(f.masterMobile??''),masterMobileState:block.masterMobileState??'',cargo:f.cargo??'',capacity:f.capacity??'',importer:f.importer??'',destination:f.destination??'',bookingDate:block.bookingDate??null,escortName:f.escortName??'',escortMobile:block.employeeMobile??'',dutyDate:block.assignmentDate??null,shift:block.shift??'',releasePoint:releasePoint(block.raw??''),trip:f.trip??''};
}
// An incoming Order may state a loading/booking/service date. That date is a
// hint, not a confirmed assignment, so it must not block Draft creation. Only an
// escort name or mobile turns the message into an assignment.
function validDraftFields(data){return !!(data.motherVessel&&data.lighterVessel&&data.masterMobile&&!data.escortName&&!data.escortMobile);}
// Assignment evidence: the message names an escort for a known vessel pair. It
// may omit the escort mobile, duty date or shift; those gaps are recorded as
// reasons instead of discarding the evidence. Nothing here confirms a program.
function assignmentEvidenceFields(data){return !!(data.motherVessel&&data.lighterVessel&&data.masterMobile&&data.escortName);}
function assignmentGaps(data){
 const gaps=[];
 if(!phone(data.escortMobile))gaps.push('ESCORT_MOBILE');
 if(!data.dutyDate)gaps.push('DUTY_DATE');
 if(!data.shift)gaps.push('SHIFT');
 return gaps;
}
const value=(row,snake,camel)=>row?.[snake]??row?.[camel]??'';
const rowForMatch=row=>({
 id:row.id,
 account_id:value(row,'account_id','accountId'),
 client_contact_id:value(row,'client_contact_id','clientContactId'),
 chat_jid:value(row,'chat_jid','chatJid'),
 source_time:value(row,'source_time','sourceTime'),
 master_mobile:phone(value(row,'master_mobile','masterMobile'))||clean(value(row,'master_mobile','masterMobile')),
 mother_vessel:value(row,'mother_vessel','motherVessel'),
 lighter_vessel:value(row,'lighter_vessel','lighterVessel'),
 booking_date:value(row,'booking_date','bookingDate'),
 destination:value(row,'destination','destination'),
 escort_mobile:value(row,'escort_mobile','escortMobile'),
 duty_date:value(row,'duty_date','dutyDate'),
 shift:value(row,'shift','shift'),
 business_key:value(row,'business_key','businessKey'),
 status:value(row,'status','status'),
 });
// Group senders are authorized only through an explicit, active authorization
// row for the exact group and participant JID. A contact qualifies when it is an
// Owner-provided escort client (frozen list in this module) or when it was added
// from Owner-approved group evidence (source OWNER_APPROVED_GROUP_*). Direct
// chats remain stricter: only Owner-provided clients can be a direct source.
export const APPROVED_GROUP_CONTACT_SOURCE='OWNER_APPROVED_GROUP_20261026';
function approvedGroupContact(contact){
 if(!contact||contact.account_id!=='wa-01'||contact.active===false)return false;
 return ownerContactPhones.get(String(contact.id))===contact.phone
  ||String(contact.source??'')===APPROVED_GROUP_CONTACT_SOURCE;
}
function authorizedGroupContact(message,contacts,groupAuthorizations){
 if(!message.chatJid?.endsWith('@g.us')||message.direction!=='INCOMING')return null;
 const participant=String(message.nativeSenderJid||message.sender||'').trim();
 if(!participant)return null;
 const authorization=groupAuthorizations.find(item=>
  value(item,'account_id','accountId')===message.accountId
  &&value(item,'group_jid','groupJid')===message.chatJid
  &&value(item,'participant_jid','participantJid')===participant
  &&item.active!==false);
 if(!authorization)return null;
 return contacts.find(contact=>contact.id===value(authorization,'client_contact_id','clientContactId')
  &&approvedGroupContact(contact))??null;
}
// Contacts explicitly authorized for one approved group. Used to attribute an
// office-posted assignment to the escort the message itself names; a person is
// never guessed from position, display order or proximity.
function groupAuthorizedContacts(message,contacts,groupAuthorizations){
 if(!message.chatJid?.endsWith('@g.us'))return [];
 const ids=new Set(groupAuthorizations
  .filter(item=>value(item,'account_id','accountId')===message.accountId
   &&value(item,'group_jid','groupJid')===message.chatJid
   &&item.active!==false)
  .map(item=>String(value(item,'client_contact_id','clientContactId'))));
 return contacts.filter(contact=>ids.has(String(contact.id))&&approvedGroupContact(contact));
}
// Resolve the escort a block names, but only when the match is unique inside
// the authorized participants of that group: mobile first, then exact name.
function resolveGroupBlockContact(message,contacts,groupAuthorizations,data){
 const candidates=groupAuthorizedContacts(message,contacts,groupAuthorizations);
 if(!candidates.length)return null;
 const mobile=phone(data.escortMobile);
 if(mobile){
  const matched=candidates.filter(contact=>phone(contact.phone)===mobile);
  return matched.length===1?matched[0]:null;
 }
 const name=textKey(data.escortName);
 if(!name)return null;
 const matched=candidates.filter(contact=>textKey(contact.display_name)===name);
 return matched.length===1?matched[0]:null;
}
export function resolveEscortSourceContact(account,message,contacts,aliases={},groupAuthorizations=[]){
 if(account.accountId!=='wa-01'||message.accountId!=='wa-01')return null;
 if(message.chatJid?.endsWith('@g.us')){
  return authorizedGroupContact(message,contacts,groupAuthorizations);
 }
 if(!direct(message.chatJid))return null;
 const chatPhone=mappedPhone(message.chatJid,aliases);
 const senderPhone=message.direction==='INCOMING'?peerPhone(message,aliases):chatPhone;
 if(!chatPhone||senderPhone!==chatPhone)return null;
 return contacts.find(contact=>contact.account_id==='wa-01'
  &&contact.active!==false&&contact.phone===chatPhone
  &&ownerContactPhones.get(String(contact.id))===contact.phone)??null;
}
export function classifyBusinessSource(account,message,contacts,aliases={},groupAuthorizations=[],cashScopeChats=[]){
 if(account.accountId!=='wa-01'||message.accountId!=='wa-01'){
  return {domain:null,outcome:'ACCOUNT_EXCLUDED'};
 }
 const isCashSource=cashScopeChats.includes(message.chatJid);
 const vesselContact=resolveEscortSourceContact(account,message,contacts,aliases,groupAuthorizations);
 if(isCashSource&&vesselContact)return {domain:null,outcome:'SOURCE_CONFLICT'};
 if(isCashSource)return {domain:'cash',outcome:'CASH_SOURCE'};
 if(vesselContact)return {domain:'vessel',outcome:'VESSEL_SOURCE'};
 // An Owner-approved group also carries the office's own posts. They are vessel
 // evidence, but only a block-level match can attribute them to an escort.
 if(message.chatJid?.endsWith('@g.us')&&groupAuthorizedContacts(message,contacts,groupAuthorizations).length){
  return {domain:'vessel',outcome:'VESSEL_GROUP_SOURCE'};
 }
 return {domain:null,outcome:'UNAPPROVED_SOURCE'};
}
function provenance(account,message){
 return {accountId:account.accountId,chatJid:message.chatJid,messageId:message.id,sourceTime:message.sourceTime,
  direction:message.direction,senderJid:message.nativeSenderJid||message.sender||null,
  senderPhoneTransport:message.senderPhoneTransport||null,
  chatType:message.chatJid?.endsWith('@g.us')?'group':direct(message.chatJid)?'direct':'unknown'};
}
const textKey=value=>clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
function businessKey(accountId,data){
 const mother=vesselKey(data.motherVessel),lighter=vesselKey(data.lighterVessel);
 const escort=phone(data.escortMobile),date=String(data.dutyDate??'');
 const parsedDate=new Date(`${date}T00:00:00Z`);
 if(!mother||!lighter||!escort||! /^\d{4}-\d{2}-\d{2}$/.test(date)
  ||!Number.isFinite(parsedDate.getTime())||parsedDate.toISOString().slice(0,10)!==date)return null;
 return hash(['escort-business-order-v1',accountId,mother,lighter,escort,date]);
}
function validDateValue(value){
 if(value instanceof Date&&!Number.isFinite(value.getTime()))return null;
 const date=value instanceof Date?value.toISOString().slice(0,10):String(value??'').slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
 const timestamp=Date.parse(`${date}T00:00:00Z`);
 return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===date
  ?{date,timestamp}:null;
}
function sameVesselPair(row,data){
 const mother=vesselKey(value(row,'mother_vessel','motherVessel'));
 const lighter=vesselKey(value(row,'lighter_vessel','lighterVessel'));
 return !!mother&&!!lighter&&mother===vesselKey(data.motherVessel)
  &&lighter===vesselKey(data.lighterVessel);
}
function assignmentWithinOneDay(row,data){
 if(!value(row,'escort_mobile','escortMobile'))return false;
 const existing=validDateValue(value(row,'duty_date','dutyDate'));
 const incoming=validDateValue(data.dutyDate);
 return !!existing&&!!incoming&&Math.abs(existing.timestamp-incoming.timestamp)<=86400000;
}
function rowBusinessKey(row){
 return value(row,'business_key','businessKey')
  ||businessKey(row.account_id,{
   motherVessel:value(row,'mother_vessel','motherVessel'),
   lighterVessel:value(row,'lighter_vessel','lighterVessel'),
   escortMobile:value(row,'escort_mobile','escortMobile'),
   dutyDate:value(row,'duty_date','dutyDate'),
  });
}

/** Purely derives idempotent database operations from the read-only bridge snapshot. */
export function deriveEscortRegisterOps(account,messages,contacts,existingRows,aliases={},groupAuthorizations=[],cashScopeChats=[],options={}){
 if(account.accountId!=='wa-01')return [];
 const epoch=options.epoch??null;
 const chatAliases=options.chatAliases??{};
 // Canonical rows get an epoch-salted id so a pre-transition row can never own
 // the same primary key; replay inside one epoch stays deterministic.
 const salt=options.epoch?[options.epoch]:[];
 const canonicalChat=jid=>chatAliases[jid]??jid;
 // Provenance epochs are independent reconstructions: a canonical row is never
 // suppressed by an archived row that describes the same source block.
 const scopedRows=existingRows.filter(r=>epoch==null||(value(r,'dataset_epoch','datasetEpoch')||epoch)===epoch);
 const known=scopedRows.map(rowForMatch).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const orderPool=scopedRows.filter(r=>value(r,'status')==='DRAFT'&&value(r,'account_id','accountId')===account.accountId)
  .map(r=>({id:String(value(r,'id')),messageId:String(value(r,'source_message_id','sourceMessageId')),chatJid:String(value(r,'chat_jid','chatJid')),mother:String(value(r,'mother_vessel','motherVessel')),lighter:String(value(r,'lighter_vessel','lighterVessel')),masterRaw:String(r.parsed?.fields?.masterMobile??value(r,'master_mobile','masterMobile')??''),sourceTime:String(value(r,'source_time','sourceTime')),contactId:String(value(r,'client_contact_id','clientContactId')),shift:String(value(r,'shift')||r.parsed?.shift||''),dutyDate:String(value(r,'duty_date','dutyDate')??'')}));
 const ops=[];const existingHashes=new Set(scopedRows.map(r=>`${value(r,'account_id','accountId')}|${value(r,'source_hash','sourceHash')}|${value(r,'block_key','blockKey')}`));
 // Logical Vessel order identity (Target 01). One business order can arrive as
 // several message fragments. Every fragment keeps its own row and its own
 // source message — evidence is never dropped or overwritten — but carries the
 // same deterministic `logicalOrderId`, so the register and the Admin
 // Confirmation matcher can treat them as one order instead of manufacturing an
 // ambiguity. Fragments only share an identity within the same Lighter, Master
 // Mobile and shift on the same day (or one day apart); anything else stays a
 // separate order, including a genuinely new duty for the same Lighter.
 const logicalOrderIdOf=(chat,data,sourceTime)=>{
  const identity=orderIdentity({lighter:data.lighterVessel,masterRaw:data.masterMobileRaw||data.masterMobile,shift:data.shift});
  if(!identity)return null;
  const day=orderBusinessDay({dutyDate:data.dutyDate,sourceTime});
  // The mother's leading name word buckets the fleet without splitting the two
  // spellings of one vessel. The merge decision itself is made by the matcher,
  // which additionally applies the tolerant `motherCompatible` rule.
  return {logicalOrderId:hash(['escort-logical-order-v1',account.accountId,chat,identity,day,motherFamily(data.motherVessel)]),orderIdentity:`${identity}|${day}`};
 };
 for(const message of messages){
  const sourceRoute=classifyBusinessSource(account,message,contacts,aliases,groupAuthorizations,cashScopeChats);
  if(sourceRoute.domain!=='vessel')continue;
  const authorContact=resolveEscortSourceContact(account,message,contacts,aliases,groupAuthorizations);
  if(!message.text||message.deletedAt)continue;
  const blocks=parseEscortOrder(message.text,{messageDate:dhakaDate(message.sourceTime)});
  const source=sourceHash(account,message);
  for(const block of blocks){
   const data=blockData({...block,raw:message.text});
   const sourceProvenance=provenance(account,message);
   const blockKey=`${block.startLine??1}:${vesselKey(data.lighterVessel)}`;
   if(existingHashes.has(`${account.accountId}|${source}|${blockKey}`))continue;
   // Group messages: the author is the source for an incoming participant post.
   // An office post has no author person, so the escort named inside the block is
   // resolved against the authorized participants of that exact group.
   const namedContact=message.chatJid?.endsWith('@g.us')&&data.escortName
    ?resolveGroupBlockContact(message,contacts,groupAuthorizations,data)
    :null;
   const contact=authorContact??namedContact;
   if(!contact)continue;
   // An incoming participant may not create an assignment for somebody else.
   if(message.direction==='INCOMING'&&authorContact&&data.escortName
    &&(!namedContact||String(namedContact.id)!==String(authorContact.id)))continue;
   if(message.direction==='INCOMING'&&!message.chatJid?.endsWith('@g.us')&&validDraftFields(data)){
    // A repeated fragment of an order that is already known is evidence for the
    // existing draft, never a second draft. The message itself stays immutable in
    const id=hash(['escort-order',...salt,account.accountId,source,blockKey]);
    const logicalOrderId=logicalOrderIdOf(canonicalChat(message.chatJid),data,message.sourceTime);
    const row={id,accountId:account.accountId,clientContactId:contact.id,clientPhone:contact.phone,chatJid:message.chatJid,sourceMessageId:message.id,sourceHash:source,blockKey,sourceTime:message.sourceTime,businessKey:null,...data,status:'DRAFT',reasons:[],parsed:{...block,source:sourceProvenance,...(logicalOrderId?{logicalOrderId:logicalOrderId.logicalOrderId,orderIdentity:logicalOrderId.orderIdentity}:{})},sourceText:message.text};
    const draftOp={kind:'DRAFT',row,event:{id:hash(['escort-order-event',id,'DRAFT_CREATED',source]),orderId:id,eventType:'DRAFT_CREATED',sourceMessageId:message.id,sourceHash:source,payload:{...row,source:sourceProvenance}}};
    ops.push(draftOp);known.push(rowForMatch({...row,account_id:account.accountId,client_phone:contact.phone,source_hash:source,block_key:blockKey,status:'DRAFT'}));orderPool.push({id,messageId:message.id,chatJid:row.chatJid,mother:data.motherVessel,lighter:data.lighterVessel,masterRaw:data.masterMobileRaw||data.masterMobile,sourceTime:message.sourceTime,contactId:contact.id,dutyDate:data.dutyDate??null,shift:data.shift??null});existingHashes.add(`${account.accountId}|${source}|${blockKey}`);continue;
   }
   // Office assignments are outbound. A complete assignment posted inside an
   // approved group by its author is evidence for Admin review, never a
   // confirmation (the program rule still needs the direct-client reply).
   const assignmentDirection=message.direction==='OUTGOING'
    ||(message.direction==='INCOMING'&&message.chatJid?.endsWith('@g.us'));
   if(!assignmentDirection||!assignmentEvidenceFields(data))continue;
   // Verified-Admin gate (opt-in): an outgoing row that is not from the paired
   // Admin identity can never act as a confirmation, even in a client chat.
   if(message.direction==='OUTGOING'&&options.requireVerifiedAdmin
    &&typeof options.isVerifiedAdmin==='function'&&!options.isVerifiedAdmin(message))continue;
   // Owner rule: the actual outgoing Admin message in the same client conversation
   // is the confirmation. Matching uses conversation identity, vessel context,
   // Master Mobile digits (with one-digit/correction evidence) and chronology.
   const confirmationMatch=matchConfirmation(orderPool,{
    messageId:message.id,chatJid:message.chatJid,mother:data.motherVessel,lighter:data.lighterVessel,
    masterRaw:data.masterMobileRaw||data.masterMobile,sourceTime:message.sourceTime,contactId:contact.id,
    shift:data.shift||null,
   },{windowDays:options.windowDays??30,corrections:options.corrections,canonicalChat});
   const candidates=confirmationMatch.orderId?[known.find(r=>r.id===confirmationMatch.orderId)].filter(Boolean):[];
   const key=businessKey(account.accountId,data);
   const duplicateCandidates=[...new Map(known.filter(row=>
     row.account_id===account.accountId&&sameVesselPair(row,data)&&assignmentWithinOneDay(row,data))
     .map(row=>[row.id,row])).values()];
   // Shadow classification (disabled by default): records explainable
   // EXACT/PROBABLE/AMBIGUOUS/DISTINCT evidence for review without changing
   // candidate selection or any write decision.
   const duplicateClassification=options.duplicateShadow===true
     ? duplicateCandidates.map(candidate=>({orderId:String(candidate.id),...classifyProgramDuplicate({
        motherVessel:data.motherVessel,lighterVessel:data.lighterVessel,startDate:data.dutyDate,
        shift:data.shift,masterMobile:data.masterMobile,escortMobile:data.escortMobile,
        releasePoint:data.releasePoint,
       },{
        motherVessel:String(value(candidate,'mother_vessel','motherVessel')),
        lighterVessel:String(value(candidate,'lighter_vessel','lighterVessel')),
        startDate:String(value(candidate,'duty_date','dutyDate')),
        shift:String(value(candidate,'shift')),
        masterMobile:String(candidate.parsed?.fields?.masterMobile??value(candidate,'master_mobile','masterMobile')??''),
        escortMobile:String(value(candidate,'escort_mobile','escortMobile')),
        releasePoint:String(value(candidate,'release_point','releasePoint')),
       })}))
     : undefined;
   const duplicate=duplicateCandidates.length===1?duplicateCandidates[0]:null;
   const sameBusinessOrder=!!duplicate&&rowBusinessKey(duplicate)===key
     &&String(duplicate.shift).toUpperCase()===String(data.shift).toUpperCase();
   const id=duplicate
     ?duplicate.id
     :duplicateCandidates.length===0&&key
      ?hash(['escort-business-order-v1',...salt,key])
      :hash(['escort-assignment-review',...salt,account.accountId,source,blockKey]);
   const gaps=assignmentGaps(data);
   const reasons=[...(gaps.length?[`ASSIGNMENT_EVIDENCE_INCOMPLETE:${gaps.join('+')}`]:[]),
    ...(duplicateCandidates.length>1
     ?['POTENTIAL_DUPLICATE_AMBIGUOUS_REQUIRES_REVIEW']
     :sameBusinessOrder
      ?['BUSINESS_DUPLICATE_SOURCE_LINKED']
      :duplicate
       ?['POTENTIAL_DUPLICATE_WITHIN_ONE_DAY_REQUIRES_REVIEW']
     :confirmationMatch.state==='AMBIGUOUS'
     ?['ASSIGNMENT_MATCH_AMBIGUOUS']
     :confirmationMatch.state==='WEAK_EVIDENCE'
      ?['MASTER_MOBILE_UNRESOLVED']
      :confirmationMatch.orderId
       ?['ASSIGNMENT_MATCH_CANDIDATE_REQUIRES_REVIEW']
       :['DRAFT_MATCH_UNRESOLVED'])];
   const row={id,accountId:account.accountId,clientContactId:contact.id,clientPhone:contact.phone,chatJid:message.chatJid,sourceMessageId:message.id,sourceHash:source,blockKey,sourceTime:message.sourceTime,businessKey:duplicate?rowBusinessKey(duplicate):duplicateCandidates.length?null:key,...data,status:'REVIEW',reasons,parsed:{...block,source:sourceProvenance,...(duplicateClassification?{duplicateClassification}:{}),candidateDraftIds:candidates.map(candidate=>candidate.id),businessDuplicateOrderId:duplicate?.id??null,potentialDuplicateOrderIds:duplicateCandidates.map(candidate=>candidate.id),confirmationMatch,evidenceOnly:message.direction!=='OUTGOING',ownerRule:'ASSIGNMENT_DOES_NOT_CONFIRM_OR_START_DUTY'},confirmationMessageId:message.direction==='OUTGOING'?message.id:null,confirmationSourceHash:message.direction==='OUTGOING'?source:null,sourceText:message.text};
   ops.push({kind:'REVIEW',row,event:{id:hash(['escort-order-event',id,'ASSIGNMENT_REVIEW',source]),orderId:id,eventType:'ASSIGNMENT_REVIEW',sourceMessageId:message.id,sourceHash:source,payload:{...row,ownerRule:'ASSIGNMENT_DOES_NOT_CONFIRM_OR_START_DUTY',source:sourceProvenance}}});
   existingHashes.add(`${account.accountId}|${source}|${blockKey}`);
   if(!known.some(candidate=>candidate.id===row.id)){
    known.push(rowForMatch({...row,account_id:account.accountId,client_contact_id:contact.id,
     client_phone:contact.phone,source_hash:source,block_key:blockKey}));
   }
  }
 }
 return ops;
}

export function sourceHashForEscortMessage(account,message){return sourceHash(account,message);}
