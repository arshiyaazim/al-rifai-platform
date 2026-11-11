import {createHash} from 'node:crypto';
import {extractEscortMessages,explicitDutyDate} from './employee-program-validation.mjs';
import {parseEscortOrder} from './escort-intake-candidate.mjs';

export const HISTORY_PARSER_VERSION='stored-history-extraction-v2';
export const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const digits=s=>String(s).normalize('NFC').replace(/[০-৯]/g,c=>String(c.charCodeAt(0)-0x09e6));
// Cash method markers are written in Bangla as well as ASCII. Normalize the
// explicit markers used by the approved payment format so the same parser
// handles `(বি)` / `(নগদ)` exactly like `(B)` / `(N)`.
const cashMarkers=s=>String(s)
 .replace(/\(\s*বি(?:কাশ)?\s*\)/g,'(B)')
 .replace(/\(\s*এন\s*\)/g,'(N)')
 .replace(/\(\s*নগদ\s*\)/g,'(N)')
 .replace(/\(\s*সি\s*\)/g,'(C)')
 .replace(/\(\s*রকেট\s*\)/g,'(R)')
 .replace(/\(\s*ব্যাংক\s*\)/g,'(BANK)');
const normalizeCash=s=>cashMarkers(digits(s)).replace(/\bID\s*:\s*ID\s*:/gi,'ID:');
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
// Phone numbers may be written with spaces, dots or hyphens between digits
// (observed in the authorized Admin -> Accountant conversation). The canonical
// normalization below still strips those separators before validating.
const phonePattern=/(?:\+?880|00880|0)[\s.\-]*1[3-9](?:[\s.\-]?[0-9]){8}(?![0-9])/g;
const isPhoneStart=(s,i)=>i===0||!/[0-9]/.test(s[i-1]);
const ID_PREFIX=/^\s*(?:ID|Employee\s*ID|আইডি)(?=\s|:|;|-|$)\s*[:;=\-]?\s*:?\s*/iu;
const idLine=line=>ID_PREFIX.test(line);
const METHOD_MARKER=/[\(\{]\s*(B|BKASH|BIKASH|N|NAGAD|C|CASH|R|ROCKET|BANK)\s*[\)\}]?/i;
const METHOD_WORD=/\b(BKASH|BIKASH|NAGAD|CASH|ROCKET|BANK)\b/i;
const METHODS={B:'bkash',BKASH:'bkash',BIKASH:'bkash',N:'nagad',NAGAD:'nagad',C:'cash',CASH:'cash',R:'rocket',ROCKET:'rocket',BANK:'bank'};
const NAME_PATTERN=/^[\p{L}\p{M} .,'’()&:\/-]{2,100}$/u;
const cleanName=value=>String(value??'').trim().replace(/^[\s,:;*\-]+|[\s,:;*\-]+$/g,'').trim();

function amountToken(value){
 const slash=/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*\/\s*-{1,2}/.exec(value);
 if(slash)return {raw:slash[1],index:slash.index,length:slash[0].length};
 const labelled=/(?:Tk|Amount|টাকা)\s*[:=]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(value);
 if(labelled)return {raw:labelled[1],index:labelled.index,length:labelled[0].length};
 // `(N) 500-` without a slash is an observed abbreviation.
 const bare=/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*-{1,2}\s*(?:$|[\s,])/.exec(value);
 if(bare)return {raw:bare[1],index:bare.index,length:bare[0].length};
 return null;
}

function blockComplete(value){
 return [...value.matchAll(phonePattern)].length>0
  && !!amountToken(value)
  && (METHOD_MARKER.test(value)||METHOD_WORD.test(value));
}

// Explicit ID/name/payout blocks are deliberately stricter than the archive parser.
// A history row alone cannot establish author, forwarding state or send success.
//
// Owner rule: when an eligible payment block contains exactly one identifiable
// mobile number, that number is BOTH the employee identity and the payout
// destination. Two numbers keep the canonical ID + payout structure. Three or
// more numbers are ambiguous and always go to review.
/**
 * @param {string} text
 * @returns {Array<{blockKey:string;blockOrder:number;kind:string;fields:Record<string,string>;reasons:string[]}>}
 */
export function parsePaymentBlocks(text){
 const lines=normalizeCash(text).split(/\r?\n/),out=[];
 for(let i=0;i<lines.length;i++){
  if(!idLine(lines[i]))continue;
  let block=lines[i].replace(ID_PREFIX,'').replace(/^[\s:;=\-]+/,'').trim(),end=i;
  while(end+1<lines.length&&end-i<6&&!idLine(lines[end+1])){
   const next=lines[end+1].trim();
   if(blockComplete(block)&&!/^(?:purpose|উদ্দেশ্য|tk|amount|টাকা|note|নোট)\b/i.test(next))break;
   block+=' '+next;
   end+=1;
  }
  const issues=[],fields={};
  const phones=[...block.matchAll(phonePattern)].filter(m=>isPhoneStart(block,m.index));
  const first=phones[0],second=phones[1],last=phones[phones.length-1];
  if(!first){
   issues.push('EMPLOYEE_ID_UNRESOLVED','PAYOUT_DESTINATION_UNRESOLVED');
  }else{
   fields.employeeId=first[0];
   const employee=employeeMobile(first[0]);
   if(employee)fields.employeeMobile=employee;else issues.push('EMPLOYEE_ID_UNRESOLVED');
   if(phones.length===1){
    // Single-mobile rule: employee_mobile = payout_mobile.
    fields.payoutNumber=first[0];
    fields.payoutMobile=employee;
    if(!employee)issues.push('PAYOUT_DESTINATION_UNRESOLVED');
   }else if(phones.length===2){
    fields.payoutNumber=second[0];
    const payout=employeeMobile(second[0]);
    if(payout)fields.payoutMobile=payout;else issues.push('PAYOUT_DESTINATION_UNRESOLVED');
   }else{
    issues.push('AMBIGUOUS_MOBILE_NUMBERS');
   }
  }

  // Employee name. Canonical two-number form keeps the name between the ID and
  // payout number. The single-number form may put the name before OR after the
  // one number.
  let name='';
  if(first&&second&&phones.length===2){
   name=cleanName(block.slice(first.index+first[0].length,second.index));
  }else if(first){
   const after=block.slice(first.index+first[0].length);
   const before=block.slice(0,first.index);
   const markerIndex=after.search(/[\(\{]\s*(?:B|N|C|R|BKASH|NAGAD|CASH|ROCKET|BANK)\b/i);
   const afterName=cleanName((markerIndex>=0?after.slice(0,markerIndex):after).replace(/[0-9][0-9\s.\-]*/g,' '));
   const beforeName=cleanName(before.replace(/[0-9][0-9\s.\-]*/g,' '));
   name=NAME_PATTERN.test(afterName)?afterName:(NAME_PATTERN.test(beforeName)?beforeName:'');
  }
  if(name&&NAME_PATTERN.test(name))fields.employeeName=name;
  else issues.push('EMPLOYEE_NAME_UNRESOLVED');

  // Payment method. Only the verified markers/labels already used by this
  // platform are accepted; a missing method is never fabricated as `cash`.
  const tail=last?block.slice(last.index+last[0].length):block;
  const marker=METHOD_MARKER.exec(tail)??METHOD_MARKER.exec(block);
  const word=marker?null:(METHOD_WORD.exec(tail)??METHOD_WORD.exec(block));
  if(marker||word){
   const key=(marker?marker[1]:word[1]).toUpperCase();
   fields.methodMarker=key;
   fields.method=METHODS[key];
  }else{
   issues.push('PAYMENT_METHOD_UNRESOLVED');
  }

  // Amount in minor units. The token must be a positive, exactly parsable
  // amount; commas and one/two decimal places are preserved.
  const amount=amountToken(tail)??amountToken(block);
  if(amount){
   fields.amount=amount.raw;
   const minor=exactMinor(amount.raw);
   if(minor)fields.amountMinor=minor;else issues.push('AMOUNT_INVALID');
  }else{
   issues.push('AMOUNT_INVALID');
  }

  const explicitPurpose=/^\s*(?:purpose|উদ্দেশ্য)\s*[:=]\s*(.+)$/imu.exec(block);
  if(explicitPurpose)fields.purpose=explicitPurpose[1].trim().slice(0,500);
  else if(amount){
   const rest=tail.slice(amount.index+amount.length).trim().replace(/^[\s,;:*\-]+/,'');
   if(rest&&!/^[\/\-]+$/.test(rest))fields.purpose=rest.slice(0,500);
  }
  if(!fields.purpose)fields.purpose='Owner direct payment instruction';

  if(/cancel|পাঠাবেন না|পাঠিও না|বাদ দিন|ফেরত/iu.test(text))issues.push('CANCELLATION_OR_RETURN_REQUIRES_REVIEW');
  out.push({blockKey:'payment-block-'+out.length,blockOrder:out.length,kind:'PAYMENT',fields,reasons:[...new Set(issues)]});
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
