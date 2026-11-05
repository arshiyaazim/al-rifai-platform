import {createHash} from 'node:crypto';
import {extractEscortMessages,explicitDutyDate} from './employee-program-validation.mjs';
import {parseEscortOrder} from './escort-intake-candidate.mjs';

export const HISTORY_PARSER_VERSION='stored-history-extraction-v2';
export const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const digits=s=>String(s).normalize('NFC').replace(/[০-৯]/g,c=>String(c.charCodeAt(0)-0x09e6));
export function reconcileCashSourceCopies(rows,signatureOf){
 const groups=new Map();
 for(const row of rows){
  const key=`${row.account_id}\u0000${row.message_id}`;
  const group=groups.get(key)??[];
  group.push(row);
  groups.set(key,group);
 }
 const unique=[],unresolvedGroups=[];
 let duplicateCopies=0,resolvedConflictGroups=0,ambiguousCopies=0;
 for(const group of groups.values()){
  const originals=group.filter(row=>row.source_store==='original');
  const signatures=new Set(group.map(signatureOf).map(value=>JSON.stringify(value)));
  if(originals.length===1){
   unique.push(originals[0]);
   duplicateCopies+=group.length-1;
   if(signatures.size>1)resolvedConflictGroups+=1;
  }else if(signatures.size===1){
   unique.push(originals[0]??group[0]);
   duplicateCopies+=group.length-1;
  }else{
   unresolvedGroups.push(group);
   ambiguousCopies+=group.length;
  }
 }
 return {unique,duplicateCopies,resolvedConflictGroups,unresolvedGroups,ambiguousCopies};
}
export function employeeMobile(value){
 const v=digits(value).replace(/[\s().-]/g,'');
 const national=v.replace(/^(?:\+?880|00880)/,'0');
 return /^01[3-9][0-9]{8}$/.test(national)?'+88'+national:null;
}
export function exactMinor(value){
 const v=digits(value).trim();
 if(!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?$/.test(v))return null;
 const [whole,fraction='']=v.replaceAll(',','').split('.');
 const amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 return amount>0n&&amount<=BigInt(Number.MAX_SAFE_INTEGER)?amount.toString():null;
}
const phonePattern=/(?:\+?880|00880|0)1[3-9][0-9]{8}(?![0-9])/g;
const isPhoneStart=(s,i)=>i===0||!/[0-9]/.test(s[i-1]);

// Explicit ID/name/payout blocks are deliberately stricter than the archive parser.
// A history row alone cannot establish author, forwarding state or send success.
/**
 * @param {string} text
 * @returns {Array<{blockKey:string;blockOrder:number;kind:string;fields:Record<string,string>;reasons:string[]}>}
 */
