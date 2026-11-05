/** Passive deterministic preparation only. No database/network/process access. */
import {createHash} from 'node:crypto';
export const VERSION='employee-program-v4-lifecycle';
export const canonical=value=>JSON.stringify(sort(value));
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const comparison=value=>typeof value==='string'?value.normalize('NFC').replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c))).trim().toLowerCase():value;
const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
const escape=k=>k.replace(/~/g,'~0').replace(/\//g,'~1');
export function shapeErrors(value,spec,path=''){
 if(!spec)return [{code:'UNKNOWN_SOURCE_KEY',path}];
 if(!spec.types.includes(type(value)))return [{code:'SOURCE_TYPE',path}];
 const out=[];
 if(type(value)==='object'){
  for(const k of spec.required??[])if(!Object.hasOwn(value,k))out.push({code:'MISSING_SOURCE_KEY',path:path+'/'+escape(k)});
  for(const k of Object.keys(value).sort())out.push(...shapeErrors(value[k],spec.properties?.[k],path+'/'+escape(k)));
 }else if(Array.isArray(value))for(let i=0;i<value.length;i++)out.push(...shapeErrors(value[i],spec.items,path+'/'+i));
 return out;
}
export function validDate(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s&&s>='1900-01-01'&&s<='2200-12-31';}
export function occurrence(file,fileSha,documentPointer,decodedPointer,record,payloadSha=null){
 const key={file,fileSha,documentPointer,decodedPointer,payloadSha,sourceId:record?.id??null};
 return {...key,id:sha(canonical(key)),recordSha:sha(canonical(record)),raw:record};
}
export function identityGroups(rows){
 const phones=new Map(),names=new Map();
 for(const r of rows){if(!r.name||!r.employeePhone)continue;const p=r.employeePhone,n=r.name;if(!phones.has(p))phones.set(p,new Set());if(!names.has(n))names.set(n,new Set());phones.get(p).add(n);names.get(n).add(p);}
 return {multiNamePhoneGroups:[...phones.values()].filter(s=>s.size>1).length,multiPhoneNameGroups:[...names.values()].filter(s=>s.size>1).length};
}
/** Source attestation flags are deliberately ignored. Approval records never create employees. */
export function resolveIdentity(approval,kind,registry,date,occurrenceId){
 if(!approval||approval.kind!==kind||approval.occurrenceId!==occurrenceId||approval.decision!=='APPROVED'||!approval.approver||!validDate(approval.approvedOn)||!/^([a-f0-9]{64})$/.test(approval.evidenceSha??'')||!(['INDEPENDENT_AUTHORITY','OWNER_VERIFIED_ESCORT_FIELD_ROLE','OWNER_VERIFIED_EMPLOYEE_MOBILE'].includes(approval.evidenceKind)))return {code:'IDENTITY_UNVERIFIED'};
 if(approval.evidenceKind==='OWNER_VERIFIED_ESCORT_FIELD_ROLE'&&(kind!=='employee'||approval.fieldRole!=='escortMobile'||approval.fieldRoleVerified!==true||!normalizeEscortMobile(approval.sourceEscortMobile)))return {code:'IDENTITY_UNVERIFIED'};
 if(approval.evidenceKind==='OWNER_VERIFIED_EMPLOYEE_MOBILE'&&(kind!=='employee'||approval.fieldRole!=='employee_id'||approval.fieldRoleVerified!==true||!normalizeEmployeeMobile(approval.sourceEmployeeId)))return {code:'IDENTITY_UNVERIFIED'};
 const entity=registry?.[kind]?.find(e=>e.id===approval.targetId||(kind==='employee'&&normalizeEmployeeMobile(e.employee_id)&&normalizeEmployeeMobile(e.employee_id)===normalizeEmployeeMobile(approval.targetId)));
 if(!entity)return {code:'MISSING_FOREIGN_KEY_IDENTITY'};
 if(approval.evidenceKind==='OWNER_VERIFIED_ESCORT_FIELD_ROLE'&&!entity.contacts?.some(c=>c.escortKey===normalizeEscortMobile(approval.sourceEscortMobile)&&c.verified===true&&c.fieldRole==='escortMobile'))return {code:'IDENTITY_UNVERIFIED'};
 if(kind==='employee'&&!normalizeEmployeeMobile(entity.employee_id))return {code:'EMPLOYEE_LEDGER_KEY_MISSING'};
 if(approval.evidenceKind==='OWNER_VERIFIED_EMPLOYEE_MOBILE'&&normalizeEmployeeMobile(approval.sourceEmployeeId)!==normalizeEmployeeMobile(entity.employee_id))return {code:'IDENTITY_UNVERIFIED'};
 if(kind==='employee'&&entity.status!=='confirmed')return {code:'APPLICANT_NOT_EMPLOYEE'};
 if(!validDate(date)||!validDate(approval.validFrom)||(approval.validTo!=null&&!validDate(approval.validTo))||date<approval.validFrom||(approval.validTo&&date>=approval.validTo))return {code:'IDENTITY_PERIOD_UNVERIFIED'};
 return {id:entity.id,...(kind==='employee'?{employee_id:normalizeEmployeeMobile(entity.employee_id)}:{})};
}
export function assignmentErrors(events,registry){
 const reasons=[],seen=new Map(),successors=new Set();
 for(const e of events){
  if(!e.id||seen.has(e.id))reasons.push('DUPLICATE_ASSIGNMENT_EVENT');
  if(!registry.employee?.some(x=>(e.employee_id!=null?normalizeEmployeeMobile(x.employee_id)===normalizeEmployeeMobile(e.employee_id)&&normalizeEmployeeMobile(e.employee_id)!=null:x.id===e.employeeId)&&x.status==='confirmed')||!registry.program?.some(x=>x.id===e.programId)||!registry.vessel?.some(x=>x.id===e.lighterId))reasons.push('MISSING_FOREIGN_KEY_IDENTITY');
  if(!['assigned','replaced','cancelled','ended'].includes(e.kind)||!validDate(e.validFrom)||(e.validTo!=null&&(!validDate(e.validTo)||e.validTo<e.validFrom)))reasons.push('ASSIGNMENT_PERIOD_UNVERIFIED');
  if(['replaced','cancelled','ended'].includes(e.kind)){
   if(successors.has(e.previousId))reasons.push('ASSIGNMENT_PREDECESSOR_REUSED');
   successors.add(e.previousId);
   const prior=seen.get(e.previousId);
   if(!prior||prior.programId!==e.programId||prior.lighterId!==e.lighterId||e.validFrom<prior.validFrom)reasons.push('ASSIGNMENT_PREDECESSOR');
  }else if(e.previousId!=null)reasons.push('ASSIGNMENT_PREDECESSOR');
  if(!e.validFrom)reasons.push('ASSIGNMENT_PERIOD_UNVERIFIED');
  seen.set(e.id,e);
 }
 return [...new Set(reasons)].sort();
}
export function validateProgramOccurrence(o,{shape,approvals=[],registry={},asOf}){
 const r=o.raw,errors=shapeErrors(r,shape),reasons=errors.map(e=>e.code);
 const required=['motherVessel','lighterVessel','escortName','startDate','shift'];
 const missing=required.filter(k=>typeof r?.[k]!=='string'||!r[k].trim());
 if(!String(r?.employee_id??r?.escort_mobile??r?.escortMobile??'').trim())missing.push('employeeMobile');
 for(const k of missing)reasons.push('MISSING_'+k);
 for(const k of ['startDate','endDate'])if(r?.[k]&&!validDate(r[k]))reasons.push('INVALID_'+k);
 if(r?.shift&&!['D','N'].includes(r.shift))reasons.push('INVALID_SHIFT');
 if(r?.startDate&&r?.endDate&&r.endDate<r.startDate)reasons.push('DATE_ORDER');
 if(r?.startDate>asOf)reasons.push('FUTURE_HISTORICAL_DATE');
 if(r?.conflicts?.length)reasons.push('CONFLICTING_ASSERTIONS');
 if(['Escort change','Cancelled'].includes(r?.status))reasons.push('ASSIGNMENT_HISTORY_REQUIRED');
 if(['Date review','Release review','Active','Completed','Released'].includes(r?.status))reasons.push('LIFECYCLE_EVIDENCE_REQUIRED');
 const bindings={};
 for(const role of ['employee','mother','lighter','program']){
  const kind=['mother','lighter'].includes(role)?'vessel':role;
  const a=approvals.find(a=>a.occurrenceId===o.id&&a.role===role);
  const result=resolveIdentity(a,kind,registry,r?.startDate,o.id);
  if(result.code)reasons.push(role.toUpperCase()+'_'+result.code);else bindings[role]=role==='employee'?result.employee_id:result.id;
 }
 if(bindings.mother&&bindings.mother===bindings.lighter)reasons.push('VESSEL_ROLE_COLLISION');
 // A label or source status never supplies an effective assignment or verified lifecycle.
 reasons.push('ASSIGNMENT_EVIDENCE_NOT_SUPPLIED','BUSINESS_APPROVAL_NOT_SUPPLIED');
 return {reasons:[...new Set(reasons)].sort(),errors,missing,bindings,structurallyValid:errors.length===0};
}
export function buildManifest(occurrences,options){
 const employeeMatches=new Map((options.employeeMobileResult?.employees??[]).flatMap(e=>e.sourceReferences.map(r=>[r.occurrenceId,{employee_id:e.employee_id,internalId:e.internalId,aliasIds:e.aliases.filter(a=>a.sourceReferences.some(ref=>ref.occurrenceId===r.occurrenceId)).map(a=>a.id)}])));
 const seen=new Map(),ids=new Map(),rows=[],phones=new Map(),names=new Map(),programVersions=new Map();
 for(const o of occurrences){const r=o.raw;if(o.domain==='employee'&&r?.name&&r?.employeePhone){if(!phones.has(r.employeePhone))phones.set(r.employeePhone,new Set());if(!names.has(r.name))names.set(r.name,new Set());phones.get(r.employeePhone).add(r.name);names.get(r.name).add(r.employeePhone);}
  if(o.domain==='program'&&o.sourceId){if(!programVersions.has(o.sourceId))programVersions.set(o.sourceId,new Map());programVersions.get(o.sourceId).set(o.file,o.recordSha);}}
 for(const o of occurrences){const key=o.file+'|'+o.sourceId;if(!ids.has(key))ids.set(key,new Set());ids.get(key).add(o.recordSha);}
 for(const o of occurrences){
  const validation=o.domain==='program'?validateProgramOccurrence(o,{...options,shape:options.spec.sources[o.file].selectors[o.selector].shape}):{reasons:[o.domain==='employee'?(employeeMatches.has(o.id)?'EMPLOYEE_MOBILE_MATCHED':'EMPLOYEE_MOBILE_UNRESOLVED'):'EVIDENCE_ONLY'],errors:shapeErrors(o.raw,options.spec.sources[o.file].selectors[o.selector].shape),missing:[],bindings:{},structurallyValid:true};
  if(o.domain==='employee'){if(phones.get(o.raw?.employeePhone)?.size>1)validation.reasons.push('SAME_EMPLOYEE_MOBILE_NAME_ALIASES');if(names.get(o.raw?.name)?.size>1)validation.reasons.push('SAME_NAME_DIFFERENT_MOBILE_SEPARATE');}
  const versions=programVersions.get(o.sourceId);if(o.domain==='program'&&versions?.size>1&&new Set(versions.values()).size>1)validation.reasons.push('CROSS_VERSION_ASSERTION_CONFLICT');
  validation.structurallyValid=validation.errors.length===0;
  validation.reasons.push(...validation.errors.map(e=>e.code));
  if(seen.has(o.id))validation.reasons.push(seen.get(o.id)===o.recordSha?'DUPLICATE_SOURCE_OCCURRENCE':'OCCURRENCE_CONTENT_CONFLICT');
  seen.set(o.id,o.recordSha);
  if(o.sourceId&&ids.get(o.file+'|'+o.sourceId).size>1)validation.reasons.push('CONFLICTING_SOURCE_ID');
  if(o.domain!=='reference')validation.reasons.push('SCHEMA_GAP');
  rows.push({occurrenceId:o.id,file:o.file,fileSha:o.fileSha,documentPointer:o.documentPointer,decodedPointer:o.decodedPointer,payloadSha:o.payloadSha,sourceId:o.sourceId,recordSha:o.recordSha,domain:o.domain,selector:o.selector,employeeMatch:employeeMatches.get(o.id)??null,classification:o.domain==='reference'?'MANUAL_REVIEW':'BLOCKED',...validation,reasons:[...new Set(validation.reasons)].sort(),normalized:Object.fromEntries(Object.entries(o.raw??{}).filter(([,v])=>typeof v==='string').map(([k,v])=>[k,comparison(v)]))});
 }
 rows.sort((a,b)=>a.occurrenceId.localeCompare(b.occurrenceId,'en'));
 const summary={total:rows.length,eligible:0,manualReview:rows.filter(r=>r.classification==='MANUAL_REVIEW').length,blocked:rows.filter(r=>r.classification==='BLOCKED').length,structurallyValid:rows.filter(r=>r.structurallyValid).length,identityResolved:rows.filter(r=>Object.keys(r.bindings).length===4).length,missingRequiredRows:rows.filter(r=>r.missing.length).length,unknownKeyRows:rows.filter(r=>r.errors.some(e=>e.code==='UNKNOWN_SOURCE_KEY')).length,duplicateOccurrenceRows:rows.filter(r=>r.reasons.includes('DUPLICATE_SOURCE_OCCURRENCE')).length,reasons:{},domains:{}};
 for(const r of rows){for(const reason of r.reasons)summary.reasons[reason]=(summary.reasons[reason]??0)+1;const d=summary.domains[r.domain]??={total:0,blocked:0,manualReview:0};d.total++;d[r.classification==='BLOCKED'?'blocked':'manualReview']++;}
 const body={version:VERSION,asOf:options.asOf,schemaSha:options.schemaSha,mappingSha:options.mappingSha,sourceChecksums:options.sourceChecksums,approvalSha:sha(canonical(options.approvals??[])),rows,summary};
 return {...body,manifestSha:sha(canonical(body))};
}
export function assertSchema(actual,expected){if(!actual||sha(canonical(actual))!==expected)throw Error('SCHEMA_FINGERPRINT_MISMATCH');}
export function assertChecksum(bytes,expected){if(sha(bytes)!==expected)throw Error('SOURCE_CHECKSUM_MISMATCH');}

// Owner rules v2. Field-role evidence, matching and candidate review never authorize writes.
function normalizedPhoneComparison(value){
 if(typeof value!=='string'||/@|[\/;,]|\b(?:jid|lid)\b/i.test(value))return null;
 const n=value.replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c))).replace(/[\s().-]/g,'');
 const m=n.match(/^(?:\+?880|0)(1[3-9]\d{8})$/);return m?'+880'+m[1]:null;
}
export function normalizeEscortMobile(value,fieldRole='escortMobile'){return fieldRole==='escortMobile'?normalizedPhoneComparison(value):null;}
const dayIndex=s=>validDate(s)?Date.parse(s+'T00:00:00Z')/86400000:null;
const vesselKey=s=>comparison(s??'').replace(/^m\.?\s*v\.?\s*/,'').replace(/[\s.\-]/g,'');
const calendarTimestamp=m=>validDate(m.messageDate)&&/^\d{2}:\d{2}(?::\d{2})?$/.test(m.time??'')&&Number(m.time.slice(0,2))<24&&Number(m.time.slice(3,5))<60&&(m.time.length!==8||Number(m.time.slice(6))<60)?m.messageDate+'T'+m.time:null;
export function explicitDutyDate(value){
 if(typeof value!=='string')return {date:null,shift:null};
 let text=value.trim(),shift=null;const suffix=text.match(/\s*\(\s*(D|N|Day|Night)\s*\)\s*$/i);
 if(suffix){shift=suffix[1][0].toUpperCase();text=text.slice(0,suffix.index).trim();}
 text=text.replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
 const m=text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
 if(m)text=m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
 return {date:validDate(text)?text:null,shift};
}
export function verifiedMessageRole(message,bindings=[]){
 const matches=bindings.filter(b=>b.decision==='APPROVED'&&b.evidenceKind==='OWNER_VERIFIED_MESSAGE_ROLE'&&b.approver&&validDate(b.approvedOn)&&/^[a-f0-9]{64}$/.test(b.evidenceSha??'')&&['admin','client','requester'].includes(b.role)&&b.chatKey===message.chatKey&&b.sender===message.sender&&/^[a-f0-9]{64}$/.test(b.sourceExportSha??'')&&b.sourceExportSha===message.reference?.sourceExportSha&&validDate(b.validFrom)&&validDate(message.messageDate)&&message.messageDate>=b.validFrom&&(b.validTo==null||(validDate(b.validTo)&&message.messageDate<b.validTo)));
 return matches.length===1?matches[0].role:null;
}
/** Parse labeled blocks only. Never borrow a mobile/date/shift from a projection or sender. */
export function extractEscortMessages(messages,{roleBindings=[],asOf}={}){
 const events=[];
 const labels={'program id':'programId','order id':'orderId','event':'event','effective date':'effectiveDate','cancellation date':'effectiveDate','restart date':'effectiveDate','replacement date':'effectiveDate','old employee id':'oldEmployeeId','old escort mobile':'oldEmployeeId','new employee id':'newEmployeeId','new escort mobile':'newEmployeeId','actual start date':'actualStartDate','release date':'releaseDate','end date':'releaseDate','end shift':'endShift','start shift':'shift','duty start shift':'shift','escort number':'escortMobile','mother vessel':'motherVessel','lighter vessel':'lighterVessel','escort name':'escortName','escort mobile':'escortMobile','employee id':'employee_id','master mobile':'masterMobile','duty start date':'startDate','start date':'startDate','shift':'shift'};
 for(const m of [...messages].sort((a,b)=>a.id.localeCompare(b.id,'en'))){
  if(m.sensitiveExcluded)continue;
  let blocks=[],block={fields:{},fieldEvidence:{},reasons:[],startLine:0},mother=null;
  const flush=()=>{if(Object.keys(block.fields).length)blocks.push(block);block={fields:{},fieldEvidence:{},reasons:[],startLine:0};};
  const lines=(m.body??'').split(/\r?\n/);
  lines.forEach((line,index)=>{
   const match=line.match(/^\s*\*?([^:\n]{1,50}?)\*?\s*:\s*(.*?)\s*$/);if(!match)return;
   const label=match[1].trim().toLowerCase(),field=labels[label];if(!field)return;
   if((field==='motherVessel'&&(block.fields.motherVessel||block.fields.lighterVessel||block.fields.escortName||block.fields.escortMobile||block.fields.employee_id))||(field==='lighterVessel'&&block.fields.lighterVessel))flush();
   if(field==='motherVessel')mother={value:match[2],evidence:{label:match[1],bodyLine:index+1,raw:match[2]}};
   if(field==='lighterVessel'&&!block.fields.motherVessel&&mother){block.fields.motherVessel=mother.value;block.fieldEvidence.motherVessel=mother.evidence;}
   if(Object.hasOwn(block.fields,field))block.reasons.push('REPEATED_FIELD_REQUIRES_REVIEW');
   block.fields[field]=match[2];block.fieldEvidence[field]={label:match[1],bodyLine:index+1,raw:match[2]};
   if(!block.startLine)block.startLine=index+1;
  });flush();
  if(!blocks.length&&lifecycleIntent(m.body))blocks=[{fields:{},fieldEvidence:{},reasons:[],startLine:1}];
  for(const b of blocks){
   // Ignore standalone vessel reference and incidental name-only text; retain incomplete order/confirmation blocks.
   if(!b.fields.escortMobile&&!b.fields.employee_id&&!b.fields.escortName&&!lifecycleIntent(m.body))continue;
   const date=explicitDutyDate(b.fields.startDate),explicitShift=b.fields.shift?.trim().toUpperCase();
   const shift=['D','N'].includes(explicitShift)?explicitShift:date.shift;
   const escortKey=normalizeEmployeeMobile(b.fields.employee_id??b.fields.escortMobile,b.fields.employee_id?'employee_id':'escortMobile');
   const reasons=[...b.reasons];if(explicitShift&&!['D','N'].includes(explicitShift))reasons.push('INVALID_EXPLICIT_SHIFT');if(explicitShift&&date.shift&&explicitShift!==date.shift)reasons.push('CONTRADICTORY_SHIFT');
   if(b.fields.employee_id&&b.fields.escortMobile&&normalizeEmployeeMobile(b.fields.employee_id)!==normalizeEmployeeMobile(b.fields.escortMobile,'escortMobile'))reasons.push('EMPLOYEE_ESCORT_MOBILE_MISMATCH_REVIEW');
   const required=['motherVessel','lighterVessel','escortName','startDate'];
   const missing=required.filter(k=>!b.fields[k]?.trim());if(!b.fields.employee_id?.trim()&&!b.fields.escortMobile?.trim())missing.push('employeeMobile');if(!shift)missing.push('shift');
   if(b.fields.startDate&&!date.date)reasons.push('INVALID_OR_UNSUPPORTED_DUTY_DATE');
   if((b.fields.escortMobile||b.fields.employee_id)&&!escortKey)reasons.push('INVALID_EXPLICIT_ESCORT_MOBILE');
   if(date.date&&asOf&&date.date>asOf)reasons.push('FUTURE_HISTORICAL_DATE');
   const role=verifiedMessageRole(m,roleBindings);
   if(!role)reasons.push('MESSAGE_ROLE_UNVERIFIED');
   if(!m.reference?.nativeHref)reasons.push('ORIGINAL_WHATSAPP_LINK_UNAVAILABLE');
   const complete=missing.length===0&&!!date.date&&!!escortKey&&!reasons.some(r=>['INVALID_EXPLICIT_SHIFT','CONTRADICTORY_SHIFT','REPEATED_FIELD_REQUIRES_REVIEW','FUTURE_HISTORICAL_DATE','EMPLOYEE_ESCORT_MOBILE_MISMATCH_REVIEW'].includes(r));
   const intent=lifecycleIntent(m.body);
   const classification=['client','requester'].includes(role)&&(!intent||intent==='SERVICE_ORDER')?'DRAFT':role==='admin'&&complete&&(!intent||intent==='ADMIN_CONFIRMATION')?'ADMIN_CONFIRMATION_CANDIDATE':'REVIEW';
   const businessKey=complete?sha(canonical({mother:vesselKey(b.fields.motherVessel),lighter:vesselKey(b.fields.lighterVessel),escortKey,startDate:date.date,shift})):null;
   events.push({sourceBlockStartLine:b.startLine,sourceOccurrenceId:m.reference?.occurrenceId??null,originalMessage:m.body??'',intent,intentEvidence:explicitLifecycleIntent(m.body)?'EXPLICIT_MESSAGE_MARKER':intent?'LEXICAL_REVIEW_ONLY':null,candidateEventTypes:lifecycleSignals(m.body),roleEvidence:verifiedRoleEvidence(m,roleBindings),id:sha(canonical({messageOccurrence:m.reference?.occurrenceId??m.id,startLine:b.startLine})),messageId:m.id,reference:m.reference??null,rawFields:b.fields,fieldEvidence:b.fieldEvidence,role,classification,complete,missing,reasons:reasons.sort(),escortKey,motherVessel:b.fields.motherVessel??'',lighterVessel:b.fields.lighterVessel??'',escortName:b.fields.escortName??'',masterKey:normalizedPhoneComparison(b.fields.masterMobile),startDate:date.date,shift,messageDate:m.messageDate,messageTimestamp:calendarTimestamp(m),timestampTimezone:null,historicalStatus:m.historicalStatus??null,businessKey});
  }
 }
 return events.sort((a,b)=>a.id.localeCompare(b.id,'en'));
}
/** masterKey above is comparison-only metadata; it is never routed to employee matching. */
export function reconcileEscortIdentities(events,{knownIdentities=[],ownershipContradictions=[],ledgerEmployees=[],ownerApprovedLinks=[]}={}){
 const known=[...ledgerEmployees.map(e=>({id:e.internalId??e.id,employee_id:e.employee_id})),...knownIdentities.filter(i=>normalizeEmployeeMobile(i.employee_id)).map(i=>({id:i.id,employee_id:i.employee_id}))];
 const normalizedKnown=[...new Map(known.map(e=>[e.id+'|'+normalizeEmployeeMobile(e.employee_id),e])).values()];
 const records=events.map(e=>({id:e.id,sourceOccurrenceId:e.id,employee_id:e.rawFields.employee_id??e.rawFields.escortMobile,employee_name:e.escortName,sourceRole:e.rawFields.employee_id?'employee_id':'escortMobile',sourceRoleEstablished:!!(e.fieldEvidence?.employee_id??e.fieldEvidence?.escortMobile)&&!e.reasons?.includes('REPEATED_FIELD_REQUIRES_REVIEW'),reference:e.reference,escort_mobile:e.rawFields.employee_id?e.rawFields.escortMobile:undefined}));
 const result=reconcileEmployeeMobileRecords(records,{knownEmployees:normalizedKnown,ownerApprovedLinks});
 const identities=result.employees.map(e=>({employee_id:e.employee_id,escortKey:e.matchingMobiles[0],internalId:e.internalId,identityState:e.identityState,aliases:e.aliases.map(a=>a.name),aliasRecords:e.aliases,eventIds:records.filter(r=>e.matchingMobiles.includes(normalizeEmployeeMobile(r.employee_id,r.sourceRole))).map(r=>r.id).sort(),references:e.sourceReferences,contactHistory:e.contactHistory,employmentStatus:e.employmentStatus,ownershipWarnings:ownershipContradictions.filter(c=>e.matchingMobiles.includes(c.escortKey)&&c.verified===true)}));
 return {identities,rejected:result.unresolved,sameMobileMultipleNameAliasGroups:result.summary.nameAliasGroups,ownershipReviewGroups:identities.filter(e=>e.ownershipWarnings.length).length,sameNameMultipleMobileGroups:result.summary.sameNameDifferentMobileGroups};
}
export function programWindowCandidates(events){
 const pairs=[],sorted=[...events].sort((a,b)=>(a.messageTimestamp??a.messageDate??'').localeCompare(b.messageTimestamp??b.messageDate??'')||a.id.localeCompare(b.id));
 for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length;j++){
  const a=sorted[i],b=sorted[j],ad=dayIndex(a.messageDate),bd=dayIndex(b.messageDate);if(ad==null||bd==null)continue;const days=bd-ad;if(days<0||days>5)continue;
  const reasons=[];
  const sameLighter=!!vesselKey(a.lighterVessel)&&vesselKey(a.lighterVessel)===vesselKey(b.lighterVessel);
  const sameCore=sameLighter&&!!vesselKey(a.motherVessel)&&vesselKey(a.motherVessel)===vesselKey(b.motherVessel)&&a.escortKey&&a.escortKey===b.escortKey;
  const orderConfirmationReference=a.businessKey&&a.businessKey===b.businessKey&&a.role&&b.role&&a.role!==b.role;
  const corroborationConflict=(a.masterKey&&b.masterKey&&a.masterKey!==b.masterKey)||(a.historicalStatus&&b.historicalStatus&&a.historicalStatus!==b.historicalStatus);
  if(orderConfirmationReference)reasons.push('ORDER_CONFIRMATION_REFERENCE');
  if(!orderConfirmationReference&&a.businessKey&&a.businessKey===b.businessKey&&days===0&&!corroborationConflict)reasons.push('SAME_DAY_DUPLICATE_CANDIDATE');
  if(!orderConfirmationReference&&sameCore&&days<=3)reasons.push(a.businessKey&&a.businessKey===b.businessKey&&!corroborationConflict?'THREE_DAY_DUPLICATE_CANDIDATE':'THREE_DAY_CORRECTION_REVIEW');
  if(!orderConfirmationReference&&sameLighter&&!reasons.some(r=>r.endsWith('DUPLICATE_CANDIDATE')))reasons.push('FIVE_DAY_CANCEL_RESTART_REPLACEMENT_REVIEW');
  if(corroborationConflict&&sameLighter)reasons.push('MASTER_OR_STATUS_CONTRADICTION');
  if(reasons.length)pairs.push({a:a.id,b:b.id,messageDayDifference:days,reasons:reasons.sort(),references:[a.reference,b.reference],action:'REFERENCE_EXISTING_OR_REVIEW',automaticCancel:false});
 }
 return pairs.sort((a,b)=>(a.a+'|'+a.b).localeCompare(b.a+'|'+b.b));
}
export function priorAssignmentClosureReviews(events,priorAssignments=[]){
 const open=[...priorAssignments],reviews=[];
 const sorted=[...events].sort((a,b)=>(a.messageTimestamp??'').localeCompare(b.messageTimestamp??'')||a.id.localeCompare(b.id));
 for(const e of sorted){if(e.classification!=='ADMIN_CONFIRMATION_CANDIDATE')continue;
  for(const prior of open)if(prior.escortKey===e.escortKey&&prior.businessKey!==e.businessKey&&prior.open===true)reviews.push({newEventId:e.id,previousAssignmentId:prior.id,reason:'PRIOR_ASSIGNMENT_CLOSURE_REVIEW',reference:e.reference,priorReference:prior.reference??null,automaticClosure:false,releaseDate:null,dutyTotal:null});
  if(!open.some(p=>p.businessKey===e.businessKey))open.push({id:e.id,escortKey:e.escortKey,businessKey:e.businessKey,open:true,reference:e.reference});
 }
 return reviews;
}
export function releaseCandidate(message,{mediaAvailable=false,ocrEvidence=null,verification=null,programs=[]}={}){
 const refs=message.reference??null,media=[...(message.mediaNames??[])];
 const candidate=/release\s*(?:slip|point|date)|released|রিলিজ/i.test(message.body??'')||['Release review','Released'].includes(message.historicalStatus);
 if(!candidate)return null;
 const reasons=[],fields=ocrEvidence?.fields??{},employee_id=normalizeEmployeeMobile(fields.employee_id??fields.escortMobile),date=explicitDutyDate(fields.releaseDate).date;
 if(media.length&&!mediaAvailable)reasons.push('OCR_MEDIA_UNAVAILABLE');
 if(mediaAvailable&&!ocrEvidence)reasons.push('OCR_REQUIRED');
 if(ocrEvidence&&(ocrEvidence.ambiguities?.length||ocrEvidence.errors?.length))reasons.push('OCR_AMBIGUITY_REVIEW');
 const eligible=programs.filter(p=>employee_id===normalizeEmployeeMobile(p.employee_id??p.escortKey)&&!!employee_id&&date&&validDate(p.startDate)&&p.startDate<=date&&(!p.endDate||date<=p.endDate)&&(!fields.motherVessel||vesselKey(p.motherVessel)===vesselKey(fields.motherVessel))&&(!fields.lighterVessel||vesselKey(p.lighterVessel)===vesselKey(fields.lighterVessel)));
 const requested=fields.programId??verification?.programId;
 const candidates=requested?eligible.filter(p=>p.id===requested):eligible;
 const explicitVessels=!!fields.motherVessel&&!!fields.lighterVessel;
 const uniqueProgram=candidates.length===1?candidates[0].id:null;
 if(!explicitVessels&&!uniqueProgram)reasons.push(candidates.length>1?'RELEASE_PROGRAM_MATCH_AMBIGUOUS':'RELEASE_PROGRAM_MATCH_UNRESOLVED');
 const documentVerified=mediaAvailable&&!!ocrEvidence&&/^[a-f0-9]{64}$/.test(ocrEvidence.mediaSha??'')&&ocrEvidence.reference&&verification?.decision==='APPROVED'&&verification.approver&&verification.mediaSha===ocrEvidence.mediaSha&&verification.programId&&date&&verification.releaseFieldsVerified===true&&verification.identityFieldsVerified===true&&employee_id&&!reasons.includes('OCR_AMBIGUITY_REVIEW')&&(explicitVessels||uniqueProgram===verification.programId)&&(!programs.length||uniqueProgram===verification.programId);
 if(!documentVerified)reasons.push('RELEASE_FIELDS_NOT_VERIFIED');
 return {messageId:message.id,sourceOccurrenceId:refs?.occurrenceId??null,eventType:'RELEASE_EVIDENCE',ruleIds:['REL-001','REL-002','PRG-008'],reference:refs,role:message.role??null,roleEvidence:message.roleEvidence??null,messageTimestamp:calendarTimestamp(message),timestampTimezone:null,rawFields:fields,missing:['employeeMobile','releaseDate'].filter(k=>k==='employeeMobile'?!employee_id:!date),linkedOrderId:null,references:[refs],mediaReferences:media,ocrEvidence,employee_id,proposedProgramIds:candidates.map(p=>p.id).sort(),linkedProgramId:documentVerified?verification.programId:uniqueProgram,classification:documentVerified?'RELEASED_CANDIDATE':'RELEASE_REVIEW',releaseDate:documentVerified?date:null,programCompleted:false,settlementApproved:false,paymentCompleted:false,dutyTotal:null,reasons:[...new Set(reasons)].sort()};
}
/** Offline dependency injection only; never fetches media or invokes a network OCR provider. */
export function extractReleaseOcr({mediaBytes,reference,extractor}={}){
 if(!(mediaBytes instanceof Uint8Array)||!mediaBytes.length||!reference)throw Error('OCR_SOURCE_MEDIA_REQUIRED');
 if(typeof extractor!=='function')return {mediaSha:sha(mediaBytes),reference,fields:{},ambiguities:['OCR_EXTRACTOR_UNAVAILABLE'],approval:false};
 const extracted=extractor(mediaBytes);if(!extracted||typeof extracted!=='object'||!extracted.fields||Array.isArray(extracted.fields))throw Error('OCR_RESULT_SHAPE');
 return {mediaSha:sha(mediaBytes),reference,fields:{...extracted.fields},rawText:extracted.rawText??null,ambiguities:[...(extracted.ambiguities??[])],extractor:extracted.extractor??null,approval:false};
}
export function verifiedMilestones({release=false,programCompletion=false,settlement=false,payment=false}={}){
 // Callers pass only independently verified milestone decisions; one never implies another.
 return {release:release?'Released':'Not verified',program:programCompletion?'Program Completed':'Not verified',settlement:settlement?'Settlement Approved':'Not verified',payment:payment?'Payment Completed':'Not verified'};
}
export function ghatDutyCandidates(payments,{currencyContext=null,asOf=null,priorEvents=[]}={}){
 const groups=new Map(),seen=new Map(),evidence=[],excluded=[];
 for(const p of [...payments].sort((a,b)=>a.id.localeCompare(b.id))){
  const occurrenceKey=p.reference?.occurrenceId??p.id;if(seen.has(occurrenceKey)){if(seen.get(occurrenceKey)!==canonical(p))throw Error('GHAT_SOURCE_OCCURRENCE_CONFLICT');excluded.push({id:p.id,reason:'DUPLICATE_PAYMENT_EVIDENCE'});continue;}seen.set(occurrenceKey,canonical(p));
  if(p.amountCents!==20000||(p.currency??currencyContext)!=='BDT')continue;
  // employeePhone is the established ledger mobile role; this pattern does not prove employment or transfer.
  const mobile=normalizeEmployeeMobile(p.employee_id??p.employeePhone,p.sourceRole??'ledger_employee_mobile');
  const key=mobile?sha('employee-mobile-ghat-v4|'+mobile):null;
  const transferVerified=p.transferVerification?.decision==='APPROVED'&&/^[a-f0-9]{64}$/.test(p.transferVerification.receiptSha??'')&&p.transferVerification.transferReference&&p.transferVerification.approver&&validDate(p.transferVerification.approvedOn)&&p.transferVerification.paymentEvidenceId===p.id&&p.transferVerification.amountCents===20000&&p.transferVerification.currency==='BDT'&&p.transferVerification.paymentDate===p.date&&validDate(p.date);
  const item={id:p.id,sourceOccurrenceId:p.reference?.occurrenceId??null,eventType:'GHAT_DUTY_CANDIDATE',ruleIds:['GHAT-001','GHAT-002','EMP-001','EMP-006','PRG-008'],role:p.role??null,roleEvidence:p.roleEvidence??null,messageTimestamp:calendarTimestamp({messageDate:p.date,time:p.time}),timestampTimezone:null,rawFields:{employeeMobile:p.employee_id??p.employeePhone,date:p.date,amountCents:p.amountCents,currency:p.currency??currencyContext,purpose:p.purpose??null},missing:!mobile?['employeeMobile']:[],reasons:!mobile?['GHAT_EMPLOYEE_MOBILE_UNRESOLVED']:[],linkedOrderId:null,linkedProgramId:null,labelKey:key,employee_id:mobile,date:p.date,purpose:p.purpose??null,reference:p.reference??null,evidenceType:transferVerified?'VERIFIED_TRANSFER':'PAYMENT_INSTRUCTION',currencyBasis:p.currency?'SOURCE':'OWNER_GHAT_PATTERN_CONTEXT',personIdentityResolved:!!mobile};evidence.push(item);
  if(asOf&&validDate(p.date)&&p.date>asOf){excluded.push({id:p.id,reason:'FUTURE_PAYMENT_EVIDENCE_REVIEW'});continue;}
  if(!key||!validDate(p.date)){excluded.push({id:p.id,reason:!key?'GHAT_EMPLOYEE_MOBILE_UNRESOLVED':'PAYMENT_DATE_INVALID'});continue;}
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);
 }
 const candidates=[];
 for(const [key,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const dates=[...new Set(items.map(p=>p.date))].sort();if(dates.length<2)continue;
  const runs=[];let run=[];for(const date of dates){if(run.length&&dayIndex(date)-dayIndex(run.at(-1))!==1){runs.push(run);run=[];}run.push(date);}if(run.length)runs.push(run);
  const consecutive=runs.filter(r=>r.length>=3);
  const context=priorEvents.filter(e=>normalizeEmployeeMobile(e.employee_id??e.escortKey)===items[0].employee_id&&validDate(e.effectiveDate??e.releaseDate??e.startDate??e.messageDate)&&(e.effectiveDate??e.releaseDate??e.startDate??e.messageDate)<=dates[0]);
  const released=context.filter(e=>e.eventType==='PROGRAM_RELEASE'&&e.accepted===true);
  candidates.push({id:sha(canonical({rule:'ghat-v4',key,dates})),eventType:'GHAT_DUTY_CANDIDATE',sourceOccurrenceIds:items.map(p=>p.sourceOccurrenceId),reference:items[0].reference,role:items[0].role,roleEvidence:items[0].roleEvidence,messageTimestamp:items[0].messageTimestamp,timestampTimezone:null,rawFields:items.map(p=>p.rawFields),missing:released.length?[]:['priorReleaseEvidence'],linkedOrderId:null,linkedProgramIds:context.map(e=>e.linkedProgramId).filter(Boolean),ruleIds:['EMP-001','EMP-006','GHAT-001','GHAT-002','PRG-008'],employee_id:items[0].employee_id,priorLifecycleReferences:context.map(e=>e.reference??null),priorReleaseVerified:released.length>0,reasons:released.length?[]:['PRIOR_RELEASE_EVIDENCE_MISSING'],labelKey:key,classification:consecutive.length?'HIGH_PRIORITY_GHAT_REVIEW':'POSSIBLE_GHAT_DUTY',evidenceDates:dates,consecutiveRuns:consecutive,references:items.map(p=>p.reference),instructionCount:items.filter(p=>p.evidenceType==='PAYMENT_INSTRUCTION').length,verifiedTransferCount:items.filter(p=>p.evidenceType==='VERIFIED_TRANSFER').length,reason:'BDT_200_DAY_PATTERN_NOT_ATTENDANCE_OR_TRANSFER_PROOF',cashPosting:false,attendancePosting:false,payrollPosting:false,settlementPosting:false});
 }
 return {evidence,candidates,excluded};
}

