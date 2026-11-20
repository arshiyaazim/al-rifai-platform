/**
 * Display-only Taka formatting for the homepage employee search.
 *
 * Owner rule:
 *   * up to and including BDT 1,000,000 -> the full amount;
 *   * strictly greater than BDT 1,000,000 -> English "k" suffix (thousands);
 *   * the value always stays on one line.
 *
 * Amounts are integer minor units (paisa), exactly as stored. This helper never
 * performs a financial calculation: it only divides by 100 for display and, for
 * the "k" form, by 1000 as the owner requested.
 */

const FULL_LIMIT_BDT = 1_000_000;

export function compactTaka(minor: string | number | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const value = Number(minor);
  if (!Number.isFinite(value)) return '—';
  const taka = value / 100;
  if (taka <= FULL_LIMIT_BDT) {
    return taka.toLocaleString('en-US', {maximumFractionDigits: 2});
  }
  const thousands = taka / 1000;
  return `${thousands.toLocaleString('en-US', {maximumFractionDigits: 2})}k`;
}
