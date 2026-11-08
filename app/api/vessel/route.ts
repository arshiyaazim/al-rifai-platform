import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {assignEscort, countPrograms, createProgram, listPrograms} from '@/lib/standalone/programs';
import {recordAudit} from '@/lib/standalone/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Vessel register alias for the existing program list. Same read model. */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'vessel.read');
    const url = new URL(request.url);
    const filters = {
      q: url.searchParams.get('q') ?? '',
      state: url.searchParams.get('state') ?? undefined,
      escort: url.searchParams.get('escort') ?? undefined,
      mother: url.searchParams.get('mother') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    };
    const [rows, total] = await Promise.all([listPrograms(filters), countPrograms(filters)]);
    return ok({rows, total, limit: filters.limit, offset: filters.offset});
  } catch (error) {
    return errorResponse(error);
  }
}

/** Manually create a vessel program (source_type MANUAL). */
export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'vessel.command');
    const body = await bodyOf<{
      motherVessel?: string; lighterName?: string; lighterVessel?: string;
      masterName?: string; masterMobile?: string; startDate?: string; startShift?: string;
      escortMobile?: string; escortName?: string; notes?: string;
    }>(request);
    const result = await createProgram(actor as never, {
      motherVessel: String(body.motherVessel ?? ''),
      lighterVessel: String(body.lighterVessel ?? body.lighterName ?? ''),
      masterName: body.masterName ?? null,
      masterMobile: body.masterMobile ?? null,
      startDate: String(body.startDate ?? ''),
      startShift: String(body.startShift ?? 'D'),
      notes: body.notes ?? null,
    }, {channel: 'WEB', sourceType: 'MANUAL'});
    if (body.escortMobile) {
      await assignEscort(actor as never, result.program.id, {
        employeeMobile: body.escortMobile,
        employeeName: body.escortName ?? undefined,
        startDate: body.startDate,
        startShift: body.startShift,
      });
    }
    await recordAudit({
      actor: actor as never,
      action: 'VESSEL:MANUAL_PROGRAM_CREATED',
      entity: 'program',
      entityId: result.program.id,
      detail: {
        motherVessel: result.program.mother_vessel,
        lighterVessel: result.program.lighter_vessel,
        masterName: body.masterName ?? null,
        masterMobile: body.masterMobile ?? null,
        startDate: result.program.start_date,
        startShift: result.program.start_shift,
        escortMobile: body.escortMobile ?? null,
        sourceType: 'MANUAL',
      },
      source: 'WEB',
      sourceRef: result.program.id,
    });
    return ok({program: result.program, potentialDuplicates: result.potentialDuplicates}, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
