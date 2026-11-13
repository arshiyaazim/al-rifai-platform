// Display-only mobile formatting. Stored values are never changed.
//
// Operator rule:
//   * strip everything that is not a digit;
//   * 13 digits starting 880  -> "0" + the last 10 digits (01850316884);
//   * 11 digits starting 0    -> unchanged (already local form);
//   * anything else           -> the original input, unchanged.
//
// This is deliberately a *display* helper: the database keeps +880…, 880…,
// aliases and raw WhatsApp values exactly as received.
export function displayMobile(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('880')) return `0${digits.slice(-10)}`;
  if (digits.length === 11 && digits.startsWith('0')) return digits;
  return raw;
}
