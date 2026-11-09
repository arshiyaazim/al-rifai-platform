import {actorFor, errorResponse, ok} from '../../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {
  cashTransactionView, countCashTransactions, getCashEmployeeSummary, listCashTransactions,
} from '@/lib/standalone/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One employee's Cash transaction history. Read-only; same authorised read
 * model as /api/cash/transactions, filtered by the employee mobile.
 */
export async function GET(request: Request, context: {params: Promise<{employeeId: string}>}) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const {employeeId} = await context.params;
    const id = decodeURIComponent(employeeId);
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 10000);
    const from = (url.searchParams.get('from') ?? '').trim() || undefined;
    const to = (url.searchParams.get('to') ?? '').trim() || undefined;
    const amountMin = url.searchParams.get('amountMin');
    const amountMax = url.searchParams.get('amountMax');
    const filters = {
      employeeId: id,
      from,
      to,
      amountMin: amountMin ? Number(amountMin) : undefined,
      amountMax: amountMax ? Number(amountMax) : undefined,
    };
    const [employee, rows, total] = await Promise.all([
      getCashEmployeeSummary(id),
      listCashTransactions({...filters, limit, offset: (page - 1) * limit}),
      countCashTransactions(filters),
    ]);
    return ok({
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
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
