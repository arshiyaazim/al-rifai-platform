export type PortalEmployeeRequestRow={
  id:string;
  employeeName:string;
  employeeMobile:string;
  state:string;
  activatedAt:string|null;
  activatedByUsername:string|null;
};

export type PaymentEmployeeIdentity={employeePhone:string|null};

export const EMPLOYEE_PAGE_SIZE=40;

export function employeePage<T>(rows:T[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/EMPLOYEE_PAGE_SIZE));
  const currentPage=Math.min(Math.max(1,Math.floor(page)||1),pages);
  const start=(currentPage-1)*EMPLOYEE_PAGE_SIZE;
  return {
    rows:rows.slice(start,start+EMPLOYEE_PAGE_SIZE),
    page:currentPage,
    pages,
    start:rows.length?start+1:0,
    end:Math.min(start+EMPLOYEE_PAGE_SIZE,rows.length),
  };
}

export function portalActivatedEmployees(
  requests:PortalEmployeeRequestRow[],
  paymentEmployees:PaymentEmployeeIdentity[],
){
  const paymentMobiles=new Set(paymentEmployees.flatMap(row=>row.employeePhone?[row.employeePhone]:[]));
  return requests
    .filter(row=>row.state==='ACTIVE')
    .map(row=>({
      ...row,
      source:'PORTAL_ACTIVATION' as const,
      status:'ACTIVE' as const,
      paymentIdentityCollision:paymentMobiles.has(row.employeeMobile),
    }));
}
