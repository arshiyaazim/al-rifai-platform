export type EmployeeDecision='APPROVED'|'REJECTED';
export type EmployeeRequestState='PENDING_APPROVAL'|'APPROVED'|'REJECTED'|'ACTIVE';

export class EmployeeSubmissionPolicyError extends Error {
  readonly code:string;
  readonly status:number;
  constructor(code:string,status=403){
    super(code);
    this.name='EmployeeSubmissionPolicyError';
    this.code=code;
    this.status=status;
  }
}

export function validateEmployeeDecision(value:unknown):EmployeeDecision|null{
  return value==='APPROVED'||value==='REJECTED'?value:null;
}

export function validateEmployeeDecisionNote(decision:EmployeeDecision,note:unknown):string|null{
  if(typeof note!=='string')return null;
  const normalized=note.trim();
  if(normalized.length>500)return null;
  if(decision==='REJECTED'&&!normalized)return null;
  return normalized;
}

export function assertCanDecideEmployee(
  actorRole:string,
  state:EmployeeRequestState,
  actorUserRef:string,
  submitterUserRef:string,
):void{
  if(actorRole!=='ADMIN')throw new EmployeeSubmissionPolicyError('ADMIN_REQUIRED');
  if(actorUserRef===submitterUserRef)throw new EmployeeSubmissionPolicyError('EMPLOYEE_SELF_REVIEW_FORBIDDEN');
  if(state!=='PENDING_APPROVAL')throw new EmployeeSubmissionPolicyError('EMPLOYEE_REQUEST_ALREADY_DECIDED',409);
}

export function assertCanActivateEmployee(
  superAdmin:boolean,
  state:EmployeeRequestState,
  confirmation:unknown,
):void{
  if(superAdmin!==true)throw new EmployeeSubmissionPolicyError('SUPER_ADMIN_REQUIRED');
  if(state==='ACTIVE')throw new EmployeeSubmissionPolicyError('EMPLOYEE_REQUEST_ALREADY_DECIDED',409);
  if(state!=='APPROVED')throw new EmployeeSubmissionPolicyError('EMPLOYEE_REQUEST_NOT_APPROVED',409);
  if(confirmation!=='ACTIVATE_EMPLOYEE')throw new EmployeeSubmissionPolicyError('EMPLOYEE_ACTIVATION_CONFIRMATION_REQUIRED',400);
}
