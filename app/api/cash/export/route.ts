import {actorFor, errorResponse} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {cashTransactionView, listCashTransactions} from '@/lib/standalone/finance';
import {toCsv} from '@/lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = [
  'Date', 'Employee ID', 'Name', 'Designation', 'Date of Join',
  'Payouts', 'Amount', 'Total Paid',
];

const dateOnly = (value: unknown) => {
  if (!value) return '';
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.day}.${parts.month}.${parts.year}`;
};

const decimal = (minor: unknown) => {
  if (minor === null || minor === undefined || minor === '') return '';
  const number = Number(minor);
  return Number.isFinite(number) ? (number / 100).toFixed(2) : '';
};

const localMobile = (value: unknown) => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return /^8801[3-9][0-9]{8}$/.test(digits) ? `0${digits.slice(3)}` : String(value ?? '');
};

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const url = new URL(request.url);
    const search = (url.searchParams.get('search') ?? url.searchParams.get('q') ?? '').trim();
    const state = (url.searchParams.get('status') ?? url.searchParams.get('state') ?? '').trim() || undefined;
    const employeeId = (url.searchParams.get('employee_mobile')
      ?? url.searchParams.get('employeeId') ?? '').trim() || undefined;
    const from = (url.searchParams.get('date_from') ?? url.searchParams.get('from') ?? '').trim() || undefined;
    const to = (url.searchParams.get('date_to') ?? url.searchParams.get('to') ?? '').trim() || undefined;

    const data = await listCashTransactions({
      q: search, state, employeeId, from, to, limit: 10000, offset: 0,
    });

    const body = data.map((row) => {
      const view = cashTransactionView(row);
      return [
        dateOnly(view.eventAt),
        localMobile(view.employeeId),
        view.nameOfEmployee ?? '',
        view.designation ?? '',
        view.dateOfJoin ? dateOnly(view.dateOfJoin) : '',
        view.payoutNumber ?? '',
        decimal(view.amountMinor),
        decimal(view.totalPaidMinor),
      ];
    });

    const filename = `cash-export-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(HEADERS, body), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
