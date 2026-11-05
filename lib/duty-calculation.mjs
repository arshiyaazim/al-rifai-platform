import {validDate} from './employee-program-validation.mjs';
// Existing settlement policy accepts half-day units. No effective salary/rate is
// inferred from a confirmation, payment history or the legacy 150 BDT food field.
export function calculateSourceDuty({assignment,attendance=[],rates=[],policy=null,conveyanceMinor=null}){
 const reasons=[];
 const money=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v)&&BigInt(v)<=9007199254740991n;
 if(!assignment?.employeeMobile||!validDate(assignment.actualStart)||!validDate(assignment.releaseDate)||assignment.releaseDate<assignment.actualStart)reasons.push('DOCUMENTED_START_RELEASE_REQUIRED');
 if(policy?.verified!==true||!policy.version||policy.unit!=='HALF_DAY'||policy.rounding!=='EXACT_MINOR')reasons.push('VERIFIED_UNIT_ROUNDING_POLICY_REQUIRED');
 const shifts=new Map();
 for(const a of attendance){if(a?.verified!==true||!a.sourceRef||a.employeeMobile!==assignment?.employeeMobile||!validDate(a.date)||!['D','N'].includes(a.shift)||a.date<assignment.actualStart||a.date>assignment.releaseDate){reasons.push('ATTENDANCE_EVIDENCE_INVALID');continue;}const k=a.date+':'+a.shift;if(shifts.has(k)&&shifts.get(k).sourceRef!==a.sourceRef)reasons.push('ATTENDANCE_CONFLICT');else shifts.set(k,a);}
 if(!shifts.size)reasons.push('VERIFIED_ATTENDANCE_REQUIRED');
 let earned=0n;const usedRates=new Map();
 for(const a of shifts.values()){
  const subjectRates=rates.filter(r=>r?.employeeMobile===a.employeeMobile);
  if(subjectRates.some(r=>r.verified===true&&(!validDate(r.validFrom)||(r.validTo!==null&&(!validDate(r.validTo)||r.validTo<=r.validFrom))))){reasons.push('DATED_RATE_UNRESOLVED');continue;}
  const applicable=subjectRates.filter(r=>r.verified===true&&r.sourceRef&&r.version&&r.validFrom<=a.date&&(r.validTo===null||a.date<r.validTo));
  if(applicable.length!==1||!money(applicable[0]?.halfDayMinor)){reasons.push('DATED_RATE_UNRESOLVED');continue;}
  const rate=applicable[0];earned+=BigInt(rate.halfDayMinor);usedRates.set(JSON.stringify([rate.sourceRef,rate.version]),rate);
 }
 if(conveyanceMinor!==null&&!money(conveyanceMinor))reasons.push('CONVEYANCE_EVIDENCE_INVALID');
 if(reasons.length)return {state:'UNRESOLVED',reasons:[...new Set(reasons)],payableMinor:null,policyVersion:policy?.version??null};
 return {state:'CALCULATED_NOT_POSTED',halfDayUnits:shifts.size,earnedMinor:earned.toString(),conveyanceMinor:conveyanceMinor??null,payableMinor:conveyanceMinor===null?null:(earned+BigInt(conveyanceMinor)).toString(),reasons:conveyanceMinor===null?['CONVEYANCE_NOT_ESTABLISHED']:[],policyVersion:policy.version,rateVersions:[...new Set([...usedRates.values()].map(r=>r.version))],sourceRefs:[...new Set([...shifts.values()].map(a=>a.sourceRef).concat([...usedRates.values()].map(r=>r.sourceRef)))]};
}
