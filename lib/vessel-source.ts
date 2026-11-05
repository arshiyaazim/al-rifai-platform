import {normalizeEmployeeMobile,canonical,sha} from './employee-program-validation.mjs';
import type {RosterReadOptions,RosterTrace} from './vessel-data';
import {integrationConfig as env} from "@/lib/integrations";
import {database} from '../db/raw';
import {seed} from './seed';
import {importedPrograms,importSummary,type ImportedProgram} from './conversation-snapshot';
import {missingFields,validDate,type VesselRecord,type Snapshot} from './vessel-data';
export class RegisterError extends Error{constructor(message:string,public status=503){super(message);}}
const string=(v:unknown,max=200)=>typeof v==='string'?v.trim().slice(0,max):typeof v==='number'?String(v):'';
const date=(v:unknown)=>{const s=string(v,30).slice(0,10);return validDate(s)?s:'';};
export function historicalRecord(p:Record<string,unknown>):VesselRecord{
 let d:Record<string,unknown>={};try{d=(typeof p.details==='string'?JSON.parse(p.details):p.details)||{};}catch{}
 const r:VesselRecord={id:string(p.id),motherVessel:string(p.motherVessel),lighterVessel:string(p.lighterVessel),escortName:string(p.escortName),escortMobile:string(p.escortMobile,30),masterMobile:string(p.masterMobile,30),destination:string(p.destination),startDate:date(p.startDate),endDate:date(p.endDate),shift:['D','N'].includes(string(p.shift))?string(p.shift):'',status:string(p.status)||'Unknown',notes:string(p.notes,2000),source:string(p.source)||'Historical register',sourceRef:string(d.sourceMessageId)||string(p.id),duplicateOf:string(p.duplicateOf)||null,endShift:string(d.endShift),releasePoint:string(d.releasePoint),releaseConfirmed:d.releaseConfirmed===true,evidence:Array.isArray(p.evidence)?p.evidence as ImportedProgram['evidence']:[],aliases:Array.isArray(p.aliases)?p.aliases as string[]:[string(p.id)],conflicts:Array.isArray(p.conflicts)?p.conflicts as ImportedProgram['conflicts']:[],issues:Array.isArray(d.issues)?d.issues.filter((x):x is string=>typeof x==='string').map(s=>s.slice(0,500)).slice(0,30):[]};if(d.recordKind==='Vessel reference')r.id='';return r;
}
export function coreRecord(p:Record<string,unknown>):VesselRecord{
 const id=p.program_id??p.id;if((typeof id!=='string'&&typeof id!=='number')||!String(id).trim()||String(id).length>100||typeof id==='number'&&(!Number.isSafeInteger(id)||id<1))throw new RegisterError('Core returned a program without a valid canonical ID.',502);
 const value=(camel:string,snake:string)=>string(p[snake]??p[camel]);const shift=value('shift','start_shift').toUpperCase();
 const r:VesselRecord={id:String(id),motherVessel:value('motherVessel','mother_vessel'),lighterVessel:value('lighterVessel','lighter_vessel'),escortName:value('escortName','escort_name'),escortMobile:value('escortMobile','escort_mobile'),masterMobile:value('masterMobile','master_mobile'),destination:value('destination','destination'),startDate:date(p.start_date??p.startDate),endDate:date(p.end_date??p.endDate),shift:['D','N'].includes(shift)?shift:'',status:value('status','status')||'Unknown',notes:string(p.notes,2000),source:'Fazle Core · canonical programs',sourceRef:value('sourceRef','source_message_id')||String(id),duplicateOf:null,endShift:value('endShift','end_shift'),releasePoint:value('releasePoint','release_point'),issues:[]};
 if(!value('status','status'))r.issues.push('Canonical program status is unavailable. No roster/payroll status was substituted.');return r;
}
export function connectionState(){const config=env as unknown as Record<string,string>;return {coreConfigured:!!(config.FAZLE_CORE_URL&&config.FAZLE_CORE_READ_KEY&&config.FAZLE_CORE_VESSEL_READ_VERIFIED==='true'),aiConfigured:!!(config.OPENAI_API_KEY&&(config.REGISTER_AI_MODEL||config.OPENAI_MODEL)),readOnly:true};}
function coreOrigin(base:string){let u:URL;try{u=new URL(base);}catch{throw new RegisterError('The configured Core HTTPS origin is invalid.');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.hostname==='localhost'||/^[\d.:]+$/.test(u.hostname)||u.hostname.endsWith('.local'))throw new RegisterError('Configure a trusted HTTPS origin for Core, without a path or credentials.');return u.origin;}
export async function liveSnapshot(fetcher:typeof fetch=fetch):Promise<Snapshot>{
 const config=env as unknown as Record<string,string>;if(!config.FAZLE_CORE_URL||!config.FAZLE_CORE_READ_KEY)throw new RegisterError('Live Core is not connected. The Site needs a verified HTTPS origin and a read-scoped credential. Historical records can still be opened.');
 if(config.FAZLE_CORE_VESSEL_READ_VERIFIED!=='true')throw new RegisterError('The canonical vessel endpoint and its read-scoped credential have not been verified. Live reads remain disabled.');
 const origin=coreOrigin(config.FAZLE_CORE_URL),rows:VesselRecord[]=[],ids=new Set<string>(),signal=AbortSignal.timeout(25000);let total=0,complete=true;
 try{for(let page=1;page<=10;page++){
  const url=new URL('/api/integration/v1/programs',origin);url.searchParams.set('page',String(page));url.searchParams.set('page_size','200');
  const result=await fetcher(url,{method:'GET',headers:{'X-Internal-Key':config.FAZLE_CORE_READ_KEY,'Accept':'application/json','Cache-Control':'no-store'},redirect:'manual',signal});
  if(!result.ok)throw new RegisterError([401,403].includes(result.status)?'Core denied the read credential. Keep a read-scoped key; do not substitute an administrator key.':'Core could not supply its vessel records.',502);
  if(Number(result.headers.get('content-length')??0)>3_000_000)throw new RegisterError('Core response exceeds the safe read limit.',502);
  const reader=result.body?.getReader();if(!reader)throw new RegisterError('Core returned an empty response.',502);const chunks:Uint8Array[]=[];let bytes=0;while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>3_000_000){await reader.cancel();throw new RegisterError('Core response exceeds the safe read limit.',502);}chunks.push(chunk.value);}const buffer=new Uint8Array(bytes);let offset=0;for(const c of chunks){buffer.set(c,offset);offset+=c.length;}const body=JSON.parse(new TextDecoder().decode(buffer));
  if(!body||!Array.isArray(body.items)||body.items.length>200||!Number.isSafeInteger(body.total)||body.total<0||body.page!==page||body.page_size!==200)throw new RegisterError('Core returned an incompatible roster response. No records were accepted.',502);
  if(page===1)total=body.total;else if(total!==body.total)throw new RegisterError('Core changed during paging. Refresh before interpreting counts.',502);
  for(const item of body.items){if(!item||typeof item!=='object'||Array.isArray(item))throw new RegisterError('Core returned an invalid record.',502);const r=coreRecord(item);if(ids.has(r.id))throw new RegisterError('Core returned overlapping pages. Refresh before interpreting counts.',502);ids.add(r.id);rows.push(r);}
  if(rows.length>total)throw new RegisterError('Core returned an inconsistent total.',502);if(rows.length===total)break;if(body.items.length<200)throw new RegisterError('Core returned incomplete pagination. No totals can be verified.',502);
 }}catch(e){if(e instanceof RegisterError)throw e;throw new RegisterError('Core could not be read. It may be unreachable or the request timed out. Try Refresh; existing records have not been changed.',502);}
 complete=complete&&rows.length===total;return {rows,source:'live',checkedAt:new Date().toISOString(),complete,availableTotal:total,sourceLabel:'Fazle Core · canonical program API',notice:complete?'Read from the verified canonical Core program API. A paginated read is not a transactional snapshot; records may change after this read.':'Partial Core read: the register exceeds the 2,000-row read limit. Summaries and answers cover only loaded records.'};
}
// One passive projection of the existing programs/source snapshots. No writes or employee creation.
const contextKey=(r:VesselRecord)=>[r.startDate,r.shift,...[r.motherVessel,r.lighterVessel].map(v=>v.normalize('NFC').toLowerCase().replace(/\bm\.?\s*v\.?\s*/g,'').replace(/[^\p{L}\p{M}\p{N}]/gu,''))];
function detailsOf(p:Record<string,unknown>):Record<string,unknown>{try{const d=typeof p.details==='string'?JSON.parse(p.details):p.details;return d&&typeof d==='object'&&!Array.isArray(d)?d:{};}catch{return {};}}
function scopeConflict(p:Record<string,unknown>){const d=detailsOf(p);return p.accountId!==undefined&&d.accountId!==undefined&&p.accountId!==d.accountId||p.chatJid!==undefined&&d.chatJid!==undefined&&p.chatJid!==d.chatJid;}
function sourceScope(p:Record<string,unknown>){const d=detailsOf(p);if(scopeConflict(p))return {accountId:null,chatJid:null};return {accountId:typeof (p.accountId??d.accountId)==='string'?String(p.accountId??d.accountId):null,chatJid:typeof (p.chatJid??d.chatJid)==='string'?String(p.chatJid??d.chatJid):null};}
function sameScope(a:RosterTrace,b:RosterTrace){return a.accountId===b.accountId&&a.chatJid===b.chatJid;}
function employeeOf(p:Record<string,unknown>){
 // Never fall back to master/client/sender/payout, or normalize a truncated number.
 if(p.sourceRoleEstablished===false||p.sourceRole!==undefined&&!['employee_id','ledger_employee_mobile','escort_mobile','escortMobile'].includes(String(p.sourceRole)))return null;
 const explicit=['employee_id','escort_mobile','escortMobile'].filter(k=>p[k]!=null&&p[k]!=='');
 const ids=explicit.map(k=>normalizeEmployeeMobile(p[k],k));
 if(!ids.length||ids.some(v=>!v)||new Set(ids).size!==1)return null;
 return ids[0] as string;
}
function traceOf(p:Record<string,unknown>,origin:RosterTrace['origin']):RosterTrace{
 const d=detailsOf(p),r=historicalRecord(p),scope=sourceScope(p);
 return {id:r.id,origin,sourceRef:r.sourceRef,sourceLine:string(d.sourceLine,500),sourceHash:sha(canonical(p)),rawName:typeof p.escortName==='string'?p.escortName:'',rawMobile:p.employee_id??p.escort_mobile??p.escortMobile??null,employeeId:employeeOf(p),...scope,originalStatus:r.status,revision:Number.isSafeInteger(p.revision)&&Number(p.revision)>=0?Number(p.revision):0,fields:Object.fromEntries(['motherVessel','lighterVessel','escortName','escortMobile','employee_id','escort_mobile','masterMobile','destination','startDate','endDate','shift','status','source','notes','details','accountId','chatJid','sourceRef','sourceReferences','sourceRole','sourceRoleEstablished'].filter(k=>p[k]!==undefined).map(k=>[k,structuredClone(p[k])])),reason:scopeConflict(p)?'CONFLICTING_SOURCE_SCOPE':'ORIGINAL_SOURCE'};
}
function scoped(p:Record<string,unknown>,options:RosterReadOptions){if(!options.scope)return true;const scope=sourceScope(p);return scope.accountId===options.scope.accountId&&!!scope.chatJid&&options.scope.chatJids.includes(scope.chatJid)&&(!options.scope.employeeIds||!!employeeOf(p)&&options.scope.employeeIds.includes(employeeOf(p)!));}
function projected(p:Record<string,unknown>,origin:RosterTrace['origin']):VesselRecord{
 const r=historicalRecord(p),t=traceOf(p,origin);r.employeeId=t.employeeId;
 r.employeeIdentity={employeeId:t.employeeId,state:t.employeeId?'MOBILE_RESOLVED':'UNRESOLVED',aliases:t.rawName?[{name:t.rawName,sourceRef:t.sourceRef,sourceHash:t.sourceHash}]:[],employmentVerified:false};
 r.roster={authority:'HISTORICAL_REFERENCE_ONLY',state:origin==='SOURCE'?'SOURCE_REVIEW':'STORED_REFERENCE',targetId:origin==='SOURCE'?null:r.id,candidateTargetIds:[],reviewRequired:origin==='SOURCE'||!t.employeeId,linkReasons:[],history:[t]};
 if(scopeConflict(p)){r.roster.state='UNRESOLVED_REFERENCE';r.roster.reviewRequired=true;r.roster.linkReasons.push('CONFLICTING_SOURCE_SCOPE');r.issues.push('Conflicting account/chat provenance; no source-to-target link inferred.');}
 if(!t.employeeId){r.issues.push('Employee mobile missing, invalid, conflicting or source role unavailable; identity unresolved.');r.roster.linkReasons.push('EMPLOYEE_ID_UNRESOLVED');}
 r.releaseConfirmed=false; // Historical flag/label is retained in trace, never operational release authority.
 if(origin==='SOURCE'){r.status='Review';}
 return r;
}
function appendTrace(target:VesselRecord,source:VesselRecord,reason:string,linked:boolean){
 if(target.roster!.history.length+source.roster!.history.length>256)throw new RegisterError('Roster history budget exceeded; no partial linkage accepted.');
 for(const h of source.roster!.history)if(!target.roster!.history.some(old=>old.sourceHash===h.sourceHash&&old.origin===h.origin))target.roster!.history.push({...h,reason});
 if(linked)target.aliases=[...new Set([...(target.aliases??[]),source.id,...(source.aliases??[])])];
 target.evidence=[...(target.evidence??[]),...(source.evidence??[]),{id:source.id,source:source.source,sourceRef:source.sourceRef,sourceLine:source.roster!.history[0].sourceLine,reason}].filter((e,i,a)=>a.findIndex(v=>canonical(v)===canonical(e))===i);
 target.roster!.linkReasons=[...new Set([...target.roster!.linkReasons,reason])];
 if(source.employeeId&&source.employeeId===target.employeeId)for(const alias of source.employeeIdentity!.aliases)if(!target.employeeIdentity!.aliases.some(a=>canonical(a)===canonical(alias)))target.employeeIdentity!.aliases.push(alias);
 for(const field of ['motherVessel','lighterVessel','escortMobile','masterMobile','destination','startDate','endDate','shift','status'] as const){
  const incoming=source.roster!.history[0].fields[field],existing=target.roster!.history.find(h=>h.origin!=='SOURCE')?.fields[field];
  const equivalent=field==='escortMobile'?!!target.employeeId&&target.employeeId===source.employeeId:field==='status'?true:canonical(existing??'')===canonical(incoming??'');
  if(existing&&incoming&&!equivalent){target.conflicts=[...(target.conflicts??[]),{field,existing:String(existing),incoming:String(incoming),sourceRow:source.id}];target.roster!.reviewRequired=true;target.issues.push('Source '+field+' differs; stored anchor and original evidence retained.');}
 }
 if(source.conflicts?.length){target.conflicts=[...(target.conflicts??[]),...source.conflicts];target.roster!.reviewRequired=true;}
}
export function buildHistoricalRoster(stored:readonly Record<string,unknown>[],imported:readonly Record<string,unknown>[],options:RosterReadOptions={},storedOrigin:'STORED'|'SEED'='STORED'):VesselRecord[]{
 if(stored.length+imported.length>5000||Buffer.byteLength(canonical([stored,imported]))>32*1024*1024)throw new RegisterError('Roster read exceeds the bounded qualification budget.');
 if(options.scope&&(!/^wa-0[12]$/.test(options.scope.accountId)||!options.scope.chatJids.length||options.scope.chatJids.length>64))throw new RegisterError('An explicit account/chat read scope is required.',403);
 let traceBytes=0,edges=0;const outputLimit=8*1024*1024;
 const anchors=new Map<string,VesselRecord>(),sources=new Map<string,VesselRecord>();
 const collect=(input:readonly Record<string,unknown>[],origin:RosterTrace['origin'],map:Map<string,VesselRecord>)=>{
  for(const p of [...input].filter(p=>scoped(p,options)).sort((a,b)=>Number(a.revision??0)-Number(b.revision??0)||sha(canonical(a)).localeCompare(sha(canonical(b))))){
   if(typeof p.id!=='string'||!p.id.trim()||p.id.length>128)throw new RegisterError('Roster source identity missing or exceeds the safe limit.');
   const r=projected(p,origin);if(!r.id)continue;const t=r.roster!.history[0];const size=Buffer.byteLength(canonical(t));if(size>64000)throw new RegisterError('Roster evidence budget exceeded; original sources unchanged.');const key=canonical([t.accountId,t.chatJid,r.id]),old=map.get(key);
   if(old?.roster!.history.some(h=>h.sourceHash===t.sourceHash))continue;
   if((traceBytes+=size)>outputLimit)throw new RegisterError('Roster evidence budget exceeded; original sources unchanged.');
   if(!old){map.set(key,r);continue;}
   const equalRevision=old.roster!.history.at(-1)!.revision===t.revision;
   r.roster!.history=[...old.roster!.history,t];r.roster!.reviewRequired=true;r.roster!.state='CONFLICT_REVIEW';r.roster!.linkReasons.push(equalRevision?'CONFLICTING_SOURCE_REPLAY':'SOURCE_CORRECTION_HISTORY');r.issues.push('Multiple versions retained; no assignment or release inferred.');map.set(key,r);
  }
 };
 collect(stored,storedOrigin,anchors);collect(imported,'SOURCE',sources);
 const candidateMap=new Map<string,{targets:VesselRecord[];reason:string}>();
 for(const [key,source] of sources){
  const st=source.roster!.history.at(-1)!;const inScope=[...anchors.values()].filter(a=>st.reason!=='CONFLICTING_SOURCE_SCOPE'&&a.roster!.history.at(-1)!.reason!=='CONFLICTING_SOURCE_SCOPE'&&sameScope(a.roster!.history.at(-1)!,st));
  const declared=(options.links??[]).filter(l=>l.sourceId===source.id);
  const proofs=declared.filter(l=>l.sourceHash===st.sourceHash);
  const verified=proofs.filter(l=>l.decision==='APPROVED'&&l.approver&&/^\d{4}-\d{2}-\d{2}$/.test(l.approvedOn)&&validDate(l.approvedOn)&&/^[a-f0-9]{64}$/.test(l.evidenceSha)&&options.verifyLink?.(l)===true);
  const exact=inScope.filter(a=>a.id===source.id||source.aliases?.includes(a.id)||a.aliases?.includes(source.id));
  let targets=declared.length&&!verified.length?[]:verified.length===1?inScope.filter(a=>a.id===verified[0].targetId&&a.roster!.history.at(-1)!.sourceHash===verified[0].targetHash):verified.length>1?inScope.filter(a=>verified.some(l=>l.targetId===a.id)):exact;
  if(verified.length===1&&verified[0].kind==='EMPLOYEE_IDENTITY'&&targets.length===1&&source.employeeId&&targets[0].employeeId){source.employeeId=targets[0].employeeId;source.employeeIdentity!.employeeId=targets[0].employeeId;source.roster!.linkReasons.push('INDEPENDENTLY_VERIFIED_EMPLOYEE_LINK');}
  let reason=verified.length===1&&verified[0].kind==='EMPLOYEE_IDENTITY'?'VERIFIED_EMPLOYEE_IDENTITY_LINK':verified.length?'VERIFIED_REFERENCE_LINK':exact.length?'EXPLICIT_SOURCE_REFERENCE':'MOBILE_PROGRAM_CONTEXT';
  if(!targets.length&&!declared.length)targets=inScope.filter(a=>!!a.employeeId&&a.employeeId===source.employeeId&&contextKey(a).every((v,i)=>!!v&&v===contextKey(source)[i]));
  if(declared.length&&!targets.length){reason='LINK_TARGET_OR_PROOF_UNVERIFIED';source.roster!.state='UNRESOLVED_REFERENCE';source.roster!.linkReasons.push(reason);}
  if(!targets.length&&!source.employeeId&&!declared.length){targets=inScope.filter(a=>contextKey(a).every((v,i)=>!!v&&v===contextKey(source)[i]));reason='MISSING_MOBILE_CONTEXT_REVIEW';}
  edges+=targets.length;if(targets.length>50||edges>10000)throw new RegisterError('Roster match fanout exceeds the safe review budget; narrow the source scope.');
  candidateMap.set(key,{targets,reason});
 }
 // Decide the entire graph before linking; input order cannot silently disambiguate.
 const incoming=new Map<VesselRecord,number>();for(const c of candidateMap.values())for(const a of c.targets)incoming.set(a,(incoming.get(a)??0)+1);
 const unmatched:VesselRecord[]=[];
 for(const [key,source] of sources){const {targets,reason}=candidateMap.get(key)!;source.roster!.candidateTargetIds=targets.map(a=>a.id).sort();
  if(!targets.length){if(source.roster!.state!=='UNRESOLVED_REFERENCE'&&(source.aliases??[]).some(id=>id!==source.id)){source.roster!.state='UNRESOLVED_REFERENCE';source.roster!.linkReasons.push('SOURCE_TARGET_NOT_FOUND');}unmatched.push(source);continue;}
  const identityConflict=targets.some(a=>a.employeeId&&source.employeeId&&a.employeeId!==source.employeeId);
  const ambiguous=targets.length!==1||!reason.startsWith('VERIFIED_')&&targets.some(a=>incoming.get(a)!>1)||reason==='MISSING_MOBILE_CONTEXT_REVIEW';
  for(const anchor of targets){
   if((traceBytes+=Buffer.byteLength(canonical(source.roster!.history)))>outputLimit)throw new RegisterError('Roster output budget exceeded; no partial result accepted.');
   const safe=!ambiguous&&!identityConflict&&source.roster!.state!=='CONFLICT_REVIEW';
   appendTrace(anchor,source,safe?reason:identityConflict?'EMPLOYEE_MOBILE_CONFLICT':ambiguous?'AMBIGUOUS_SOURCE_TARGET_REVIEW':'CONFLICTING_SOURCE_REPLAY',safe);
   if(!safe){anchor.roster!.state=identityConflict?'CONFLICT_REVIEW':'AMBIGUOUS_REVIEW';anchor.roster!.reviewRequired=true;anchor.roster!.candidateTargetIds=[...new Set([...anchor.roster!.candidateTargetIds,...targets.map(t=>t.id)])].sort();anchor.issues.push('Source linkage requires review; stored ID/status retained and no additional assignment created.');if(identityConflict)anchor.employeeIdentity!.state='CONFLICT';}
   if(!source.employeeId)anchor.roster!.reviewRequired=true;
  }
 }
 const rows=[...anchors.values(),...unmatched].sort((a,b)=>b.startDate.localeCompare(a.startDate)||a.id.localeCompare(b.id)||canonical(a.roster).localeCompare(canonical(b.roster)));
 // Across distinct programs, same-mobile names remain aliases without merging programs.
 const aliases=new Map<string,NonNullable<VesselRecord['employeeIdentity']>['aliases']>();
 for(const r of rows)if(r.employeeId){const values=aliases.get(r.employeeId)??[];for(const h of r.roster!.history)if((h.employeeId===r.employeeId||h.reason==='VERIFIED_EMPLOYEE_IDENTITY_LINK')&&h.rawName){const v={name:h.rawName,sourceRef:h.sourceRef,sourceHash:h.sourceHash};if(!values.some(a=>a.name===v.name))values.push(v);}aliases.set(r.employeeId,values);}
 for(const [id,values] of aliases)if(Buffer.byteLength(canonical(values))*rows.filter(r=>r.employeeId===id).length>outputLimit)throw new RegisterError('Roster alias output budget exceeded; narrow the source scope.');
 for(const r of rows){if(r.employeeId)r.employeeIdentity!.aliases=structuredClone(aliases.get(r.employeeId)!);r.conflicts=(r.conflicts??[]).filter((c,i,a)=>a.findIndex(v=>canonical(v)===canonical(c))===i);r.issues=[...new Set(r.issues)];}
 if(Buffer.byteLength(canonical(rows))>outputLimit)throw new RegisterError('Roster output budget exceeded; no partial result accepted.');
 return rows;
}
// Current and Archive are separated by dataset provenance, never by message date.
const VESSEL_CURRENT_EPOCH='CANONICAL_BACKFILL_20261026',VESSEL_ARCHIVE_EPOCH='LEGACY_PRE_TRANSITION_20261026';
export async function historicalSnapshot(options:RosterReadOptions={},scope:'CURRENT'|'ARCHIVE'='CURRENT'):Promise<Snapshot>{
 try{
 const epoch=scope==='ARCHIVE'?VESSEL_ARCHIVE_EPOCH:VESSEL_CURRENT_EPOCH;
 const [result,imported,pay]=await Promise.all([
  database().all('SELECT * FROM programs WHERE dataset_epoch=$1 ORDER BY "startDate" DESC, id',[epoch]),
  importedPrograms(scope),
  // Derived pay for the same epoch. Read-only join: program_pay is computed from
  // escort_rate_config by recalculate_program_pay(); nothing here writes it.
  database().all('SELECT pp.program_id,pp.state,pp.reasons,pp.half_day_units,pp.salary_minor::text AS salary_minor,pp.conveyance_minor::text AS conveyance_minor,pp.total_minor::text AS total_minor FROM public.program_pay pp JOIN public.programs p ON p.id=pp.program_id WHERE p.dataset_epoch=$1',[epoch]),
 ]);
 const stored=(result.results.length?result.results:(scope==='CURRENT'?[]:seed)) as unknown as Record<string,unknown>[];
 const rows=buildHistoricalRoster(stored,imported as unknown as Record<string,unknown>[],options,result.results.length?'STORED':'SEED');
 // Attach pay to the derived rows. Amounts stay as exact integer minor-unit
 // strings so no float rounding happens between the database and the formatter.
 type PayRow={program_id:string;state:string;reasons:unknown;half_day_units:number|null;salary_minor:string|null;conveyance_minor:string|null;total_minor:string|null};
 const payById=new Map<string,PayRow>((pay.results as unknown as PayRow[]).map(r=>[String(r.program_id),r]));
 for(const row of rows){
  const p=payById.get(row.id);if(!p)continue;
  row.payState=p.state==='CALCULATED'?'CALCULATED':'UNRESOLVED';
  row.payReason=Array.isArray(p.reasons)&&p.reasons.length?String(p.reasons[0]):null;
  row.halfDayUnits=p.half_day_units===null?null:Number(p.half_day_units);
  row.salaryMinor=p.salary_minor;row.conveyanceMinor=p.conveyance_minor;row.totalMinor=p.total_minor;
 }
 return {rows,source:scope==='ARCHIVE'?'archive':'historical',checkedAt:new Date().toISOString(),complete:true,availableTotal:rows.length,sourceLabel:scope==='ARCHIVE'?'Archive · pre-transition vessel records (read-only)':'Canonical WA-01 backfill · '+importSummary.updatedAt,notice:scope==='ARCHIVE'?'Archive view: pre-transition vessel records preserved by provenance. Archive records are never counted in Current totals and are read-only.':'Current view: canonical vessel records only. Pre-transition records are held in Archive Records for Vessel. Stored IDs/status retained; ambiguous evidence remains Review.'};
 }catch(error){if(error instanceof RegisterError)throw error;throw new RegisterError('The updated register could not be loaded. Retry; original records are preserved.');}
}
export async function loadSnapshot(source:string){if(source==='live')return liveSnapshot();if(source==='historical')return historicalSnapshot();if(source==='archive')return historicalSnapshot({},'ARCHIVE');throw new RegisterError('Choose Historical, Archive or Live Core.',400);}
export function enrichRecord(r:VesselRecord){return {...r,issues:[...r.issues,...missingFields(r).map(k=>`${k} is not available`)]};}
