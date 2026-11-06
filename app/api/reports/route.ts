import {actorFor, errorResponse} from '../_shared';
import {listEmployees} from '@/lib/standalone/employees';
import {listPrograms} from '@/lib/standalone/programs';
import {listAttendance} from '@/lib/standalone/attendance';
import {listInstructions, listLedger} from '@/lib/standalone/finance';
import {programPayList} from '@/lib/standalone/payroll';
import {listAudit} from '@/lib/standalone/audit';
import {assertCapability} from '@/lib/standalone/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const csv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))].join('\n');
};

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    const type = url.searchParams.get('type') ?? 'employees';
    if (type === 'audit') assertCapability(actor as never, 'audit.read');
    else if (type === 'cash' || type === 'ledger') assertCapability(actor as never, 'cash.read');
    else if (type === 'payroll') assertCapability(actor as never, 'payroll.read');
    else if (type === 'programs') assertCapability(actor as never, 'vessel.read');
    else if (type === 'employees') assertCapability(actor as never, 'employee.read');
    else if (type === 'attendance') assertCapability(actor as never, 'attendance.read');
    let rows: Array<Record<string, unknown>> = [];
    if (type === 'employees') rows = (await listEmployees({limit: 10000})) as never;
    else if (type === 'programs') rows = (await listPrograms({limit: 10000})) as never;
    else if (type === 'attendance') rows = (await listAttendance({limit: 10000})) as never;
    else if (type === 'cash') rows = (await listInstructions({limit: 10000})) as never;
    else if (type === 'ledger') rows = (await listLedger({limit: 10000})) as never;
    else if (type === 'payroll') rows = (await programPayList({limit: 10000})) as never;
    else if (type === 'audit') rows = (await listAudit({limit: 10000})) as never;
    else return new Response(JSON.stringify({error: 'UNKNOWN_REPORT'}), {status: 400});
    const body = csv(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="alrifai-${type}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
