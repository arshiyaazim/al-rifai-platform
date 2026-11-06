// AL-RIFA'I — DB-backed employee identity resolution.
//
// Evidence levels are defined in identity-resolution.mjs. A financial or duty
// record may attach automatically only on EXACT or VERIFIED_ALIAS. Name-only
// and context-only matches are returned for review, never silently attached.
import {rows} from './standalone/db.ts';
import {normalizeMobile, normalizePersonName, nameSimilarity} from './business-rules.mjs';
import {classifyIdentity, mayAttachAutomatically} from './identity-resolution.mjs';

type EmployeeRow = {
  employee_mobile: string;
  preferred_name: string;
  name_aliases: string[] | null;
  state: string;
};

type AliasRow = {
  jid: string;
  canonical_jid: string | null;
  employee_mobile: string | null;
  confidence: string;
  display_name: string | null;
};

export type EmployeeIdentityResult = {
  level: string;
  employeeMobile: string | null;
  displayName: string | null;
  automatic: boolean;
  candidates: Array<{employeeMobile: string; preferredName: string; score: number; reason: string}>;
  reasons: string[];
};

export async function resolveEmployeeIdentity(input: {
  accountId?: string;
  jid?: string | null;
  phone?: string | null;
  name?: string | null;
  includeInactive?: boolean;
}): Promise<EmployeeIdentityResult> {
  const phone = normalizeMobile(input.phone);
  const name = normalizePersonName(input.name);
  const employees = await rows<EmployeeRow>(
    `SELECT employee_mobile, preferred_name, name_aliases, state FROM employees
      ${input.includeInactive ? '' : "WHERE state = 'ACTIVE'"}
      ORDER BY preferred_name`,
  );
  const reasons: string[] = [];
  const candidates: EmployeeIdentityResult['candidates'] = [];

  if (phone) {
    const exact = employees.find((employee) => normalizeMobile(employee.employee_mobile) === phone);
    if (exact) {
      return {
        level: 'EXACT',
        employeeMobile: exact.employee_mobile,
        displayName: exact.preferred_name,
        automatic: true,
        candidates: [{employeeMobile: exact.employee_mobile, preferredName: exact.preferred_name, score: 1, reason: 'CANONICAL_MOBILE'}],
        reasons: ['CANONICAL_MOBILE'],
      };
    }
  }

  let aliasEmployee: string | null = null;
  if (input.accountId && input.jid) {
    const aliases = await rows<AliasRow>(
      `SELECT jid, canonical_jid, employee_mobile, confidence, display_name
         FROM identity_aliases
        WHERE account_id = $1 AND (jid = $2 OR canonical_jid = $2)`,
      [input.accountId, input.jid],
    );
    const linked = aliases.find((alias) => alias.employee_mobile);
    if (linked?.employee_mobile) {
      aliasEmployee = linked.employee_mobile;
      reasons.push('VERIFIED_IDENTITY_ALIAS');
    }
  }

  if (aliasEmployee) {
    const employee = employees.find((entry) => entry.employee_mobile === aliasEmployee);
    if (employee) {
      return {
        level: 'VERIFIED_ALIAS',
        employeeMobile: employee.employee_mobile,
        displayName: employee.preferred_name,
        automatic: true,
        candidates: [{employeeMobile: employee.employee_mobile, preferredName: employee.preferred_name, score: 1, reason: 'VERIFIED_IDENTITY_ALIAS'}],
        reasons,
      };
    }
  }

  if (name) {
    for (const employee of employees) {
      const names = [employee.preferred_name, ...(employee.name_aliases ?? [])].filter(Boolean);
      let best = 0;
      for (const candidate of names) {
        const normalized = normalizePersonName(candidate);
        const score = normalized === name ? 1 : nameSimilarity(name, candidate);
        if (score > best) best = score;
      }
      if (best >= 0.8) {
        candidates.push({
          employeeMobile: employee.employee_mobile,
          preferredName: employee.preferred_name,
          score: Number(best.toFixed(2)),
          reason: best === 1 ? 'EXACT_NAME_OR_ALIAS' : 'SIMILAR_NAME',
        });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  const unique = [...new Map(candidates.map((entry) => [entry.employeeMobile, entry])).values()];
  const conflicting = unique.length > 1 && unique[0].score === unique[1].score;
  const level = classifyIdentity({
    exactPhone: false,
    verifiedAlias: false,
    contextSignals: unique.length ? (unique.length === 1 ? 1 : 2) : 0,
    conflicting,
  });
  reasons.push(...(unique.length ? ['NAME_OR_ALIAS_EVIDENCE'] : []));
  if (conflicting) reasons.push('CONFLICTING_NAME_CANDIDATES');
  return {
    level,
    employeeMobile: mayAttachAutomatically(level) ? unique[0]?.employeeMobile ?? null : null,
    displayName: unique[0]?.preferredName ?? null,
    automatic: mayAttachAutomatically(level),
    candidates: unique.slice(0, 10),
    reasons,
  };
}
