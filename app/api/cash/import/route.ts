import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {approveInstruction, createInstruction, postInstruction} from '@/lib/standalone/finance';
import {row} from '@/lib/standalone/db';
import {autoMapColumns, cell} from '@/lib/csv-auto-mapper';
import {parseCsv, parseAmountMinor, parseImportDate} from '@/lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BYTES = 5 * 1024 * 1024;
const METHODS = new Set(['bkash', 'nagad', 'rocket', 'bank', 'cash']);

const normaliseMobile = (value: unknown) => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (/^01[3-9][0-9]{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}`;
  return null;
};

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'cash.submit');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);

    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dryRun') === 'true' || url.searchParams.get('dryRun') === '1';
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return ok({error: 'FILE_REQUIRED'}, 400);
    if (file.size <= 0 || file.size > MAX_BYTES) return ok({error: 'FILE_SIZE_INVALID'}, 400);
    if (!/\.csv$/i.test(file.name)) return ok({error: 'CSV_REQUIRED'}, 400);

    const parsed = parseCsv(await file.text());
    if (!parsed.headers.length) return ok({error: 'EMPTY_FILE'}, 400);
    const mapped = autoMapColumns(parsed.headers, 'cash');
    if (mapped.missingRequired.length) {
      return ok({error: 'REQUIRED_COLUMNS_MISSING', missingRequired: mapped.missingRequired, columnMapping: mapped}, 400);
    }

    const rows = parsed.rows.map((cells) => {
      const method = cell(cells, mapped.mapping, 'method').toLowerCase();
      return {
        employeeMobile: normaliseMobile(cell(cells, mapped.mapping, 'employeeMobile')),
        employeeName: cell(cells, mapped.mapping, 'employeeName'),
        amountMinor: parseAmountMinor(cell(cells, mapped.mapping, 'amount')),
        date: parseImportDate(cell(cells, mapped.mapping, 'date')) ?? new Date().toISOString().slice(0, 10),
        description: cell(cells, mapped.mapping, 'description') || null,
        method: METHODS.has(method) ? method : 'cash',
      };
    });

    if (dryRun) {
      return ok({
        dryRun: true,
        totalRows: rows.length,
        columnMapping: mapped,
        parseErrors: parsed.errors,
        preview: rows.slice(0, 5),
      });
    }

    const account = await row<{id: string}>(
      `SELECT id FROM cash_accounts WHERE active ORDER BY code LIMIT 1`,
    );
    if (!account) return ok({error: 'CASH_ACCOUNT_REQUIRED'}, 409);

    let imported = 0;
    let duplicates = 0;
    const errors: Array<{row: number; reason: string}> = [];
    for (let index = 0; index < rows.length; index += 1) {
      const entry = rows[index];
      if (!entry.employeeMobile || !entry.amountMinor) {
        errors.push({row: index + 2, reason: 'EMPLOYEE_MOBILE_AND_AMOUNT_REQUIRED'});
        continue;
      }
      const duplicate = await row(
        `SELECT 1 FROM cash_instructions
          WHERE employee_mobile = $1 AND amount_minor = $2
            AND (event_at AT TIME ZONE 'Asia/Dhaka')::date = $3::date
            AND state <> 'VOID' LIMIT 1`,
        [entry.employeeMobile, entry.amountMinor, entry.date],
      );
      if (duplicate) { duplicates += 1; continue; }

      try {
        const employee = await row<{preferred_name: string}>(
          'SELECT preferred_name FROM employees WHERE employee_mobile = $1', [entry.employeeMobile],
        );
        const name = entry.employeeName || employee?.preferred_name
          || `Unknown-${entry.employeeMobile.slice(-4)}`;
        const designation = /client|ক্লায়েন্ট/i.test(String(entry.description ?? '')) ? 'client' : 'other';
        await row(
          `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, created_by)
           VALUES ($1,$2,'other',$3,'import:csv')
           ON CONFLICT (employee_mobile) DO NOTHING`,
          [entry.employeeMobile, name, designation],
        );
        const created = await createInstruction(actor as never, {
          employeeMobile: entry.employeeMobile,
          employeeName: name,
          payoutMobile: entry.employeeMobile,
          method: entry.method,
          amountMinor: entry.amountMinor,
          purpose: entry.description,
          accountId: account.id,
          sourceChannel: 'IMPORT',
          eventAt: `${entry.date}T12:00:00+06:00`,
        });
        if (!created) { errors.push({row: index + 2, reason: 'INSTRUCTION_NOT_CREATED'}); continue; }
        await approveInstruction(actor as never, created.id);
        await postInstruction(actor as never, created.id);
        imported += 1;
      } catch (error) {
        errors.push({row: index + 2, reason: (error instanceof Error ? error.message : String(error)).slice(0, 180)});
      }
    }

    return ok({
      imported,
      skipped: errors.length + duplicates,
      duplicates,
      errors,
      columnMapping: mapped,
      parseErrors: parsed.errors,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
