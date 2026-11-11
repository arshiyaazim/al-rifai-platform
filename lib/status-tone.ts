/**
 * Shared status → pill tone mapping. The CSS classes keep the required
 * distinctions in both themes:
 *   DRAFT gray · CONFIRMED blue · RELEASED green · REVERSED muted ·
 *   CORRECTION amber · POSTED emerald.
 */
export function cashStateTone(state: string, correctionCount = 0): string {
  if (state === 'POSTED') return 'posted';
  if (state === 'REVERSED') return 'reversed';
  if (state === 'APPROVED') return 'info';
  if (state === 'REJECTED' || state === 'VOID') return 'bad';
  if (correctionCount > 0) return 'correction';
  return '';
}

export function vesselStateTone(state: string): string {
  if (state === 'RELEASED' || state === 'COMPLETED') return 'ok';
  if (state === 'CONFIRMED' || state === 'ASSIGNED' || state === 'IN_DUTY') return 'info';
  if (state === 'VOIDED') return 'bad';
  return '';
}

export function reviewStateTone(state: string): string {
  if (state === 'APPROVED' || state === 'RESOLVED') return 'ok';
  if (state === 'REJECTED') return 'bad';
  if (state === 'REVIEW_REQUIRED' || state === 'PENDING') return 'warn';
  return '';
}
