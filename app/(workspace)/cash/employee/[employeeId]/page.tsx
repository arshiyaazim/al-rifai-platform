import {pageUser} from '@/lib/standalone/session';
import {
  cashTransactionView, countCashTransactions, getCashEmployeeSummary, listCashTransactions,
} from '@/lib/standalone/finance';
import {CashEmployeeHistory, type CashEmployeePayload} from '@/components/standalone/cash-employee-history';

export const dynamic = 'force-dynamic';

export default async function CashEmployeePage({params}: {params: Promise<{employeeId: string}>}) {
  const user = await pageUser();
  const {employeeId} = await params;
  const id = decodeURIComponent(employeeId);
  const limit = 20;
  const [employee, rows, total] = await Promise.all([
    getCashEmployeeSummary(id),
    listCashTransactions({employeeId: id, limit, offset: 0}),
    countCashTransactions({employeeId: id}),
  ]);
  const initial: CashEmployeePayload = {
    employee: employee ? {
      employeeId: employee.employee_mobile,
      nameOfEmployee: employee.name_of_employee,
      designation: employee.designation,
      dateOfJoin: employee.date_of_join,
      totalPayouts: Number(employee.total_payouts),
      totalPaid: employee.total_paid_minor,
      totalPaidMinor: employee.total_paid_minor,
    } : null,
    transactions: rows.map(cashTransactionView),
    total,
    page: 1,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
  return <CashEmployeeHistory employeeId={id} initial={initial} canManage={user.role === 'ADMIN' && user.capabilities.includes('cash.review')} generatedBy={user.displayName} />;
}
