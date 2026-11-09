// Vessel duplicate / master-correction decision (Step 13).
// Same order_key within N days is a duplicate. A different Master Mobile inside
// the window is a correction: the later message's number wins.

import {rows} from '../../standalone/db.ts';
import {featureConfig} from '../../feature-flags.ts';

export type DuplicateDecision = {
  isDuplicate: boolean;
  isCorrection: boolean;
  existingProgramId?: string;
  windowDays: number;
  existingMasterMobile?: string | null;
};

const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');

export async function checkDuplicate(
  orderKey: string,
  eventAt: Date,
  masterMobile?: string | null,
): Promise<DuplicateDecision> {
  const config = await featureConfig('vessel.duplicate_days', {days: 5});
  const windowDays = Math.max(1, Number(config.days ?? 5) || 5);
  const found = await rows<{id: string; master_mobile: string | null}>(
    `SELECT id, master_mobile
       FROM programs
      WHERE order_key = $1
        AND state <> 'VOIDED'
        AND event_at >= $2::timestamptz - ($3::text || ' days')::interval
        AND event_at <= $2::timestamptz
      ORDER BY event_at DESC
      LIMIT 1`,
    [orderKey, eventAt.toISOString(), String(windowDays)],
  );
  if (!found.length) {
    return {isDuplicate: false, isCorrection: false, windowDays};
  }
  const existing = found[0];
  const incoming = digits(masterMobile);
  const prior = digits(existing.master_mobile);
  const same = !incoming || !prior || incoming === prior;
  return {
    isDuplicate: same,
    isCorrection: !same,
    existingProgramId: existing.id,
    existingMasterMobile: existing.master_mobile,
    windowDays,
  };
}
