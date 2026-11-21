// Destination spelling normalisation for payroll / conveyance.
//
// The Owner writes the same ghat in several ways ("Narayangonj", "N. Gonj",
// "n. gonj"). Stored rate keys stay stable; this helper maps a reviewed value
// to the nearest known key using punctuation-insensitive aliases and a 50%
// character-similarity guard for the remaining spelling variants.

type Destination = {key: string; aliases: string[]};

export const DESTINATIONS: Destination[] = [
  {key: 'nowapara', aliases: ['nowapara', 'n para', 'n.para', 'n para']},
  {key: 'nagorbari', aliases: ['nagorbari', 'nagor bari', 'n bari', 'n.bari']},
  {key: 'baghabari', aliases: ['baghabari', 'bagha bari', 'b bari', 'b.bari']},
  {key: 'jhalokathi', aliases: ['jhalokathi', 'j kathi', 'j.kathi']},
  {key: 'barishal', aliases: ['barishal', 'barisal']},
  {key: 'vhola', aliases: ['vhola', 'bhola']},
  {key: 'local', aliases: ['local']},
  {key: 'chattogram', aliases: ['chattogram', 'chittagong', 'ctg']},
  {key: 'faridpur', aliases: ['faridpur', 'f pur', 'f.pur']},
  {key: 'narayanganj', aliases: ['narayanganj', 'narayangonj', 'n gonj', 'n.gonj']},
];

const compact = (value: unknown) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Bounded Levenshtein distance, enough for short destination names. */
function distance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

/**
 * Return a canonical rate key when the value is a known destination or a
 * close spelling (at least 50% character similarity). Unknown values are kept
 * verbatim and trimmed so an operator can still see what was written.
 */
export function normalizeDestination(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const key = compact(raw);
  for (const destination of DESTINATIONS) {
    if (destination.aliases.some((alias) => compact(alias) === key)) {
      // Preserve the operator's display spelling when it is already the
      // canonical spelling (for example "Chattogram", not "chattogram").
      return compact(raw) === compact(destination.key) ? raw : destination.key;
    }
  }
  let best: {key: string; score: number} | null = null;
  for (const destination of DESTINATIONS) {
    const score = 1 - distance(key, compact(destination.key)) / Math.max(key.length, compact(destination.key).length, 1);
    if (!best || score > best.score) best = {key: destination.key, score};
  }
  return best && best.score >= 0.5 ? best.key : raw;
}