// EMP-001..006 v3: employee_id is a mobile-valued operational key, not a UUID.
export function normalizeEmployeeMobile(value,sourceRole='employee_id'){
 return ['employee_id','ledger_employee_mobile','escort_mobile','escortMobile'].includes(sourceRole)?normalizedPhoneComparison(value):null;
}
export function reconcileEmployeeMobileRecords(records,{knownEmployees=[],ownerApprovedLinks=[]}={}){
 const groups=new Map(),unresolved=[],seenOccurrences=new Map();
 for(const r of [...records].sort((a,b)=>(a.sourceOccurrenceId??a.id??'').localeCompare(b.sourceOccurrenceId??b.id??'')||canonical(a).localeCompare(canonical(b)))){
  const occurrenceId=r.sourceOccurrenceId??r.reference?.occurrenceId;
  const content=sha(canonical(r));
  if(occurrenceId&&seenOccurrences.has(occurrenceId)){if(seenOccurrences.get(occurrenceId)!==content)throw Error('EMPLOYEE_SOURCE_OCCURRENCE_CONFLICT');continue;}
  if(occurrenceId)seenOccurrences.set(occurrenceId,content);
  const reject=reason=>unresolved.push({sourceOccurrenceId:occurrenceId??null,reason,originalMobile:r.employee_id??null,originalName:r.employee_name??null,reference:r.reference??null,employee_id:null,internalId:null});
  if(r.sourceRoleEstablished!==true||!['employee_id','ledger_employee_mobile','escort_mobile','escortMobile'].includes(r.sourceRole)){reject('EMPLOYEE_SOURCE_ROLE_UNESTABLISHED');continue;}
  if(r.employee_id==null||r.employee_id===''){reject('EMPLOYEE_MOBILE_MISSING');continue;}
  if(typeof r.employee_id!=='string'){reject('EMPLOYEE_MOBILE_INVALID_OR_AMBIGUOUS');continue;}
  if(!r.employee_id.trim()){reject('EMPLOYEE_MOBILE_MISSING');continue;}
  const mobile=normalizeEmployeeMobile(r.employee_id,r.sourceRole);if(!mobile){reject('EMPLOYEE_MOBILE_INVALID_OR_AMBIGUOUS');continue;}
  if(r.escort_mobile!=null&&(!normalizeEmployeeMobile(r.escort_mobile,'escort_mobile')||normalizeEmployeeMobile(r.escort_mobile,'escort_mobile')!==mobile)){reject('EMPLOYEE_ESCORT_MOBILE_MISMATCH_REVIEW');continue;}
  if(!occurrenceId||!r.reference){reject('EMPLOYEE_SOURCE_REFERENCE_MISSING');continue;}
  const existing=knownEmployees.filter(e=>normalizeEmployeeMobile(e.employee_id)===mobile);
  const links=ownerApprovedLinks.filter(l=>normalizeEmployeeMobile(l.fromEmployeeId)===mobile&&l.decision==='APPROVED'&&l.approver&&validDate(l.approvedOn)&&/^[a-f0-9]{64}$/.test(l.evidenceSha??''));
  if(existing.length>1||links.length>1){reject('DUPLICATE_EXISTING_IDENTITY_BINDING_REVIEW');continue;}
  const linked=links.length?knownEmployees.find(e=>e.id===links[0].targetInternalId):null;
  if(links.length&&!linked){reject('LINK_TARGET_IDENTITY_MISSING');continue;}
  const target=existing[0]??linked,primary=target?normalizeEmployeeMobile(target.employee_id):mobile;
  if(!primary){reject('KNOWN_EMPLOYEE_MOBILE_INVALID');continue;}
  if(existing[0]&&linked&&existing[0].id!==linked.id){reject('CONFLICTING_OWNER_LINK_REVIEW');continue;}
  const internalId=target?.id??'employee-candidate-'+sha('internal-employee-mobile-v3|'+primary);
  const key=primary;
  if(!groups.has(key))groups.set(key,{employee_id:primary,internalId,identityState:target?'MATCHED_EXISTING_IDENTITY':'OPERATIONAL_EMPLOYEE_CANDIDATE',matchingMobiles:new Set(),aliasMap:new Map(),sourceMap:new Map(),contactMap:new Map(),employmentStatus:'NOT_INFERRED'});
  const group=groups.get(key);if(group.internalId!==internalId)throw Error('EMPLOYEE_INTERNAL_ID_CONFLICT');
  group.matchingMobiles.add(mobile);group.sourceMap.set(occurrenceId,r.reference);
  group.contactMap.set(occurrenceId,{originalValue:r.employee_id,normalizedMobile:mobile,sourceRole:r.sourceRole,reference:r.reference,validFrom:r.verifiedValidFrom??null,validTo:r.verifiedValidTo??null});
  if(typeof r.employee_name==='string'&&r.employee_name.length){
   const rawName=r.employee_name;if(!group.aliasMap.has(rawName))group.aliasMap.set(rawName,{id:sha(canonical({rule:'EMP-003',employee_id:primary,rawName})),name:rawName,sourceMap:new Map()});
   group.aliasMap.get(rawName).sourceMap.set(occurrenceId,r.reference);
  }
 }
 const employees=[...groups.values()].map(g=>({employee_id:g.employee_id,internalId:g.internalId,identityState:g.identityState,matchingMobiles:[...g.matchingMobiles].sort(),aliases:[...g.aliasMap.values()].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(a=>({id:a.id,name:a.name,sourceReferences:[...a.sourceMap].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v)})),sourceReferences:[...g.sourceMap].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v),contactHistory:[...g.contactMap].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v),employmentStatus:g.employmentStatus})).sort((a,b)=>a.employee_id.localeCompare(b.employee_id));
 const names=new Map();for(const e of employees)for(const a of e.aliases){if(!names.has(a.name))names.set(a.name,new Set());names.get(a.name).add(e.employee_id);}
 return {employees,unresolved,summary:{sourceOccurrences:seenOccurrences.size,matchedSourceOccurrences:employees.reduce((n,e)=>n+e.sourceReferences.length,0),operationalEmployeeKeys:employees.length,nameAliasGroups:employees.filter(e=>e.aliases.length>1).length,aliasRecords:employees.reduce((n,e)=>n+e.aliases.length,0),sameNameDifferentMobileGroups:[...names.values()].filter(s=>s.size>1).length,unresolvedOccurrences:unresolved.length}};
}