export function parsePaymentBlocks(text){
 const lines=digits(text).split(/\r?\n/),out=[];
 for(let i=0;i<lines.length;i++){
  if(!/^\s*(?:ID|Employee\s*ID|আইডি)(?=\s|:|$)\s*:?\s*/iu.test(lines[i]))continue;
  let block=lines[i].trim(),end=i;
  while(end+1<lines.length&&end-i<4&&!/^\s*(?:ID|Employee\s*ID|আইডি)(?=\s|:|$)\s*:?\s*/iu.test(lines[end+1])){
   if(/\d\s*\/-/.test(block))break;
   block+=' '+lines[++end].trim();
  }
  const issues=[],phones=[...block.matchAll(phonePattern)].filter(m=>isPhoneStart(block,m.index));
  const fields={};
  const first=phones[0],second=phones[1];
  if(first&&/^\s*(?:ID|Employee\s*ID|আইডি)(?=\s|:|$)\s*:?\s*$/iu.test(block.slice(0,first.index))){
   fields.employeeId=first[0];
   fields.employeeMobile=employeeMobile(first[0]);
  }else issues.push('EMPLOYEE_ID_UNRESOLVED');
  if(phones.length!==2)issues.push('PAYOUT_DESTINATION_UNRESOLVED');
  if(first&&second&&phones.length===2){
   const name=block.slice(first.index+first[0].length,second.index).trim().replace(/^[\s,:;*-]+|[\s,:;*-]+$/g,'');
   if(/^[\p{L}\p{M} .,'’()-]{2,100}$/u.test(name))fields.employeeName=name;
   else issues.push('EMPLOYEE_NAME_UNRESOLVED');
   fields.payoutNumber=second[0];
   fields.payoutMobile=employeeMobile(second[0]);
   const tail=block.slice(second.index+second[0].length);
   const method=/^\s*\(\s*(B|N)\s*\)\s*[:=]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*\/-(?:\s+(.*?))?\s*$/i.exec(tail);
   if(method){
    fields.methodMarker=method[1];
    fields.method=({B:'bkash',N:'nagad'})[method[1].toUpperCase()];
    fields.amount=method[2];
    const minor=exactMinor(method[2]);
    if(minor)fields.amountMinor=minor;else issues.push('AMOUNT_INVALID');
    fields.purpose=method[3]?.trim().slice(0,500)||'Owner direct payment instruction';
   }else issues.push('PAYMENT_FORMAT_REQUIRES_REVIEW');
  }
  if(end+1<lines.length&&/^\s*(?:purpose|উদ্দেশ্য)\s*[:=]/iu.test(lines[end+1])){fields.purpose=lines[++end].replace(/^\s*(?:purpose|উদ্দেশ্য)\s*[:=]\s*/iu,'').trim().slice(0,500);}
  if(/cancel|পাঠাবেন না|পাঠিও না|বাদ দিন|ফেরত/iu.test(text))issues.push('CANCELLATION_OR_RETURN_REQUIRES_REVIEW');
  out.push({blockKey:'payment-block-'+out.length,blockOrder:out.length,kind:'PAYMENT',fields,reasons:issues});
  i=end;
 }
 return out;
}

export function extractStoredMessage(message,context){
 if(!message||!['wa-01','wa-02'].includes(message.accountId)||typeof message.id!=='string'||!message.id||message.id.length>256||typeof message.chatJid!=='string'||message.chatJid.length>256||typeof message.sender!=='string'||message.sender.length>256||typeof message.text!=='string'||Buffer.byteLength(message.text)>64000||!['INCOMING','OUTGOING'].includes(message.direction)||!Number.isFinite(Date.parse(message.sourceTime)))throw Error('HISTORY_MESSAGE_CONTRACT_INVALID');
 if(!context?.allowed||!['ACCOUNTANT','CLIENT','APPROVED_GROUP'].includes(context.subjectRole))throw Error('HISTORY_SCOPE_DENIED');
 if(message.deletedAt)return [];
 const common=['HISTORICAL_ROLE_NOT_ESTABLISHED','FORWARDING_STATE_UNKNOWN','STORED_PROJECTION_NOT_SEND_SUCCESS'];
 const normalized=digits(message.text);
 let blocks=[];
 if(context.subjectRole==='ACCOUNTANT'&&message.direction==='OUTGOING'&&context.admission?.role==='ADMIN')blocks=parsePaymentBlocks(normalized);
 if(context.subjectRole==='CLIENT'||context.subjectRole==='APPROVED_GROUP'){
  const date=new Date(Date.parse(message.sourceTime)+6*3600000).toISOString().slice(0,10);
  blocks=parseEscortOrder(normalized,{messageDate:date}).map((b,i)=>{
   const fields={};
   for(const k of ['motherVessel','lighterVessel','masterMobile','destination','bookingDate','employeeName','escortName','employeeMobile','escortMobile','assignmentDate','shift','cargo','importer','capacity'])if(typeof b.fields[k]==='string'&&b.fields[k].trim())fields[k]=b.fields[k].trim().slice(0,500);
   if(b.employeeMobile)fields.employeeMobile=b.employeeMobile;
   if(b.masterMobile)fields.masterMobile=b.masterMobile;
   if(b.assignmentDate)fields.assignmentDate=b.assignmentDate;
   if(b.shift)fields.shift=b.shift;
   return {blockKey:'escort-block-'+i,blockOrder:i,kind:'ESCORT',fields,reasons:b.reasons};
  });
 }
 // Reuse the established explicit lifecycle/field parser. Lexical chatter is
 // retained by the chat reader, never admitted to a lifecycle command.
 if(context.subjectRole==='CLIENT'){
  const events=extractEscortMessages([{id:message.id,body:normalized,messageDate:new Date(Date.parse(message.sourceTime)+21600000).toISOString().slice(0,10)}]);
  const explicit=events.filter(e=>e.intentEvidence==='EXPLICIT_MESSAGE_MARKER');
  if(explicit.length)blocks=explicit.map((e,i)=>{
   const fields={...e.rawFields,lifecycleAction:e.intent};
   if(fields.employee_id){fields.employeeMobile=employeeMobile(fields.employee_id)??'';delete fields.employee_id;}
   if(fields.escortMobile)fields.escortMobile=employeeMobile(fields.escortMobile)??'';
   if(fields.oldEmployeeId)fields.oldEmployeeId=employeeMobile(fields.oldEmployeeId)??'';
   if(fields.newEmployeeId)fields.newEmployeeId=employeeMobile(fields.newEmployeeId)??'';
   for(const key of ['effectiveDate','actualStartDate','releaseDate','startDate'])if(fields[key])fields[key]=explicitDutyDate(fields[key]).date??'';
   if(fields.startDate){fields.assignmentDate=fields.startDate;delete fields.startDate;}
   if(e.shift)fields.shift=e.shift;
   delete fields.event;delete fields.orderId;
   return {blockKey:'escort-block-'+i,blockOrder:i,kind:'ESCORT',fields,reasons:e.reasons.filter(r=>!['MESSAGE_ROLE_UNVERIFIED','ORIGINAL_WHATSAPP_LINK_UNAVAILABLE'].includes(r))};
  });
 }
 if(context.subjectRole==='APPROVED_GROUP')blocks=[];
 const release=/(?:release date|end date|রিলিজের তারিখ)\s*[:=]/iu.test(normalized);
 if(release&&(context.subjectRole==='APPROVED_GROUP'||context.subjectRole==='CLIENT')){
  const fields={};
  const labels={employeeMobile:'(?:employee id|escort mobile|escort number)',releaseDate:'(?:release date|end date)',endShift:'(?:end shift)',releasePoint:'(?:release point)',masterMobile:'(?:master mobile)',conveyanceMinor:'(?:conveyance)'};
  const reasons=[];
  for(const [key,label] of Object.entries(labels)){const matches=[...normalized.matchAll(new RegExp('^\\s*'+label+'\\s*[:=]\\s*(.+)$','gim'))];if(matches.length===1)fields[key]=matches[0][1].trim();else if(matches.length>1)reasons.push('CONFLICTING_'+key);}
  if(fields.employeeMobile)fields.employeeMobile=employeeMobile(fields.employeeMobile)??'';
  if(fields.masterMobile)fields.masterMobile=employeeMobile(fields.masterMobile)??'';
  if(fields.conveyanceMinor)fields.conveyanceMinor=exactMinor(fields.conveyanceMinor)??'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fields.releaseDate??'')||!Number.isFinite(Date.parse(fields.releaseDate))||new Date(fields.releaseDate).toISOString().slice(0,10)!==fields.releaseDate)reasons.push('RELEASE_DATE_UNRESOLVED');
  if(!fields.employeeMobile)reasons.push('EMPLOYEE_ID_UNRESOLVED');
  if(!['D','N'].includes(fields.endShift))reasons.push('RELEASE_SHIFT_UNRESOLVED');
  blocks=[{blockKey:'release-block-0',blockOrder:0,kind:'RELEASE',fields,reasons}];
 }
 if(!blocks.length)return [];
 const sourceHash=sha({accountId:message.accountId,chatJid:message.chatJid,id:message.id,sender:message.sender,text:message.text,sourceTime:message.sourceTime,direction:message.direction,deletedAt:message.deletedAt??null});
 if(blocks.length>50)throw Error('HISTORY_BLOCK_BUDGET_EXCEEDED');
 return blocks.map(block=>{
  const externalRef=JSON.stringify([message.accountId,message.chatJid,message.id]);
  const sourceId=sha([externalRef,sourceHash,block.blockKey]);
  const id=sha([sourceId,HISTORY_PARSER_VERSION,sha(context.admission??null)]);
  return {id,source:{id:sourceId,accountId:message.accountId,chatJid:message.chatJid,messageId:message.id,sourceTime:message.sourceTime,sourceHash,externalRef,blockKey:block.blockKey,senderRef:message.sender,provider:'WHATSAPP_SQLITE_PROJECTION',originState:'UNKNOWN',visibilityState:'PROJECTION_PRESENT'},assertion:{version:'history-extraction-v2',parserVersion:HISTORY_PARSER_VERSION,kind:block.kind,fields:block.fields,reasons:[...new Set([...(context.admission?.historical?common.filter(r=>r!=='HISTORICAL_ROLE_NOT_ESTABLISHED'):common),...block.reasons])],senderLabel:context.senderLabel,direction:message.direction,blockOrder:block.blockOrder??0,operationId:sha([message.accountId,message.chatJid,message.id,block.blockKey]),admission:context.admission??{role:'UNRESOLVED',actorRef:null,bindingRefs:[],historical:false},subjectRef:context.subjectRef,authority:'REVIEW_ONLY',rawBodyCopied:false,posted:false}};
 });
}
