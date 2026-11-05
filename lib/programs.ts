export type Program = {
  id:string; motherVessel:string; lighterVessel:string; masterMobile:string; destination:string;
  escortName:string; escortMobile:string; startDate:string; endDate:string; shift:string;
  details?:Record<string,string|string[]>; status:string; source:string; notes:string; duplicateOf:string|null; createdAt:string; revision:number;
};
export type Review={id:string;aId:string;bId:string;decision:string;note:string;createdAt:string};
export type State={programs:Program[];reviews:Review[]};
export const detailKeys=["recordKind","sourceMessageId","sourceMessageDate","sourceLine","sender","issues","loadingPoint","releasePoint","releaseDate","location","masterName","owner","flag","vesselType","vesselState","alongside","loadCommence","loadCompleted"];
export const fields=["motherVessel","lighterVessel","masterMobile","destination","escortName","escortMobile","startDate","endDate","shift","status","source","notes"] as const;
export const labels:Record<typeof fields[number],string>={motherVessel:"Mother Vessel",lighterVessel:"Lighter Vessel",masterMobile:"Master Mobile",destination:"Destination",escortName:"Escort Name",escortMobile:"Escort Mobile",startDate:"Start Date",endDate:"End Date",shift:"Shift",status:"Status",source:"Source",notes:"Notes"};
export function blankProgram():Program{return {id:"",motherVessel:"",lighterVessel:"",masterMobile:"",destination:"",escortName:"",escortMobile:"",startDate:"",endDate:"",shift:"",status:"Recorded",source:"Manual entry",notes:"",duplicateOf:null,createdAt:"",revision:0,details:{}};}
export const digits=(s:string)=>s.replace(/[০-৯]/g,c=>String("০১২৩৪৫৬৭৮৯".indexOf(c)));
export const norm=(s:string)=>digits(s).toLowerCase().replace(/\bm\.?\s*v\.?\s*/g,"").replace(/[^\p{L}\p{N}]/gu,"");
export function parseDate(value:string):{date:string;shift:string}{
 let s=digits(value).trim();let shift="";const suffix=s.match(/\s*\(\s*(D|N|Day|Night)\s*\)\s*$/);
 if(suffix){shift=suffix[1][0].toUpperCase();s=s.slice(0,suffix.index).trim();}
 if(!s || ["—","-"].includes(s))return {date:"",shift};
 let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);let y:number,mo:number,d:number;
 if(m){y=+m[1];mo=+m[2];d=+m[3];}else{m=s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/);if(!m)throw new Error(`Invalid date “${value}”. Use DD.MM.YYYY or YYYY-MM-DD.`);d=+m[1];mo=+m[2];y=+m[3];if(y<100)y+=2000;}
 const dt=new Date(Date.UTC(y,mo-1,d));if(y<1900 || y>2200 || dt.getUTCFullYear()!==y || dt.getUTCMonth()!==mo-1 || dt.getUTCDate()!==d)throw new Error(`Invalid calendar date “${value}”.`);
 return {date:`${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`,shift};
}
export const displayDate=(s:string)=>s?s.split("-").reverse().join("."):"Not available";
export function validateProgram(input:unknown):Program{
 if(!input || typeof input!=="object")throw new Error("A program row is required.");
 const v=input as Record<string,unknown>,p=blankProgram();
 for(const f of fields){if(v[f]!==undefined && typeof v[f]!=="string")throw new Error(`${labels[f]} must be text.`);p[f]=String(v[f]??p[f]).trim();if(p[f].length>(f==="notes"?2000:200))throw new Error(`${labels[f]} is too long.`);if(["—","-"].includes(p[f]))p[f]="";}
 if(!p.motherVessel && !p.lighterVessel && !p.escortName)throw new Error("Enter at least a mother vessel, lighter vessel, or escort name.");
 const date=parseDate(p.startDate);p.startDate=date.date;p.endDate=parseDate(p.endDate).date;
 p.shift=digits(p.shift).toUpperCase().replace(/^(DAY|দিন)$/,"D").replace(/^(NIGHT|রাত)$/,"N");
 if(date.shift && p.shift && date.shift!==p.shift)throw new Error("Shift conflicts with Start Date.");p.shift=p.shift||date.shift;
 if(!["","D","N"].includes(p.shift))throw new Error("Shift must be D, N, or blank.");
 if(p.endDate && p.startDate && p.endDate<p.startDate)throw new Error("End Date cannot be before Start Date.");
 for(const f of ["masterMobile","escortMobile"] as const){p[f]=digits(p[f]);if(p[f] && !/^\+?[\d\s()\-]{7,25}$/.test(p[f]))throw new Error(`${labels[f]} must be a phone number or blank.`);}
 p.status ||= "Recorded";
 p.status=({recorded:"Recorded",active:"Active",completed:"Completed",cancelled:"Cancelled",canceled:"Cancelled",released:"Released","escort change":"Escort change"} as Record<string,string>)[p.status.toLowerCase()]??"";
 if(!p.status)throw new Error("Unknown program status. Use Recorded, Active, Completed, Cancelled, Released, or Escort change.");p.source||="Manual entry";
 if(v.id!==undefined && v.id!==""){if(typeof v.id!=="string" || !/^[A-Za-z0-9_-]{1,100}$/.test(v.id))throw new Error("Invalid row ID.");p.id=v.id;}
 if(v.revision!==undefined){if(!Number.isInteger(v.revision) || Number(v.revision)<0)throw new Error("Invalid revision.");p.revision=Number(v.revision);}
 if(v.details){if(typeof v.details!=="object"||Array.isArray(v.details))throw new Error("Invalid vessel details.");for(const [k,val] of Object.entries(v.details)){if(!detailKeys.includes(k))continue;if(k==="issues"){if(Array.isArray(val))p.details![k]=val.filter(x=>typeof x==="string"&&x.length<=500).slice(0,30);continue;}if(typeof val!=="string"||val.length>500)throw new Error("Invalid vessel detail: "+k);p.details![k]=val.trim();}}return p;
}
export const missingFields=(p:Program)=>["motherVessel","lighterVessel","escortName","destination","startDate","shift"].filter(f=>!p[f as keyof Program]).map(f=>labels[f as keyof typeof labels]);
export const pairId=(a:string,b:string)=>[a,b].sort().join("~");
export type Candidate={id:string;a:Program;b:Program;reason:string;level:"Exact"|"Likely"|"Possible";review?:Review};
const phone=(s:string)=>digits(s).replace(/\D/g,"").replace(/^880/,"0");
function similar(a:string,b:string){const x=norm(a),y=norm(b);if(!x||!y)return false;if(x===y)return true;if(x.length<6||y.length<6||Math.abs(x.length-y.length)>1)return false;
 // A single insertion, deletion or substitution catches small spelling errors in linear time.
 let i=0,j=0,edits=0;while(i<x.length&&j<y.length){if(x[i]===y[j]){i++;j++;continue;}if(++edits>1)return false;if(x.length>=y.length)i++;if(y.length>=x.length)j++;}return edits+(x.length-i)+(y.length-j)<=1;
}
export function candidates(rows:Program[],reviews:Review[]=[]):Candidate[]{
 const result:Candidate[]=[],reviewed=new Map(reviews.map(r=>[r.id,r]));
 // Compare source programs only; missing dates require compatible source dates.
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  const a=rows[i],b=rows[j];
  if(a.details?.recordKind==="Vessel reference"||b.details?.recordKind==="Vessel reference")continue;
  if((!a.startDate||!b.startDate)&&a.details?.sourceMessageDate&&b.details?.sourceMessageDate&&a.details.sourceMessageDate!==b.details.sourceMessageDate)continue;
  let reason="",level:Candidate["level"]="Possible";
  if(a.startDate && b.startDate && a.startDate!==b.startDate)continue;if(a.shift && b.shift && a.shift!==b.shift)continue;
  if(!similar(a.lighterVessel,b.lighterVessel))continue;
  const exact=fields.filter(f=>!["source","notes"].includes(f)).every(f=>norm(a[f])===norm(b[f]));
  if(exact && a.startDate && a.shift){reason="Same vessel, escort, date, shift and details";level="Exact";}
  else if(a.startDate && a.startDate===b.startDate && a.shift && a.shift===b.shift){reason=norm(a.escortName)!==norm(b.escortName) && a.escortName && b.escortName?"Same voyage; different escort — check for an escort change":"Same lighter vessel, date and shift; spelling or missing details";level="Likely";}
  else if((a.escortName && similar(a.escortName,b.escortName)) || (a.escortMobile && phone(a.escortMobile)===phone(b.escortMobile)) || (a.motherVessel && norm(a.motherVessel)===norm(b.motherVessel)))reason="Matching vessel and related details; date or shift is missing";
  if(reason){const id=pairId(a.id,b.id);result.push({id,a,b,reason,level,review:reviewed.get(id)});}
 }return result;
}
export type Filters={search:string;motherVessel:string;lighterVessel:string;escortName:string;destination:string;status:string;owner:string;flag:string;vesselType:string;vesselState:string;location:string;from:string;to:string;shift:string;count:string};
export const emptyFilters:Filters={search:"",motherVessel:"",lighterVessel:"",escortName:"",destination:"",status:"",owner:"",flag:"",vesselType:"",vesselState:"",location:"",from:"",to:"",shift:"",count:""};
export function filterPrograms(rows:Program[],f:Filters){return rows.filter(p=>{
 if(f.search && ![...fields.map(k=>p[k]),p.id].some(s=>norm(s).includes(norm(f.search))))return false;
 for(const k of ["motherVessel","lighterVessel","escortName","destination"] as const)if(f[k] && !norm(p[k]).includes(norm(f[k])))return false;
 for(const k of ["owner","flag","vesselType","vesselState","location"] as const)if(f[k]&&(f[k]==="missing"?!!p.details?.[k]:!norm(String(p.details?.[k]??(k==="location"?p.destination:""))).includes(norm(f[k]))))return false;
 if(f.status&&p.status!==f.status)return false;
 if(f.from && (!p.startDate||p.startDate<f.from))return false;if(f.to && (!p.startDate||p.startDate>f.to))return false;
 if(f.shift && (f.shift==="missing"?!!p.shift:p.shift!==f.shift))return false;
 if(f.count&&p.details?.recordKind==="Vessel reference")return false;
 if(f.count==="included" && p.duplicateOf)return false;if(f.count==="repeats" && !p.duplicateOf)return false;return true;
});}
export function totals(input:Program[]){const rows=input.filter(p=>p.details?.recordKind!=="Vessel reference");return {raw:rows.length,repeats:rows.filter(p=>p.duplicateOf).length,counted:rows.filter(p=>!p.duplicateOf).length,incomplete:rows.filter(p=>missingFields(p).length).length,day:rows.filter(p=>!p.duplicateOf&&p.shift==="D").length,night:rows.filter(p=>!p.duplicateOf&&p.shift==="N").length,unknown:rows.filter(p=>!p.duplicateOf&&!p.shift).length,cancelled:rows.filter(p=>!p.duplicateOf&&p.status==="Cancelled").length};}
const headerKey=(s:string)=>s.replace(/^\uFEFF/,"").toLowerCase().replace(/[^a-z]/g,"");
const aliases:Record<string,typeof fields[number]>={mothervessel:"motherVessel",mother:"motherVessel",lightervessel:"lighterVessel",lighter:"lighterVessel",mastermobile:"masterMobile",masterphone:"masterMobile",destination:"destination",escortname:"escortName",escort:"escortName",escortmobile:"escortMobile",escortphone:"escortMobile",startdate:"startDate",date:"startDate",dateshift:"startDate",enddate:"endDate",shift:"shift",status:"status",source:"source",notes:"notes",note:"notes"};
export function csvRows(text:string):string[][]{
 text=text.replace(/^\uFEFF/,"");
 const out:string[][]=[];const delimiter=text.split(/\r?\n/)[0].includes(",")?",":"\t";let row:string[]=[],cell="",quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(!quoted&&cell.length)throw new Error("Unexpected quote in CSV. Quote the whole cell.");else quoted=!quoted;}
  else if(!quoted&&c===delimiter){row.push(cell);cell="";}
  else if(!quoted&&(c==="\n"||c==="\r")){if(c==="\r"&&text[i+1]==="\n")i++;row.push(cell);if(row.some(s=>s.trim()))out.push(row);row=[];cell="";}else cell+=c;
 }if(quoted)throw new Error("CSV has an unclosed quote.");row.push(cell);if(row.some(s=>s.trim()))out.push(row);return out;
}
export type ImportResult={rows:Program[];errors:string[];warnings:string[]};
export function parseImport(text:string,source:string):ImportResult{
 if(text.length>2_000_000)throw new Error("Use an import under 2 MB.");const rows:Program[]=[],errors:string[]=[],warnings:string[]=[];
 const accept=(v:Record<string,string>,line:number,details:Record<string,string>={})=>{try{rows.push(validateProgram({...v,source:v.source||source,details}));}catch(e){errors.push(`Row ${line}: ${(e as Error).message}`);}};
 if(/^\s*Mother\s*Vessel\s*:/im.test(text)){
  const blocks=text.split(/(?=^\s*Mother\s*Vessel\s*:)/im).filter(s=>/^\s*Mother\s*Vessel\s*:/i.test(s));
  blocks.forEach((block,i)=>{const v:Record<string,string>={},extra:string[]=[];for(const line of block.split(/\r?\n/)){const m=line.match(/^\s*([^:]+):\s*(.*)$/),key=m?aliases[headerKey(m[1])]:undefined;if(m&&key)v[key]=m[2].trim();else if(line.trim()&&!/^\s*(?:cargo booking|capacity|client|importer|registration(?: number| no)?|slip(?: number| no)?)\s*:/i.test(line))extra.push(line.trim());}if(extra.length)v.notes=[v.notes??"",...extra].filter(Boolean).join("\n");accept(v,i+1);});
 }else{
  const raw=csvRows(text);if(raw.length<2)throw new Error("Add CSV headers and at least one row, or paste Mother Vessel message blocks.");
  const detailAliases:Record<string,string>={recordkind:"recordKind",sourcemessage:"sourceMessageId",sourcedate:"sourceMessageDate",owner:"owner",flag:"flag",vesseltype:"vesselType",vesselstatus:"vesselState",location:"location",mastername:"masterName",loadingpoint:"loadingPoint",releasepoint:"releasePoint",releasedate:"releaseDate"};
  const detailHeaders=raw[0].map(h=>detailAliases[headerKey(h)]);
  const headers=raw[0].map(h=>aliases[headerKey(h)]);if(!headers.some(h=>["motherVessel","lighterVessel","escortName"].includes(h)))throw new Error("No recognized headers. Use Mother Vessel, Lighter Vessel and Escort Name.");
  const recognized=[...headers.filter(Boolean),...detailHeaders.filter(Boolean)];if(new Set(recognized).size!==recognized.length)throw new Error("Two CSV headers map to the same field.");
  const excluded=/^(cargobooking|booking|capacity|client|importer|registration|registrationnumber|registrationno|slip|slipnumber|slipno)$/;
  const dropped=raw[0].filter(h=>excluded.test(headerKey(h)));if(dropped.length)warnings.push(`Excluded columns: ${dropped.join(", ")}.`);
  const unknown=raw[0].filter((_,i)=>!headers[i]&&!detailHeaders[i]&&!excluded.test(headerKey(raw[0][i]))&&!['id','duplicateof','counted'].includes(headerKey(raw[0][i])));if(unknown.length)warnings.push(`Unrecognized columns retained in Notes: ${unknown.join(", ")}.`);
  raw.slice(1).forEach((cells,i)=>{if(cells.length!==raw[0].length){errors.push(`Row ${i+2}: ${cells.length} cells; expected ${raw[0].length}.`);return;}const v:Record<string,string>={},details:Record<string,string>={},extra:string[]=[];headers.forEach((key,j)=>{if(key)v[key]=cells[j].replace(/^\x27(?=[=+@-])/,"");else if(detailHeaders[j])details[detailHeaders[j]]=cells[j].replace(/^\x27(?=[=+@-])/,"");else if(unknown.includes(raw[0][j])&&cells[j])extra.push(`${raw[0][j]}: ${cells[j]}`);});if(extra.length)v.notes=[v.notes??"",...extra].filter(Boolean).join("\n");accept(v,i+2,details);});
 }
 if(rows.length>1000)throw new Error("Import at most 1,000 rows at a time.");if(!rows.length&&!errors.length)throw new Error("No program rows found.");return {rows,errors,warnings};
}
export function exportCsv(rows:Program[]){const esc=(s:string)=>`"${(/^[=+@\-]/.test(s)?"'":"")+s.replace(/"/g,'""')}"`;return "\uFEFF"+[["ID",...fields.map(f=>labels[f]),"Record kind","Source message","Source date",...Object.keys({owner:1,flag:1,vesselType:1,vesselStatus:1,location:1,masterName:1,loadingPoint:1,releasePoint:1,releaseDate:1}),"Duplicate Of","Counted"],...rows.map(p=>[p.id,...fields.map(f=>p[f]),String(p.details?.recordKind??"Escort program"),String(p.details?.sourceMessageId??""),String(p.details?.sourceMessageDate??""),...["owner","flag","vesselType","vesselState","location","masterName","loadingPoint","releasePoint","releaseDate"].map(k=>String(p.details?.[k]??"")),p.duplicateOf??"",p.details?.recordKind==="Vessel reference"?"Not a program":p.duplicateOf?"No":"Yes"])].map(r=>r.map(esc).join(",")).join("\r\n");}
