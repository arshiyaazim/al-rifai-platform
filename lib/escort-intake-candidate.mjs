/**
 * Pure Escort intake parser. It does not perform writes or establish actor authority.
 * Selectively ports Fazle-Core Escort's mobile-grouped lighter parsing and blank
 * Admin drafts under AL-RIFA’I's current policies.
 * Reference: modules/escort at 1838619b644dc83f4ca723d3442d94435e6050f1,
 * also supplied by the Owner on 11 October 2026. Source text is always retained.
 * Binding/alias decisions below are caller-supplied qualification inputs; this
 * module does not authenticate actors or turn input flags into production grants.
 */
import {canonical,sha,normalizeEmployeeMobile,validDate} from './employee-program-validation.mjs';
import {analyzeMobile} from './mobile-identity.mjs';

export const ESCORT_INTAKE_VERSION='escort-intake-candidate-v2';
const digits=s=>s.replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
const clean=s=>s.trim().replace(/^[\s*_:=-]+|[\s*]+$/g,'').trim();
const mobilePattern=/(?:\+?880|0)[\s-]?1[3-9](?:[\s-]?\d){8}(?!\d)/g;
const mobile=s=>normalizeEmployeeMobile(s,'employee_id');
const vesselName=s=>clean(s).replace(/^\(?\d{1,2}\)?\s*[-.)]\s*/,'').replace(/^m\.?\s*v\.?\s*[,:.]?\s*|^এমভি\s*[:.,]?\s*/i,'').replace(/^[*_~`"'\s,;-]+|[*_~`"'\s]+$/g,'').trim().replace(/[.,;]+$/,'');
const vesselKey=s=>vesselName(s).normalize('NFC').toLowerCase().replace(/[.\s-]/g,'');
const clone=v=>JSON.parse(JSON.stringify(v));
const proven=v=>v?.decision==='APPROVED'&&typeof v.approver==='string'&&!!v.approver.trim()&&/^[a-f0-9]{64}$/.test(v.evidenceSha??'');
const labels={
 'mother vessel':'motherVessel','mather vessel':'motherVessel','mother vessel name':'motherVessel','mother ship':'motherVessel',
 'মাদার ভেসেল':'motherVessel','মাদার ভেসেলের নাম':'motherVessel','মাদার শিপ':'motherVessel',
 'lighter vessel':'lighterVessel','righter vessel':'lighterVessel','lighter name':'lighterVessel','lighter':'lighterVessel',
 'লাইটার ভেসেল':'lighterVessel','লাইটার নাম':'lighterVessel','লাইটার':'lighterVessel',
 'master mobile':'masterMobile','master mobile number':'masterMobile','master mob':'masterMobile','mst mob':'masterMobile','mobile number':'masterMobile','mob':'masterMobile',
 'মাস্টার মোবাইল':'masterMobile','মোবাইল নম্বর':'masterMobile','মাস্টার':'masterMobile',
 'cargo':'cargo','capacity':'capacity','cap':'capacity','ক্যাপাসিটি':'capacity','importer':'importer','a/c':'importer',
 'destination':'destination','dest':'destination','গন্তব্য':'destination','ডেস্টিনেশন':'destination',
 'booking date':'bookingDate','booking dt':'bookingDate',
 'escort name':'escortName','escort mobile':'escortMobile','employee id':'employeeMobile',
 'assignment':'assignmentDate','assignment date':'assignmentDate','start date':'assignmentDate','start dete':'assignmentDate',
 'shift':'shift','start shift':'shift','time':'shift',
 'trip':'trip','ট্রিপ':'trip',
};
// A label may be separated from its value by ":" "=" "." "-" (with optional
// spaces) or by whitespace alone. Whitespace-only is required for the Owner's
// real messages "Destination kacpur" and "DESTINATION SHAH"; a bare label line
// ("Importer") still matches nothing, which is the existing behaviour.
const labelExpression=new RegExp('^('+Object.keys(labels).sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')'+'(?:\\s*[:=.-]+\\s*|\\s+)(.*)$','i');
const labeled=s=>{const text=clean(s),mv=text.match(/^MV\s*[:=]\s*(.*)$/i),m=text.match(labelExpression);return mv?{field:'motherVessel',value:clean(mv[1])}:m?{field:labels[m[1].toLowerCase()],value:clean(m[2])}:null;};

export function parseEscortDate(raw,messageDate){
 if(typeof raw!=='string')return {date:null,shift:null};
 // A trailing clock such as "(9:40AM)" is a time-of-day note, not a shift and not
 // part of the date. Proven by a real authorized message: "১২/০৯/২৬(৯:৪০AM)".
 const text=digits(raw.trim()).replace(/[.,]+$/,'').replace(/\s*\(\s*\d{1,2}:\d{2}\s*(?:am|pm)?\s*\)\s*$/i,''),shiftMatch=text.match(/\(+\s*(D|N|Day|Night)\s*\)+/i);
 const shift=shiftMatch?shiftMatch[1][0].toUpperCase():null;
 const m=text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?:\s*\(+\s*(?:D|N|Day|Night)\s*\)+)?\s*$/i);
 if(!m){const iso=text.replace(/\s*\(+\s*(?:D|N|Day|Night)\s*\)+\s*$/i,'');return {date:validDate(iso)?iso:null,shift};}
 let year=Number(m[3]);
 if(m[3].length===2){
  if(!validDate(messageDate))return {date:null,shift};
  year=Math.floor(Number(messageDate.slice(0,4))/100)*100+year;
  if(Math.abs(year-Number(messageDate.slice(0,4)))>5)return {date:null,shift};
 }
 const date=`${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
 return {date:validDate(date)?date:null,shift};
}

function nativeTime(timestamp){
 if(typeof timestamp!=='string'||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp))return null;
 const ms=Date.parse(timestamp.replace(' ','T'));
 if(!Number.isFinite(ms)||!validDate(timestamp.slice(0,10))||Number(timestamp.slice(11,13))>23||Number(timestamp.slice(14,16))>59||Number(timestamp.slice(17,19))>59)return null;
 const local=new Date(ms+6*3600000).toISOString();
 return {messageDate:local.slice(0,10),messageTimestamp:local.slice(0,19)+'+06:00',timezone:'Asia/Dhaka'};
}

/**
 * The Owner-authorized free-text order carries no numbered list and no
 * "Lighter Vessel:" label, so the numbered/labelled grammar never opens a block:
 *
 *   Mother vessel Mv Beltokyo, yellow corn to Amram feed
 *   Mv Ritaj
 *   Capacity 2000mt
 *   K/a to rupshi
 *   master
 *   +880 1921-155548
 *   driver
 *   +880 1992-783176
 *
 * Detection is deliberately narrow — a "Mother vessel" line carrying prose after
 * a comma, a bare "Mv <name>" line, and a bare "master" line followed by a phone.
 * A message that does not match all three keeps the existing behaviour exactly.
 * No date or shift is invented; a value that is not written stays empty.
 */
function freeTextOrder(lines){
 const phoneLine=/^(?:\+?880|0)[\s-]?1[3-9](?:[\s-]?\d){8}$/;
 const motherLine=lines.find(l=>/^mother\s+vessel\b/i.test(l.value)&&l.value.includes(','));
 if(!motherLine)return null;
 const bareVessel=lines.find(l=>l!==motherLine
  &&/^m\.?\s*v\.?\s*\S.*$/i.test(l.value)&&l.value.split(/\s+/).length<=4
  &&!l.value.includes(',')&&![...digits(l.value).matchAll(mobilePattern)].length);
 if(!bareVessel)return null;
 const masterAt=lines.findIndex(l=>/^(?:master|mst)\s*$/i.test(l.value));
 if(masterAt<0)return null;
 const masterPhone=lines.slice(masterAt+1,masterAt+3).find(l=>phoneLine.test(l.value.trim()));
 if(!masterPhone)return null;

 const motherText=clean(clean(motherLine.value).replace(/^mother\s+vessel\b/i,'').replace(/^[\s:=.-]+/,''));
 const motherHead=clean(motherText.split(',')[0]);
 if(!vesselName(motherHead))return null;

 const fields={},fieldEvidence={},reasons=[];
 fields.motherVessel=motherHead;
 fieldEvidence.motherVessel={raw:motherText,bodyLine:motherLine.line};
 fields.lighterVessel=bareVessel.value;
 fieldEvidence.lighterVessel={raw:bareVessel.value,bodyLine:bareVessel.line};
 fields.masterMobile=masterPhone.value.trim();
 fieldEvidence.masterMobile={raw:masterPhone.value.trim(),bodyLine:masterPhone.line};

 // Reuse the labelled grammar for every other field it already understands.
 for(const l of lines){
  if(l===motherLine||l===bareVessel||l===masterPhone)continue;
  const f=labeled(l.value);
  if(!f||!['capacity','destination','cargo','importer','bookingDate','assignmentDate','shift'].includes(f.field))continue;
  if(fields[f.field]||!f.value)continue;
  fields[f.field]=f.value;fieldEvidence[f.field]={raw:l.value,bodyLine:l.line};
 }
 // "K/a to <place>" is the client's destination shorthand in this format.
 const ka=lines.find(l=>/^k\s*\/?\s*a\s+to\s+\S/i.test(l.value));
 if(ka&&!fields.destination){
  const value=clean(clean(ka.value).replace(/^k\s*\/?\s*a\s+to\s+/i,''));
  if(value){fields.destination=value;fieldEvidence.destination={raw:ka.value,bodyLine:ka.line};}
 }
 return {startLine:bareVessel.line,fields,fieldEvidence,reasons};
}

/** Text parsing establishes field evidence only, never source authority. */
/** @param {string} text @param {{messageDate?:string|null}} [options] */
export function parseEscortOrder(text,{messageDate=null}={}){
 if(typeof text!=='string'||text.length>64000)throw Error('ESCORT_TEXT_INVALID_OR_TOO_LARGE');
 const lines=text.split(/\r?\n/).map((raw,i)=>({raw,value:clean(raw),line:i+1}));
 // Free-text form (line-separated or pipe-separated). Gated so an ordinary
 // message can never enter it; a null result leaves the existing path untouched.
 const free=freeTextOrder(lines)
  ??(text.includes('|')?freeTextOrder(text.split('|').map((raw,i)=>({raw,value:clean(raw),line:i+1}))):null);
 const vesselLine=s=>/^(?:\(?\d{1,2}\)?[.)]\s*)?(?:m\.?\s*v\.?\s*|এমভি)/i.test(s)||/^\(?\d{1,2}\)?[.)]\s*\S/.test(s);
 const groupedPhone=i=>{
  for(let j=i;j<Math.min(i+5,lines.length);j++){
   if(j>i&&(vesselLine(lines[j].value)||labeled(lines[j].value)?.field==='lighterVessel'))break;
   const f=labeled(lines[j].value);
   if(f&&['escortName','escortMobile','employeeMobile','bookingDate','assignmentDate'].includes(f.field))continue;
   if([...digits(lines[j].value).matchAll(mobilePattern)].length)return true;
  }
  return false;
 };
 const mothers=[];let motherMobileConflict=false;
 // "AT-O/A" (at owner's account) is the client's Mother-Vessel separator: the
 // lighter lines come first, then the marker, then the Mother Vessel. 62 real
 // authorized messages use it, so when the marker is present the Mother Vessel is
 // chosen only from the lines after it; without the marker the heuristic is
 // unchanged. The name is still truncated at "/" ("M.V.Belyamato At O/A" →
 // "Belyamato At O") because that truncation is the key programIdFor() used for
 // the 85 existing Programs; preserving "/A" would derive a different Program
 // identity for the same duty. Order and confirmation truncate alike, so
 // matching stays consistent.
 const atOaIndex=lines.findIndex(l=>/^at\s*[- ]?o\s*\/?\s*a\b/i.test(l.value));
 for(let i=0;i<lines.length;i++){
  const f=labeled(lines[i].value);
  const motherPositionOk=atOaIndex<0||i>atOaIndex;
  if(f?.field==='motherVessel'){
   if(!motherPositionOk)continue;
   if(groupedPhone(i))motherMobileConflict=true;
   else mothers.push({raw:f.value,line:lines[i].line});
  }
  else if(motherPositionOk&&vesselLine(lines[i].value)&&!groupedPhone(i)&&!(/^\(?\d/.test(lines[i].value)))mothers.push({raw:lines[i].value,line:lines[i].line});
 }
 const atOaMotherMissing=atOaIndex>=0&&mothers.length===0;
 const motherKeys=[...new Set(mothers.map(m=>vesselKey(m.raw.split('/')[0])).filter(Boolean))];
 const mother=motherKeys.length===1?mothers[0]:null;
 const context={},contextEvidence={};const blocks=[];let current=null;
 // The free-text block is already complete; the line loop would only add
 // conflicting evidence (the driver's phone, a repeated capacity).
 if(free){blocks.push(free);current=free;}
 // A DESTINATION line belongs to the whole message, so a Lighter listed before
 // the line must still receive it. A block-level or inline value always wins.
 let messageDestination=null;
 function set(block,field,value,line){
  // A trailing comma belongs to the sentence, not to the destination name.
  const normalised=field==='destination'?String(value).replace(/[,\s]+$/,''):value;
  if(block.fields[field]&&block.fields[field]!==normalised){
   block.reasons.push('CONFLICTING_'+field);
   // A Lighter-specific destination is never overwritten by a message-level one.
   if(field==='destination')return;
  }
  block.fields[field]=normalised;block.fieldEvidence[field]={raw:value,bodyLine:line};
 }
 function start(raw,line){
  current={startLine:line,fields:{...context,lighterVessel:raw},fieldEvidence:{...contextEvidence,lighterVessel:{raw,bodyLine:line}},reasons:[]};
  if(mother){current.fields.motherVessel=mother.raw.split('/')[0];current.fieldEvidence.motherVessel={raw:mother.raw,bodyLine:mother.line};}
  blocks.push(current);
 }
 for(let i=0;!free&&i<lines.length;i++){
  const {value,line}=lines[i];if(!value)continue;const f=labeled(value);
  if(f?.field==='motherVessel')continue;
  if(f?.field==='lighterVessel'){
   let name=f.value;
   if(!name){let next=i+1;while(next<lines.length&&!lines[next].value)next++;if(lines[next]&&!labeled(lines[next].value)){name=lines[next].value;i=next;}}
   // The value line can itself be the old "15. NAME, CAPACITY: …, PHONE: …" form.
   const markerAt=name.search(/,\s*(?:CAPACITY|PHONE)\b/i);
   if(markerAt>0){
    const raw=name;
    const cap=raw.match(/\bCAPACITY\s*[:=]?\s*(\d[\d,.]*\s*(?:m\/?ton|mts|m\.?t|m\/t))/i);
    const ph=raw.match(/\bPHONE\s*[:=]?\s*((?:\+?88)?0?1[3-9][\d\s-]{8,})/i);
    start(raw.slice(0,markerAt),line);
    if(cap&&!current.fields.capacity)set(current,'capacity',cap[1].trim(),line);
    if(ph&&!current.fields.masterMobile)set(current,'masterMobile',ph[1].trim(),line);
    continue;
   }
   start(name,line);continue;
  }
  if(!f&&vesselLine(value)&&groupedPhone(i)){
   const phones=[...digits(value).matchAll(mobilePattern)];const first=phones[0];
   // Old client format: "02. HADIZ, CAPACITY: 1,000 M/T, PHONE: 01863191301".
   // Everything from the CAPACITY/PHONE marker on describes the lighter, not its
   // name. Splitting on the marker (not on commas) keeps "1,000" intact.
   const beforePhone=first?value.slice(0,first.index):value;
   const markerAt=beforePhone.search(/,\s*(?:CAPACITY|PHONE)\b/i);
   const name=(markerAt>0?beforePhone.slice(0,markerAt):beforePhone).replace(/[\s-]+$/,'');
   start(name,line);
   if(first){
    set(current,'masterMobile',first[0],line);
    // Capacity stated before the phone in the same old format.
    const capBefore=beforePhone.match(/\bCAPACITY\s*[:=]?\s*(\d[\d,.]*\s*(?:m\/?ton|mts|m\.?t|m\/t))/i);
    if(capBefore&&!current.fields.capacity)set(current,'capacity',capBefore[1].trim(),line);
    const tail=clean(value.slice(first.index+first[0].length));
    if(tail){
     current.fields.inlineContext=tail;
     const cap=tail.match(/\d[\d,]*(?:\.\d+)?\s*(?:m\/?ton|mts|m\.?t|m\/t)\.?$/i);
     // Never let a bare separator ("/", "-", "|") become a destination. The
     // inline tail before the capacity is only a destination when it carries a
     // letter or digit; otherwise the labelled/context destination is kept.
     if(cap){set(current,'capacity',cap[0],line);const dest=clean(tail.slice(0,cap.index));if(dest&&/[\p{L}\p{N}]/u.test(dest))set(current,'destination',dest,line);}
     // Old format may put a bare destination after the phone, with the capacity
     // written before it. A separator-only tail is never a destination.
     else if(tail&&tail.length<=60&&!/^[\/,.;:|+-]/.test(tail)&&/[\p{L}]/u.test(tail))set(current,'destination',tail,line);
    }
   }
   continue;
  }
  if(f){
   if(f.field==='destination'&&f.value)messageDestination=f.value.replace(/[,\s]+$/,'');
   if(!current){if(['cargo','importer','bookingDate','destination'].includes(f.field)){context[f.field]=f.value;contextEvidence[f.field]={raw:f.value,bodyLine:line};}continue;}
   set(current,f.field,f.value,line);continue;
  }
  if(!current)continue;
  const ac=value.match(/\bA\/c\s*[.:=-]?\s*(.+)$/i);
  if(ac){set(current,'importer',ac[1],line);const dest=clean(value.slice(0,ac.index));if(dest&&/[\p{L}\p{N}]/u.test(dest))set(current,'destination',dest,line);continue;}
  const capacity=value.match(/^(?:capacity|cap)\s*[:=-]?\s*(.+)$/i);
  if(capacity){set(current,'capacity',capacity[1],line);continue;}
  const rawPhones=[...digits(value).matchAll(mobilePattern)];
  if(rawPhones.length){
   if(rawPhones.length!==1)current.reasons.push('MASTER_MOBILE_AMBIGUOUS');
   else if(!current.fields.masterMobile)set(current,'masterMobile',rawPhones[0][0],line);
   else current.reasons.push('UNLABELED_ADDITIONAL_MOBILE');
   continue;
  }
  if(parseEscortDate(value,messageDate).date)set(current,'assignmentDate',value,line);
 }
 return blocks.map(b=>{
  const fields={...b.fields,motherVessel:(mother||b.fields.motherVessel!==undefined)?vesselName(b.fields.motherVessel??''):'',lighterVessel:vesselName(b.fields.lighterVessel)};
  if(!fields.destination&&messageDestination)fields.destination=messageDestination.replace(/[,\s]+$/,'');
  // Bengali digits in a numeric field (e.g. "ক্যাপাসিটি:১৭০০ mts") become ASCII;
  // the raw text stays in fieldEvidence and in the source message.
  if(fields.capacity)fields.capacity=digits(String(fields.capacity));
  const masterMobile=mobile(fields.masterMobile??'');
  const employeeMobile=mobile(fields.employeeMobile??fields.escortMobile??'');
  const assignment=parseEscortDate(fields.assignmentDate,messageDate),booking=parseEscortDate(fields.bookingDate,messageDate);
  const shiftText=(fields.shift??'').replace(/[.,]+$/,'');
  const explicitShift=/^(D|N|Day|Night)$/i.test(shiftText)?shiftText[0].toUpperCase():null;
  const reasons=[...b.reasons];
  if(!free&&motherMobileConflict)reasons.push('MOTHER_VESSEL_HAS_GROUPED_MOBILE');
  if(!free&&atOaMotherMissing)reasons.push('AT_OA_MOTHER_MISSING');
  if(!free&&motherKeys.length>1)reasons.push('MOTHER_VESSEL_AMBIGUOUS');
  const masterState=analyzeMobile(fields.masterMobile??'').kind;
  if(fields.masterMobile&&!masterMobile)reasons.push(masterState==='SHORT'?'MASTER_MOBILE_MISSING_DIGIT':masterState==='LONG'?'MASTER_MOBILE_EXTRA_DIGIT':'MASTER_MOBILE_INVALID_OR_AMBIGUOUS');
  if((fields.employeeMobile||fields.escortMobile)&&!employeeMobile)reasons.push('EMPLOYEE_MOBILE_INVALID_OR_AMBIGUOUS');
  if(fields.employeeMobile&&fields.escortMobile&&mobile(fields.employeeMobile)!==mobile(fields.escortMobile))reasons.push('EMPLOYEE_ESCORT_MOBILE_CONFLICT');
  if(fields.assignmentDate&&!assignment.date)reasons.push('ASSIGNMENT_DATE_INVALID_OR_AMBIGUOUS');
  if(fields.bookingDate&&!booking.date)reasons.push('BOOKING_DATE_INVALID_OR_AMBIGUOUS');
  if(fields.shift&&!explicitShift)reasons.push('SHIFT_INVALID');
  if(explicitShift&&assignment.shift&&explicitShift!==assignment.shift)reasons.push('SHIFT_CONFLICT');
  return {...b,fields,masterMobile,masterMobileRaw:String(fields.masterMobile??'').trim(),masterMobileState:masterState,employeeMobile,assignmentDate:assignment.date,bookingDate:booking.date,shift:explicitShift??assignment.shift,reasons};
 });
}

const senderPhone=sender=>typeof sender==='string'&& !/@lid$/.test(sender)?mobile(sender.replace(/@s\.whatsapp\.net$/,'')):null;

function resolveBinding(message,time,bindings){
 const chatType=message.chatJid.endsWith('@g.us')?'group':/@(?:s\.whatsapp\.net|lid)$/.test(message.chatJid)?'direct':null;
 if(!time||!chatType)return null;
 // A scoped, evidenced binding may resolve a LID; an unresolved handle alone
 // is never a phone. Client IDs group multiple separately authorized numbers.
 const matches=bindings.filter(b=>proven(b)&&typeof b.id==='string'&&b.id&&typeof b.version==='string'&&b.version&&b.active===true&&b.accountId===message.accountId&&b.chatJid===message.chatJid&&b.senderJid===message.senderJid&&b.direction===message.direction&&b.chatType===chatType&&validDate(b.validFrom)&&b.validFrom<=time.messageDate&&(b.validTo==null||(validDate(b.validTo)&&time.messageDate<b.validTo))&&['client','admin','group_evidence'].includes(b.role)&&
  (b.role==='group_evidence'||((senderPhone(message.senderJid)||(/^[^@]+@lid$/.test(message.senderJid)&&mobile(b.resolvedPhone??'')))&&(!b.resolvedPhone||!senderPhone(message.senderJid)||mobile(b.resolvedPhone)===senderPhone(message.senderJid))))&&
  (b.role!=='client'||(typeof b.clientId==='string'&&!!b.clientId.trim())));
 return matches.length===1?clone(matches[0]):null;
}

function sameVessel(a,b,aliases){
 if(vesselKey(a)===vesselKey(b)&&!!vesselKey(a))return true;
 return aliases.some(v=>proven(v)&&((vesselKey(v.left)===vesselKey(a)&&vesselKey(v.right)===vesselKey(b))||(vesselKey(v.right)===vesselKey(a)&&vesselKey(v.left)===vesselKey(b))));
}

/** Select only a unique qualified target. Confidence never breaks ambiguity. */
export function selectEscortDraftMatch(candidates){
 const records=new Map();
 for(const c of candidates){
  if(typeof c?.id!=='string'||!c.id.trim())return {state:'UNRESOLVED — ADMIN REVIEW REQUIRED',linkedDraftId:null};
  if(records.has(c.id)&&canonical(records.get(c.id))!==canonical(c))return {state:'AMBIGUOUS — ADMIN REVIEW REQUIRED',linkedDraftId:null};
  records.set(c.id,c);
 }
 const ids=[...records.keys()].sort();
 return {state:ids.length>1?'AMBIGUOUS — ADMIN REVIEW REQUIRED':ids.length?'UNIQUE_DRAFT':'UNRESOLVED — ADMIN REVIEW REQUIRED',linkedDraftId:ids.length===1?ids[0]:null,candidateIds:ids};
}

function reviewDomains(text){
 const domains=['OPERATIONS'];
 if(/\b(?:food|conveyance|payment|paid|cash|accounts?|bill|bkash|nagad)\b|খাবার|ভাড়া|টাকা|বিকাশ|নগদ/i.test(text))domains.push('ACCOUNTS');
 if(/\b(?:release|duty\s+slip)\b|রিলিজ/i.test(text))domains.push('RELEASE');
 return domains;
}

/** Returns drafts/reviews/link proposals only. Caller inputs are never mutated. */
export function qualifyEscortIntake(message,{bindings=[],existingDrafts=[],approvedVesselAliases=[],existingOccurrences=[],existingAssignments=[]}={}){
 const required=['accountId','chatJid','senderJid','nativeMessageId'];
 if(required.some(k=>typeof message?.[k]!=='string'||!message[k].trim()||message[k].length>200)||!['INCOMING','OUTGOING'].includes(message.direction))throw Error('NATIVE_SOURCE_ENVELOPE_REQUIRED');
 if(typeof message.text!=='string'||message.text.length>64000)throw Error('ESCORT_TEXT_INVALID_OR_TOO_LARGE');
 const key={accountId:message.accountId,chatJid:message.chatJid,nativeMessageId:message.nativeMessageId};
 const occurrenceId=sha(canonical(key));
 const payloadSha=sha(canonical({text:message.text,senderJid:message.senderJid,direction:message.direction,timestamp:message.timestamp??null,quotedMessageId:message.quotedMessageId??null,forwarded:message.forwarded??null,media:message.media??null}));
 const repeats=existingOccurrences.filter(r=>r.id===occurrenceId);
 if(repeats.some(r=>r.payloadSha!==payloadSha))throw Error('SOURCE_OCCURRENCE_CONFLICT');
 const time=nativeTime(message.timestamp),binding=resolveBinding(message,time,bindings);
 const evidence={id:occurrenceId,...key,payloadSha,text:message.text,senderJid:message.senderJid,direction:message.direction,sourceTimestamp:message.timestamp??null,...time,chatType:message.chatJid.endsWith('@g.us')?'group':/@(?:s\.whatsapp\.net|lid)$/.test(message.chatJid)?'direct':'unknown',groupJid:message.chatJid.endsWith('@g.us')?message.chatJid:null,quotedMessageId:message.quotedMessageId??null,forwarded:clone(message.forwarded??null),media:clone(message.media??null),binding};
 const result={version:ESCORT_INTAKE_VERSION,evidence,replay:repeats.length>0,items:[],operationalWrites:false,sendAuthorized:false,cashPostingAuthorized:false};
 if(result.replay)return result;
 const blocks=parseEscortOrder(message.text,{messageDate:time?.messageDate});
 const knownAssignments=[...existingAssignments];
 const proposedAssignmentIds=new Set();
 const reviewContext=/\b(?:release(?:d)?|duty\s+slip|food|conveyance|payment|paid|cash|accounts?|bill|bkash|nagad|departed|complaint)\b|রিলিজ|খাবার|ভাড়া|টাকা|চলে|ছেড়ে|ছেড়ে|স্কট দেন নাই/i.test(message.text);
 const base=[];
 if(!time)base.push('SOURCE_TIMESTAMP_UNVERIFIED');
 if(!binding)base.push('SOURCE_ROLE_UNVERIFIED');
 if(message.chatJid.endsWith('@g.us'))base.push('GROUP_SUPPORTING_EVIDENCE_ONLY');
 // Forwarded and copy-pasted messages are ordinary messages (Owner rule). The
 // `forwarded` field is preserved in the occurrence evidence and in payloadSha so
 // two distinct sends stay distinct, but it never downgrades the classification:
 // authority still comes from the actual sender binding and direction.
 if(message.media?.length)base.push('MEDIA_EXTRACTION_REQUIRES_REVIEW');
 if(reviewContext)base.push('OPERATIONAL_DISCUSSION_REQUIRES_REVIEW');
 for(const block of blocks){
  const reasons=[...base,...block.reasons];
  for(const [field,value] of Object.entries({motherVessel:block.fields.motherVessel,lighterVessel:block.fields.lighterVessel,masterMobile:block.masterMobile}))if(!value)reasons.push('MISSING_'+field);
  const assignmentPresent=!!(block.fields.escortName||block.fields.escortMobile||block.fields.employeeMobile);
  if(binding?.role==='client'&&(block.fields.assignmentDate||block.fields.shift))reasons.push('ADMIN_ASSIGNMENT_AUTHORITY_REQUIRED');
  let classification='REVIEW',linkedDraftId=null,matchState=null,assignmentProposal=null,assignmentReplayState=null;
  if(binding?.role==='client'&&message.direction==='INCOMING'&&!assignmentPresent&&!reasons.length)classification='ORDER_DRAFT';
  if(assignmentPresent){
   for(const [field,value] of Object.entries({escortName:block.fields.escortName,employeeMobile:block.employeeMobile,assignmentDate:block.assignmentDate,shift:block.shift}))if(!value)reasons.push('MISSING_'+field);
   if(binding?.role!=='admin'||message.direction!=='OUTGOING')reasons.push('ADMIN_OUTGOING_AUTHORITY_REQUIRED');
   if(!reasons.length){
    const matches=existingDrafts.filter(d=>d.classification==='ORDER_DRAFT'&&d.evidence?.binding?.role==='client'&&proven(d.evidence.binding)&&d.evidence.binding.active===true&&d.evidence.direction==='INCOMING'&&d.evidence.accountId===message.accountId&&d.evidence.chatJid===message.chatJid&&d.masterMobile===block.masterMobile&&sameVessel(d.fields.motherVessel,block.fields.motherVessel,approvedVesselAliases)&&sameVessel(d.fields.lighterVessel,block.fields.lighterVessel,approvedVesselAliases)&&validDate(d.evidence.messageDate)&&time.messageDate>=d.evidence.messageDate&&(Date.parse(time.messageDate)-Date.parse(d.evidence.messageDate))/86400000<=3&&block.assignmentDate>=(d.bookingDate??d.evidence.messageDate)&&block.assignmentDate<=time.messageDate);
    const selected=selectEscortDraftMatch(matches);matchState=selected.state;
    if(selected.linkedDraftId){
     linkedDraftId=selected.linkedDraftId;
     const payload={linkedDraftId,employeeMobile:block.employeeMobile,escortName:block.fields.escortName,assignmentDate:block.assignmentDate,shift:block.shift};
     const assignmentOperationId=sha(canonical(payload));
     const prior=knownAssignments.filter(a=>a.linkedDraftId===linkedDraftId);
     if(prior.some(a=>a.assignmentOperationId!==assignmentOperationId||canonical(Object.fromEntries(Object.keys(payload).map(k=>[k,a[k]])))!==canonical(payload)))reasons.push('EXISTING_ASSIGNMENT_CONFLICT_REQUIRES_REVIEW');
     else if(prior.length){classification='ADMIN_ASSIGNMENT_REPLAY';assignmentReplayState=proposedAssignmentIds.has(assignmentOperationId)?'ALREADY_PROPOSED':'ALREADY_RECORDED';}
     else {classification='ADMIN_ASSIGNMENT_LINK_CANDIDATE';assignmentProposal={...payload,assignmentOperationId,sourceOccurrenceId:occurrenceId};knownAssignments.push(assignmentProposal);proposedAssignmentIds.add(assignmentOperationId);}
    }
    else reasons.push(selected.state.startsWith('AMBIGUOUS')?'DRAFT_MATCH_AMBIGUOUS':'DRAFT_MATCH_UNRESOLVED');
   }
  }
  result.items.push({...block,id:sha(canonical({occurrenceId,startLine:block.startLine})),classification,linkedDraftId,matchState,assignmentProposal,assignmentState:classification==='ORDER_DRAFT'?'UNASSIGNED':assignmentProposal?'PROPOSED':assignmentReplayState??'REVIEW',clientDeliveryState:'NOT_SENT',reviewDomains:classification==='REVIEW'?reviewDomains(message.text):[],reasons:[...new Set(reasons)],evidence:clone(evidence)});
 }
 if(!blocks.length)result.items.push({id:sha(occurrenceId+'|review'),classification:'REVIEW',linkedDraftId:null,assignmentProposal:null,assignmentState:'REVIEW',clientDeliveryState:'NOT_SENT',reviewDomains:reviewDomains(message.text),reasons:[...new Set([...base,'NO_ASSIGNABLE_LIGHTER_BLOCK'])],evidence:clone(evidence)});
 return result;
}

export function buildEscortAdminDraft(item){
 if(item?.classification!=='ORDER_DRAFT')throw Error('QUALIFIED_ORDER_DRAFT_REQUIRED');
 const f=item.fields;
 return ['Notun escort order:',`Mother Vessel: ${f.motherVessel}`,`Lighter Vessel: ${f.lighterVessel}`,`Master Mobile: ${item.masterMobile}`,`Cargo: ${f.cargo??''}`,`Capacity: ${f.capacity??''}`,`Importer: ${f.importer??''}`,`Destination: ${f.destination??f.inlineContext??''}`,`Booking Date: ${f.bookingDate??''}`,'Escort Name:','Escort Mobile:','Assignment Date:','Shift:',`Source reference: ${item.id}`,'Draft — pending authorized Admin assignment.'].join('\n');
}

/**
 * Pure qualification of a trusted transport call record, never a sender.
 * The caller must supply real authorization and correlated transport evidence.
 * SEND_ACCEPTED proves the send call succeeded, not recipient delivery/read.
 * Inputs/flags are qualification controls here, not production credentials.
 */
export function qualifyEscortSendOutcome(intent,outcome,{authorization=null}={}){
 const result={clientDeliveryState:'UNCONFIRMED — REVIEW REQUIRED',confirmedSent:false,recipientDeliveryVerified:false,operationalWrites:false,sendAuthorized:false,cashPostingAuthorized:false,reasons:[]};
 if(outcome?.timeout||outcome?.error){result.reasons.push('TRANSPORT_OUTCOME_UNCERTAIN');return result;}
 if(outcome?.body?.success===false||outcome?.rejected===true||(Number.isInteger(outcome?.httpStatus)&&(outcome.httpStatus<200||outcome.httpStatus>=300))){result.clientDeliveryState='SEND_REJECTED';result.reasons.push('TRANSPORT_REJECTED');return result;}
 const keys=['assignmentOperationId','accountId','chatJid','senderJid','callId','payloadSha'];
 if(keys.some(k=>typeof intent?.[k]!=='string'||!intent[k].trim())||!/@(?:s\.whatsapp\.net|lid)$/.test(intent.chatJid)||!senderPhone(intent.senderJid)||!(/^[a-f0-9]{64}$/.test(intent.assignmentOperationId)&&/^[a-f0-9]{64}$/.test(intent.payloadSha)))result.reasons.push('SEND_INTENT_UNVERIFIED');
 const sendTime=nativeTime(outcome?.evidence?.timestamp);
 if(!proven(authorization)||!authorization.id||!authorization.version||authorization.active!==true||authorization.role!=='admin'||authorization.chatType!=='direct'||authorization.capability!=='messages.send'||authorization.purpose!=='escort-client-confirmation'||!sendTime||!validDate(authorization.validFrom)||authorization.validFrom>sendTime.messageDate||(authorization.validTo!=null&&(!validDate(authorization.validTo)||sendTime.messageDate>=authorization.validTo))||keys.some(k=>authorization[k]!==intent?.[k]))result.reasons.push('OUTBOUND_AUTHORIZATION_UNVERIFIED');
 const e=outcome?.evidence;
 if(outcome?.httpStatus!==200||outcome?.body?.success!==true||e?.source!=='whatsapp_transport_call_result'||e.authoritative!==true||keys.some(k=>e[k]!==intent?.[k])||e.direction!=='OUTGOING'||typeof e.nativeMessageId!=='string'||!e.nativeMessageId.trim()||/^bridge\d*:/i.test(e.nativeMessageId)||!nativeTime(e.timestamp))result.reasons.push('AUTHORITATIVE_SEND_EVIDENCE_MISSING');
 if(!result.reasons.length){result.clientDeliveryState='SEND_ACCEPTED';result.confirmedSent=true;result.sendEvidence=clone(e);}
 return result;
}
