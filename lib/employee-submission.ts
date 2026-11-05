import {createHash} from 'node:crypto';
import {normalizeEmployeeMobile,validDate} from './employee-program-validation.mjs';

export type EmployeeSubmissionInput={
  employeeName?:unknown;
  employeeMobile?:unknown;
  proposedAssignment?:unknown;
  requestedJoiningDate?:unknown;
  note?:unknown;
};

export type EmployeeSubmissionPayload={
  employeeName:string;
  employeeMobile:string;
  proposedAssignment:string;
  requestedJoiningDate:string|null;
  note:string;
  payloadHash:string;
  state:'PENDING_APPROVAL';
};

export type EmployeeSubmissionResult=
  |{ok:true;payload:EmployeeSubmissionPayload}
  |{ok:false;reasons:string[]};

const text=(value:unknown)=>typeof value==='string'?value.trim():null;
const allowedFields=new Set(['employeeName','employeeMobile','proposedAssignment','requestedJoiningDate','note']);

export function validateEmployeeSubmission(input:EmployeeSubmissionInput):EmployeeSubmissionResult{
  const unexpected=Object.keys(input).filter(key=>!allowedFields.has(key));
  if(unexpected.length)return {ok:false,reasons:['UNSUPPORTED_FIELDS']};

  const employeeName=text(input.employeeName);
  const employeeMobile=typeof input.employeeMobile==='string'?normalizeEmployeeMobile(input.employeeMobile,'employee_id'):null;
  const proposedAssignment=input.proposedAssignment===undefined||input.proposedAssignment===null?'':text(input.proposedAssignment);
  const requestedJoiningDate=input.requestedJoiningDate===undefined||input.requestedJoiningDate===null||input.requestedJoiningDate===''
    ?null:text(input.requestedJoiningDate);
  const note=input.note===undefined||input.note===null?'':text(input.note);
  const reasons:string[]=[];

  if(!employeeName||employeeName.length>150)reasons.push('EMPLOYEE_NAME_INVALID');
  if(!employeeMobile)reasons.push('EMPLOYEE_ID_INVALID');
  if(proposedAssignment===null||proposedAssignment.length>200)reasons.push('ASSIGNMENT_REFERENCE_INVALID');
  if(requestedJoiningDate!==null&&!validDate(requestedJoiningDate))reasons.push('JOINING_DATE_INVALID');
  if(note===null||note.length>500)reasons.push('NOTE_INVALID');
  if(reasons.length)return {ok:false,reasons};

  const normalized={
    employeeName:employeeName!,
    employeeMobile:employeeMobile!,
    proposedAssignment:proposedAssignment!,
    requestedJoiningDate,
    note:note!,
  };
  const payloadHash=createHash('sha256').update(JSON.stringify([
    normalized.employeeName,normalized.employeeMobile,normalized.proposedAssignment,
    normalized.requestedJoiningDate,normalized.note,
  ])).digest('hex');
  return {ok:true,payload:{...normalized,payloadHash,state:'PENDING_APPROVAL'}};
}
