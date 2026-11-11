// Pure Unicode-aware mother-vessel canonical clustering.
// No database, no I/O. Used by the consolidation script and unit tests.

export type NameCount = {name: string; count: number};
export type MotherCluster = NameCount & {
  key: string;
  digits: string;
  aliases: string[];
  ambiguous: string[];
};

export const canonicalNormalise = (value: string): string => String(value)
  .normalize('NFKC')
  .toUpperCase()
  .replace(/^M\.?\s*V\.?\s*/, '')
  .replace(/\s*\(.*?\)\s*$/, '')
  .replace(/[^\p{L}\p{N}\p{M}]/gu, '');

export const canonicalDigitKey = (value: string): string =>
  (value.match(/\d+/g) ?? []).map((part) => String(Number(part))).join(',');

/** Levenshtein distance over Unicode code points (not UTF-16 bytes). */
export function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  let previous = Array.from({length: b.length + 1}, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Canonical = highest count, then shorter normalized name, then lexical.
 * A candidate is compared only to the chosen canonical (no transitive merge).
 * Names < 5 code points are never fuzzy-matched. Different digit runs are kept
 * separate; leading zeros are normalised before comparison.
 */
export function buildMotherClusters(names: readonly NameCount[]): MotherCluster[] {
  const items = names.map((item) => ({
    ...item,
    key: canonicalNormalise(item.name),
    digits: canonicalDigitKey(canonicalNormalise(item.name)),
  })).sort((a, b) => b.count - a.count
    || a.key.length - b.key.length
    || a.key.localeCompare(b.key));

  const canonical: MotherCluster[] = [];
  const assigned = new Map<string, string>();
  for (const seed of items) {
    if (assigned.has(seed.name)) continue;
    const cluster = [seed];
    for (const candidate of items) {
      if (candidate.name === seed.name || assigned.has(candidate.name)) continue;
      if (seed.key.length < 5 || candidate.key.length < 5) continue;
      if (Math.abs(Array.from(seed.key).length - Array.from(candidate.key).length) > 3) continue;
      if (editDistance(seed.key, candidate.key) > 3) continue;
      if (seed.digits && candidate.digits && seed.digits !== candidate.digits) continue;
      if (Boolean(seed.digits) !== Boolean(candidate.digits)) continue;
      cluster.push(candidate);
    }
    const safe = cluster.filter((candidate) => candidate.name === seed.name
      || !canonical.some((other) => other.name !== seed.name
        && other.key.length >= 5 && candidate.key.length >= 5
        && Math.abs(Array.from(other.key).length - Array.from(candidate.key).length) <= 3
        && editDistance(other.key, candidate.key) <= 3
        && other.digits === candidate.digits));
    const ambiguous = cluster.filter((candidate) => !safe.includes(candidate));
    canonical.push({...seed, aliases: safe.filter((c) => c.name !== seed.name).map((c) => c.name),
      ambiguous: ambiguous.map((c) => c.name)});
    for (const item of safe) assigned.set(item.name, seed.name);
    for (const item of ambiguous) assigned.set(item.name, item.name);
  }
  return canonical;
}
