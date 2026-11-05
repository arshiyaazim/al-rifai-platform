import { norm,missingFields,type Program,type State } from "./programs.ts";
export type SourceMessage={id:string;source:string;messageDate:string;time:string;sender:string;body:string;line:number;category:string;mediaNames:string[]};
export type ReleaseEntry={id:string;kind:string;employeeId:string;name:string;paymentNumber:string;method:string;amount:number|null;location:string;vessel:string;date:string;sourceMessageId:string;source:string;issues:string[];description:string};
export type SourceSummary={manualMaritimeMessageIds?:string[];totalMessages:number;programRows:number;recordKinds:Record<string,number>;releaseEntries:number;entryKinds:Record<string,number>;sourceCategories:Record<string,number>;programIssues:Record<string,number>;fieldCoverage:Record<string,number>;files:{file:string;messages:number;first:string;last:string;mediaReferences:number;deleted:number}[]};
export type RegisterState=State & {summary?:SourceSummary;entries?:ReleaseEntry[]};
export const isProgram=(p:Program)=>p.details?.recordKind!=="Vessel reference";
export const extraLabels:Record<string,string>={owner:"Owner / মালিক",flag:"Flag / পতাকা",vesselType:"Vessel type / ধরন",vesselState:"Vessel status / জাহাজের অবস্থা",location:"Location / অবস্থান",masterName:"Master name",loadingPoint:"Loading point",releasePoint:"Release point",releaseDate:"Release date"};
export type Vessel={key:string;name:string;aliases:string[];roles:string[];rows:Program[];owners:string[];flags:string[];types:string[];states:string[];locations:string[]};
export function vesselDirectory(rows:Program[]):Vessel[]{
 const result=new Map<string,Vessel>();
 for(const p of rows)for(const field of ["motherVessel","lighterVessel"] as const){
  const name=p[field],key=norm(name);if(!key)continue;
  const vessel=result.get(key)??{key,name,aliases:[],roles:[],rows:[],owners:[],flags:[],types:[],states:[],locations:[]};
  if(!vessel.aliases.includes(name))vessel.aliases.push(name);
  const role=field==="motherVessel"?"Mother":"Lighter";if(!vessel.roles.includes(role))vessel.roles.push(role);
  if(!vessel.rows.some(r=>r.id===p.id))vessel.rows.push(p);
  // Row-level master/location/metadata refer to the lighter vessel only.
  if(field==="lighterVessel")for(const [target,key] of [["owners","owner"],["flags","flag"],["types","vesselType"],["states","vesselState"],["locations","location"]] as const){const value=String(p.details?.[key]??"");if(value&&!vessel[target].includes(value))vessel[target].push(value);}
  result.set(key,vessel);
 }
 return [...result.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
export function qualityIssues(p:Program){
 const issues=Array.isArray(p.details?.issues)?[...p.details.issues]:[];
 if(isProgram(p))issues.push(...missingFields(p).map(f=>f+" not available"));
 for(const field of ["masterMobile","escortMobile"] as const)if(p[field]&&!/^01[3-9]\d{8}$/.test(p[field].replace(/\D/g,"").replace(/^880/,"0"))&&!issues.some(i=>i.includes(field)))issues.push(field+" needs verification");
 return issues;
}
export function csv(headers:string[],rows:(string|number|null)[][]){const escape=(value:string|number|null)=>{let s=String(value??"");if(/^[\s\u0000-\u001f]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return '\uFEFF'+[headers,...rows].map(row=>row.map(escape).join(',')).join('\r\n');}
export function saveCsv(contents:string,name:string){const url=URL.createObjectURL(new Blob([contents],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export const historicalRows=(rows:Program[],from="2026-08-01",to="2026-08-31")=>rows.filter(p=>isProgram(p)&&p.startDate>=from&&p.startDate<=to);
