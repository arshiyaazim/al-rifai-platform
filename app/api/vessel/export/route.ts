import {actorFor, errorResponse} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {rows} from '@/lib/standalone/db';
import {toCsv} from '@/lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = [
  'Date', 'Mother Vessel', 'Lighter Vessel', 'Escort Name', 'Escort Mobile',
  'Start', 'End', 'Days', 'Salary', 'Conv.', 'Total',
];

const dateDmy = (value: unknown) => {
  if (!value) return '—';
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.day}.${parts.month}.${parts.year}`;
};

const shiftCell = (date: unknown, shift: unknown) => {
  const rendered = dateDmy(date);
  return rendered === '—' ? '' : `${rendered}(${shift ?? '—'})`;
};

const mv = (value: unknown) => {
  const name = String(value ?? '').trim();
  if (!name) return '';
  return /^m\.?\s*v\.?\s+/i.test(name) ? name : `MV ${name}`;
};

const decimal = (minor: unknown) => {
  if (minor === null || minor === undefined || minor === '') return '';
  const number = Number(minor);
  return Number.isFinite(number) ? (number / 100).toFixed(2) : '';
};

const days = (shifts: unknown) => {
  if (shifts === null || shifts === undefined) return '';
  const number = Number(shifts);
  return Number.isFinite(number) ? (number / 2).toFixed(2) : '';
};

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'vessel.read');
    const url = new URL(request.url);
    const escortMobile = (url.searchParams.get('escort_mobile') ?? '').trim();
    const mother = (url.searchParams.get('mother') ?? '').trim();
    const lighter = (url.searchParams.get('lighter') ?? '').trim();
    const status = (url.searchParams.get('status') ?? '').trim().toUpperCase();
    const client = (url.searchParams.get('client') ?? '').trim();
    const from = (url.searchParams.get('date_from') ?? url.searchParams.get('from') ?? '').trim();
    const to = (url.searchParams.get('date_to') ?? url.searchParams.get('to') ?? '').trim();

    const params: unknown[] = [];
    const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const where: string[] = [`p.state <> 'VOIDED'`];
    if (escortMobile) where.push(`coalesce(p.escort_mobile,'') ILIKE ${bind(`%${escortMobile}%`)}`);
    if (mother) where.push(`coalesce(p.mother_vessel_normalized,p.mother_vessel) ILIKE ${bind(`%${mother}%`)}`);
    if (lighter) where.push(`coalesce(p.lighter_vessel_normalized,p.lighter_vessel) ILIKE ${bind(`%${lighter}%`)}`);
    if (client) where.push(`p.source_chat_jid = ${bind(client)}`);
    if (from) where.push(`(p.event_at AT TIME ZONE 'Asia/Dhaka')::date >= ${bind(from)}::date`);
    if (to) where.push(`(p.event_at AT TIME ZONE 'Asia/Dhaka')::date <= ${bind(to)}::date`);
    if (status === 'RUNNING') where.push(`p.state IN ('CONFIRMED','ASSIGNED','IN_DUTY')`);
    else if (status === 'COMPLETED') where.push(`p.state IN ('RELEASED','COMPLETED')`);
    else if (status === 'CANCEL') where.push(`p.state IN ('VOIDED','WITHDRAWN')`);
    else if (status === 'ESCORT_CHANGE') where.push(`p.escort_change_from_program_id IS NOT NULL`);
    else if (status === 'DRAFT') where.push(`p.state = 'DRAFT'`);

    const data = await rows<Record<string, unknown>>(
      `SELECT p.event_at, p.mother_vessel_normalized, p.lighter_vessel_normalized,
              p.escort_name, p.escort_mobile, p.start_date, p.start_shift,
              p.end_date, p.end_shift, pp.shifts, pp.salary_minor,
              pp.conveyance_minor, pp.total_minor,
              coalesce(e.preferred_name, p.escort_name, '') AS preferred_name
         FROM programs p
         LEFT JOIN program_pay pp ON pp.program_id = p.id
         LEFT JOIN employees e ON e.employee_mobile = p.escort_mobile
        WHERE ${where.join(' AND ')}
        ORDER BY p.event_at DESC, p.created_at DESC`,
      params,
    );

    const body = data.map((row) => [
      dateDmy(row.event_at),
      mv(row.mother_vessel_normalized ?? row.mother_vessel),
      mv(row.lighter_vessel_normalized ?? row.lighter_vessel),
      row.preferred_name ?? '',
      row.escort_mobile ?? '',
      shiftCell(row.start_date, row.start_shift),
      shiftCell(row.end_date, row.end_shift),
      days(row.shifts),
      decimal(row.salary_minor),
      decimal(row.conveyance_minor),
      decimal(row.total_minor),
    ]);

    const csv = toCsv(HEADERS, body);
    const filename = `vessel-export-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
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
