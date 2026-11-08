// Display-only employee-name cleaning.
//
// Parsed Cash rows sometimes append the source/channel and instruction state to
// the name ("Md.Nazmul HossainWHATSAPP · REVIEW"). Those tokens are presentation
// artefacts, never part of the person's name. This helper strips only trailing
// source/state tokens and leaves the stored value untouched.

const TRAILING_TAG = /(?:\s*[·|,:/\\-]\s*)?(WHATSAPP|REVIEW|WEB|OFFICE|POSTED|APPROVED|VOID|REJECTED|IMPORT)\s*$/i;

export function cleanEmployeeName(value: unknown): string {
  let name = String(value ?? '').trim();
  for (let pass = 0; pass < 5; pass += 1) {
    const match = name.match(TRAILING_TAG);
    // Do not erase a legitimate name that happens to equal a tag on its own.
    if (!match || match.index === undefined || match.index === 0) break;
    name = name.slice(0, match.index).replace(/[\s·|,:/\\-]+$/, '').trim();
  }
  return name || '—';
}
