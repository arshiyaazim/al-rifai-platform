import {actorFor, errorResponse} from '../_shared';
import {listEmployees} from '@/lib/standalone/employees';
import {listPrograms} from '@/lib/standalone/programs';
import {listAttendance} from '@/lib/standalone/attendance';
import {listInstructions, listLedger} from '@/lib/standalone/finance';
import {programPayList} from '@/lib/standalone/payroll';
import {listAudit} from '@/lib/standalone/audit';

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
    await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    const type = url.searchParams.get('type') ?? 'employees';
    let rows: Array<Record<string, unknown>> = [];
    if (type === 'employees') rows = (await listEmployees({})) as never;
    else if (type === 'programs') rows = (await listPrograms({})) as never;
    else if (type === 'attendance') rows = (await listAttendance({})) as never;
    else if (type === 'cash') rows = (await listInstructions({})) as never;
    else if (type === 'ledger') rows = (await listLedger({})) as never;
    else if (type === 'payroll') rows = (await programPayList({})) as never;
    else if (type === 'audit') rows = (await listAudit({limit: 500})) as never;
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
