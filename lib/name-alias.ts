// Name normalisation for the Cash employee directory.
//
// The Owner rule is deliberately simple:
//   * the Employee ID (mobile) is the identity; the same ID is always the same
//     person, whatever spelling arrives with a payment;
//   * a small spelling difference (dot/dash/colon/spacing, or two words joined
//     together) is a minor variant and must not create a second employee;
//   * a completely different name on the same ID is a second name for that
//     person, so it is kept as an alias;
//   * the same/similar name under two different IDs is shown in the alias table
//     but never merged into one employee.

const PUNCTUATION = /[\s.,:;'"`’‘“”\-_/\\()[\]{}]+/g;

/** Lower-case, punctuation-free, single-spaced text used for matching. */
export function normalizeName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A stricter key: all spaces are removed, so "Abdul Karim" and "AbdulKarim" match. */
export function compactName(value: unknown): string {
  return normalizeName(value).replace(/\s+/g, '');
}

/** Levenshtein distance with an early exit for long strings. */
export function editDistance(left: string, right: string): number {
  const a = left;
  const b = right;
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);
  let previous = Array.from({length: b.length + 1}, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * True when two names are the same person under the Owner's "minor mistake"
 * rule: same letters with punctuation/spacing noise, one or two character
 * typos, or the same tokens joined together.
 */
export function isMinorNameVariant(left: unknown, right: unknown): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const compactA = a.replace(/\s+/g, '');
  const compactB = b.replace(/\s+/g, '');
  if (compactA === compactB) return true;
  // A joined-word variation such as "Md Rahim" vs "MdRahim".
  if (compactA.includes(compactB) || compactB.includes(compactA)) {
    return Math.abs(compactA.length - compactB.length) <= 3;
  }
  // A short typo. Longer names get a slightly larger allowance, but never so
  // large that two clearly different people collapse into one row.
  const allowance = Math.max(1, Math.min(2, Math.floor(Math.min(a.length, b.length) / 8)));
  return editDistance(compactA, compactB) <= allowance;
}

export type AliasKind = 'SAME_ID_DIFFERENT_NAME' | 'SAME_NAME_DIFFERENT_ID';

export type AliasEntry = {
  employeeId: string;
  preferredName: string;
  aliasName: string;
  kind: AliasKind;
  otherEmployeeId?: string | null;
  otherName?: string | null;
};

/**
 * Build alias rows from an employee list. Pure and deterministic so it can be
 * reused by a server read model and by unit tests.
 */
export function buildAliasEntries(
  employees: Array<{employee_mobile: string; preferred_name: string; name_aliases?: string[] | null}>,
): AliasEntry[] {
  const entries: AliasEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: AliasEntry) => {
    const key = [entry.kind, entry.employeeId, entry.aliasName, entry.otherEmployeeId ?? ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const employee of employees) {
    for (const rawAlias of employee.name_aliases ?? []) {
      const aliasName = String(rawAlias ?? '').trim();
      if (!aliasName) continue;
      if (isMinorNameVariant(aliasName, employee.preferred_name)) continue;
      add({
        employeeId: employee.employee_mobile,
        preferredName: employee.preferred_name,
        aliasName,
        kind: 'SAME_ID_DIFFERENT_NAME',
      });
    }
  }

  for (let i = 0; i < employees.length; i += 1) {
    for (let j = i + 1; j < employees.length; j += 1) {
      const left = employees[i];
      const right = employees[j];
      if (left.employee_mobile === right.employee_mobile) continue;
      const leftNames = [left.preferred_name, ...(left.name_aliases ?? [])];
      const rightNames = [right.preferred_name, ...(right.name_aliases ?? [])];
      const matched = leftNames.some((leftName) =>
        rightNames.some((rightName) => isMinorNameVariant(leftName, rightName)));
      if (!matched) continue;
      add({
        employeeId: left.employee_mobile,
        preferredName: left.preferred_name,
        aliasName: right.preferred_name,
        kind: 'SAME_NAME_DIFFERENT_ID',
        otherEmployeeId: right.employee_mobile,
        otherName: right.preferred_name,
      });
    }
  }

  return entries;
}
