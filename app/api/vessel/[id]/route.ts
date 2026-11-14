import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability, can} from '@/lib/standalone/authz';
import {submitForReview} from '@/lib/standalone/review';
import {assignEscort, getProgram, releaseProgram, updateProgram, voidProgram} from '@/lib/standalone/programs';
import {listProgramSourcesForPrograms} from '@/lib/standalone/review';
import {getMessageEvidence} from '@/lib/standalone/messages';
import {recordAudit} from '@/lib/standalone/audit';
import {DomainError} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function detail(id: string) {
  const data = await getProgram(id);
  const sources = await listProgramSourcesForPrograms([id]);
  const accountId = sources[0]?.account_id ?? 'wa-01';
  const confirmationEvidence = data.program.confirmation_message_id && data.program.confirmation_chat_jid
    ? await getMessageEvidence(accountId, data.program.confirmation_chat_jid, data.program.confirmation_message_id)
    : null;
  const releaseEvidence = data.program.release_message_id && data.program.release_chat_jid
    ? await getMessageEvidence(accountId, data.program.release_chat_jid, data.program.release_message_id)
    : null;
  return {...data, sources, confirmationEvidence, releaseEvidence};
}

/** Vessel detail alias. Includes confirmation_* and release_* provenance. */
export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'vessel.read');
    const {id} = await context.params;
    return ok(await detail(decodeURIComponent(id)));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Soft-delete: the row and its audit trail stay, state becomes VOIDED.
 */
export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'vessel.command');
    const {id} = await context.params;
    const programId = decodeURIComponent(id);
    let reason = 'Deleted from vessel register';
    try {
      const body = await request.clone().json() as {reason?: string};
      if (body?.reason) reason = String(body.reason).slice(0, 500);
    } catch {
      // DELETE without a JSON body is allowed; the default reason is audited.
    }
    const result = await voidProgram(actor as never, programId, reason);
    return ok(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Edit supported program fields. Mother/Lighter identity is never edited here;
 * the order message remains their source of truth.
 */
export async function PATCH(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    const {id} = await context.params;
    const programId = decodeURIComponent(id);
    const body = await bodyOf<{
      escortMobile?: string; escortName?: string; masterMobile?: string | null;
      startDate?: string; startShift?: string; endDate?: string | null; endShift?: string | null; notes?: string | null;
    }>(request);
    if (!can(actor as never, 'vessel.command')) {
      // USER edits stage for review instead of writing directly. Escort and
      // release changes still need the operational capabilities.
      const current = await getProgram(programId);
      if (current.program.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);
      if (current.program.state === 'COMPLETED') throw new DomainError('PROGRAM_COMPLETED', 409);
      const digits = (value: unknown) => String(value ?? '')
        .replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1');
      const escortChanged = body.escortMobile !== undefined
        && digits(body.escortMobile) !== digits(current.program.escort_mobile);
      const releaseChanged = (body.endDate !== undefined && String(body.endDate ?? '') !== String(current.program.end_date ?? ''))
        || (body.endShift !== undefined && String(body.endShift ?? '') !== String(current.program.end_shift ?? ''));
      if (escortChanged) assertCapability(actor as never, 'vessel.command');
      if (releaseChanged) assertCapability(actor as never, 'vessel.release');
      assertCapability(actor as never, 'vessel.submit');
      const payload: Record<string, unknown> = {};
      if (body.masterMobile !== undefined) payload.masterMobile = body.masterMobile;
      if (body.startDate !== undefined) payload.startDate = body.startDate;
      if (body.startShift !== undefined) payload.startShift = body.startShift;
      if (body.notes !== undefined) payload.notes = body.notes;
      if (!Object.keys(payload).length) return ok({pending: false, unchanged: true}, 200);
      const review = await submitForReview(actor as never, {
        domain: 'PROGRAM', action: 'UPDATE', targetRef: programId, payload,
      });
      return ok({pending: true, review}, 202);
    }
    assertCapability(actor as never, 'vessel.command');
    const current = await getProgram(programId);
    if (current.program.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);

    const changed: Record<string, unknown> = {};
    if (body.masterMobile !== undefined
      || body.startDate !== undefined || body.startShift !== undefined || body.notes !== undefined) {
      await updateProgram(actor as never, programId, {
        masterMobile: body.masterMobile,
        startDate: body.startDate,
        startShift: body.startShift,
        notes: body.notes,
      });
      changed.fields = true;
    }
    if (body.escortMobile) {
      assertCapability(actor as never, 'vessel.command');
      await assignEscort(actor as never, programId, {
        employeeMobile: body.escortMobile,
        employeeName: body.escortName,
        startDate: body.startDate,
        startShift: body.startShift,
        replace: true,
      });
      changed.escort = true;
    }
    if (body.endDate) {
      assertCapability(actor as never, 'vessel.release');
      await releaseProgram(actor as never, programId, {
        endDate: body.endDate,
        endShift: body.endShift ?? current.program.end_shift ?? current.program.start_shift,
        note: body.notes ?? undefined,
      });
      changed.released = true;
    }
    await recordAudit({
      actor: actor as never,
      action: 'VESSEL:PROGRAM_UPDATED',
      entity: 'program',
      entityId: programId,
      detail: {changed, body: {...body}},
      source: 'WEB',
      sourceRef: programId,
    });
    return ok(await detail(programId));
  } catch (error) {
    return errorResponse(error);
  }
}
