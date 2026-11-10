// Draft delivery queue for the Admin and Office Group (Step 15).
// Nothing is sent here. A row is QUEUED only when its feature flag is enabled;
// otherwise it is CANCELLED with DELIVERY_SUPPRESSED_PHASE2.

import {createHash} from 'node:crypto';
import {row} from '../../standalone/db.ts';
import {getFeatureFlag} from '../../feature-flags.ts';
import {renderOwnerDraftFields} from '../../order-draft-template.ts';
import {sendVesselDraft, vesselDraftTransportPaths} from '../../vessel-draft-transport.ts';

export const ADMIN_DRAFT_RECIPIENT = '8801880446111@s.whatsapp.net';
export const OFFICE_GROUP_RECIPIENT = '120363426895117693@g.us';

export type DraftProgram = {
  id: string;
  mother_vessel?: string | null;
  lighter_vessel?: string | null;
  master_mobile?: string | null;
  destination?: string | null;
  escort_name?: string | null;
  escort_mobile?: string | null;
  start_date?: string | null;
  start_shift?: string | null;
  event_at?: string | null;
  source_message_id?: string | null;
};

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function contentFor(program: DraftProgram): string | null {
  const date = program.event_at
    ? new Date(program.event_at).toLocaleDateString('en-CA', {timeZone: 'Asia/Dhaka'})
    : String(program.start_date ?? '').slice(0, 10);
  const shift = program.start_shift === 'D' || program.start_shift === 'N' ? program.start_shift : 'D';
  if (!program.mother_vessel || !program.lighter_vessel || !program.master_mobile || !date) return null;
  try {
    return renderOwnerDraftFields({
      motherVessel: program.mother_vessel,
      lighterVessel: program.lighter_vessel,
      masterMobile: program.master_mobile,
      destination: program.destination,
      escortName: program.escort_name,
      escortMobile: program.escort_mobile,
      date,
      shift,
    });
  } catch {
    return null;
  }
}

export async function enqueueDraftDeliveries(program: DraftProgram): Promise<{queued: number; suppressed: number}> {
  const content = contentFor(program);
  if (!content) return {queued: 0, suppressed: 0};
  const contentHash = sha(content);
  const targets = [
    {flag: 'vessel.draft_to_admin', recipient: ADMIN_DRAFT_RECIPIENT},
    {flag: 'vessel.draft_to_office', recipient: OFFICE_GROUP_RECIPIENT},
  ];
  let queued = 0;
  let suppressed = 0;
  for (const target of targets) {
    const flag = await getFeatureFlag(target.flag, {enabled: false});
    const state = flag.enabled ? 'QUEUED' : 'CANCELLED';
    const id = `vdd_${sha([program.id, contentHash, target.recipient].join('\n'))}`;
    const inserted = await row<{id: string}>(
      `INSERT INTO vessel_draft_deliveries
         (id, program_id, source_message_id, account_id, recipient_jid, content,
          content_hash, state, attempts, next_attempt_at, error)
       VALUES($1,$2,$3,'wa-01',$4,$5,$6,$7,0,$8,$9)
       ON CONFLICT (program_id, content_hash, recipient_jid) DO NOTHING
       RETURNING id`,
      [id, program.id, program.source_message_id ?? null, target.recipient, content, contentHash, state,
        flag.enabled ? new Date().toISOString() : null,
        flag.enabled ? null : 'DELIVERY_SUPPRESSED_PHASE2'],
    ).catch(() => null);
    if (!inserted) continue;
    if (!flag.enabled) { suppressed += 1; continue; }
    if (process.env.ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED !== '1') {
      await row(`UPDATE vessel_draft_deliveries SET state='CANCELLED', error='OUTBOUND_DISABLED' WHERE id=$1`, [id]).catch(() => null);
      suppressed += 1;
      continue;
    }
    const paths = vesselDraftTransportPaths();
    if (!paths) {
      await row(`UPDATE vessel_draft_deliveries SET state='FAILED', error='TRANSPORT_NOT_CONFIGURED' WHERE id=$1`, [id]).catch(() => null);
      continue;
    }
    const outcome = await sendVesselDraft({
      accountId: 'wa-01',
      recipientJid: target.recipient,
      text: content,
      idempotencyKey: id,
    }, paths);
    const nextState = outcome.kind === 'sent' ? 'SENT' : outcome.kind === 'unknown' ? 'DELIVERY_UNKNOWN' : 'FAILED';
    await row(
      `UPDATE vessel_draft_deliveries
          SET state=$2, attempts=attempts+1, delivery_ref=$3, error=$4, updated_at=now()
        WHERE id=$1`,
      [id, nextState, outcome.kind === 'sent' ? outcome.deliveryRef : null, outcome.kind === 'sent' ? null : outcome.error],
    ).catch(() => null);
    if (outcome.kind === 'sent') queued += 1;
  }
  return {queued, suppressed};
}
