import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {createProgram} from '@/lib/standalone/programs';
import {autoMapColumns, cell} from '@/lib/csv-auto-mapper';
import {parseCsv, splitDateShift, parseShift} from '@/lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'vessel.command');
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
    const mapped = autoMapColumns(parsed.headers, 'vessel');
    if (mapped.missingRequired.length) {
      return ok({
        error: 'REQUIRED_COLUMNS_MISSING',
        missingRequired: mapped.missingRequired,
        columnMapping: mapped,
      }, 400);
    }

    const mappedRows = parsed.rows.map((row) => {
      const start = splitDateShift(cell(row, mapped.mapping, 'startDate'));
      const end = cell(row, mapped.mapping, 'endDate');
      const endParts = end ? splitDateShift(end) : {date: null, shift: null};
      return {
        motherVessel: cell(row, mapped.mapping, 'motherVessel'),
        lighterVessel: cell(row, mapped.mapping, 'lighterVessel'),
        masterMobile: cell(row, mapped.mapping, 'masterMobile') || null,
        escortName: cell(row, mapped.mapping, 'escortName') || null,
        escortMobile: cell(row, mapped.mapping, 'escortMobile') || null,
        startDate: start.date,
        startShift: cell(row, mapped.mapping, 'startShift') ? parseShift(cell(row, mapped.mapping, 'startShift')) : start.shift,
        endDate: endParts.date,
        endShift: cell(row, mapped.mapping, 'endShift') ? parseShift(cell(row, mapped.mapping, 'endShift')) : endParts.shift,
        notes: cell(row, mapped.mapping, 'description') || null,
      };
    });

    if (dryRun) {
      return ok({
        dryRun: true,
        totalRows: mappedRows.length,
        columnMapping: mapped,
        parseErrors: parsed.errors,
        preview: mappedRows.slice(0, 5),
      });
    }

    let imported = 0;
    let duplicates = 0;
    const errors: Array<{row: number; reason: string}> = [];
    for (let index = 0; index < mappedRows.length; index += 1) {
      const row = mappedRows[index];
      if (!row.motherVessel || !row.lighterVessel || !row.startDate) {
        errors.push({row: index + 2, reason: 'MOTHER_LIGHTER_START_REQUIRED'});
        continue;
      }
      try {
        await createProgram(actor as never, {
          motherVessel: row.motherVessel,
          lighterVessel: row.lighterVessel,
          masterMobile: row.masterMobile,
          escortName: row.escortName,
          escortMobile: row.escortMobile,
          startDate: row.startDate,
          startShift: row.startShift ?? 'D',
          endDate: row.endDate,
          endShift: row.endShift,
          notes: row.notes,
        }, {channel: 'IMPORT', sourceType: 'MANUAL'});
        imported += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('DUPLICATE_PROGRAM')) duplicates += 1;
        else errors.push({row: index + 2, reason: message.slice(0, 180)});
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
