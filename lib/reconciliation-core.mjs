import {createHash} from 'node:crypto';
import {parseEscortOrder} from './escort-intake-candidate.mjs';
import {exactMinor} from './history-extraction.mjs';
export const PARSER='owner-reconciliation-v1';
export const INITIAL_START='2026-06-30T18:00:00.000Z',INITIAL_END='2026-10-16T18:00:00.000Z';
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const digits=v=>String(v??'').replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
export function phone(v){let n=digits(v).replace(/(?::\d+)?@(s\.whatsapp\.net|c\.us)$/,'').replace(/[\s()+.-]/g,'');if(n.startsWith('880'))n='0'+n.slice(3);return /^01[3-9]\d{8}$/.test(n)?'+88'+n:null;}
export const businessDay=v=>Number.isFinite(Date.parse(v))?new Date(Date.parse(v)+21600000).toISOString().slice(0,10):null;
export function inWindow(at,start,end,snapshot){const t=Date.parse(at);return Number.isFinite(t)&&t>=Date.parse(start)&&t<Math.min(Date.parse(end),Date.parse(snapshot));}
export const messageIdentity=m=>hash([m.accountId,m.chatJid,m.id]);
export const revisionIdentity=m=>hash([messageIdentity(m),m.sender,m.senderPhone,m.receiverPhone,m.direction,m.sourceTime,m.text,m.media,m.quoted,m.deletedAt,m.nativeRevision??null]);
export function classify(m,knownDomain){if(knownDomain==='ACCOUNTS')return 'ACCOUNTS';if(knownDomain==='ESCORT')return 'ESCORT';if(knownDomain==='RELEASE')return 'RELEASE';const s=m.text||'';if(/release|relace|রিলিজ|end\s*(?:date|shift)|release\s*point/i.test(s))return 'RELEASE';if(/escort|lighter|mother\s*vessel|এস্কর্ট|এসকর্ট|লাইটার|মাদার|master\s*(?:mobile|name)/i.test(s))return 'ESCORT';if(/(?:ID\s*[:=]|\([BNCR]\)|bkash|bikash|nagad|rocket|বিকাশ|নগদ|পেমেন্ট|payment\s*instruction|\d\s*\/-)/i.test(s))return 'ACCOUNTS';return null;}
export function parsePayments(text){
 const lines=digits(text).split(/\r?\n/),out=[];const ptn=/(?:\+?880|0)1[3-9](?:[ -]?\d){8}(?!\d)/g;
 for(let i=0;i<lines.length;i++){
  const start=i;if(!/(?:ID\s*[:=;-]|\([BNCR]\)|\b(?:bkash|nagad|cash|rocket)\b|\d\s*\/-)/i.test(lines[i])&&!ptn.test(lines[i])){ptn.lastIndex=0;continue;}ptn.lastIndex=0;
  let raw=lines[i];for(let j=0;j<5&&!/\d\s*\/[-+]/.test(raw)&&i+1<lines.length;j++){if(/^\s*ID\s*[:=;-]/i.test(lines[i+1]))break;raw+='\n'+lines[++i];}
  const s=raw.replace(/\n/g,' ').trim(),phones=[...s.matchAll(ptn)],fields={},reasons=[];
  if(phones.length===2){const [a,b]=phones,prefix=s.slice(0,a.index).trim();if(prefix&&!/^ID\s*[:=;-]?$/i.test(prefix))reasons.push('EMPLOYEE_ID_POSITION_AMBIGUOUS');else fields.employeeMobile=phone(a[0]);fields.employeeName=s.slice(a.index+a[0].length,b.index).trim().replace(/^[,:;* -]+|[,:;* -]+$/g,'');fields.payoutMobile=phone(b[0]);}
  else if(phones.length===1){const a=phones[0],name=s.slice(0,a.index).trim();if(!name||/\bID\s*[:=;-]/i.test(name))reasons.push('INCOMPLETE_ID_STRUCTURE');else{fields.employeeMobile=phone(a[0]);fields.employeeName=name;fields.payoutMobile=null;reasons.push('SEPARATE_PAYOUT_NOT_AVAILABLE');}}
  else reasons.push('EMPLOYEE_PAYOUT_IDENTITY_UNRESOLVED');
  const tail=phones.length?s.slice(phones.at(-1).index+phones.at(-1)[0].length):s;
  const amount=/([0-9][0-9,.]*)\s*\/[-+]/.exec(tail),method=/\(\s*(B|N|C|R)\s*\)|\b(BKASH|BIKASH|NAGAD|CASH|ROCKET|BANK)\b/i.exec(tail);
  fields.amountMinor=amount?exactMinor(amount[1]):null;fields.method=method?({B:'bkash',BKASH:'bkash',BIKASH:'bkash',N:'nagad',NAGAD:'nagad',C:'cash',CASH:'cash',R:'rocket',ROCKET:'rocket',BANK:'bank'})[(method[1]||method[2]).toUpperCase()]:'unknown';
  if(!fields.amountMinor)reasons.push('AMOUNT_UNRESOLVED');if(!fields.employeeName)reasons.push('EMPLOYEE_NAME_UNRESOLVED');if(!method)reasons.push('METHOD_UNRESOLVED');
  if(/cancel|ফেরত|পাঠাবেন না|পাঠিও না/i.test(text))reasons.push('CANCELLATION_OR_REVISION');
  if(!amount&&!phones.length&&!/^\s*ID\s*[:=;-]/i.test(s))continue;
  const stated=/^(?:payment date|instruction date|date|তারিখ)\s*[:=]\s*(.+)$/im.exec(digits(text));if(stated)fields.paymentDate=date(stated[1]);
  out.push({blockKey:'payment:'+start,fields,reasons,rawSpan:{firstLine:start+1,lastLine:i+1}});
 }
 return out;
}
function date(v){if(!v)return '';const iso=/\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(v),local=/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/.exec(v);const s=iso?iso[0]:local?[local[3],local[2].padStart(2,'0'),local[1].padStart(2,'0')].join('-'):'';return s&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s?s:'';}
export function parsePrograms(m,domain){
 const text=digits(m.text);if(domain==='RELEASE'){
  const fields={};const labels={endDate:'(?:end date|release date|completion date|relace date)',endShift:'(?:end shift|release shift|completion shift)',releasePoint:'(?:release point|release place|relace point)',masterMobile:'(?:master mobile|master number)',escortMobile:'(?:escort mobile|escort number|employee id)',motherVessel:'mother vessel',lighterVessel:'lighter vessel',startDate:'(?:start date|assignment date)',shift:'(?:start shift|shift)'};const reasons=[];
  for(const [k,label] of Object.entries(labels)){const a=[...text.matchAll(new RegExp('^\\s*'+label+'\\s*[:=.-]\\s*(.+)$','gim'))];if(a.length===1)fields[k]=a[0][1].trim();if(a.length>1)reasons.push('CONFLICTING_'+k);}
  fields.endDate=date(fields.endDate);if(fields.startDate)fields.startDate=date(fields.startDate);if(fields.escortMobile)fields.escortMobile=phone(fields.escortMobile);if(fields.masterMobile)fields.masterMobile=phone(fields.masterMobile);
  if(fields.endShift)fields.endShift=/^(?:D|Day)$/i.test(fields.endShift)?'D':/^(?:N|Night)$/i.test(fields.endShift)?'N':fields.endShift;
  for(const k of ['endDate','endShift','releasePoint'])if(!fields[k]||k==='endShift'&&!['D','N'].includes(fields[k]))reasons.push('MISSING_'+k);
  if(/voucher|ভাউচার/i.test(text))reasons.push('VOUCHER_NOT_RELEASE_PROOF');if(m.media?.length&&!m.media.some(x=>x.available))reasons.push('ORIGINAL_MEDIA_NOT_CACHED');
  return [{blockKey:'release:0',fields,reasons,rawSpan:{firstLine:1,lastLine:text.split('\n').length}}];
 }
 return parseEscortOrder(text,{messageDate:businessDay(m.sourceTime)}).map((b,i)=>{const f={...b.fields};for(const k of ['cargo','capacity','bookingDate','importer','registration','slipNumber'])delete f[k];if(b.masterMobile)f.masterMobile=b.masterMobile;if(b.employeeMobile)f.escortMobile=b.employeeMobile;if(b.assignmentDate)f.startDate=b.assignmentDate;if(b.shift)f.shift=b.shift;return {blockKey:'program:'+i,fields:f,reasons:b.reasons||[],rawSpan:{firstLine:b.startLine||1,lastLine:b.endLine||b.startLine||1}};});
}
export function compareProgram(fields,rows){
 const matches=[];for(const row of rows){const master=phone(fields.masterMobile),escort=phone(fields.escortMobile||fields.employeeMobile);if(master&&escort&&fields.startDate&&master===phone(row.masterMobile)&&escort===phone(row.escortMobile)&&fields.startDate===row.startDate){const differences=Object.keys(fields).filter(k=>fields[k]&&row[k]&&String(fields[k]).trim().toLowerCase()!==String(row[k]).trim().toLowerCase());matches.push({type:'program',id:row.id,revision:row.revision,exact:!differences.length,differences});}}return matches;
}
export function snapshotUpper(now){return new Date(Math.min(Date.parse(INITIAL_END),Date.parse(now))).toISOString();}

// Decode once after buffering: a transport chunk may split any UTF-8 character.
export async function readEnvelope(stream,maxBytes=128*1024*1024){const chunks=[];let size=0;for await(const chunk of stream){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>maxBytes)throw Error('INPUT_BUDGET');chunks.push(b);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}

export const caseStatusTally=status=>({linked:status==='LINKED'?1:0,pending:['PENDING','CLARIFICATION'].includes(status)?1:0,decided:['APPROVED','REJECTED','SUPERSEDED'].includes(status)?1:0});