// Lifecycle API uses the existing lower-case SQL assertion/assignment types through this adapter.
export const lifecycleEventTypes=Object.freeze({SERVICE_ORDER:'client_order',ORDER_DRAFT:'client_order',ADMIN_CONFIRMATION:'admin_confirmation',PROGRAM_DUPLICATE:'duplicate',PROGRAM_CORRECTION:'corrected',PROGRAM_CANCELLATION:'cancelled',PROGRAM_RESTART:'restarted',ESCORT_REPLACEMENT:'escort_replaced',DUTY_START:'duty_started',RELEASE_EVIDENCE:'release_evidence',PROGRAM_RELEASE:'released',PROGRAM_COMPLETION:'program_completed',NEW_ASSIGNMENT:'assigned',GHAT_DUTY_CANDIDATE:'ghat_review'});
export function verifiedRoleEvidence(message,bindings=[]){
 const role=verifiedMessageRole(message,bindings);if(!role)return null;
 return bindings.find(b=>verifiedMessageRole(message,[b])===role)??null;
}
function explicitLifecycleIntent(body=''){
 const patterns=[['SERVICE_ORDER',/^\s*(?:client escort service order|escort service order|notun escort order|service order)(?:\s*[:\n]|\s*$)/im],['PROGRAM_CANCELLATION',/^\s*(?:event\s*:\s*)?(?:program cancellation|program cancelled|program canceled|cancelled|canceled)(?:\s*[:\n]|\s*$)/im],['PROGRAM_RESTART',/^\s*(?:event\s*:\s*)?(?:program restart|program restarted|restart)(?:\s*[:\n]|\s*$)/im],['ESCORT_REPLACEMENT',/^\s*(?:event\s*:\s*)?(?:escort replacement|escort change|replacement escort supply)(?:\s*[:\n]|\s*$)/im],['PROGRAM_CORRECTION',/^\s*(?:event\s*:\s*)?(?:program correction|correction)(?:\s*[:\n]|\s*$)/im],['DUTY_START',/^\s*(?:event\s*:\s*)?(?:duty started|actual duty start|duty start)(?:\s*[:\n]|\s*$)/im],['PROGRAM_COMPLETION',/^\s*(?:event\s*:\s*)?(?:program completion|program completed)(?:\s*[:\n]|\s*$)/im],['PROGRAM_RELEASE',/^\s*(?:event\s*:\s*)?(?:program release|duty released)(?:\s*[:\n]|\s*$)/im],['RELEASE_EVIDENCE',/^\s*(?:release slip|release evidence|release document)(?:\s|:|$)/im],['ADMIN_CONFIRMATION',/^\s*(?:event\s*:\s*)?(?:admin confirmation|program confirmation)(?:\s*[:\n]|\s*$)/im],['NEW_ASSIGNMENT',/^\s*(?:event\s*:\s*)?new assignment(?:\s*[:\n]|\s*$)/im]];
 const matches=patterns.filter(([,r])=>r.test(body)).map(([t])=>t);
 return matches.length===1?matches[0]:matches.length>1?'AMBIGUOUS_LIFECYCLE_INTENT':null;
}
export function lifecycleSignals(body=''){
 const signals=[];if(/\bcancel(?:led|ed|lation)?\b|বাতিল/i.test(body))signals.push('PROGRAM_CANCELLATION');if(/\brestart(?:ed)?\b/i.test(body))signals.push('PROGRAM_RESTART');if(/\bescort\s+(?:change|replacement)\b|\breplacement escort supply\b/i.test(body))signals.push('ESCORT_REPLACEMENT');if(/\breleased\b|release\s*(?:slip|document)|রিলিজ/i.test(body))signals.push('RELEASE_EVIDENCE');if(/\bprogram(?:me)?\s+complet(?:e|ed|ion)\b/i.test(body))signals.push('PROGRAM_COMPLETION');return signals;
}
export function lifecycleIntent(body=''){return explicitLifecycleIntent(body)??(lifecycleSignals(body).length===1?lifecycleSignals(body)[0]:lifecycleSignals(body).length>1?'AMBIGUOUS_LIFECYCLE_INTENT':null);}
const approvedProof=p=>p?.decision==='APPROVED'&&!!p.approver&&validDate(p.approvedOn)&&/^[a-f0-9]{64}$/.test(p.evidenceSha??'');
const orderedEvents=events=>[...events].sort((a,b)=>(a.messageTimestamp??a.messageDate??'').localeCompare(b.messageTimestamp??b.messageDate??'')||a.id.localeCompare(b.id));
const compatibleDraft=(draft,event)=>['motherVessel','lighterVessel','escortKey','startDate','shift'].every(k=>!draft[k]||draft[k]===(['motherVessel','lighterVessel'].includes(k)?vesselKey(event[k]):event[k]));
const draftMeaning=e=>({motherVessel:vesselKey(e.motherVessel),lighterVessel:vesselKey(e.lighterVessel),escortKey:e.escortKey,startDate:e.startDate,shift:e.shift,escortName:comparison(e.escortName),rawFields:Object.fromEntries(Object.entries(e.rawFields).filter(([k])=>!['event','orderId','programId'].includes(k)).map(([k,v])=>[k,comparison(v)]))});
/** Allowed states are business facts; corrections/restarts/replacements append events, not statuses. */
export function lifecycleTransition(state,event,{role=null,complete=false,effectiveDate=null,releaseVerified=false,completionVerified=false,linked=false,restartVerified=false,replacementVerified=false,assignmentVerified=false}={}){
 const reject=reason=>({allowed:false,state,reason});
 if(event==='SERVICE_ORDER'||event==='ORDER_DRAFT')return ['client','requester'].includes(role)?{allowed:true,state:'draft'}:reject('REQUESTER_ROLE_UNVERIFIED');
 if(role!=='admin'&&event!=='RELEASE_EVIDENCE')return reject('ADMIN_ROLE_UNVERIFIED');
 if(event==='ADMIN_CONFIRMATION')return complete&&['draft','review',null].includes(state)?{allowed:true,state:'confirmed'}:reject('CONFIRMATION_INCOMPLETE_OR_STATE_CONFLICT');
 if(!linked)return reject('LINKED_PROGRAM_REQUIRED');
 if(event==='PROGRAM_DUPLICATE')return {allowed:true,state};
 if(event==='PROGRAM_CORRECTION')return !['completed','cancelled'].includes(state)&&approvedProof(assignmentVerified)?{allowed:true,state}:reject('CORRECTION_FIELDS_UNVERIFIED');
 if(!validDate(effectiveDate))return reject('EFFECTIVE_DATE_UNVERIFIED');
 if(event==='NEW_ASSIGNMENT')return state==='confirmed'&&assignmentVerified===true?{allowed:true,state:'assigned'}:reject('ASSIGNMENT_EVIDENCE_REQUIRED');
 if(event==='DUTY_START')return ['confirmed','assigned'].includes(state)?{allowed:true,state:'active'}:reject('ACTUAL_START_STATE_CONFLICT');
 if(event==='PROGRAM_CANCELLATION')return ['draft','confirmed','assigned','active'].includes(state)?{allowed:true,state:'cancelled'}:reject('CANCELLATION_STATE_CONFLICT');
 if(event==='PROGRAM_RESTART')return state==='cancelled'&&complete&&restartVerified===true?{allowed:true,state:'confirmed'}:reject('RESTART_PREDECESSOR_OR_FIELDS_UNVERIFIED');
 if(event==='ESCORT_REPLACEMENT')return ['confirmed','assigned','active'].includes(state)&&replacementVerified===true?{allowed:true,state}:reject('REPLACEMENT_IDENTITIES_UNVERIFIED');
 if(event==='PROGRAM_RELEASE')return ['confirmed','assigned','active'].includes(state)&&releaseVerified===true?{allowed:true,state:'released'}:reject('RELEASE_EVIDENCE_UNVERIFIED');
 if(event==='PROGRAM_COMPLETION')return state==='released'&&completionVerified===true?{allowed:true,state:'completed'}:reject('COMPLETION_EVIDENCE_UNVERIFIED');
 return reject('EVENT_REQUIRES_REVIEW');
}
/** One pure candidate reducer on the existing extractor. No persistence, network or startup hook. */
export function classifyProgramLifecycle(messages,{roleBindings=[],knownPrograms=[],asOf,releaseEvidence={},transitionEvidence={}}={}){
 if(!validDate(asOf))throw Error('EXPLICIT_AS_OF_REQUIRED');
 const sourceMessages=new Map();
 for(const m of messages){const key=m.reference?.occurrenceId??m.id;if(sourceMessages.has(key)&&sourceMessages.get(key)!==canonical(m))throw Error('LIFECYCLE_OCCURRENCE_CONFLICT');sourceMessages.set(key,canonical(m));}
 const extractedById=new Map();
 for(const e of extractEscortMessages(messages,{roleBindings,asOf})){if(extractedById.has(e.id)&&canonical(extractedById.get(e.id))!==canonical(e))throw Error('LIFECYCLE_OCCURRENCE_CONFLICT');extractedById.set(e.id,e);}
 const extracted=[...extractedById.values()],seen=new Map(),records=[],orders=[],programs=[],assignments=[],pairCandidates=programWindowCandidates(extracted);
 for(const p of knownPrograms){
  if(!approvedProof(p.verification)||!p.reference||!p.id||!['draft','review','confirmed','assigned','active','released','completed','cancelled'].includes(p.state))throw Error('PROGRAM_CONTEXT_UNVERIFIED');
  if(programs.some(x=>x.id===p.id))throw Error('DUPLICATE_PROGRAM_CONTEXT');
  if(!['draft','review'].includes(p.state)&&(!normalizeEmployeeMobile(p.employee_id)||!validDate(p.startDate)||p.startDate>asOf))throw Error('PROGRAM_CONTEXT_FIELDS_UNVERIFIED');
  programs.push({...p,employee_id:normalizeEmployeeMobile(p.employee_id),businessKey:p.businessKey??sha(canonical({mother:vesselKey(p.motherVessel),lighter:vesselKey(p.lighterVessel),escortKey:normalizeEmployeeMobile(p.employee_id),startDate:p.startDate,shift:p.shift})),plannedStartDate:p.plannedStartDate??p.startDate,actualStartDate:p.actualStartDate??null,history:[],references:[p.reference],candidateOnly:true});
  if(p.employee_id&&['confirmed','assigned','active'].includes(p.state))assignments.push({id:p.assignmentId??sha('existing-assignment|'+p.id),programId:p.id,employee_id:normalizeEmployeeMobile(p.employee_id),open:true,reference:p.reference,predecessorId:null,effectiveDate:null});
 }
 const eventRule={SERVICE_ORDER:['PRG-001'],ORDER_DRAFT:['PRG-001'],ADMIN_CONFIRMATION:['PRG-002'],PROGRAM_DUPLICATE:['PRG-003'],PROGRAM_CORRECTION:['PRG-003','PRG-006'],PROGRAM_CANCELLATION:['PRG-006'],PROGRAM_RESTART:['PRG-004','PRG-006'],ESCORT_REPLACEMENT:['PRG-006','EMP-001','EMP-005'],DUTY_START:['PRG-007'],RELEASE_EVIDENCE:['REL-001'],PROGRAM_RELEASE:['REL-001','REL-002'],PROGRAM_COMPLETION:['REL-002'],NEW_ASSIGNMENT:['PRG-007','REL-003']};
 for(const e of orderedEvents(extracted)){
  if(seen.has(e.id)){if(seen.get(e.id)!==canonical(e))throw Error('LIFECYCLE_OCCURRENCE_CONFLICT');continue;}seen.set(e.id,canonical(e));
  let eventType=e.intent??(['client','requester'].includes(e.role)?'SERVICE_ORDER':e.role==='admin'?'ADMIN_CONFIRMATION':null);
  const out={...e,bindingKey:{occurrence_id:e.sourceOccurrenceId,role:'program_event',event_key:e.id},eventType,sqlEventType:lifecycleEventTypes[eventType]??null,ruleIds:[...new Set(['EMP-001','EMP-006','PRG-008',...(eventRule[eventType]??[])])].sort(),classification:'REVIEW_REQUIRED',accepted:false,candidateOnly:true,linkedOrderId:null,linkedProgramId:null,predecessorEventId:null,assignmentId:null,effectiveDate:null,missing:[...e.missing],reasons:[...e.reasons],stateBefore:null,stateAfter:null};
  records.push(out);
  const deny=reason=>{out.reasons.push(reason);};
  if(!e.sourceOccurrenceId||!e.reference){deny('SOURCE_REFERENCE_REQUIRED');continue;}
  if(!validDate(e.messageDate)||!e.messageTimestamp||e.messageDate>asOf){deny('MESSAGE_TIMESTAMP_UNVERIFIED');continue;}
  if(e.intent==='AMBIGUOUS_LIFECYCLE_INTENT'){deny('MULTIPLE_LIFECYCLE_INTENTS_REVIEW');continue;}
  if(eventType==='SERVICE_ORDER'){
   if(!['client','requester'].includes(e.role)){deny('REQUESTER_ROLE_UNVERIFIED');continue;}
   const meaning=draftMeaning(e),equivalent=orders.filter(o=>canonical(o.meaning)===canonical(meaning)&&dayIndex(e.messageDate)-dayIndex(o.lastMessageDate)>=0&&dayIndex(e.messageDate)-dayIndex(o.lastMessageDate)<=3&&o.sourceChat===e.reference.sourceExportSha);
   if(equivalent.length>1){deny('DRAFT_MATCH_AMBIGUOUS');continue;}
   const o=equivalent[0]??{id:sha('draft-occurrence|'+e.id),state:'draft',meaning,...meaning,sourceChat:e.reference.sourceExportSha,references:[],eventIds:[],lastMessageDate:e.messageDate};
   if(!equivalent.length)orders.push(o);o.references.push(e.reference);o.eventIds.push(e.id);o.lastMessageDate=e.messageDate;
   out.linkedOrderId=o.id;out.classification='ORDER_DRAFT';out.accepted=true;out.stateAfter='draft';continue;
  }
  if(eventType==='RELEASE_EVIDENCE'){
   out.classification='RELEASE_EVIDENCE_CANDIDATE';deny('RELEASE_APPROVAL_REQUIRED');continue;
  }
  if(e.role!=='admin'){deny('ADMIN_ROLE_UNVERIFIED');continue;}
  if(e.intentEvidence==='LEXICAL_REVIEW_ONLY'){deny('EXPLICIT_TRANSITION_ASSERTION_REQUIRED');continue;}
  let p=null;
  if(e.rawFields.programId){p=programs.find(p=>p.id===e.rawFields.programId);if(!p){deny('REFERENCED_PROGRAM_NOT_FOUND');continue;}}
  if(eventType==='ADMIN_CONFIRMATION'){
   if(!e.complete){deny('CONFIRMATION_INCOMPLETE');continue;}
   const drafts=orders.filter(o=>dayIndex(e.messageDate)-dayIndex(o.lastMessageDate)>=0&&dayIndex(e.messageDate)-dayIndex(o.lastMessageDate)<=3&&compatibleDraft(o,e));
   if(e.rawFields.orderId){const explicit=orders.find(o=>o.id===e.rawFields.orderId);if(!explicit||!compatibleDraft(explicit,e)){deny('REFERENCED_ORDER_NOT_FOUND_OR_CONFLICTING');continue;}out.linkedOrderId=explicit.id;}
   else if(drafts.length===1)out.linkedOrderId=drafts[0].id;
   else if(drafts.length>1){deny('ORDER_MATCH_AMBIGUOUS');continue;}
   else deny('UNMATCHED_ADMIN_CONFIRMATION'); // Owner permits Admin creation without inventing a client order.
   const prior=programs.filter(x=>vesselKey(x.lighterVessel)===vesselKey(e.lighterVessel)&&validDate(x.lastMessageDate??x.messageDate??x.startDate)).sort((a,b)=>(b.lastMessageDate??b.messageDate??b.startDate).localeCompare(a.lastMessageDate??a.messageDate??a.startDate));
   const recent=prior.filter(x=>{const days=dayIndex(e.messageDate)-dayIndex(x.lastMessageDate??x.messageDate??x.startDate);return days>=0&&days<=5;});
   if(!p&&recent.length){
    const same=recent.filter(x=>x.businessKey===e.businessKey);
    if(same.length===1&&same[0].state!=='cancelled'&&same[0].state!=='released'&&same[0].state!=='completed'&&(!same[0].masterKey||!e.masterKey||same[0].masterKey===e.masterKey)){
     const days=dayIndex(e.messageDate)-dayIndex(same[0].lastMessageDate);
     out.linkedProgramId=same[0].id;
     if(days<=3){out.eventType='PROGRAM_DUPLICATE';out.sqlEventType='duplicate';out.classification='PROGRAM_DUPLICATE_CANDIDATE';out.ruleIds.push('PRG-003');out.accepted=true;same[0].references.push(e.reference);same[0].history.push(e.id);out.stateBefore=same[0].state;out.stateAfter=same[0].state;continue;}
    }
    const candidates=recent.filter(x=>vesselKey(x.motherVessel)===vesselKey(e.motherVessel)&&x.employee_id===e.escortKey);
    if(candidates.length===1&&dayIndex(e.messageDate)-dayIndex(candidates[0].lastMessageDate)<=3){out.eventType='PROGRAM_CORRECTION';out.sqlEventType='corrected';out.classification='PROGRAM_CORRECTION_CANDIDATE';out.linkedProgramId=candidates[0].id;out.ruleIds.push('PRG-003');deny('CORRECTION_FIELDS_REQUIRE_APPROVAL');}
    else {out.classification='FIVE_DAY_RECURRENCE_REVIEW';out.ruleIds.push('PRG-004');deny('CANCEL_RESTART_REPLACEMENT_EVIDENCE_REQUIRED');}
    continue;
   }
   if(p){
    if(!['draft','review'].includes(p.state)||!compatibleDraft({...p,motherVessel:vesselKey(p.motherVessel),lighterVessel:vesselKey(p.lighterVessel),escortKey:p.employee_id},e)){deny('EXPLICIT_PROGRAM_CONFIRMATION_REQUIRES_TRANSITION_REVIEW');continue;}
    out.linkedProgramId=p.id;out.stateBefore=p.state;out.stateAfter='confirmed';out.accepted=true;out.classification='CONFIRMED_PROGRAM_CANDIDATE';
    Object.assign(p,{state:'confirmed',motherVessel:e.motherVessel,lighterVessel:e.lighterVessel,employee_id:e.escortKey,escortName:e.escortName,startDate:e.startDate,shift:e.shift,plannedStartDate:e.startDate,actualStartDate:null,businessKey:e.businessKey,masterKey:e.masterKey,lastMessageDate:e.messageDate});p.references.push(e.reference);p.history.push(e.id);
    const a={id:sha('assignment-confirmation|'+e.id),programId:p.id,employee_id:e.escortKey,open:true,predecessorId:null,effectiveDate:null,reference:e.reference};
    for(const prior of assignments.filter(a=>a.employee_id===e.escortKey&&a.open&&a.programId!==p.id))out.reasons.push('PRIOR_ASSIGNMENT_CLOSURE_REVIEW:'+prior.id);
    assignments.push(a);out.assignmentId=a.id;continue;
   }
   const staleRepeat=prior.filter(x=>x.businessKey===e.businessKey);
   if(staleRepeat.length){out.eventType='PROGRAM_DUPLICATE';out.sqlEventType='duplicate';out.classification='REPEATED_BUSINESS_DETAILS_REVIEW';out.linkedProgramId=staleRepeat.length===1?staleRepeat[0].id:null;out.ruleIds.push('PRG-004');deny('DISTINCT_BUSINESS_EVENT_EVIDENCE_REQUIRED');continue;}
   const transition=lifecycleTransition(out.linkedOrderId?'draft':null,'ADMIN_CONFIRMATION',{role:e.role,complete:e.complete});
   if(!transition.allowed){deny(transition.reason);continue;}
   p={id:sha('program-confirmation-occurrence|'+e.id),businessKey:e.businessKey,motherVessel:e.motherVessel,lighterVessel:e.lighterVessel,employee_id:e.escortKey,escortName:e.escortName,startDate:e.startDate,shift:e.shift,masterKey:e.masterKey,plannedStartDate:e.startDate,actualStartDate:null,endDate:null,state:'confirmed',messageDate:e.messageDate,lastMessageDate:e.messageDate,references:[e.reference],history:[e.id],candidateOnly:true};programs.push(p);
   out.linkedProgramId=p.id;out.classification='CONFIRMED_PROGRAM_CANDIDATE';out.accepted=true;out.stateAfter='confirmed';
   if(out.linkedOrderId){const o=orders.find(o=>o.id===out.linkedOrderId);o.state='confirmed';o.programId=p.id;o.references.push(e.reference);o.eventIds.push(e.id);p.references.unshift(...o.references.filter(r=>r!==e.reference));}
   if(prior.length)out.reasons.push('AFTER_FIVE_DAYS_NEW_PROGRAM_CANDIDATE');
   const priorOpen=assignments.filter(a=>a.employee_id===e.escortKey&&a.open&&a.programId!==p.id);
   for(const a of priorOpen)out.reasons.push('PRIOR_ASSIGNMENT_CLOSURE_REVIEW:'+a.id);
   const a={id:sha('assignment-confirmation|'+e.id),programId:p.id,employee_id:e.escortKey,open:true,predecessorId:null,effectiveDate:null,reference:e.reference};assignments.push(a);out.assignmentId=a.id;
   continue;
  }
  if(!p){deny('LINKED_PROGRAM_REQUIRED');continue;}
  out.linkedProgramId=p.id;out.stateBefore=p.state;
  const proof=transitionEvidence[e.id]??transitionEvidence[e.messageId];
  const effectiveDate=explicitDutyDate(eventType==='DUTY_START'?e.rawFields.actualStartDate:e.rawFields.effectiveDate??e.rawFields.releaseDate).date;
  out.effectiveDate=effectiveDate;
  if(!effectiveDate)deny('EFFECTIVE_DATE_UNVERIFIED');
  if(effectiveDate&&(effectiveDate>asOf||(p.startDate&&effectiveDate<p.startDate)||(p.lastEffectiveDate&&effectiveDate<p.lastEffectiveDate))){deny('LIFECYCLE_DATE_ORDER_CONFLICT');continue;}
  if(eventType==='PROGRAM_CORRECTION'){
   if(!approvedProof(proof)||proof.programId!==p.id||proof.occurrenceId!==e.sourceOccurrenceId||!proof.correctedFields||Object.keys(proof.correctedFields).some(k=>!['motherVessel','lighterVessel','startDate','shift','masterMobile'].includes(k))){deny('CORRECTION_FIELDS_UNVERIFIED');continue;}
   if(Object.entries(proof.correctedFields).some(([k,v])=>e.rawFields[k]!==v)){deny('CORRECTION_SOURCE_VALUE_MISMATCH');continue;}
   const corrected={...p,...proof.correctedFields};
   if(!validDate(corrected.startDate)||!['D','N'].includes(corrected.shift)||!corrected.motherVessel||!corrected.lighterVessel){deny('CORRECTION_FIELDS_INVALID');continue;}
   // Preserve immutable previous field snapshot in history; never apply correction to source evidence.
   out.previousFields={motherVessel:p.motherVessel,lighterVessel:p.lighterVessel,startDate:p.startDate,shift:p.shift,masterMobile:p.masterMobile??null};
  }
  const newMobile=normalizeEmployeeMobile(e.rawFields.newEmployeeId),oldMobile=normalizeEmployeeMobile(e.rawFields.oldEmployeeId);
  const oldAssignment=assignments.filter(a=>a.programId===p.id&&a.open).at(-1);
  const release=releaseEvidence[e.id]??releaseEvidence[e.messageId];
  const released=release?releaseCandidate({...messages.find(m=>m.id===e.messageId),body:'Release Slip'}, {...release,programs:[p]}):null;
  const context={role:e.role,complete:e.complete,effectiveDate,linked:true,assignmentVerified:eventType==='PROGRAM_CORRECTION'?proof:approvedProof(proof)&&proof.programId===p.id&&proof.occurrenceId===e.sourceOccurrenceId,restartVerified:approvedProof(proof)&&proof.programId===p.id&&proof.occurrenceId===e.sourceOccurrenceId,replacementVerified:!!newMobile&&!!oldMobile&&oldMobile===p.employee_id&&oldMobile!==newMobile&&!!oldAssignment,releaseVerified:released?.classification==='RELEASED_CANDIDATE'&&released.releaseDate===effectiveDate,completionVerified:approvedProof(proof)&&proof.programId===p.id&&proof.occurrenceId===e.sourceOccurrenceId&&proof.completionDate===effectiveDate};
  if(eventType==='PROGRAM_RESTART'&&(vesselKey(e.motherVessel)!==vesselKey(p.motherVessel)||vesselKey(e.lighterVessel)!==vesselKey(p.lighterVessel)||e.startDate!==effectiveDate)){deny('RESTART_RELATIONSHIP_OR_START_DATE_CONFLICT');continue;}
  const t=lifecycleTransition(p.state,eventType,context);if(!t.allowed){deny(t.reason);continue;}
  out.accepted=true;out.classification=eventType+'_CANDIDATE';out.stateAfter=t.state;out.predecessorEventId=p.history.at(-1)??null;
  if(eventType==='PROGRAM_CORRECTION'){Object.assign(p,proof.correctedFields);p.masterKey=normalizedPhoneComparison(p.masterMobile)??p.masterKey;p.businessKey=sha(canonical({mother:vesselKey(p.motherVessel),lighter:vesselKey(p.lighterVessel),escortKey:p.employee_id,startDate:p.startDate,shift:p.shift}));out.effectiveDate=null;}
  if(eventType==='ESCORT_REPLACEMENT'){
   oldAssignment.open=false;oldAssignment.successorId=sha('replacement-assignment|'+e.id);oldAssignment.closedBy=e.id;oldAssignment.endDate=effectiveDate;
   const a={id:oldAssignment.successorId,programId:p.id,employee_id:newMobile,open:true,predecessorId:oldAssignment.id,effectiveDate,reference:e.reference};assignments.push(a);p.employee_id=newMobile;out.assignmentId=a.id;out.previousAssignmentId=oldAssignment.id;
  }
  if(eventType==='PROGRAM_RESTART'){
   const predecessor=assignments.filter(a=>a.programId===p.id).at(-1);const a={id:sha('restart-assignment|'+e.id),programId:p.id,employee_id:e.escortKey,open:true,predecessorId:predecessor?.id??null,effectiveDate,reference:e.reference};assignments.push(a);out.assignmentId=a.id;p.startDate=e.startDate;p.shift=e.shift;p.employee_id=e.escortKey;p.businessKey=e.businessKey;p.actualStartDate=null;p.endDate=null;
  }
  if(eventType==='DUTY_START')p.actualStartDate=effectiveDate;
  if(['PROGRAM_CANCELLATION','PROGRAM_RELEASE','PROGRAM_COMPLETION'].includes(eventType))for(const a of assignments.filter(a=>a.programId===p.id&&a.open)){a.open=false;a.closedBy=e.id;a.endDate=effectiveDate;}
  if(eventType==='PROGRAM_RELEASE'||eventType==='PROGRAM_COMPLETION')p.endDate=effectiveDate;
  p.state=t.state;p.history.push(e.id);p.references.push(e.reference);p.lastMessageDate=e.messageDate;if(effectiveDate)p.lastEffectiveDate=effectiveDate;
 }
 for(const e of records){e.ruleIds=[...new Set(e.ruleIds)].sort();e.reasons=[...new Set(e.reasons)].sort();}
 const eventCounts=Object.fromEntries(Object.keys(lifecycleEventTypes).map(t=>[t,records.filter(e=>e.eventType===t).length]));
 return {events:records.sort((a,b)=>a.id.localeCompare(b.id)),orders:orders.sort((a,b)=>a.id.localeCompare(b.id)),programs:programs.sort((a,b)=>a.id.localeCompare(b.id)),assignments:assignments.sort((a,b)=>a.id.localeCompare(b.id)),pairCandidates,summary:{sourceEventBlocks:records.length,untypedProgramDetails:records.filter(e=>e.eventType===null).length,ambiguousIntentBlocks:records.filter(e=>e.intent==='AMBIGUOUS_LIFECYCLE_INTENT').length,eventCounts,draftCandidates:records.filter(e=>e.classification==='ORDER_DRAFT').length,adminConfirmationCandidates:records.filter(e=>e.eventType==='ADMIN_CONFIRMATION'&&e.role==='admin'&&e.complete).length,confirmedProgramCandidates:records.filter(e=>e.classification==='CONFIRMED_PROGRAM_CANDIDATE').length,uniqueCandidateOrders:orders.length,uniqueCandidatePrograms:programs.filter(p=>!knownPrograms.some(k=>k.id===p.id)).length,reviewRequired:records.filter(e=>!e.accepted).length,incomplete:records.filter(e=>e.missing.length).length,verifiedOperationalPrograms:0,writes:0}};
}
